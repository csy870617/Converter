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
  return { paragraphs: text(doc), tables: (doc.match(/<w:tbl>/g) || []).length, headers: hf.join('\n'), bold: /<w:b\/>/.test(doc) };
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

const LABEL = { up2: '고화질 2배', up4: '고화질 4배', compress: '용량 줄이기', split: '쪽 나누기', merge: '하나로 합치기' };
const UPSCALE = ['up2', 'up4'];
const pdfPages = async (b) => (await PDFDocument.load(b)).getPageCount();

// [입력 파일들, 변환 형식, 예상 결과 파일 이름, 예상 가로 크기, 동영상 코덱 강제, AI 세기 '강하게']
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
  [['사진.jpg'], 'png', '사진.png'],
  [['투명.png'], 'jpg', '투명.jpg'],
  [['아이폰.heic'], 'jpg', '아이폰.jpg'],
  [['scan.tiff'], 'png', 'scan.png'],
  [['pic.webp'], 'jpg', 'pic.jpg'],
  [['pic.bmp'], 'webp', 'pic.webp'],
  [['anim.gif'], 'png', 'anim.png'],
  [['사진.jpg'], 'ico', '사진.ico'],
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
  [['내글꼴.docx'], 'pdf', '내글꼴.pdf'], // 내 컴퓨터 글꼴(허락한 경우)로 그리기
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
  [['두쪽.pdf'], 'split', '변환결과.zip'],
  [['두쪽.pdf', '보고서.pdf'], 'merge', '두쪽_합침.pdf'],
  [['사진.jpg'], 'up2', '사진_고화질2배.jpg', 1600],
  [['투명.png'], 'up4', '투명_고화질4배.png'],
  [['작은영상.mp4'], 'up4', '작은영상_고화질4배.mp4'], // 하드웨어 인코더가 없을 때 (ffmpeg 인코딩)
  [['작은영상.mp4'], 'up2', '작은영상_고화질2배.mp4', null, 'vp9'], // ffmpeg로 풀고 브라우저 인코더로 묶기. 크로미움엔 H.264가 없어 VP9로 확인
  [['작은영상.webm'], 'up2', '작은영상_고화질2배.mp4', null, 'vp9'], // 브라우저만으로 풀고 묶기 (ffmpeg 없이)
  [['사진.jpg'], 'up2', '사진_고화질2배_강하게.jpg', 1600, null, true],
  [['작은영상.webm'], 'up4', '작은영상_고화질4배_강하게.mp4', null, 'vp9', true],
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
for (const [inputs, target, expected, width, codec, strong] of CASES) {
  const label = `${inputs.join(' + ')} → ${LABEL[target] || target.toUpperCase()}${strong ? ' 강하게' : ''}${codec ? ` (${codec})` : ''}`;
  if (only && !only.test(label)) continue;
  const started = Date.now();
  try {
    await page.reload();
    await page.evaluate((c) => (c ? localStorage.setItem('upscale-codec', c) : localStorage.removeItem('upscale-codec')), codec ?? null);
    await page.setInputFiles('#picker', inputs.map((name) => ({
      name, mimeType: 'application/octet-stream', buffer: fs.readFileSync(path.join(fixtures, name)),
    })));
    await page.getByRole('button', LABEL[target] ? { name: LABEL[target] } : { name: target.toUpperCase(), exact: true }).click();
    if (UPSCALE.includes(target)) await page.getByRole('button', { name: strong ? '강하게' : '자연스럽게', exact: true }).click();
    if (expected === null) {
      await page.click('#go');
      await page.waitForSelector('#msg.err', { timeout: 600000 });
      const msg = await page.textContent('#msg');
      if (/변환 중 문제가 생겼습니다/.test(msg)) throw new Error(`원인을 알려 주지 못하는 안내 문구: ${msg}`);
      console.log(`✔ ${label}  → 오류 안내: ${msg.split('\n')[0]}`);
      continue;
    }
    const downloading = page.waitForEvent('download', { timeout: 600000 });
    await page.click('#go');
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
