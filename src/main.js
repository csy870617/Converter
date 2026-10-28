// 글꼴: Pretendard (SIL OFL 1.1). 화면에 쓰인 글자가 든 조각만 받는다.
import 'pretendard/dist/web/variable/pretendardvariable-dynamic-subset.css';
import './style.css';
import { CATEGORIES, ConvertError, MIME, PasswordError, TOOLS, UPSCALE, categoryOf, extOf, stemOf, targetLabel, targetsFor } from './formats.js';
import { LOAD_FAILED, convertFile, imagesToPdf, isLoadFailure, mergePdfs, officeSupported } from './engines.js';
import { localFontsSupported, requestLocalFonts } from './localfonts.js';

// ---------------------------------------------------------------------------
// 화면
// ---------------------------------------------------------------------------
const $ = (id) => document.getElementById(id);
// AI 화질 개선 세기: 'original'(원본) | 'natural'(자연스럽게) | 'strong'(강하게)
const STRENGTHS = ['original', 'natural', 'strong'];
const STRENGTH_NOTES = {
  original: '원본의 결(잡음·필름 입자·압축 흔적)까지 그대로 살려 키웁니다. AI가 지우거나 바꾸는 것이 가장 적어요.',
  natural: '원본은 그대로 두고 흐릿한 부분만 선명하게, 압축 때문에 생긴 얼룩은 깨끗하게 합니다.',
  strong: '자연스럽게에 윤곽을 한 번 더 또렷하게 합니다. 1080p처럼 이미 괜찮은 영상에서 차이가 잘 보여요.',
};
const state = { files: [], target: null, busy: false, status: new Map(), strength: 'natural' };
try {
  const saved = localStorage.getItem('upscale-strength');
  if (STRENGTHS.includes(saved)) state.strength = saved;
} catch { /* 저장 불가해도 동작 */ }
let lastUrl = null;
let downloads = 0; // 이 페이지에서 자동으로 내려받은 횟수
let clickedAt = 0; // '변환하기'를 누른 시각

const IMAGE = CATEGORIES.find((c) => c.id === 'image');
// 세기 선택 막대는 AI 화질 개선 줄 안으로 옮겨 다니므로(화면에서 빠져 있을 때도 있다) 처음에 잡아 둔다
const strengthRow = $('strengthRow');

// 작은 그림(아이콘). 모두 aria-hidden이라 버튼 이름은 글자만 읽힌다.
const svg = (body) => `<svg viewBox="0 0 24 24" aria-hidden="true">${body}</svg>`;
const ICONS = {
  sparkle: svg('<path d="M12 2.5l1.9 5.6 5.6 1.9-5.6 1.9L12 17.5l-1.9-5.6L4.5 10l5.6-1.9z"/><path d="M18.5 15l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8z"/>'),
  compress: svg('<path d="M4 14h6v6M20 10h-6V4M14 10l6.5-6.5M3.5 20.5 10 14"/>'),
  rotr: svg('<path d="M20.5 12a8.5 8.5 0 1 1-2.5-6l2.5 2.5"/><path d="M20.5 3.5v5h-5"/>'),
  rotl: svg('<path d="M3.5 12a8.5 8.5 0 1 0 2.5-6L3.5 8.5"/><path d="M3.5 3.5v5h5"/>'),
  split: svg('<circle cx="6" cy="6" r="2.5"/><circle cx="6" cy="18" r="2.5"/><path d="M8.2 7.4 20 17M8.2 16.6 20 7"/>'),
  merge: svg('<path d="M12 3.5l8.5 4.5-8.5 4.5L3.5 8z"/><path d="M3.5 12.5l8.5 4.5 8.5-4.5"/><path d="M3.5 16.5l8.5 4.5 8.5-4.5"/>'),
  unlock: svg('<rect x="4.5" y="11" width="15" height="10" rx="2"/><path d="M8 11V7.5a4 4 0 0 1 7.6-1.7"/>'),
  protect: svg('<rect x="4.5" y="11" width="15" height="10" rx="2"/><path d="M8 11V7.5a4 4 0 0 1 8 0V11"/>'),
  x: svg('<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>'),
  up: svg('<path d="M12 19V5M5.5 11.5 12 5l6.5 6.5"/>'),
};

function prettySize(n) {
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${i ? n.toFixed(1) : n} ${units[i]}`;
}

function usableFiles() {
  return state.files.filter((f) => targetsFor(f.name).length);
}

function addFiles(list) {
  if (state.busy || !list.length) return; // 파일이 아닌 것(글자 등)을 놓았을 때는 아무것도 바꾸지 않는다
  for (const f of list) {
    if (!state.files.some((x) => x.name === f.name && x.size === f.size && x.lastModified === f.lastModified)) {
      state.files.push(f);
    }
  }
  state.status.clear();
  setMsg('');
  render();
}

function render() {
  // 모든 파일에 공통으로 가능한 형식만 보여준다
  const usable = usableFiles();
  let common = null;
  for (const f of usable) {
    const t = targetsFor(f.name);
    common = common === null ? t : common.filter((x) => t.includes(x));
  }
  common ??= [];
  // PDF 여러 개: 하나로 합치기
  if (usable.length > 1 && allPdf(usable)) common.push('merge');
  if (!common.includes(state.target)) state.target = common.length === 1 ? common[0] : null;

  const ul = $('files');
  ul.replaceChildren();
  state.files.forEach((f, i) => {
    const ok = targetsFor(f.name).length > 0;
    const li = document.createElement('li');
    // 파일 종류(확장자) · 이름과 크기 · 진행 상태
    const badge = document.createElement('span');
    badge.className = 'badge';
    badge.textContent = (extOf(f.name) || '?').slice(0, 4).toUpperCase();
    badge.setAttribute('aria-hidden', 'true');
    const meta = document.createElement('span');
    meta.className = 'fmeta';
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = f.name;
    name.title = f.name;
    const size = document.createElement('span');
    size.className = ok ? 'size' : 'size bad';
    size.textContent = ok ? prettySize(f.size) : '지원하지 않는 형식';
    meta.append(name, size);
    li.append(badge, meta);
    const st = state.status.get(f);
    if (st) {
      const info = document.createElement('span');
      info.className = `state ${st.kind || ''}`;
      info.textContent = st.text;
      li.append(info);
    }
    // 여러 파일을 하나로 합칠 때는 목록 순서대로 합치므로 순서를 바꿀 수 있게 한다
    if (merging() && i > 0) {
      const up = iconButton('up', '위로 올리기', `${f.name} 위로`);
      up.onclick = () => { [state.files[i - 1], state.files[i]] = [state.files[i], state.files[i - 1]]; render(); };
      li.append(up);
    }
    const del = iconButton('x', '목록에서 빼기', `${f.name} 빼기`);
    del.classList.add('del');
    del.onclick = () => { state.files.splice(i, 1); state.status.clear(); render(); };
    li.append(del);
    ul.append(li);
  });

  // 파일 수·전체 크기, 모두 빼기
  const summary = $('filesInfo');
  summary.replaceChildren();
  if (state.files.length) {
    const total = state.files.reduce((sum, f) => sum + f.size, 0);
    const label = document.createElement('span');
    const b = document.createElement('b');
    b.textContent = '선택한 파일';
    label.append(b, `${state.files.length}개 · ${prettySize(total)}`);
    summary.append(label);
    if (state.files.length > 1) {
      const clear = document.createElement('button');
      clear.type = 'button';
      clear.className = 'link-btn';
      clear.textContent = '모두 빼기';
      clear.disabled = state.busy;
      clear.onclick = () => { state.files = []; state.status.clear(); setMsg(''); render(); };
      summary.append(clear);
    }
  }
  // 파일을 넣은 뒤에는 넣는 곳을 작게 줄인다
  $('drop').classList.toggle('compact', state.files.length > 0);
  $('dropBig').textContent = state.files.length ? '파일 더 넣기' : '파일을 여기에 끌어다 놓으세요';
  $('dropSmall').textContent = state.files.length ? '끌어다 놓거나 눌러서 선택' : '사진·동영상·오디오·문서·PDF, 여러 개를 한 번에 넣을 수 있어요';

  // 형식 바꾸기·AI 화질 개선·도구는 성격이 달라 줄을 나눠 보여준다. 세기 선택은 AI 화질 개선 줄 안에.
  const groups = [
    { label: '변환', items: common.filter((t) => !UPSCALE[t] && !TOOLS[t]) },
    { label: 'AI 화질 개선', items: common.filter((t) => UPSCALE[t]), extra: strengthRow },
    { label: allPdf(usable) ? 'PDF 도구' : '도구', items: common.filter((t) => TOOLS[t]) },
  ];
  $('targets').replaceChildren(...groups.filter((g) => g.items.length).map((g) => {
    const row = document.createElement('div');
    row.className = 'group';
    const label = document.createElement('div');
    label.className = 'group-label';
    label.textContent = g.label;
    const chips = document.createElement('div');
    chips.className = 'chips';
    chips.append(...g.items.map(formatButton));
    row.append(label, chips);
    if (g.extra) row.append(g.extra);
    return row;
  }));

  const hint = $('targetHint');
  if (!state.files.length) hint.textContent = '파일을 넣으면 바꿀 수 있는 형식이 여기에 나타나요.';
  else if (!usable.length) hint.textContent = '지원하지 않는 파일입니다.';
  else if (!common.length) hint.textContent = '같은 종류의 파일끼리 넣어 주세요.';
  else hint.textContent = '';
  hint.classList.toggle('hidden', !hint.textContent);

  $('mergeRow').classList.toggle('hidden', !imagesToOnePdf(usable));
  $('mergeNote').classList.toggle('hidden', !merging());
  // 문서 엔진·PDF→Word 엔진은 처음 한 번 받느라 오래 걸린다
  const needsEngine = usable.some((f) => categoryOf(f.name).engine === 'office')
    || (state.target === 'docx' && usable.some((f) => ['pdf', 'hwp'].includes(categoryOf(f.name).engine)));
  $('officeNote').classList.toggle('hidden', !needsEngine);
  $('fontNote').classList.toggle('hidden', !(localFontsSupported() && usable.some((f) => categoryOf(f.name).engine === 'office')));
  const upscaling = !!UPSCALE[state.target];
  $('upNote').textContent = STRENGTH_NOTES[state.strength];
  $('upNote').classList.toggle('hidden', !upscaling);
  // 세기 선택은 AI 화질 개선 버튼이 보이면 항상 함께 보여준다 (고르기 전에도 눈에 띄도록)
  strengthRow.classList.toggle('hidden', !common.some((t) => UPSCALE[t]));
  for (const b of strengthRow.querySelectorAll('[data-strength]')) {
    b.setAttribute('aria-pressed', String(b.dataset.strength === state.strength));
    b.disabled = state.busy;
  }
  $('upVideoNote').classList.toggle('hidden', !(upscaling && usable.some((f) => categoryOf(f.name).id === 'video')));

  const go = $('go');
  go.disabled = state.busy || !(usable.length && state.target);
  go.classList.toggle('busy', state.busy);
  if (!state.busy) {
    if (!state.target) go.textContent = '변환하기';
    else if (UPSCALE[state.target]) go.textContent = `${targetLabel(state.target)}로 화질 높이기`;
    else if (TOOLS[state.target]) go.textContent = `${allPdf(usable) ? 'PDF ' : ''}${targetLabel(state.target)}`;
    else go.textContent = `${state.target.toUpperCase()}${TAKES_EURO.includes(state.target) ? '으로' : '로'} 변환하기`;
  }
}

const allPdf = (usable) => usable.length > 0 && usable.every((f) => extOf(f.name) === 'pdf');
// 읽는 소리가 받침으로 끝나는 형식 이름 (웹엠·플락·독 → '으로', 나머지는 '로')
const TAKES_EURO = ['webm', 'flac', 'doc'];

/** 형식·도구 버튼 */
function formatButton(t) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = `fmt${UPSCALE[t] ? ' ai' : ''}${TOOLS[t] ? ' tool' : ''}${t === state.target ? ' on' : ''}`;
  b.setAttribute('aria-pressed', String(t === state.target));
  const icon = UPSCALE[t] ? ICONS.sparkle : ICONS[t];
  if (icon) b.insertAdjacentHTML('beforeend', icon);
  b.append(targetLabel(t));
  b.disabled = state.busy;
  b.onclick = () => { state.target = t; render(); };
  return b;
}

/** 그림만 있는 작은 버튼 (위로 올리기, 빼기) */
function iconButton(icon, title, label) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'icon-btn';
  b.title = title;
  b.setAttribute('aria-label', label);
  b.insertAdjacentHTML('beforeend', ICONS[icon]);
  b.disabled = state.busy;
  return b;
}

/** 사진 여러 장 → PDF 한 개로 합치기 (체크 상자로 고른다) */
function imagesToOnePdf(usable = usableFiles()) {
  return usable.length > 1 && state.target === 'pdf' && usable.every((f) => IMAGE.exts.includes(extOf(f.name)));
}

/** 여러 파일을 목록 순서대로 하나로 합치는가 */
function merging() {
  return state.target === 'merge' || (imagesToOnePdf() && $('merge').checked);
}

function setMsg(text, kind = '', link = null) {
  const msg = $('msg');
  msg.className = kind;
  msg.textContent = text;
  if (link) {
    // 직접 누르는 다운로드는 브라우저가 막지 않는다. 다시 받고 싶을 때도 쓴다.
    const a = document.createElement('a');
    a.className = 'dl';
    a.href = link.href;
    a.download = link.name;
    a.textContent = `${link.name} 받기`;
    msg.append('\n', a);
  }
}

/**
 * 암호를 기다리는 동안 변환 버튼에 그렇다고 보여 준다 (도는 표시는 멈춘다). 다 받으면 원래대로.
 */
function waitingForPassword(promise) {
  const go = $('go');
  const text = go.textContent;
  go.textContent = '암호 입력을 기다리는 중…';
  go.classList.remove('busy');
  return promise.finally(() => {
    go.textContent = text;
    go.classList.toggle('busy', state.busy);
  });
}

/**
 * 암호를 묻는다 (메시지 자리에 입력 칸을 띄운다). 입력한 암호, 건너뛰면 null.
 */
function askPassword(fileName, wrong) {
  return waitingForPassword(new Promise((resolve) => {
    const msg = $('msg');
    msg.className = 'ask';
    const form = document.createElement('form');
    form.className = 'password';
    const text = document.createElement('p');
    text.textContent = wrong
      ? `암호가 맞지 않습니다. ${fileName}의 암호를 다시 입력해 주세요.`
      : `${fileName}에 암호가 걸려 있습니다. 암호를 입력해 주세요.`;
    const input = document.createElement('input');
    input.type = 'password';
    input.autocomplete = 'off';
    input.required = true;
    input.setAttribute('aria-label', '암호');
    const ok = document.createElement('button');
    ok.type = 'submit';
    ok.textContent = '확인';
    const skip = document.createElement('button');
    skip.type = 'button';
    skip.className = 'skip';
    skip.textContent = '건너뛰기';
    const row = document.createElement('div');
    row.append(input, ok, skip);
    form.append(text, row);
    form.onsubmit = (e) => { e.preventDefault(); resolve(input.value); };
    skip.onclick = () => resolve(null);
    msg.replaceChildren(form);
    input.focus();
  }));
}

/**
 * PDF에 걸 새 암호를 정한다 (잘못 치지 않도록 두 번 입력). 정한 암호, 취소하면 null.
 */
function askNewPassword(count) {
  return waitingForPassword(new Promise((resolve) => {
    const msg = $('msg');
    msg.className = 'ask';
    const form = document.createElement('form');
    form.className = 'password newpass';
    const text = document.createElement('p');
    text.textContent = `${count > 1 ? `PDF ${count}개에` : 'PDF에'} 걸 암호를 정해 주세요. 열 때마다 이 암호를 물어요.`;
    const input = document.createElement('input');
    const again = document.createElement('input');
    for (const [el, label] of [[input, '새 암호'], [again, '새 암호 한 번 더']]) {
      el.type = 'password';
      el.autocomplete = 'new-password';
      el.required = true;
      el.placeholder = label;
      el.setAttribute('aria-label', label);
    }
    const ok = document.createElement('button');
    ok.type = 'submit';
    ok.textContent = '암호 걸기';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'skip';
    cancel.textContent = '취소';
    const warn = document.createElement('p');
    warn.className = 'warn hidden';
    warn.textContent = '두 암호가 서로 다릅니다. 다시 입력해 주세요.';
    const row = document.createElement('div');
    row.append(input, again, ok, cancel);
    form.append(text, row, warn);
    form.onsubmit = (e) => {
      e.preventDefault();
      if (input.value !== again.value) {
        warn.classList.remove('hidden');
        again.value = '';
        again.focus();
        return;
      }
      resolve(input.value);
    };
    cancel.onclick = () => resolve(null);
    msg.replaceChildren(form);
    input.focus();
  }));
}

function setBar(mode, pct = 0) {
  const bar = $('bar');
  bar.classList.toggle('show', !!mode);
  bar.classList.toggle('busy', mode === 'busy');
  bar.firstElementChild.style.width = `${Math.round(pct * 100)}%`;
}

/**
 * 결과 파일을 준비하고, 브라우저가 허락하는 경우에만 자동으로 내려받는다.
 * 크롬·엣지는 클릭 없이 두 번째 파일부터 자동으로 받으려 하면 '여러 파일 다운로드'로 막는다.
 * (클릭의 효력은 약 5초). 그래서 첫 파일이거나 클릭 후 4초 안에 변환이 끝난 경우에만 자동으로 받고,
 * 그 밖에는 '받기' 버튼을 눌러 받게 한다. auto가 false면 버튼으로 받아야 한다.
 */
function download(name, blob) {
  if (lastUrl) URL.revokeObjectURL(lastUrl);
  lastUrl = URL.createObjectURL(blob);
  const auto = downloads === 0 || performance.now() - clickedAt < 4000;
  if (auto) {
    const a = document.createElement('a');
    a.href = lastUrl;
    a.download = name;
    document.body.append(a);
    a.click();
    a.remove();
    downloads++;
  }
  return { href: lastUrl, name, auto };
}

async function zipResults(results) {
  const { zipSync } = await import('fflate');
  const entries = {};
  const used = new Set();
  for (const r of results) {
    let name = r.name;
    for (let n = 2; used.has(name); n++) name = r.name.replace(/(\.[^.]+)$/, ` (${n})$1`);
    used.add(name);
    entries[name] = [new Uint8Array(await r.blob.arrayBuffer()), { level: 0 }];
  }
  return new Blob([zipSync(entries)], { type: MIME.zip });
}

async function run() {
  const files = usableFiles();
  const target = state.target;
  if (!files.length || !target || state.busy) return;
  // 문서 변환: 내 컴퓨터 글꼴(맑은 고딕 등)을 쓰도록 허락을 구한다. 버튼을 누른 바로 그때만 물을 수 있다.
  if (localFontsSupported() && files.some((f) => categoryOf(f.name).engine === 'office')) requestLocalFonts();

  clickedAt = performance.now();
  state.busy = true;
  state.status.clear();
  $('go').textContent = '변환 중…';
  render();

  // 암호 걸기: 걸 암호를 먼저 정한다 (여러 파일이면 모두 같은 암호)
  let newPassword = null;
  if (target === 'protect') {
    newPassword = await askNewPassword(files.length);
    if (newPassword === null) {
      state.busy = false;
      render();
      setMsg('암호를 정하지 않아 취소했습니다.');
      return;
    }
    clickedAt = performance.now(); // 암호를 넣느라 걸린 시간 때문에 결과를 자동으로 못 받는 일이 없게
  }

  const results = [];
  const errors = [];
  const passwords = new Map(); // 파일 이름 → 입력한 암호 (이번 변환 동안만 기억한다)
  const warnings = [];
  const notes = []; // 결과 설명 (예: 줄어든 용량)
  const merge = merging();
  const jobs = merge ? [{ files, label: target === 'merge' ? `PDF ${files.length}개` : `사진 ${files.length}장` }]
    : files.map((f) => ({ files: [f], label: f.name }));
  // 여러 개면 끝에 ZIP으로 묶는다. 묶는 도구를 미리 받아 둔다 (긴 변환 중에 인터넷이 끊겨도 묶을 수 있게)
  if (jobs.length > 1) import('fflate').catch(() => {});

  for (const [i, job] of jobs.entries()) {
    const prefix = jobs.length > 1 ? `(${i + 1}/${jobs.length}) ` : '';
    const setState = (text, kind) => { for (const f of job.files) state.status.set(f, { text, kind }); render(); };
    const ctx = {
      status: (text) => { setMsg(`${prefix}${text}`); setBar('busy'); },
      progress: (p) => { setBar('progress', p); setState(`${Math.round(p * 100)}%`); },
      strength: state.strength,
      newPassword,
      passwordFor: (name) => passwords.get(name),
    };
    setState('변환 중…');
    ctx.status(`${job.label} 변환 중…`);
    try {
      const f = job.files[0];
      let out;
      // 암호가 걸려 있으면 암호를 물어 다시 한다 (틀리면 다시 묻는다)
      for (;;) {
        try {
          if (target === 'merge') out = [await mergePdfs(job.files, `${stemOf(f.name)}_합침`, ctx)];
          else if (merge) out = [await imagesToPdf(job.files, stemOf(f.name))];
          else out = await convertFile(f, categoryOf(f.name).engine, target, ctx);
          break;
        } catch (e) {
          if (!(e instanceof PasswordError)) throw e;
          const password = await askPassword(e.fileName, e.wrong);
          if (password === null) throw new ConvertError('암호를 입력하지 않아 건너뛰었습니다.');
          passwords.set(e.fileName, password);
        }
      }
      results.push(...out);
      for (const r of out) if (r.warning) warnings.push(`${job.label}: ${r.warning}`);
      for (const r of out) if (r.note) notes.push(jobs.length > 1 ? `${job.label}: ${r.note}` : r.note);
      setState('완료', 'ok');
    } catch (e) {
      console.error(e);
      const text = e instanceof ConvertError ? e.message
        : isLoadFailure(e) ? LOAD_FAILED : '변환 중 문제가 생겼습니다. 다시 시도해 주세요.';
      errors.push(`${job.label}: ${text}`);
      setState('실패', 'err');
    }
  }

  setBar(null);
  state.busy = false;
  render();

  if (!results.length) {
    setMsg(errors.join('\n\n') || '변환된 파일이 없습니다.', 'err');
    return;
  }
  const single = results.length === 1;
  let link;
  try {
    link = single ? download(results[0].name, results[0].blob) : download('변환결과.zip', await zipResults(results));
  } catch (e) {
    console.error(e);
    setMsg(isLoadFailure(e) ? LOAD_FAILED : '결과 파일을 묶지 못했습니다. 다시 시도해 주세요.', 'err');
    return;
  }
  const press = link.auto ? '' : ' 아래 버튼을 눌러 받으세요.';
  let text = single ? `완료!${press}` : `완료! 파일 ${results.length}개를 ZIP으로 묶었습니다.${press}`;
  if (errors.length) text = `일부만 완료됐습니다. (완료 ${jobs.length - errors.length}개 · 실패 ${errors.length}개)${press}\n\n${errors.join('\n')}`;
  if (notes.length) text += `\n${notes.join('\n')}`;
  if (warnings.length) text += `\n\n${warnings.join('\n')}`;
  setMsg(text, errors.length || warnings.length ? 'err' : 'ok', link);
}

// 라이트/다크 모드 전환 (처음에는 기기 설정을 따르고, 고르면 기억한다)
const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');
function currentTheme() {
  return document.documentElement.dataset.theme || (darkQuery.matches ? 'dark' : 'light');
}
const themeBtn = $('themeBtn');
function showTheme() {
  const dark = currentTheme() === 'dark';
  themeBtn.dataset.mode = dark ? 'dark' : 'light'; // 지금 모드의 반대 그림을 보여 준다 (누르면 그쪽으로)
  themeBtn.title = dark ? '라이트 모드로 바꾸기' : '다크 모드로 바꾸기';
  themeBtn.setAttribute('aria-label', themeBtn.title);
  // 휴대폰 브라우저 위쪽 막대 색도 페이지 바탕에 맞춘다
  for (const m of document.querySelectorAll('meta[name="theme-color"]')) m.content = dark ? '#111318' : '#ffffff';
}
themeBtn.onclick = () => {
  const next = currentTheme() === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem('theme', next); } catch { /* 저장 불가해도 동작 */ }
  showTheme();
};
darkQuery.addEventListener('change', showTheme);
showTheme();

// AI 화질 개선 세기 (고른 것은 기억한다)
for (const b of document.querySelectorAll('[data-strength]')) {
  b.onclick = () => {
    state.strength = b.dataset.strength;
    try { localStorage.setItem('upscale-strength', state.strength); } catch { /* 저장 불가해도 동작 */ }
    render();
  };
}

// 지원 형식 표
$('formats').replaceChildren(...CATEGORIES.map((c) => {
  const tr = document.createElement('tr');
  const name = document.createElement('td');
  name.textContent = c.name;
  const desc = document.createElement('td');
  const to = document.createElement('b');
  // 여러 파일을 하나로 합치는 것도 함께 적는다
  const extra = { pdf: ['여러 개를 하나로 합치기'], image: ['여러 장을 PDF 하나로'] }[c.id] || [];
  to.textContent = [...c.targets.map(targetLabel), ...extra].join(', ');
  desc.append(`${c.exts.join(', ').toUpperCase()} → `, to);
  tr.append(name, desc);
  return tr;
}));

// 파일 넣기: 클릭, 끌어다 놓기, 붙여넣기
const drop = $('drop');
drop.onclick = () => $('picker').click();
drop.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('picker').click(); } };
$('picker').onchange = (e) => { addFiles([...e.target.files]); e.target.value = ''; };
for (const ev of ['dragenter', 'dragover']) window.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); });
for (const ev of ['dragleave', 'drop']) window.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('over'); });
window.addEventListener('drop', (e) => addFiles([...(e.dataTransfer?.files || [])]));
window.addEventListener('paste', (e) => { if (e.clipboardData?.files.length) addFiles([...e.clipboardData.files]); });
$('go').onclick = run;
$('merge').onchange = render;
window.addEventListener('beforeunload', (e) => {
  if (!state.busy) return;
  e.preventDefault();
  e.returnValue = ''; // 일부 브라우저는 이 값이 있어야 "나가시겠습니까?"를 묻는다
});

// ---------------------------------------------------------------------------
// 서비스 워커: 문서 변환에 필요한 보안 헤더를 붙인다. 처음 방문 때 한 번 새로고침된다.
// ---------------------------------------------------------------------------
async function setupServiceWorker() {
  if (!('serviceWorker' in navigator) || !window.isSecureContext) return;
  try {
    await navigator.serviceWorker.register('./sw.js');
    await navigator.serviceWorker.ready;
    if (!self.crossOriginIsolated) {
      // 그새 파일을 골랐으면 새로고침하지 않는다 (고른 파일이 사라지므로). 문서 변환 때 새로고침을 안내한다.
      if (state.files.length || state.busy) return;
      // 무한 새로고침을 막기 위해 한 번만 시도한다
      if (!sessionStorage.getItem('sw-reloaded')) {
        sessionStorage.setItem('sw-reloaded', '1');
        location.reload();
      }
    } else {
      sessionStorage.removeItem('sw-reloaded');
    }
  } catch (e) {
    console.warn('서비스 워커 등록 실패', e);
  }
}

if (!officeSupported()) console.info('crossOriginIsolated=false: 문서 변환은 서비스 워커 적용 후 가능');
render();
setupServiceWorker();
