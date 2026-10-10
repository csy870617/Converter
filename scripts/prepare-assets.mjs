// 큰 WebAssembly 파일(LibreOffice, ffmpeg, ONNX Runtime)을 public/ 아래로 복사한다.
// GitHub Pages의 파일 크기 제한(100MB)을 피하고 내려받는 양을 줄이기 위해
// 큰 파일은 gzip으로 압축해 두고, 브라우저의 서비스 워커(public/sw.js)가 풀어서 쓴다.
import crypto from 'node:crypto';
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
  [nm('@ffmpeg/core-mt/dist/esm/ffmpeg-core.js'), pub('ffmpeg-mt/ffmpeg-core.js')],
  [nm('@ffmpeg/core-mt/dist/esm/ffmpeg-core.worker.js'), pub('ffmpeg-mt/ffmpeg-core.worker.js')],
  [nm('@ffmpeg/core-mt/dist/esm/ffmpeg-core.wasm'), pub('ffmpeg-mt/ffmpeg-core.wasm'), true],
  // AI 화질 개선 엔진. 번들에 넣으면 계산용 워커가 화면 코드까지 불러와 멈추므로 따로 둔다.
  [nm('onnxruntime-web/dist/ort.webgpu.min.mjs'), pub('ort/ort.webgpu.min.mjs')],
  [nm('onnxruntime-web/dist/ort-wasm-simd-threaded.asyncify.mjs'), pub('ort/ort-wasm-simd-threaded.asyncify.mjs')],
  [nm('onnxruntime-web/dist/ort-wasm-simd-threaded.asyncify.wasm'), pub('ort/ort-wasm-simd-threaded.asyncify.wasm'), true],
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

// PDF → Word 변환 엔진: Pyodide(브라우저용 파이썬)와 pdf2docx·PyMuPDF 등 휠 파일.
// 휠은 정해 둔 판만 받아 SHA-256으로 확인한다. (받은 것은 node_modules/.cache/wheels 에 보관)
const PYODIDE_CDN = 'https://cdn.jsdelivr.net/pyodide/v0.29.3/full/';
const PYPI = 'https://files.pythonhosted.org/packages/';
export const WHEELS = [
  ['numpy-2.2.5-cp313-cp313-pyodide_2025_0_wasm32.whl', PYODIDE_CDN, '6eaab6a7bb658d71ebe702911a3deab715323642462eb41b65565ca6a7cc23f1'],
  ['opencv_python-4.11.0.86-cp313-cp313-pyodide_2025_0_wasm32.whl', PYODIDE_CDN, 'a8b116def8c74b3ccf389b856b3ccb5cec5a2efc295ec17a15ea9cda1f88aa1e'],
  ['lxml-6.0.2-cp313-cp313-pyodide_2025_0_wasm32.whl', PYODIDE_CDN, '99b959a55eaeb41a2997fa022859892880c2b708af01ff336c34c7b125c80916'],
  ['fonttools-4.56.0-py3-none-any.whl', PYODIDE_CDN, '9d6518c8ad4d88019bc72045108eca154301014215222408aa047cf4955c726d'],
  ['typing_extensions-4.15.0-py3-none-any.whl', PYODIDE_CDN, 'b57583f623dd3df72e6ace8a4061c3e4f0683755165ef73b4cd44ac3df92ddb9'],
  ['pymupdf-1.28.2-cp313-abi3-pyemscripten_2025_0_wasm32.whl', `${PYPI}58/8c/d897dcd32a25b58186c968b15ce4324ca029e9d96460de12325314e390be/`, '2e1b574c0fd2cb238021033fd3c0f9c4388816638df064e4bfb56d9d81736dc8'],
  ['python_docx-1.2.0-py3-none-any.whl', `${PYPI}d0/00/1e03a4989fa5795da308cd774f05b704ace555a70f9bf9d3be057b680bcf/`, '3fd478f3250fbbbfd3b94fe1e985955737c145627498896a8a6bf81f4baf66c7'],
  ['pdf2docx-0.5.13-py3-none-any.whl', `${PYPI}71/4d/4041fddff079a2cd0c87612afe74a16d2cf032b2aa73ecddbc6bca2a04fe/`, 'a293e9e78d89b12a4a43fcefba1346de220681c3daf20b8a7d3e1fce77f0fe97'],
];

for (const file of ['pyodide.mjs', 'pyodide.asm.js', 'pyodide.asm.wasm', 'python_stdlib.zip', 'pyodide-lock.json']) {
  const src = nm(`pyodide/${file}`);
  const dest = pub(`pyodide/${file}`);
  if (fs.existsSync(dest) && fs.statSync(dest).mtimeMs >= fs.statSync(src).mtimeMs) continue;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const cache = nm('.cache/wheels');
fs.mkdirSync(cache, { recursive: true });
const sizes = {};
for (const [name, base, hash] of WHEELS) {
  const dest = pub(`pyodide/${name}`);
  const cached = path.join(cache, name);
  if (!fs.existsSync(cached) || sha256(fs.readFileSync(cached)) !== hash) {
    process.stdout.write(`${name} 내려받는 중 ... `);
    const res = await fetch(base + name);
    if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (sha256(buf) !== hash) throw new Error(`${name}: 체크섬이 맞지 않습니다`);
    fs.writeFileSync(cached, buf);
    console.log(`${(buf.length / 1e6).toFixed(1)}MB`);
  }
  if (!fs.existsSync(dest) || fs.statSync(dest).size !== fs.statSync(cached).size) fs.copyFileSync(cached, dest);
  sizes[name] = fs.statSync(dest).size;
}
// 작업자가 내려받기 진행률을 보여 줄 수 있게 파일 목록과 크기를 적어 둔다
fs.writeFileSync(pub('pyodide/wheels.json'), JSON.stringify(sizes, null, 1));
