// 큰 WebAssembly 파일(LibreOffice, ffmpeg)을 public/ 아래로 복사한다.
// GitHub Pages의 파일 크기 제한(100MB)을 피하고 내려받는 양을 줄이기 위해
// 큰 파일은 gzip으로 압축해 두고, 브라우저의 서비스 워커(public/sw.js)가 풀어서 쓴다.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { pipeline } from 'node:stream/promises';

const root = path.resolve(import.meta.dirname, '..');
const nm = (p) => path.join(root, 'node_modules', p);
const pub = (p) => path.join(root, 'public', p);

const assets = [
  // [원본, 대상, gzip 여부]
  [nm('@matbee/libreoffice-converter/wasm/soffice.js'), pub('lo/soffice.js')],
  [nm('@matbee/libreoffice-converter/wasm/soffice.worker.js'), pub('lo/soffice.worker.js')],
  [nm('@matbee/libreoffice-converter/wasm/soffice.wasm'), pub('lo/soffice.wasm'), true],
  [nm('@matbee/libreoffice-converter/wasm/soffice.data'), pub('lo/soffice.data'), true],
  [nm('@matbee/libreoffice-converter/dist/browser.worker.global.js'), pub('lo/browser.worker.js')],
  [nm('@ffmpeg/core/dist/esm/ffmpeg-core.js'), pub('ffmpeg/ffmpeg-core.js')],
  [nm('@ffmpeg/core/dist/esm/ffmpeg-core.wasm'), pub('ffmpeg/ffmpeg-core.wasm'), true],
];

for (const [src, dest, gz] of assets) {
  const out = gz ? `${dest}.gz` : dest;
  const srcStat = fs.statSync(src);
  if (fs.existsSync(out) && fs.statSync(out).mtimeMs >= srcStat.mtimeMs) continue;
  fs.mkdirSync(path.dirname(out), { recursive: true });
  process.stdout.write(`${path.relative(root, out)} ... `);
  if (gz) {
    await pipeline(fs.createReadStream(src), zlib.createGzip({ level: 9 }), fs.createWriteStream(out));
  } else {
    fs.copyFileSync(src, out);
  }
  console.log(`${(fs.statSync(out).size / 1e6).toFixed(1)}MB`);
}

// PDF.js 보조 파일 (한글 등 CJK 글꼴 정보, 표준 글꼴, 이미지 디코더)
for (const dir of ['cmaps', 'standard_fonts', 'wasm', 'iccs']) {
  const dest = pub(`pdfjs/${dir}`);
  if (!fs.existsSync(dest)) fs.cpSync(nm(`pdfjs-dist/${dir}`), dest, { recursive: true });
}
