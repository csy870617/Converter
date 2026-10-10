// 내 컴퓨터에 설치된 글꼴로 문서를 변환한다 (크롬·엣지의 Local Font Access API, 사용자가 허락했을 때만).
// 문서가 쓰는 글꼴(맑은 고딕·바탕 등)이 이 사이트에 없으면 비슷한 글꼴로 바꿔 그려 줄·쪽이 달라진다.
// 컴퓨터의 진짜 글꼴을 쓰면 Word에서 연 것과 거의 같게 나온다. 글꼴 파일은 이 컴퓨터 밖으로 나가지 않는다.

// 문서에 한글 이름으로 적히는 글꼴 ↔ 글꼴 목록의 영문 이름
const KO_EN = {
  '맑은 고딕': 'Malgun Gothic', '바탕': 'Batang', '바탕체': 'BatangChe', '굴림': 'Gulim', '굴림체': 'GulimChe',
  '돋움': 'Dotum', '돋움체': 'DotumChe', '궁서': 'Gungsuh', '궁서체': 'GungsuhChe', '새굴림': 'New Gulim',
  '함초롬바탕': 'HCR Batang', '함초롬돋움': 'HCR Dotum', '나눔고딕': 'NanumGothic', '나눔명조': 'NanumMyeongjo',
  '나눔바른고딕': 'NanumBarunGothic', '나눔스퀘어': 'NanumSquare', '한컴 고딕': 'Hancom Gothic',
};

// 이미 같은 크기의 대체 글꼴이 들어 있어 따로 받을 필요가 없는 글꼴
const COVERED = new Set(['calibri', 'cambria', 'arial', 'arialnarrow', 'timesnewroman', 'couriernew', 'nanumgothic', 'nanummyeongjo',
  'liberationsans', 'liberationserif', 'liberationmono', 'carlito', 'caladea', 'dejavusans', 'dejavuserif', 'notosans', 'notoserif',
  'symbol', 'opensymbol']);

const key = (name) => name.toLowerCase().replace(/[\s_-]/g, '');

export const localFontsSupported = () => typeof window.queryLocalFonts === 'function';

let fontList = null; // Promise<FontData[]>

/** 글꼴 목록을 요청한다. 허락 창이 뜰 수 있어 반드시 '변환하기'를 누른 직후에 불러야 한다. */
export function requestLocalFonts() {
  if (!localFontsSupported()) return Promise.resolve([]);
  if (!fontList) {
    fontList = window.queryLocalFonts().catch((e) => {
      console.info('내 컴퓨터 글꼴을 쓰지 않습니다', e?.name || e);
      return [];
    });
  }
  return fontList;
}

/** 문서에 적힌 글꼴 이름 후보를 모은다. (zip 형식은 XML의 글꼴 속성만, 옛 형식은 문서 속 글자 조각) */
async function documentFontNames(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const names = new Set();
  if (bytes[0] === 0x50 && bytes[1] === 0x4b) { // docx·xlsx·pptx·odt 등
    const { unzipSync, strFromU8 } = await import('fflate');
    const parts = unzipSync(bytes, { filter: (f) => /\.xml$/i.test(f.name) && f.originalSize < 50_000_000 });
    const attr = /(?:w:(?:ascii|hAnsi|eastAsia|cs)|w:name|typeface|svg:font-family|style:font-name(?:-asian|-complex)?|fo:font-family|style:font-family-(?:asian|complex)|latin|ea)="([^"]{2,60})"|<(?:x:)?name val="([^"]{2,60})"/g;
    for (const part of Object.values(parts)) {
      for (const m of strFromU8(part).matchAll(attr)) names.add((m[1] || m[2]).replace(/^'|'$/g, ''));
    }
    return { exact: names, runs: [] };
  }
  // doc·xls·ppt·rtf 등: 글꼴 표는 UTF-16(한글 포함) 또는 ASCII 글자로 들어 있다
  let latin1 = '';
  for (let i = 0; i < bytes.length; i += 0x8000) latin1 += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  const runs = [];
  for (const m of latin1.matchAll(/(?:[\x20-\x7e]\x00|[\x00-\xff][\xac-\xd7]){3,60}/g)) {
    let t = '';
    for (let i = 0; i + 1 < m[0].length; i += 2) t += String.fromCharCode(m[0].charCodeAt(i) | (m[0].charCodeAt(i + 1) << 8));
    runs.push(t);
  }
  for (const m of latin1.matchAll(/[\x20-\x7e]{3,60}/g)) runs.push(m[0]);
  return { exact: names, runs };
}

/**
 * 문서들이 쓰는 글꼴 가운데 이 컴퓨터에 있는 것을 골라 [{filename, data, id}]로 돌려준다.
 * 허락하지 않았거나 지원하지 않는 브라우저면 빈 목록.
 */
export async function localFontsFor(files, status = () => {}) {
  if (!fontList) return [];
  // 허락 창에 답을 기다린다는 것을 알리고, 30초 동안 답이 없으면 그냥 이 사이트의 글꼴로 변환한다
  let timer;
  const hint = setTimeout(() => status('글꼴 사용 허락을 기다리는 중… (주소창 아래 창에서 허용을 눌러 주세요)'), 1000);
  const list = await Promise.race([fontList, new Promise((r) => { timer = setTimeout(() => r([]), 30_000); })]);
  clearTimeout(hint);
  clearTimeout(timer);
  if (!list.length) return [];
  const families = new Map(); // key → FontData[]
  for (const f of list) {
    const k = key(f.family);
    if (!COVERED.has(k)) (families.get(k) || families.set(k, []).get(k)).push(f);
  }
  const wanted = new Set();
  for (const file of files) {
    const { exact, runs } = await documentFontNames(file);
    const exactKeys = new Set([...exact].map((n) => key(KO_EN[n] || n)));
    for (const [k, faces] of families) {
      if (exactKeys.has(k)) { wanted.add(k); continue; }
      if (!runs.length) continue;
      const names = [faces[0].family, ...Object.entries(KO_EN).filter(([, en]) => key(en) === k).map(([ko]) => ko)]
        .filter((n) => n.length >= 3);
      if (names.some((n) => runs.some((r) => r.includes(n)))) wanted.add(k);
    }
  }
  const out = [];
  const seen = []; // 한 파일(.ttc)에 여러 글꼴이 든 경우 한 번만 넣는다
  for (const k of wanted) {
    for (const face of families.get(k)) {
      const data = new Uint8Array(await (await face.blob()).arrayBuffer());
      const same = seen.some((d) => d.length === data.length && d[100] === data[100] && d[data.length >> 1] === data[data.length >> 1]);
      if (same) continue;
      seen.push(data);
      out.push({ filename: `local-${out.length}-${face.postscriptName.replace(/[^\w-]/g, '')}.ttf`, data, id: `${face.postscriptName}|${data.length}` });
    }
  }
  return out;
}
