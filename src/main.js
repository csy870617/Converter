import './style.css';
import { CATEGORIES, ConvertError, MIME, categoryOf, extOf, targetsFor } from './formats.js';
import { convertFile, imagesToPdf, officeSupported } from './engines.js';

// ---------------------------------------------------------------------------
// 서비스 워커: 문서 변환에 필요한 보안 헤더를 붙인다. 처음 방문 때 한 번 새로고침된다.
// ---------------------------------------------------------------------------
async function setupServiceWorker() {
  if (!('serviceWorker' in navigator) || !window.isSecureContext) return;
  try {
    await navigator.serviceWorker.register('./sw.js');
    await navigator.serviceWorker.ready;
    if (!self.crossOriginIsolated) {
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
setupServiceWorker();

// ---------------------------------------------------------------------------
// 화면
// ---------------------------------------------------------------------------
const $ = (id) => document.getElementById(id);
const state = { files: [], target: null, busy: false, status: new Map() };
let lastUrl = null;

const IMAGE = CATEGORIES.find((c) => c.id === 'image');

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
  if (state.busy) return;
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
  const ul = $('files');
  ul.replaceChildren();
  state.files.forEach((f, i) => {
    const ok = targetsFor(f.name).length > 0;
    const li = document.createElement('li');
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = (ok ? '' : '⚠ ') + f.name;
    name.title = f.name;
    const info = document.createElement('span');
    const st = state.status.get(f);
    if (st) {
      info.className = `state ${st.kind || ''}`;
      info.textContent = st.text;
    } else {
      info.className = 'size';
      info.textContent = ok ? prettySize(f.size) : '지원하지 않는 형식';
    }
    const del = document.createElement('button');
    del.textContent = '×';
    del.title = '목록에서 빼기';
    del.setAttribute('aria-label', `${f.name} 빼기`);
    del.disabled = state.busy;
    del.onclick = () => { state.files.splice(i, 1); state.status.clear(); render(); };
    li.append(name, info, del);
    ul.append(li);
  });

  // 모든 파일에 공통으로 가능한 형식만 보여준다
  const usable = usableFiles();
  let common = null;
  for (const f of usable) {
    const t = targetsFor(f.name);
    common = common === null ? t : common.filter((x) => t.includes(x));
  }
  common ??= [];
  if (!common.includes(state.target)) state.target = common.length === 1 ? common[0] : null;

  const box = $('targets');
  box.replaceChildren();
  for (const t of common) {
    const b = document.createElement('button');
    b.className = `fmt${t === state.target ? ' on' : ''}`;
    b.textContent = t.toUpperCase();
    b.disabled = state.busy;
    b.onclick = () => { state.target = t; render(); };
    box.append(b);
  }

  const hint = $('targetHint');
  if (!state.files.length) hint.textContent = '먼저 파일을 선택하면 바꿀 수 있는 형식이 나타납니다.';
  else if (!usable.length) hint.textContent = "지원하지 않는 파일입니다. 아래 '지원하는 형식 보기'를 확인해 주세요.";
  else if (!common.length) hint.textContent = '서로 종류가 다른 파일이 섞여 있습니다. 같은 종류끼리 변환해 주세요.';
  else hint.textContent = '';
  hint.classList.toggle('hidden', !hint.textContent);

  const allImages = usable.length > 1 && usable.every((f) => IMAGE.exts.includes(extOf(f.name)));
  $('mergeRow').classList.toggle('hidden', !(allImages && state.target === 'pdf'));
  const needsOffice = usable.some((f) => categoryOf(f.name).engine === 'office');
  $('officeNote').classList.toggle('hidden', !needsOffice);

  const go = $('go');
  go.disabled = state.busy || !(usable.length && state.target);
  if (!state.busy) go.textContent = state.target ? `${state.target.toUpperCase()}(으)로 변환하기` : '변환하기';
}

function setMsg(text, kind = '', link = null) {
  const msg = $('msg');
  msg.className = kind;
  msg.textContent = text;
  if (link) {
    msg.append('\n');
    const a = document.createElement('a');
    a.href = link.href;
    a.download = link.name;
    a.textContent = `다운로드가 시작되지 않았다면 여기를 누르세요 (${link.name})`;
    msg.append(a);
  }
}

function setBar(mode, pct = 0) {
  const bar = $('bar');
  bar.classList.toggle('show', !!mode);
  bar.classList.toggle('busy', mode === 'busy');
  bar.firstElementChild.style.width = `${Math.round(pct * 100)}%`;
}

function download(name, blob) {
  if (lastUrl) URL.revokeObjectURL(lastUrl);
  lastUrl = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = lastUrl;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  return { href: lastUrl, name };
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

  state.busy = true;
  state.status.clear();
  $('go').textContent = '변환 중…';
  render();

  const results = [];
  const errors = [];
  const merge = !$('mergeRow').classList.contains('hidden') && $('merge').checked;
  const jobs = merge ? [{ files, label: `사진 ${files.length}장` }] : files.map((f) => ({ files: [f], label: f.name }));

  for (const [i, job] of jobs.entries()) {
    const prefix = jobs.length > 1 ? `(${i + 1}/${jobs.length}) ` : '';
    const setState = (text, kind) => { for (const f of job.files) state.status.set(f, { text, kind }); render(); };
    const ctx = {
      status: (text) => { setMsg(`${prefix}${text}`); setBar('busy'); },
      progress: (p) => { setBar('progress', p); setState(`${Math.round(p * 100)}%`); },
    };
    setState('변환 중…');
    ctx.status(`${job.label} 변환 중…`);
    try {
      const f = job.files[0];
      const out = merge
        ? [await imagesToPdf(job.files, f.name.replace(/\.[^.]+$/, ''))]
        : await convertFile(f, categoryOf(f.name).engine, target, ctx);
      results.push(...out);
      setState('완료', 'ok');
    } catch (e) {
      console.error(e);
      const text = e instanceof ConvertError ? e.message : `알 수 없는 오류가 발생했습니다. (${e?.message || e})`;
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
  const link = single ? download(results[0].name, results[0].blob) : download('변환결과.zip', await zipResults(results));
  let text = single
    ? `완료! '${link.name}' 파일을 내려받았습니다.`
    : `완료! 파일 ${results.length}개를 '${link.name}'으로 묶어 내려받았습니다.`;
  if (errors.length) text += `\n\n일부 파일은 실패했습니다:\n${errors.join('\n')}`;
  setMsg(text, errors.length ? 'err' : 'ok', link);
}

// 지원 형식 표
$('formats').replaceChildren(...CATEGORIES.map((c) => {
  const tr = document.createElement('tr');
  const name = document.createElement('td');
  name.textContent = c.name;
  const desc = document.createElement('td');
  const to = document.createElement('b');
  to.textContent = c.targets.join(', ').toUpperCase();
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
window.addEventListener('beforeunload', (e) => { if (state.busy) e.preventDefault(); });

if (!officeSupported()) console.info('crossOriginIsolated=false: 문서 변환은 서비스 워커 적용 후 가능');
render();
