// 실제 브라우저로 모든 변환을 끝까지 해 보는 테스트.
// GitHub Pages와 같은 조건(하위 경로 /Converter/, 보안 헤더 없음)으로 dist/를 띄운다.
//   npm run build && npm test
//   (크롬 경로 지정: CHROME_PATH=/path/to/chrome npm test)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { unzipSync, strFromU8 } from 'fflate';
import { PDFDocument } from 'pdf-lib';

const root = path.resolve(import.meta.dirname, '..', 'dist');
const fixtures = path.resolve(import.meta.dirname, 'fixtures');
const PREFIX = '/Converter/';
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.wasm': 'application/wasm', '.png': 'image/png', '.json': 'application/json', '.gz': 'application/gzip' };

let block = null; // 이름이 맞는 파일은 받지 못하게 한다 (인터넷이 끊긴 상황 시험)
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (!p.startsWith(PREFIX)) { res.writeHead(404).end(); return; }
  p = p.slice(PREFIX.length) || 'index.html';
  if (block?.test(p)) { res.writeHead(503).end(); return; }
  const file = path.join(root, p);
  if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404).end(); return; }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}${PREFIX}`;

const MAGIC = {
  mp3: (b) => b.subarray(0, 3).toString() === 'ID3' || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0),
  wav: (b) => b.subarray(0, 4).toString() === 'RIFF',
  m4a: (b) => b.subarray(4, 8).toString() === 'ftyp',
  mp4: (b) => b.subarray(4, 8).toString() === 'ftyp',
  flac: (b) => b.subarray(0, 4).toString() === 'fLaC',
  ogg: (b) => b.subarray(0, 4).toString() === 'OggS',
  gif: (b) => b.subarray(0, 4).toString() === 'GIF8',
  jpg: (b) => b[0] === 0xff && b[1] === 0xd8,
  png: (b) => b.subarray(1, 4).toString() === 'PNG',
  webp: (b) => b.subarray(8, 12).toString() === 'WEBP',
  ico: (b) => b.readUInt32LE(0) === 0x10000,
  pdf: (b) => b.subarray(0, 4).toString() === '%PDF',
  docx: (b) => b.subarray(0, 2).toString() === 'PK',
  odt: (b) => b.subarray(0, 2).toString() === 'PK',
  ods: (b) => b.subarray(0, 2).toString() === 'PK',
  odp: (b) => b.subarray(0, 2).toString() === 'PK',
  doc: (b) => b.readUInt32BE(0) === 0xd0cf11e0,
  xls: (b) => b.readUInt32BE(0) === 0xd0cf11e0,
  ppt: (b) => b.readUInt32BE(0) === 0xd0cf11e0,
  rtf: (b) => b.subarray(0, 5).toString() === '{\\rtf',
  bmp: (b) => b.subarray(0, 2).toString() === 'BM',
  aac: (b) => b[0] === 0xff && (b[1] & 0xf6) === 0xf0,
  opus: (b) => b.subarray(0, 4).toString() === 'OggS' && b.includes('OpusHead'),
  m4r: (b) => b.subarray(4, 8).toString() === 'ftyp',
  mov: (b) => b.subarray(4, 8).toString() === 'ftyp' && b.subarray(8, 10).toString() === 'qt',
  avi: (b) => b.subarray(0, 4).toString() === 'RIFF' && b.subarray(8, 12).toString() === 'AVI ',
  webm: (b) => b.readUInt32BE(0) === 0x1a45dfa3,
  tiff: (b) => b.subarray(0, 4).toString('hex') === '4d4d002a' || b.subarray(0, 4).toString('hex') === '49492a00',
  pptx: (b) => b.subarray(0, 2).toString() === 'PK',
  xlsx: (b) => b.subarray(0, 2).toString() === 'PK',
  zip: (b) => b.subarray(0, 2).toString() === 'PK',
  txt: (b) => /한글/.test(b.toString('utf8')),
  csv: (b) => /철수/.test(b.toString('utf8')),
};

// Word 파일 안의 글·표·머리글을 꺼내 내용까지 확인한다
function wordParts(buf) {
  const files = unzipSync(new Uint8Array(buf));
  const text = (xml) => xml.split(/<\/w:p>/).map((p) => [...p.matchAll(/<w:t(?: [^>]*)?>([^<]*)<\/w:t>/g)].map((m) => m[1]).join(''));
  const doc = strFromU8(files['word/document.xml']);
  const hf = Object.keys(files).filter((k) => /word\/(header|footer)\d*\.xml/.test(k)).map((k) => strFromU8(files[k]));
  return { paragraphs: text(doc), tables: (doc.match(/<w:tbl>/g) || []).length, headers: hf.join('\n'), bold: /<w:b\/>/.test(doc), xml: doc };
}
const WORD_CHECKS = {
  '보고서.docx': (w) => {
    if (!w.paragraphs.includes('2. 주요 성과')) return '제목의 띄어쓰기가 사라짐 (2. 주요 성과)';
    if (w.tables < 2) return `표가 ${w.tables}개 (기대: 2개 이상)`;
    if (!/주식회사 한빛/.test(w.headers) || !/ PAGE /.test(w.headers)) return '머리글·쪽 번호 바닥글이 없음';
    return null;
  },
  '띄어쓰기없음.docx': (w) => (w.paragraphs.includes('제 1 조 (목적) 이 규정은 회사의 문서 관리에 필요한 사항을 정한다.')
    ? null : `한글 띄어쓰기 추정 실패: ${w.paragraphs.filter(Boolean)[0]}`),
  // 한컴 오피스식 촘촘한 표: 열 너비·좁힌 자간이 살아 있어야 Word에서 칸 안의 글이 넘치지 않는다
  '촘촘한표.docx': (w) => {
    const tables = w.xml.split('<w:tbl>').slice(1);
    if (tables.length !== 2) return `표가 ${tables.length}개 (기대: 2개, 칸 안에 표가 생기면 안 됨)`;
    const [first, second] = tables;
    const rows = (first.match(/<w:tr[ >]/g) || []).length;
    const cols = [...first.matchAll(/<w:gridCol w:w="(\d+)"/g)].map((m) => Number(m[1]));
    if (rows !== 9 || cols.length !== 7) return `표가 ${rows}행 ${cols.length}열 (기대: 9행 7열)`;
    if (!(cols[0] > 1.5 * Math.max(...cols.slice(1, 6)))) return `열 너비가 원본과 다름: ${cols.join(',')}`;
    if (!/<w:spacing w:val="-/.test(first)) return '좁힌 자간이 빠짐';
    if (!w.paragraphs.includes('도·소매업') || !w.paragraphs.includes('전문·과학·기술 서비스업')) return '가운뎃점 낱말에 띄어쓰기가 끼어듦';
    if (!w.paragraphs.includes('(단위: 억 달러, %)')) return '띄어쓰기 추정이 다름';
    // 오른쪽에 맞춘 두 줄 숫자 칸: 줄을 끊고 오른쪽 맞춤 (들여쓰기로 흉내 내면 Word에서 숫자가 쪼개진다)
    const cell = second.split('</w:tc>').find((c) => c.includes('>182.6<')) || '';
    if (!/<w:jc w:val="(right|end)"\/>/.test(cell) || !cell.includes('<w:br/>') || /w:firstLine="[1-9]/.test(cell)) {
      return '두 줄 숫자 칸이 오른쪽 맞춤 + 줄 끊기가 아님';
    }
    if (/w:ascii=""/.test(w.xml)) return '이름이 빈 글꼴이 있음 (이름표 없는 글꼴)';
    if (/ w:[A-Za-z]+="-?\d+\.\d+"/.test(w.xml)) return 'Word 규격에 맞지 않는 소수 값이 있음';
    return null;
  },
  '두쪽.docx': (w) => (w.paragraphs.some((p) => p.includes('첫째 쪽입니다. 한글 본문이 들어 있습니다.')) ? null : '본문 글이 다름'),
  '2단논문.docx': (w) => (w.paragraphs.some((p) => p.includes('Converting documents between formats is a common task.')) ? null : '본문 글이 다름'),
  '한글문서.docx': (w) => {
    if (!w.paragraphs.includes('제 1 조 (목적) 이 규정은 회사의 문서 관리에 필요한 사항을 정한다.')) return `본문 글이 다름: ${w.paragraphs.filter(Boolean)[1]}`;
    if (w.tables < 1) return '표가 없음';
    if (!w.bold) return '굵은 글씨가 사라짐';
    return null;
  },
};
// 한글 → PDF: 글자가 글자로 들어가고(굵은 글꼴·한자 글꼴), 띄어쓰기가 살아 있어야 한다
const PDF_CHECKS = {
  '한자문서.pdf': (b) => (b.includes('NotoSerifKRHanja') && b.includes('NotoSansKRHanja') ? null : '한자 글꼴로 그리지 않음 (한자가 빠짐)'),
  '로고.pdf': (b) => (/\/Subtype\s*\/Image/.test(b) ? 'SVG가 그림으로 들어감 (선으로 그려야 함)' : null),
  '한글문서.pdf': (b) => (['NanumMyeongjo-Bold', 'HanjaSerif', 'Symbols'].every((f) => b.includes(f)) ? null : '굵은 글꼴·한자·기호 글꼴이 없음'),
};
const XLSX_CHECKS = {
  '보고서.xlsx': (files) => {
    const sheet = strFromU8(files['xl/worksheets/sheet1.xml'] || new Uint8Array());
    if (!sheet.includes('온라인')) return '표의 글이 없음';
    if (!/<v>1240<\/v>/.test(sheet)) return '숫자가 숫자로 들어가지 않음 (1,240)';
    return null;
  },
};
const TXT_CHECKS = {
  '암호.txt': (t) => (t.includes('12,345') ? null : `글이 다름: ${t.slice(0, 60)}`),
  '한글문서.txt': (t) => (t.includes('大韓民國 憲法 제1조 대한민국은 민주공화국이다.') && t.includes('매출') ? null : `글이 다름: ${t.slice(0, 80)}`),
};

// 이미지 가로 크기 (AI 화질 개선 결과가 실제로 커졌는지 확인)
function imageWidth(b) {
  if (MAGIC.png(b)) return b.readUInt32BE(16);
  for (let i = 2; i < b.length - 9;) { // JPEG: SOF 표식을 찾는다
    const marker = b[i + 1];
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return b.readUInt16BE(i + 7);
    i += 2 + b.readUInt16BE(i + 2);
  }
  return 0;
}

const LABEL = { up2: '고화질 2배', up4: '고화질 4배', compress: '용량 줄이기', split: '쪽 나누기', merge: '하나로 합치기',
  rotr: '오른쪽으로 돌리기', rotl: '왼쪽으로 돌리기', unlock: '암호 풀기', protect: '암호 걸기' };
const STRENGTH = { original: '원본', natural: '자연스럽게', strong: '강하게' };
const UPSCALE = ['up2', 'up4'];
const pdfPages = async (b) => (await PDFDocument.load(b)).getPageCount();
const NEW_PASSWORD = '5678'; // '암호 걸기' 시험에서 거는 암호

/** 암호를 건 PDF: 암호 없이는 열리지 않고, 건 암호로는 열려야 한다 */
async function checkProtected(buf) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const open = (password) => pdfjs.getDocument({ data: new Uint8Array(buf), password, verbosity: 0 }).promise;
  try {
    await open(undefined);
    return '암호 없이도 열림';
  } catch (e) {
    if (e?.name !== 'PasswordException') return `암호 없이 열 때 예상 밖의 오류: ${e?.message}`;
  }
  const doc = await open(NEW_PASSWORD);
  if (!doc.numPages) return '건 암호로 열었는데 쪽이 없음';
  return null;
}

// 용량 줄이기: 이 결과들은 원본보다 작아야 한다 (나머지는 원본이 이미 작아 원본을 그대로 줄 수도 있다)
const SMALLER = ['pic_압축.png', '노래_압축.mp3', 'old_압축.mp4', '무음영상_압축.mp4'];

// [입력 파일들, 변환 형식, 예상 결과 파일 이름, 예상 가로 크기, 동영상 코덱 강제, AI 세기(기본 'natural')]
const CASES = [
  [['영상.mp4'], 'mp3', '영상.mp3'],
  [['영상.mp4'], 'wav', '영상.wav'],
  [['영상.mp4'], 'm4a', '영상.m4a'],
  [['영상.mp4'], 'gif', '영상.gif'],
  [['clip.mov'], 'mp4', 'clip.mp4'],
  [['old.avi'], 'mp4', 'old.mp4'],
  [['노래.wav'], 'mp3', '노래.mp3'],
  [['노래.wav'], 'flac', '노래.flac'],
  [['노래.wav'], 'ogg', '노래.ogg'],
  [['노래.wav'], 'aac', '노래.aac'],
  [['노래.wav'], 'opus', '노래.opus'],
  [['노래.wav'], 'm4r', '노래.m4r'], // 아이폰 벨소리
  [['영상.mp4'], 'mov', '영상.mov'],
  [['영상.mp4'], 'avi', '영상.avi'],
  [['영상.mp4'], 'webm', '영상.webm'],
  [['anim.gif'], 'mp4', 'anim.mp4'], // 움직이는 GIF → 동영상
  [['사진.jpg'], 'png', '사진.png'],
  [['투명.png'], 'jpg', '투명.jpg'],
  [['아이폰.heic'], 'jpg', '아이폰.jpg'],
  [['scan.tiff'], 'png', 'scan.png'],
  [['pic.webp'], 'jpg', 'pic.jpg'],
  [['pic.bmp'], 'webp', 'pic.webp'],
  [['anim.gif'], 'png', 'anim.png'],
  [['사진.jpg'], 'ico', '사진.ico'],
  [['사진.jpg'], 'gif', '사진.gif'],
  [['투명.png'], 'gif', '투명.gif'], // 투명한 곳 유지
  [['사진.jpg'], 'bmp', '사진.bmp'],
  [['사진.jpg'], 'tiff', '사진.tiff'],
  [['로고.svg'], 'png', '로고.png', 1024], // 작은 SVG도 크게
  [['로고.svg'], 'pdf', '로고.pdf'], // 확대해도 깨지지 않는 PDF
  [['사진.jpg'], 'pdf', '사진.pdf'],
  [['사진.jpg', '투명.png', '아이폰.heic'], 'pdf', '사진.pdf'], // 합치기
  [['사진.jpg', '투명.png'], 'webp', '변환결과.zip'],
  [['문서.pdf'], 'png', '문서.png'],
  [['문서.pdf'], 'txt', '문서.txt'],
  [['회의록.docx'], 'pdf', '회의록.pdf'],
  [['옛날문서.doc'], 'docx', '옛날문서.docx'],
  [['메모.txt'], 'pdf', '메모.pdf'],
  [['발표.pptx'], 'pdf', '발표.pdf'],
  [['발표.ppt'], 'pptx', '발표.pptx'],
  [['성적.xlsx'], 'pdf', '성적.pdf'],
  [['성적.xls'], 'xlsx', '성적.xlsx'],
  [['성적.xlsx'], 'csv', '성적.csv'],
  [['명단.csv'], 'xlsx', '명단.xlsx'],
  [['거래내역.xls'], 'xlsx', '거래내역.xlsx'], // 은행에서 받은 HTML 형식 xls
  [['문서.pdf'], 'docx', '문서.docx'],
  [['깨진파일.docx'], 'pdf', null], // 오류 안내가 떠야 한다
  [['회의록.docx'], 'pdf', '회의록.pdf'], // 오류 뒤에도 다시 잘 되어야 한다
  [['깨진영상.mp4'], 'mp3', null],
  [['영상.mp4'], 'mp3', '영상.mp3'],
  [['두쪽.pdf'], 'docx', '두쪽.docx'],
  [['두쪽.pdf'], 'jpg', '변환결과.zip'],
  [['스캔.pdf'], 'docx', '스캔.docx'],
  [['보고서.pdf'], 'docx', '보고서.docx'], // 표·머리글·바닥글(쪽 번호)·한글 띄어쓰기
  [['띄어쓰기없음.pdf'], 'docx', '띄어쓰기없음.docx'], // 띄어쓰기 글자 없이 위치로만 띄운 한글 PDF
  [['2단논문.pdf'], 'docx', '2단논문.docx'],
  [['촘촘한표.pdf'], 'docx', '촘촘한표.docx'], // 한컴 오피스식 촘촘한 표 (좁힌 자간, 가운뎃점, 두 줄 숫자 칸, 이름표 없는 글꼴)
  [['내글꼴.docx'], 'pdf', '내글꼴.pdf'], // 내 컴퓨터 글꼴(허락한 경우)로 그리기
  [['한자문서.docx'], 'pdf', '한자문서.pdf'], // 나눔 글꼴에 없는 한자
  [['한글문서.hwp'], 'pdf', '한글문서.pdf'], // 한글: 굵은 글씨·한자·기호·표
  [['한글문서.hwpx'], 'docx', '한글문서.docx'],
  [['한글문서.hwp'], 'txt', '한글문서.txt'],
  [['한글문서.hwpx'], 'png', '한글문서.png'],
  [['회의록.docx'], 'doc', '회의록.doc'], // 문서 형식 더 보기
  [['회의록.docx'], 'odt', '회의록.odt'],
  [['회의록.docx'], 'rtf', '회의록.rtf'],
  [['회의록.docx'], 'txt', '회의록.txt'],
  [['회의록.docx'], 'jpg', '회의록.jpg'], // 쪽을 그림으로
  [['발표.pptx'], 'png', '발표.png'],
  [['발표.pptx'], 'odp', '발표.odp'],
  [['성적.xlsx'], 'xls', '성적.xls'],
  [['성적.xlsx'], 'ods', '성적.ods'],
  [['보고서.pdf'], 'xlsx', '보고서.xlsx'], // PDF 표 → 엑셀
  [['보고서.pdf'], 'compress', '보고서_압축.pdf'], // PDF 도구
  [['두쪽.pdf'], 'rotr', '두쪽_회전.pdf'],
  [['두쪽.pdf'], 'split', '변환결과.zip'],
  [['보고서.pdf'], 'protect', '보고서_암호.pdf'],
  [['보고서.pdf'], 'unlock', null], // 암호가 없는 PDF는 그렇다고 알려야 한다
  [['두쪽.pdf', '보고서.pdf'], 'merge', '두쪽_합침.pdf'],
  [['암호.pdf'], 'txt', '암호.txt'], // 암호를 물어 변환 (처음엔 틀린 암호를 넣어 다시 묻는지도 본다)
  [['암호.pdf'], 'xlsx', '암호.xlsx'],
  [['암호.pdf', '보고서.pdf'], 'merge', '암호_합침.pdf'],
  [['암호.pdf'], 'unlock', '암호_암호해제.pdf'],
  [['암호.pdf'], 'protect', '암호_암호.pdf'], // 원래 암호를 풀고 새 암호를 건다
  [['암호.docx'], 'pdf', '암호.pdf'],
  [['암호.hwp'], 'pdf', '암호.pdf'],
  [['사진.jpg'], 'up2', '사진_고화질2배.jpg', 1600],
  [['투명.png'], 'up4', '투명_고화질4배.png'],
  [['작은영상.mp4'], 'up4', '작은영상_고화질4배.mp4'], // 하드웨어 인코더가 없을 때 (ffmpeg 인코딩)
  [['작은영상.mp4'], 'up2', '작은영상_고화질2배.mp4', null, 'vp9'], // ffmpeg로 풀고 브라우저 인코더로 묶기. 크로미움엔 H.264가 없어 VP9로 확인
  [['작은영상.webm'], 'up2', '작은영상_고화질2배.mp4', null, 'vp9'], // 브라우저만으로 풀고 묶기 (ffmpeg 없이)
  [['사진.jpg'], 'up2', '사진_고화질2배_강하게.jpg', 1600, null, 'strong'],
  [['작은영상.webm'], 'up4', '작은영상_고화질4배_강하게.mp4', null, 'vp9', 'strong'],
  [['사진.jpg'], 'up2', '사진_고화질2배_원본충실.jpg', 1600, null, 'original'],
  [['pic.bmp'], 'compress', 'pic_압축.png'], // 색이 적은 그림 → 256색 PNG
  [['사진.jpg'], 'compress', '사진_압축.jpg'],
  [['투명.png'], 'compress', '투명_압축.png'], // 투명한 곳 유지
  [['노래.wav'], 'compress', '노래_압축.mp3'],
  [['old.avi'], 'compress', 'old_압축.mp4'], // ffmpeg로
  [['무음영상.webm'], 'compress', '무음영상_압축.mp4', null, 'vp9'], // 브라우저만으로 (크로미움엔 H.264가 없어 VP9로 확인)
  [['사진.jpg'], 'rotl', '사진_회전.jpg', 600], // 800×600 → 600×800
  [['아이폰.heic'], 'rotr', '아이폰_회전.jpg'],
];

const only = process.argv[2] ? new RegExp(process.argv[2]) : null;
const outDir = path.resolve(import.meta.dirname, '..', 'test-results');
fs.mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined });
const context = await browser.newContext({ acceptDownloads: true });
// '내 컴퓨터 글꼴' 시험: 이 컴퓨터에 'Test Local Font'가 깔려 있고 사용을 허락한 것처럼 꾸민다
const testFont = fs.readFileSync(path.join(fixtures, 'test-local-font.ttf')).toString('base64');
await context.addInitScript((b64) => {
  window.queryLocalFonts = async () => [{
    family: 'Test Local Font', fullName: 'Test Local Font', postscriptName: 'TestLocalFont', style: 'Regular',
    blob: async () => new Blob([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))]),
  }];
}, testFont);
const page = await context.newPage();
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
await page.goto(url);
// 서비스 워커 적용을 위한 첫 새로고침을 기다린다
await page.waitForFunction(() => self.crossOriginIsolated, null, { timeout: 30000 });

let failed = 0;
for (const [inputs, target, expected, width, codec, strength = 'natural'] of CASES) {
  const label = `${inputs.join(' + ')} → ${LABEL[target] || target.toUpperCase()}${strength !== 'natural' ? ` ${STRENGTH[strength]}` : ''}${codec ? ` (${codec})` : ''}`;
  if (only && !only.test(label)) continue;
  const started = Date.now();
  try {
    await page.reload();
    await page.evaluate((c) => (c ? localStorage.setItem('video-codec', c) : localStorage.removeItem('video-codec')), codec ?? null);
    await page.setInputFiles('#picker', inputs.map((name) => ({
      name, mimeType: 'application/octet-stream', buffer: fs.readFileSync(path.join(fixtures, name)),
    })));
    await page.getByRole('button', LABEL[target] ? { name: LABEL[target], exact: !UPSCALE.includes(target) } : { name: target.toUpperCase(), exact: true }).click();
    if (UPSCALE.includes(target)) await page.getByRole('button', { name: STRENGTH[strength], exact: true }).click();
    if (expected === null) {
      await page.click('#go');
      await page.waitForSelector('#msg.err', { timeout: 600000 });
      const msg = await page.textContent('#msg');
      if (/변환 중 문제가 생겼습니다/.test(msg)) throw new Error(`원인을 알려 주지 못하는 안내 문구: ${msg}`);
      console.log(`✔ ${label}  → 오류 안내: ${msg.split('\n')[0]}`);
      continue;
    }
    const downloading = page.waitForEvent('download', { timeout: 600000 });
    downloading.catch(() => {}); // 아래에서 먼저 실패해도 처리되지 않은 오류로 멈추지 않게
    await page.click('#go');
    if (target === 'protect') {
      // 걸 암호 정하기: 두 번 다르게 치면 다시 묻고, 같게 치면 진행한다
      const [first, again] = [page.locator('.newpass input').nth(0), page.locator('.newpass input').nth(1)];
      await first.fill(NEW_PASSWORD);
      await again.fill('9999');
      await page.click('.newpass button[type=submit]');
      await page.waitForSelector('text=두 암호가 서로 다릅니다');
      await again.fill(NEW_PASSWORD);
      await page.click('.newpass button[type=submit]');
    }
    if (inputs.some((n) => n.startsWith('암호'))) {
      // 틀린 암호 → '맞지 않습니다' 안내 → 맞는 암호
      const ask = '.password:not(.newpass)';
      await page.fill(`${ask} input`, '0000', { timeout: 120000 });
      await page.click(`${ask} button[type=submit]`);
      await page.waitForSelector('text=암호가 맞지 않습니다', { timeout: 120000 });
      await page.fill(`${ask} input`, '1234');
      await page.click(`${ask} button[type=submit]`);
    }
    // 오류 메시지가 뜨면 기다리지 않고 바로 실패 처리
    const download = await Promise.race([
      downloading,
      page.waitForSelector('#msg.err', { timeout: 600000 }).then(async () => { throw new Error(await page.textContent('#msg')); }),
    ]);
    const name = download.suggestedFilename();
    const file = path.join(outDir, name);
    await download.saveAs(file);
    const buf = fs.readFileSync(file);
    const ext = name.split('.').pop();
    if (name !== expected) throw new Error(`파일 이름이 ${name} (기대: ${expected})`);
    if (!buf.length || !MAGIC[ext]?.(buf)) throw new Error(`${name} 내용이 올바르지 않음`);
    if (width && imageWidth(buf) !== width) throw new Error(`${name} 가로 크기가 ${imageWidth(buf)} (기대: ${width})`);
    if (name === '내글꼴.pdf' && !buf.includes('TestLocalFont')) throw new Error('내 컴퓨터 글꼴로 그리지 않음');
    const problem = PDF_CHECKS[name]?.(buf.toString('latin1')) || TXT_CHECKS[name]?.(buf.toString('utf8'))
      || XLSX_CHECKS[name]?.(unzipSync(new Uint8Array(buf)));
    if (name === '두쪽_합침.pdf' && (await pdfPages(buf)) !== 4) throw new Error(`합친 PDF가 ${await pdfPages(buf)}쪽 (기대: 4쪽)`);
    if (name === '두쪽_회전.pdf') {
      const angles = (await PDFDocument.load(buf)).getPages().map((p) => p.getRotation().angle);
      if (angles.some((a) => a !== 90)) throw new Error(`돌린 쪽의 각도가 ${angles.join(', ')} (기대: 90)`);
    }
    if (name === '암호_암호해제.pdf') {
      if (buf.includes('/Encrypt')) throw new Error('암호가 남아 있음');
      await PDFDocument.load(buf);
    }
    if (target === 'protect') {
      const problem = await checkProtected(buf);
      if (problem) throw new Error(`${name}: ${problem}`);
    }
    if (SMALLER.includes(name)) {
      const size = fs.statSync(path.join(fixtures, inputs[0])).size;
      if (buf.length >= size) throw new Error(`${name}이(가) 줄지 않음 (${size} → ${buf.length} bytes)`);
    }
    if (problem) throw new Error(`${name}: ${problem}`);
    if (WORD_CHECKS[name]) {
      const problem = WORD_CHECKS[name](wordParts(buf));
      if (problem) throw new Error(`${name}: ${problem}`);
    }
    // MP4 결과는 어디서나 재생되는 코덱(H.264, 아이폰 영상은 HEVC)이어야 한다 (VP9 시험은 제외)
    if (ext === 'mp4' && codec !== 'vp9' && !/avc1|hvc1/.test(buf.subarray(0, 1 << 20).toString('latin1'))) {
      throw new Error(`${name}이(가) 재생 호환 코덱(H.264)이 아님`);
    }
    const msg = await page.textContent('#msg');
    if (!msg.startsWith('완료')) throw new Error(`메시지: ${msg}`);
    console.log(`✔ ${label}  (${((Date.now() - started) / 1000).toFixed(1)}s, ${buf.length} bytes)`);
  } catch (e) {
    failed++;
    const msg = await page.textContent('#msg').catch(() => '');
    console.log(`✘ ${label}: ${e.message.split('\n')[0]}\n   화면 메시지: ${msg}`);
  }
}
// 인터넷이 끊겨 필요한 파일(여기서는 HEIC 해독기)을 못 받으면 '손상된 파일'이 아니라 새로고침하라고 안내하고,
// 새로고침하면 다시 되어야 한다 (브라우저는 못 받은 파일을 기억해서 새로고침 전에는 계속 실패한다)
if (!only || only.test('인터넷 끊김')) {
  const label = '인터넷 끊김 → 새로고침 안내';
  const pick = async () => {
    await page.setInputFiles('#picker', [{ name: '아이폰.heic', mimeType: 'application/octet-stream', buffer: fs.readFileSync(path.join(fixtures, '아이폰.heic')) }]);
    await page.getByRole('button', { name: 'JPG', exact: true }).click();
  };
  try {
    await page.reload();
    block = /^assets\/heic-to-/;
    await pick();
    await page.click('#go');
    await page.waitForSelector('#msg.err', { timeout: 60000 });
    const msg = await page.textContent('#msg');
    if (!/새로고침/.test(msg)) throw new Error(`새로고침 안내가 없음: ${msg}`);
    block = null;
    await page.reload();
    await pick();
    const downloading = page.waitForEvent('download', { timeout: 120000 });
    await page.click('#go');
    if ((await downloading).suggestedFilename() !== '아이폰.jpg') throw new Error('새로고침 뒤 변환 결과가 없음');
    console.log(`✔ ${label}  → ${msg.split('\n')[0]}`);
  } catch (e) {
    failed++;
    console.log(`✘ ${label}: ${e.message.split('\n')[0]}`);
  } finally {
    block = null;
  }
}
if (pageErrors.length) { failed++; console.log('페이지 오류:', pageErrors); }
await browser.close();
server.close();
console.log(failed ? `\n${failed}개 실패` : '\n모두 통과');
process.exit(failed ? 1 : 0);
