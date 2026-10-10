// 한글 문서(HWP·HWPX) → PDF.
// rhwp(WebAssembly)가 쪽마다 그린 그림(SVG)을 svg2pdf로 PDF에 옮긴다. 글자는 글자로 들어가서 고르고·복사하고·찾을 수 있다.
// 문서의 글꼴(함초롬바탕·맑은 고딕·Times New Roman 등)은 모양이 비슷한 자유 글꼴로 바꾸고,
// 그 글꼴에 없는 글자(한자·특수 기호)는 그 글자가 있는 글꼴로 채운다. 글자 위치는 원래 문서 그대로다.
import wasmUrl from '@rhwp/core/rhwp_bg.wasm?url';
import { ConvertError } from './formats.js';

const asset = (path) => new URL(path, document.baseURI).href;

// 글꼴 이름 → [보통, 굵게] 파일 (public/fonts)
const FONT_FILES = {
  NanumGothic: ['NanumGothic-Regular.ttf', 'NanumGothic-Bold.ttf'],
  NanumMyeongjo: ['NanumMyeongjo-Regular.ttf', 'NanumMyeongjo-Bold.ttf'],
  LiberationSans: ['LiberationSans-Regular.ttf', 'LiberationSans-Bold.ttf'],
  LiberationSerif: ['LiberationSerif-Regular.ttf', 'LiberationSerif-Bold.ttf'],
  LiberationMono: ['LiberationMono-Regular.ttf'],
  HanjaSans: ['NotoSansKR-Hanja.ttf'],
  HanjaSerif: ['NotoSerifKR-Hanja.ttf'],
  Symbols: ['DejaVuSans-Symbols.ttf'],
};

// 문서 글꼴의 갈래별로 먼저 쓸 글꼴과, 글자가 없을 때 찾아볼 순서
const CHAINS = {
  koSans: ['NanumGothic', 'HanjaSans', 'Symbols', 'LiberationSans', 'NanumMyeongjo', 'HanjaSerif'],
  koSerif: ['NanumMyeongjo', 'HanjaSerif', 'Symbols', 'LiberationSerif', 'NanumGothic', 'HanjaSans'],
  latinSans: ['LiberationSans', 'NanumGothic', 'HanjaSans', 'Symbols', 'NanumMyeongjo'],
  latinSerif: ['LiberationSerif', 'NanumMyeongjo', 'HanjaSerif', 'Symbols', 'NanumGothic'],
  mono: ['LiberationMono', 'NanumGothic', 'HanjaSans', 'Symbols', 'LiberationSans'],
};

/** 문서에 적힌 글꼴 이름이 어떤 갈래(한글 고딕·명조, 영문 고딕·명조, 고정폭)인지 */
function classOf(family) {
  if (/courier|consol|mono|lucida console|menlo|monaco|d2coding|코딩/i.test(family)) return 'mono';
  if (/[가-힣]|batang|dotum|gulim|gungsuh|malgun|nanum|hcr|^hy|hancom|kopub|pretendard|apple ?sd|apple ?myungjo|noto (sans|serif) (kr|cjk)|source han|spoqa|baekmuk|^un ?(batang|dotum)/i.test(family)) {
    return /명조|바탕|궁서|부리|batang|myeong|myung|gungsuh|serif/i.test(family) ? 'koSerif' : 'koSans';
  }
  if (/times|georgia|garamond|cambria|antiqua|palatino|bookman|baskerville|bodoni|didot|minion|constantia|tinos|serif/i.test(family)) return 'latinSerif';
  if (/arial|helvetica|calibri|verdana|tahoma|segoe|trebuchet|gill sans|futura|franklin|lucida|century gothic|candara|corbel|arimo|roboto|open sans|sans/i.test(family)) return 'latinSans';
  return 'koSans';
}

const HANGUL = /[\u1100-\u11ff\u3130-\u318f\ua960-\ua97f\uac00-\ud7af\ud7b0-\ud7ff]/;

// Word 파일을 만들 때 쓸 글꼴 이름: 문서의 글꼴을 Word(윈도)에 늘 있는 글꼴 이름으로 바꾼다.
// (함초롬바탕·HY신명조처럼 한컴 오피스에만 있는 글꼴은 Word에서 엉뚱한 글꼴로 나오므로 바탕·맑은 고딕으로)
const OFFICE_NAMES = [
  [/맑은 ?고딕|malgun/i, 'MalgunGothic'],
  [/바탕체|batangche/i, 'BatangChe'], [/궁서체|gungsuhche/i, 'GungsuhChe'],
  [/돋움체|dotumche/i, 'DotumChe'], [/굴림체|gulimche/i, 'GulimChe'],
  [/^(바탕|batang)$/i, 'Batang'], [/^(궁서|gungsuh)$/i, 'Gungsuh'],
  [/^(돋움|dotum)$/i, 'Dotum'], [/^(새?굴림|(new )?gulim)$/i, 'Gulim'],
  [/times/i, 'TimesNewRoman'], [/arial narrow/i, 'ArialNarrow'], [/arial|helvetica/i, 'Arial'],
  [/calibri/i, 'Calibri'], [/cambria/i, 'Cambria'], [/courier/i, 'CourierNew'], [/consolas/i, 'Consolas'],
  [/verdana/i, 'Verdana'], [/tahoma/i, 'Tahoma'], [/georgia/i, 'Georgia'], [/segoe/i, 'SegoeUI'], [/garamond/i, 'Garamond'],
];
const CLASS_OFFICE = { koSans: 'MalgunGothic', koSerif: 'Batang', latinSans: 'Arial', latinSerif: 'TimesNewRoman', mono: 'CourierNew' };
const officeName = (family, cls) => OFFICE_NAMES.find(([re]) => re.test(family))?.[1] || CLASS_OFFICE[cls];
// 실제로 그리는 글꼴의 짧은 표시 (같은 Word 글꼴 이름이라도 그리는 글꼴 파일이 다르면 PDF 안 글꼴을 나눈다)
const CODES = { NanumGothic: 'G', NanumMyeongjo: 'M', LiberationSans: 'LS', LiberationSerif: 'LR', LiberationMono: 'LM', HanjaSans: 'HS', HanjaSerif: 'HR', Symbols: 'SY' };

// ---------------------------------------------------------------------------
// 글꼴 파일과 글자 목록
// ---------------------------------------------------------------------------

const fontBytes = new Map(); // 파일 → Promise<Uint8Array>
const coverage = new Map(); // 글꼴 이름 → (코드 포인트) => boolean

function loadFontFile(file) {
  if (!fontBytes.has(file)) {
    fontBytes.set(file, fetch(asset(`fonts/${file}`)).then(async (res) => {
      if (!res.ok) throw new Error(`Failed to fetch fonts/${file} (${res.status})`);
      return new Uint8Array(await res.arrayBuffer());
    }).catch((e) => { fontBytes.delete(file); throw e; }));
  }
  return fontBytes.get(file);
}

/** TrueType 글꼴의 글자 목록(cmap)을 읽어 '이 글자가 있는가'를 답하는 함수를 만든다. */
function glyphCoverage(bytes) {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let cmap = 0;
  for (let i = 0, n = v.getUint16(4); i < n; i++) {
    const rec = 12 + i * 16;
    if (v.getUint32(rec) === 0x636d6170) cmap = v.getUint32(rec + 8); // 'cmap'
  }
  const ranges = []; // [시작, 끝] (끝 포함)
  if (cmap) {
    let table = 0;
    for (let i = 0, n = v.getUint16(cmap + 2); i < n; i++) {
      const platform = v.getUint16(cmap + 4 + i * 8);
      const encoding = v.getUint16(cmap + 6 + i * 8);
      const off = cmap + v.getUint32(cmap + 8 + i * 8);
      const format = v.getUint16(off);
      if (platform === 3 && encoding === 10 && format === 12) { table = off; break; }
      if (((platform === 3 && encoding === 1) || platform === 0) && format === 4 && !table) table = off;
    }
    if (table && v.getUint16(table) === 12) {
      for (let g = 0, n = v.getUint32(table + 12); g < n; g++) ranges.push([v.getUint32(table + 16 + g * 12), v.getUint32(table + 20 + g * 12)]);
    } else if (table) {
      const segs = v.getUint16(table + 6) / 2;
      const ends = table + 14;
      const starts = ends + segs * 2 + 2;
      const deltas = starts + segs * 2;
      const offsets = deltas + segs * 2;
      for (let s = 0; s < segs; s++) {
        const start = v.getUint16(starts + s * 2);
        const end = v.getUint16(ends + s * 2);
        const delta = v.getUint16(deltas + s * 2);
        const ro = v.getUint16(offsets + s * 2);
        if (start === 0xffff) continue;
        for (let c = start; c <= end; c++) {
          const glyph = ro ? v.getUint16(offsets + s * 2 + ro + (c - start) * 2) : (c + delta) & 0xffff;
          if (!glyph) continue;
          const last = ranges[ranges.length - 1];
          if (last && last[1] === c - 1) last[1] = c; else ranges.push([c, c]);
        }
      }
    }
  }
  ranges.sort((a, b) => a[0] - b[0]);
  return (cp) => {
    let lo = 0;
    let hi = ranges.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (cp < ranges[mid][0]) hi = mid - 1;
      else if (cp > ranges[mid][1]) lo = mid + 1;
      else return true;
    }
    return false;
  };
}

async function coverageOf(name) {
  if (!coverage.has(name)) coverage.set(name, glyphCoverage(await loadFontFile(FONT_FILES[name][0])));
  return coverage.get(name);
}

const fontChoice = new Map(); // '갈래|글자' → 글꼴 이름

/** 글자 하나를 그릴 글꼴. 한글·영문은 바로 정하고, 그 밖의 글자는 글꼴의 글자 목록을 보고 고른다. */
async function fontFor(cls, ch) {
  const chain = CHAINS[cls];
  const cp = ch.codePointAt(0);
  if (cp < 0x80) return chain[0];
  if (HANGUL.test(ch)) return chain[0].startsWith('Liberation') ? chain[1] : chain[0];
  const k = `${cls}|${cp}`;
  if (!fontChoice.has(k)) {
    let pick = chain[0];
    for (const name of chain) {
      if ((await coverageOf(name))(cp)) { pick = name; break; }
    }
    fontChoice.set(k, pick);
  }
  return fontChoice.get(k);
}

// ---------------------------------------------------------------------------
// SVG 손질 (svg2pdf가 그대로는 잘못 그리는 것들)
// ---------------------------------------------------------------------------

/** 글자 요소의 기준점 (x·y 속성 또는 transform의 translate) */
function glyphOrigin(el) {
  const m = (el.getAttribute('transform') || '').match(/translate\(\s*([-\d.e]+)[\s,]+([-\d.e]+)\s*\)/);
  if (m) return [Number(m[1]), Number(m[2])];
  return [parseFloat(el.getAttribute('x')) || 0, parseFloat(el.getAttribute('y')) || 0];
}

/**
 * 띄어쓰기: rhwp의 SVG에는 빈칸 글자가 없다(위치만 띄운다). 쪽의 글 배치 정보에서 빈칸 자리를 찾아
 * 바로 앞 글자 뒤에 빈칸을 붙인다. 보이는 모양은 같고, PDF에서 글을 복사·검색할 때 띄어쓰기가 살아난다.
 */
function addSpaces(texts, layout) {
  const glyphs = texts.map((el) => { const [x, y] = glyphOrigin(el); return { el, x, y }; });
  glyphs.sort((a, b) => a.x - b.x);
  const near = (x) => { // x와 가장 가까운 글자들 (정렬된 목록에서 이진 탐색)
    let lo = 0;
    let hi = glyphs.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (glyphs[mid].x < x - 1) lo = mid + 1; else hi = mid; }
    const out = [];
    for (let i = lo; i < glyphs.length && glyphs[i].x <= x + 1; i++) out.push(glyphs[i]);
    return out;
  };
  for (const run of layout?.runs || []) {
    const chars = [...(run.text || '')];
    if (!Array.isArray(run.charX) || run.charX.length < chars.length) continue;
    for (let i = 1; i < chars.length; i++) {
      if (chars[i] !== ' ' || chars[i - 1] === ' ') continue;
      const x = run.x + run.charX[i - 1];
      const g = near(x).find((c) => Math.abs(c.x - x) < 0.8 && c.y >= run.y - 1 && c.y <= run.y + run.h * 1.6 + 1);
      if (!g || g.el.textContent.endsWith(' ')) continue;
      g.el.textContent += ' ';
      g.el.setAttribute('xml:space', 'preserve');
    }
  }
}

/** svg2pdf는 markerUnits="userSpaceOnUse"를 몰라 화살표 머리를 선 굵기만큼 크게 그린다. 굵기로 나눠 둔 복사본을 쓴다. */
function fixMarkers(svg) {
  const markers = new Map([...svg.querySelectorAll('marker[markerUnits="userSpaceOnUse"]')].map((m) => [m.id, m]));
  if (!markers.size) return;
  const copies = new Map();
  for (const el of svg.querySelectorAll('[marker-start],[marker-mid],[marker-end]')) {
    const width = parseFloat(el.getAttribute('stroke-width')) || 1;
    for (const attr of ['marker-start', 'marker-mid', 'marker-end']) {
      const id = (el.getAttribute(attr) || '').match(/url\(#([^)]+)\)/)?.[1];
      const marker = id && markers.get(id);
      if (!marker) continue;
      const key = `${id}--w${width}`;
      if (!copies.has(key)) {
        const copy = marker.cloneNode(true);
        copy.id = key;
        copy.removeAttribute('markerUnits');
        for (const a of ['markerWidth', 'markerHeight']) copy.setAttribute(a, String((parseFloat(marker.getAttribute(a)) || 3) / width));
        marker.parentNode.append(copy);
        copies.set(key, copy);
      }
      el.setAttribute(attr, `url(#${key})`);
    }
  }
}

/** 기울임꼴: 기울인 글꼴 파일이 없어 글자를 기울여 그린다. */
function slant(el) {
  if (/rotate|matrix|skew/.test(el.getAttribute('transform') || '')) return;
  const [x, y] = glyphOrigin(el);
  const rest = (el.getAttribute('transform') || '').replace(/translate\([^)]*\)/, '').trim();
  el.setAttribute('transform', `translate(${x},${y}) ${rest} skewX(-12)`.replace(/\s+/g, ' '));
  el.setAttribute('x', '0');
  el.setAttribute('y', '0');
  el.removeAttribute('font-style');
}

/**
 * 한 쪽 SVG를 PDF에 옮기기 좋게 고친다. 쓰는 글꼴을 [{id, file}]로 돌려준다.
 * PDF 안 글꼴 이름(id)은 굵은 글꼴이면 '-Bold'가 붙는다. forWord면 Word 글꼴 이름(Batang-M 등)을 쓴다.
 */
async function prepareSvg(svg, layout, forWord) {
  fixMarkers(svg);
  const texts = [...svg.querySelectorAll('text')];
  addSpaces(texts, layout);
  const used = new Map();
  for (const el of texts) {
    // 글자 수를 원래 폭에 맞추는 속성은 글자 하나짜리에서 svg2pdf가 계산을 그르친다(무한대 자간). 위치는 이미 정해져 있다.
    el.removeAttribute('textLength');
    el.removeAttribute('lengthAdjust');
    const family = (el.getAttribute('font-family') || el.closest('[font-family]')?.getAttribute('font-family') || '')
      .split(',')[0].replace(/['"]/g, '').trim();
    const cls = classOf(family);
    const ch = [...el.textContent].find((c) => c.trim()) || ' ';
    const name = await fontFor(cls, ch);
    let bold = /bold|[6-9]00/.test(el.getAttribute('font-weight') || '');
    // rhwp는 굵은 글꼴이 없는 글꼴의 '진하게'를 글자 테두리로 그린다. 굵은 글꼴 파일이 있으면 진짜 굵은 글자로 바꾼다
    // (그래야 Word로 바꿀 때 굵게로 남는다). 테두리 색이 글자 색과 같고 아주 가는 것만 (외곽선 글자는 그대로).
    const size = parseFloat(el.getAttribute('font-size')) || 10;
    const stroke = el.getAttribute('stroke');
    if (stroke && stroke !== 'none' && stroke === el.getAttribute('fill') && (parseFloat(el.getAttribute('stroke-width')) || 0) <= size * 0.08
      && FONT_FILES[name].length > 1) {
      bold = true;
      el.removeAttribute('stroke');
      el.removeAttribute('stroke-width');
    }
    bold &&= FONT_FILES[name].length > 1;
    const base = forWord ? `${officeName(family, cls)}-${CODES[name]}` : name;
    const id = bold ? `${base}-Bold` : base;
    el.setAttribute('font-family', id);
    el.setAttribute('font-weight', 'normal');
    if (/italic|oblique/.test(el.getAttribute('font-style') || '')) slant(el);
    used.set(id, { id, file: FONT_FILES[name][bold ? 1 : 0] });
  }
  // 글자 요소가 아닌 곳(묶음 등)에 남은 글꼴 지정은 쓰이지 않게 한다
  for (const el of svg.querySelectorAll('[font-family]:not(text)')) el.removeAttribute('font-family');
  return [...used.values()];
}

// ---------------------------------------------------------------------------
// 변환
// ---------------------------------------------------------------------------

let rhwpPromise = null;

function loadRhwp() {
  if (!rhwpPromise) {
    rhwpPromise = (async () => {
      const rhwp = await import('@rhwp/core');
      await rhwp.default({ module_or_path: wasmUrl });
      return rhwp;
    })().catch((e) => { rhwpPromise = null; throw e; });
  }
  return rhwpPromise;
}

function base64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
const fontBase64 = new Map(); // 파일 → base64 (jsPDF가 글꼴을 이 형태로 받는다)

async function openHwp(rhwp, file) {
  let doc;
  try {
    doc = new rhwp.HwpDocument(new Uint8Array(await file.arrayBuffer()));
  } catch (e) {
    console.error(e);
    const msg = String(e?.message || e);
    if (/암호|password|encrypt/i.test(msg)) throw new ConvertError('암호가 걸린 한글 문서는 변환할 수 없습니다.');
    throw new ConvertError('한글 문서를 열 수 없습니다. 파일이 손상되었거나 확장자가 실제 형식과 다릅니다.');
  }
  let info = {};
  try { info = JSON.parse(doc.getDocumentInfo()); } catch { /* 정보가 없어도 그린다 */ }
  if (info.encrypted) {
    try { doc.free(); } catch { /* 무시 */ }
    throw new ConvertError('암호가 걸린 한글 문서는 변환할 수 없습니다.');
  }
  return doc;
}

const ENTITY = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'", nbsp: ' ' };

/** 한글 문서의 글을 문서 순서대로 (표 안의 글 포함, 2단도 섞이지 않게) */
export async function hwpToText(file) {
  const doc = await openHwp(await loadRhwp(), file);
  try {
    let text = doc.getTextFileText();
    if (text.startsWith('"')) { try { text = JSON.parse(text); } catch { /* 그대로 */ } }
    return text
      .replace(/&#(\d+);|&#x([0-9a-f]+);|&(lt|gt|amp|quot|apos|nbsp);/gi, (m, dec, hex, name) => (
        dec ? String.fromCodePoint(Number(dec)) : hex ? String.fromCodePoint(parseInt(hex, 16)) : ENTITY[name.toLowerCase()]))
      .replace(/\p{Zs}/gu, ' ') // 숫자 폭 빈칸 등 여러 가지 빈칸 글자를 보통 빈칸으로
      .replace(/\r\n?/g, '\n')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  } finally {
    try { doc.free(); } catch { /* 무시 */ }
  }
}

/**
 * @param {File} file
 * @param {{forWord?: boolean}} options forWord: Word로 바꾸기 위한 PDF (글꼴 이름을 Word 글꼴 이름으로)
 * @returns {Promise<Blob>} PDF
 */
export async function hwpToPdf(file, { status, progress }, { forWord = false } = {}) {
  status('준비 중…');
  const [rhwp, { jsPDF }, { svg2pdf }] = await Promise.all([loadRhwp(), import('jspdf'), import('svg2pdf.js')]);
  const doc = await openHwp(rhwp, file);
  const holder = document.createElement('div'); // svg2pdf가 계산된 모양을 읽을 수 있게 화면 밖에 잠시 붙인다
  holder.style.cssText = 'position:fixed;left:-100000px;top:0;width:10px;height:10px;overflow:hidden;visibility:hidden';
  document.body.append(holder);
  try {
    const pages = doc.pageCount();
    if (!pages) throw new ConvertError('한글 문서에 쪽이 없습니다.');
    status('변환 중…');
    let pdf = null;
    const registered = new Set();
    for (let i = 0; i < pages; i++) {
      let svgText;
      let layout = null;
      try {
        svgText = doc.renderPageSvg(i);
        layout = JSON.parse(doc.getPageTextLayout(i));
      } catch (e) {
        console.error(e);
        if (!svgText) throw new ConvertError(`${i + 1}쪽을 그리지 못했습니다. 한글 문서가 손상되었거나 지원하지 않는 기능이 있습니다.`);
      }
      const svg = new DOMParser().parseFromString(svgText, 'image/svg+xml').documentElement;
      if (svg.nodeName !== 'svg') throw new ConvertError(`${i + 1}쪽을 그리지 못했습니다.`);
      const fonts = await prepareSvg(svg, layout, forWord);
      const w = parseFloat(svg.getAttribute('width')) * 0.75; // px → pt
      const h = parseFloat(svg.getAttribute('height')) * 0.75;
      const orientation = w > h ? 'landscape' : 'portrait';
      if (!pdf) {
        pdf = new jsPDF({ unit: 'pt', format: [w, h], orientation, compress: true, putOnlyUsedFonts: true });
        pdf.setProperties({ title: file.name.replace(/\.[^.]+$/, ''), creator: '파일 변환기' });
      } else {
        pdf.addPage([w, h], orientation);
      }
      for (const { id, file: fileName } of fonts) {
        if (registered.has(id)) continue;
        if (!fontBase64.has(fileName)) fontBase64.set(fileName, base64(await loadFontFile(fileName)));
        pdf.addFileToVFS(fileName, fontBase64.get(fileName));
        pdf.addFont(fileName, id, 'normal', undefined, 'Identity-H');
        registered.add(id);
      }
      holder.append(svg);
      try {
        await svg2pdf(svg, pdf, { x: 0, y: 0, width: w, height: h });
      } finally {
        svg.remove();
      }
      progress((i + 1) / pages);
      await new Promise((r) => setTimeout(r, 0)); // 화면이 멈추지 않게 쪽마다 숨을 돌린다
    }
    return pdf.output('blob');
  } finally {
    holder.remove();
    try { doc.free(); } catch { /* 무시 */ }
  }
}
