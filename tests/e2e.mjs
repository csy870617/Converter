// 실제 브라우저로 모든 변환을 끝까지 해 보는 테스트.
// GitHub Pages와 같은 조건(하위 경로 /Converter/, 보안 헤더 없음)으로 dist/를 띄운다.
//   npm run build && npm test
//   (크롬 경로 지정: CHROME_PATH=/path/to/chrome npm test)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';

const root = path.resolve(import.meta.dirname, '..', 'dist');
const fixtures = path.resolve(import.meta.dirname, 'fixtures');
const PREFIX = '/Converter/';
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.wasm': 'application/wasm', '.png': 'image/png', '.json': 'application/json', '.gz': 'application/gzip' };

const server = http.createServer((req, res) => {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (!p.startsWith(PREFIX)) { res.writeHead(404).end(); return; }
  p = p.slice(PREFIX.length) || 'index.html';
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
  pptx: (b) => b.subarray(0, 2).toString() === 'PK',
  xlsx: (b) => b.subarray(0, 2).toString() === 'PK',
  zip: (b) => b.subarray(0, 2).toString() === 'PK',
  txt: (b) => /한글/.test(b.toString('utf8')),
  csv: (b) => /철수/.test(b.toString('utf8')),
};

// [입력 파일들, 변환 형식, 예상 결과 파일 이름, 옵션]
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
];

const only = process.argv[2] ? new RegExp(process.argv[2]) : null;
const outDir = path.resolve(import.meta.dirname, '..', 'test-results');
fs.mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined });
const context = await browser.newContext({ acceptDownloads: true });
const page = await context.newPage();
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
await page.goto(url);
// 서비스 워커 적용을 위한 첫 새로고침을 기다린다
await page.waitForFunction(() => self.crossOriginIsolated, null, { timeout: 30000 });

let failed = 0;
for (const [inputs, target, expected] of CASES) {
  const label = `${inputs.join(' + ')} → ${target.toUpperCase()}`;
  if (only && !only.test(label)) continue;
  const started = Date.now();
  try {
    await page.reload();
    await page.setInputFiles('#picker', inputs.map((name) => ({
      name, mimeType: 'application/octet-stream', buffer: fs.readFileSync(path.join(fixtures, name)),
    })));
    await page.getByRole('button', { name: target.toUpperCase(), exact: true }).click();
    if (expected === null) {
      await page.click('#go');
      await page.waitForSelector('#msg.err', { timeout: 240000 });
      const msg = await page.textContent('#msg');
      if (/알 수 없는 오류/.test(msg)) throw new Error(`안내 문구가 불친절함: ${msg}`);
      console.log(`✔ ${label}  → 오류 안내: ${msg.split('\n')[0]}`);
      continue;
    }
    const downloading = page.waitForEvent('download', { timeout: 240000 });
    await page.click('#go');
    // 오류 메시지가 뜨면 기다리지 않고 바로 실패 처리
    const download = await Promise.race([
      downloading,
      page.waitForSelector('#msg.err', { timeout: 240000 }).then(async () => { throw new Error(await page.textContent('#msg')); }),
    ]);
    const name = download.suggestedFilename();
    const file = path.join(outDir, name);
    await download.saveAs(file);
    const buf = fs.readFileSync(file);
    const ext = name.split('.').pop();
    if (name !== expected) throw new Error(`파일 이름이 ${name} (기대: ${expected})`);
    if (!buf.length || !MAGIC[ext]?.(buf)) throw new Error(`${name} 내용이 올바르지 않음`);
    const msg = await page.textContent('#msg');
    if (!msg.startsWith('완료')) throw new Error(`메시지: ${msg}`);
    console.log(`✔ ${label}  (${((Date.now() - started) / 1000).toFixed(1)}s, ${buf.length} bytes)`);
  } catch (e) {
    failed++;
    const msg = await page.textContent('#msg').catch(() => '');
    console.log(`✘ ${label}: ${e.message.split('\n')[0]}\n   화면 메시지: ${msg}`);
  }
}
if (pageErrors.length) { failed++; console.log('페이지 오류:', pageErrors); }
await browser.close();
server.close();
console.log(failed ? `\n${failed}개 실패` : '\n모두 통과');
process.exit(failed ? 1 : 0);
