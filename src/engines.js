// 실제 변환 엔진. 모든 변환은 브라우저 안에서 이루어지며 파일은 어디로도 전송되지 않는다.
// 무거운 엔진(ffmpeg, LibreOffice, PDF.js 등)은 필요할 때 처음 한 번만 불러온다.
import { ConvertError, MIME, extOf, stemOf } from './formats.js';

const asset = (path) => new URL(path, document.baseURI).href;

/** .gz로 올려 둔 큰 파일의 주소. 서비스 워커가 없으면 직접 받아서 푼다. */
async function bigAsset(path) {
  if (navigator.serviceWorker?.controller) return asset(path);
  const res = await fetch(asset(`${path}.gz`));
  if (!res.ok) throw new ConvertError('변환 엔진 파일을 받지 못했습니다. 인터넷 연결을 확인해 주세요.');
  const blob = await new Response(res.body.pipeThrough(new DecompressionStream('gzip'))).blob();
  return URL.createObjectURL(blob);
}

const out = (name, ext, data) => ({ name: `${name}.${ext}`, blob: data instanceof Blob ? data : new Blob([data], { type: MIME[ext] }) });

// ---------------------------------------------------------------------------
// 동영상 / 오디오 (ffmpeg.wasm)
// ---------------------------------------------------------------------------

const FFMPEG_ARGS = {
  mp3: ['-vn', '-c:a', 'libmp3lame', '-q:a', '2'],
  wav: ['-vn', '-c:a', 'pcm_s16le'],
  m4a: ['-vn', '-c:a', 'aac', '-b:a', '192k'],
  flac: ['-vn', '-c:a', 'flac'],
  ogg: ['-vn', '-c:a', 'libvorbis', '-q:a', '5'],
  mp4: ['-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '24', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart'],
  gif: ['-vf', "fps=10,scale='min(480,iw)':-2:flags=lanczos,split[a][b];[a]palettegen[p];[b][p]paletteuse", '-loop', '0'],
};

let ffmpegPromise = null;
let mediaJob = 0;

function loadFFmpeg(status) {
  if (!ffmpegPromise) {
    status('동영상·오디오 변환 엔진을 불러오는 중… (처음 한 번, 약 10MB)');
    ffmpegPromise = (async () => {
      const { FFmpeg } = await import('@ffmpeg/ffmpeg');
      const ff = new FFmpeg();
      await ff.load({ coreURL: asset('ffmpeg/ffmpeg-core.js'), wasmURL: await bigAsset('ffmpeg/ffmpeg-core.wasm') });
      return ff;
    })().catch((e) => { ffmpegPromise = null; throw e; });
  }
  return ffmpegPromise;
}

async function convertMedia(file, target, { status, progress }) {
  const ff = await loadFFmpeg(status);
  const dir = `/job${++mediaJob}`;
  const input = `${dir}/${file.name}`;
  const output = `/out${mediaJob}.${target}`;
  const log = [];
  const onLog = ({ message }) => { log.push(message); if (log.length > 30) log.shift(); };
  const onProgress = ({ progress: p }) => { if (p >= 0 && p <= 1) progress(p); };

  await ff.createDir(dir);
  await ff.mount('WORKERFS', { files: [file] }, dir); // 파일을 통째로 메모리에 복사하지 않는다
  ff.on('log', onLog);
  ff.on('progress', onProgress);
  try {
    status('변환 중…');
    let code = 1;
    // MOV/MKV → MP4는 먼저 다시 인코딩 없이 담기만 시도한다 (훨씬 빠름)
    if (target === 'mp4') {
      code = await ff.exec(['-i', input, '-c', 'copy', '-movflags', '+faststart', output]);
      if (code !== 0) await ff.deleteFile(output).catch(() => {});
    }
    if (code !== 0) code = await ff.exec(['-i', input, ...FFMPEG_ARGS[target], output]);
    if (code !== 0) {
      const reason = log.filter((l) => /error|invalid|not/i.test(l)).slice(-2).join('\n');
      throw new ConvertError(`변환에 실패했습니다. 파일이 손상되었거나 소리가 없는 영상일 수 있습니다.${reason ? `\n(${reason})` : ''}`);
    }
    const data = await ff.readFile(output);
    await ff.deleteFile(output);
    return [out(stemOf(file.name), target, data)];
  } finally {
    ff.off('log', onLog);
    ff.off('progress', onProgress);
    await ff.unmount(dir).catch(() => {});
    await ff.deleteDir(dir).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// 이미지 (Canvas, HEIC, TIFF)
// ---------------------------------------------------------------------------

const MAX_PIXELS = 16_000_000; // 사파리 캔버스 한계

async function decodeImage(file) {
  const ext = extOf(file.name);
  try {
    if (ext === 'heic' || ext === 'heif') {
      const { heicTo } = await import('heic-to');
      return await heicTo({ blob: file, type: 'bitmap' });
    }
    if (ext === 'tif' || ext === 'tiff') {
      const UTIF = (await import('utif2')).default;
      const buf = await file.arrayBuffer();
      const [ifd] = UTIF.decode(buf);
      UTIF.decodeImage(buf, ifd);
      const rgba = new Uint8ClampedArray(UTIF.toRGBA8(ifd));
      return await createImageBitmap(new ImageData(rgba, ifd.width, ifd.height));
    }
    return await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch (e) {
    if (e instanceof ConvertError) throw e;
    throw new ConvertError('이미지를 열 수 없습니다. 지원하지 않는 형식이거나 손상된 파일입니다.');
  }
}

function toCanvas(bitmap, { white = false, size = null } = {}) {
  let w = size?.[0] ?? bitmap.width;
  let h = size?.[1] ?? bitmap.height;
  if (!size && w * h > MAX_PIXELS) {
    const k = Math.sqrt(MAX_PIXELS / (w * h));
    w = Math.floor(w * k);
    h = Math.floor(h * k);
  }
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (white) {
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, w, h);
  }
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, 0, 0, w, h);
  return canvas;
}

function canvasBlob(canvas, type, quality) {
  return new Promise((resolve, reject) => canvas.toBlob(
    (b) => (b ? resolve(b) : reject(new ConvertError('이미지를 만들지 못했습니다.'))), type, quality,
  ));
}

async function makeIco(bitmap) {
  const sizes = [16, 32, 48, 64, 128, 256].filter((s) => s <= Math.max(bitmap.width, bitmap.height));
  if (!sizes.length) sizes.push(16);
  const pngs = [];
  for (const s of sizes) {
    // 비율을 유지하며 정사각형 안에 가운데 배치
    const k = s / Math.max(bitmap.width, bitmap.height);
    const c = document.createElement('canvas');
    c.width = c.height = s;
    const w = bitmap.width * k;
    const h = bitmap.height * k;
    c.getContext('2d').drawImage(bitmap, (s - w) / 2, (s - h) / 2, w, h);
    pngs.push(new Uint8Array(await (await canvasBlob(c, 'image/png')).arrayBuffer()));
  }
  const header = new DataView(new ArrayBuffer(6 + 16 * sizes.length));
  header.setUint16(2, 1, true);
  header.setUint16(4, sizes.length, true);
  let offset = header.byteLength;
  sizes.forEach((s, i) => {
    const e = 6 + 16 * i;
    header.setUint8(e, s >= 256 ? 0 : s);
    header.setUint8(e + 1, s >= 256 ? 0 : s);
    header.setUint16(e + 4, 1, true);
    header.setUint16(e + 6, 32, true);
    header.setUint32(e + 8, pngs[i].length, true);
    header.setUint32(e + 12, offset, true);
    offset += pngs[i].length;
  });
  return new Blob([header, ...pngs], { type: MIME.ico });
}

async function imagesToPdf(files, name) {
  const { PDFDocument } = await import('pdf-lib');
  const pdf = await PDFDocument.create();
  for (const file of files) {
    const bitmap = await decodeImage(file);
    const jpg = await canvasBlob(toCanvas(bitmap, { white: true }), 'image/jpeg', 0.92);
    const img = await pdf.embedJpg(await jpg.arrayBuffer());
    const scale = 72 / 150; // 150dpi 기준으로 종이 크기를 정한다
    const page = pdf.addPage([img.width * scale, img.height * scale]);
    page.drawImage(img, { x: 0, y: 0, width: page.getWidth(), height: page.getHeight() });
  }
  return out(name, 'pdf', await pdf.save());
}

async function convertImage(file, target) {
  if (target === 'pdf') return [await imagesToPdf([file], stemOf(file.name))];
  const bitmap = await decodeImage(file);
  let blob;
  if (target === 'ico') blob = await makeIco(bitmap);
  else if (target === 'jpg') blob = await canvasBlob(toCanvas(bitmap, { white: true }), 'image/jpeg', 0.92);
  else if (target === 'png') blob = await canvasBlob(toCanvas(bitmap), 'image/png');
  else if (target === 'webp') {
    blob = await canvasBlob(toCanvas(bitmap), 'image/webp', 0.9);
    if (blob.type !== 'image/webp') throw new ConvertError('이 브라우저(사파리)는 WEBP 저장을 지원하지 않습니다. 크롬이나 엣지에서 시도해 주세요.');
  }
  return [out(stemOf(file.name), target, blob)];
}

// ---------------------------------------------------------------------------
// PDF (PDF.js)
// ---------------------------------------------------------------------------

async function openPdf(file) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  pdfjs.GlobalWorkerOptions.workerSrc = (await import('pdfjs-dist/legacy/build/pdf.worker.min.mjs?url')).default;
  const task = pdfjs.getDocument({
    data: new Uint8Array(await file.arrayBuffer()),
    cMapUrl: asset('pdfjs/cmaps/'),
    cMapPacked: true,
    standardFontDataUrl: asset('pdfjs/standard_fonts/'),
    wasmUrl: asset('pdfjs/wasm/'),
    iccUrl: asset('pdfjs/iccs/'),
  });
  try {
    return { doc: await task.promise, close: () => task.destroy().catch(() => {}) };
  } catch (e) {
    task.destroy().catch(() => {});
    if (e?.name === 'PasswordException') throw new ConvertError('암호가 걸린 PDF는 변환할 수 없습니다.');
    throw new ConvertError('PDF를 열 수 없습니다. 손상된 파일일 수 있습니다.');
  }
}

async function renderPage(page, dpi, type) {
  const viewport = page.getViewport({ scale: dpi / 72 });
  const canvas = document.createElement('canvas');
  canvas.width = Math.floor(viewport.width);
  canvas.height = Math.floor(viewport.height);
  const context = canvas.getContext('2d');
  context.fillStyle = '#fff';
  context.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: context, canvas, viewport }).promise;
  return { blob: await canvasBlob(canvas, type, 0.92), width: canvas.width, height: canvas.height };
}

/** PDF 한 페이지의 글자들을 줄 → 문단으로 묶는다. */
function pageParagraphs(items) {
  const parts = items
    .filter((it) => it.str !== undefined && it.str !== '')
    .map((it) => ({
      str: it.str,
      x: it.transform[4],
      y: it.transform[5],
      size: Math.max(1, Math.hypot(it.transform[2], it.transform[3]) || it.height || 10),
      width: it.width,
    }))
    .sort((a, b) => b.y - a.y || a.x - b.x);

  const lines = [];
  for (const p of parts) {
    const line = lines.at(-1);
    if (line && Math.abs(line.y - p.y) < Math.min(line.size, p.size) * 0.5) {
      line.parts.push(p);
      line.size = Math.max(line.size, p.size);
    } else {
      lines.push({ y: p.y, size: p.size, parts: [p] });
    }
  }
  for (const line of lines) {
    line.parts.sort((a, b) => a.x - b.x);
    let text = '';
    let end = null;
    for (const p of line.parts) {
      if (end !== null && p.x - end > line.size * 0.25 && !/\s$/.test(text) && !/^\s/.test(p.str)) text += ' ';
      text += p.str;
      end = p.x + p.width;
    }
    line.text = text.trim();
  }

  const paragraphs = [];
  let prev = null;
  for (const line of lines.filter((l) => l.text)) {
    const para = paragraphs.at(-1);
    const sameBlock = prev && para && Math.abs(prev.size - line.size) < 1 && prev.y - line.y < line.size * 1.7;
    if (sameBlock) para.text += (/[-‐]$/.test(para.text) ? '' : ' ') + line.text;
    else paragraphs.push({ text: line.text, size: line.size });
    prev = line;
  }
  return paragraphs;
}

async function pdfToDocx(doc, stem, ctx) {
  const { Document, Packer, Paragraph, TextRun, ImageRun } = await import('docx');
  const sections = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const [, , w, h] = page.view;
    const content = await page.getTextContent();
    const paragraphs = pageParagraphs(content.items);
    const children = [];
    if (paragraphs.length) {
      for (const p of paragraphs) {
        children.push(new Paragraph({
          spacing: { after: Math.round(p.size * 6) },
          children: [new TextRun({ text: p.text, size: Math.round(Math.min(p.size, 72) * 2) })],
        }));
      }
    } else {
      // 글자가 없는 페이지(스캔본)는 그림으로 넣는다
      const img = await renderPage(page, 150, 'image/jpeg');
      const maxW = (w - 72) * 96 / 72;
      const k = Math.min(1, maxW / img.width, ((h - 72) * 96 / 72) / img.height);
      children.push(new Paragraph({
        children: [new ImageRun({
          type: 'jpg', data: await img.blob.arrayBuffer(),
          transformation: { width: Math.round(img.width * k), height: Math.round(img.height * k) },
        })],
      }));
    }
    sections.push({
      properties: { page: { size: { width: Math.round(w * 20), height: Math.round(h * 20) },
        margin: { top: 720, bottom: 720, left: 720, right: 720 } } },
      children,
    });
    page.cleanup();
    ctx.progress(i / doc.numPages);
  }
  const document = new Document({
    styles: { default: { document: { run: { font: { ascii: 'Malgun Gothic', eastAsia: '맑은 고딕', hAnsi: 'Malgun Gothic' } } } } },
    sections,
  });
  return out(stem, 'docx', await Packer.toBlob(document));
}

async function convertPdf(file, target, ctx) {
  const { doc, close } = await openPdf(file);
  const stem = stemOf(file.name);
  try {
    if (target === 'docx') return [await pdfToDocx(doc, stem, ctx)];
    if (target === 'txt') {
      const pages = [];
      for (let i = 1; i <= doc.numPages; i++) {
        const content = await (await doc.getPage(i)).getTextContent();
        pages.push(pageParagraphs(content.items).map((p) => p.text).join('\n'));
        ctx.progress(i / doc.numPages);
      }
      return [out(stem, 'txt', new Blob([pages.join('\n\n')], { type: MIME.txt }))];
    }
    const results = [];
    const digits = String(doc.numPages).length;
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const { blob } = await renderPage(page, 200, MIME[target]);
      const name = doc.numPages === 1 ? stem : `${stem}-${String(i).padStart(digits, '0')}`;
      results.push(out(name, target, blob));
      page.cleanup();
      ctx.progress(i / doc.numPages);
    }
    return results;
  } finally {
    await close();
  }
}

// ---------------------------------------------------------------------------
// 문서 (LibreOffice WebAssembly)
// ---------------------------------------------------------------------------

const FONTS = ['NanumGothic-Regular.ttf', 'NanumGothic-Bold.ttf', 'NanumMyeongjo-Regular.ttf', 'NanumMyeongjo-Bold.ttf'];
let officePromise = null;

export const officeSupported = () => self.crossOriginIsolated === true;

function loadOffice(status) {
  if (!officeSupported()) {
    return Promise.reject(new ConvertError('이 브라우저에서는 문서 변환을 할 수 없습니다. 최신 크롬·엣지·사파리에서 열어 주세요.'));
  }
  if (!officePromise) {
    officePromise = (async () => {
      status('문서 변환 엔진을 불러오는 중… (처음 한 번, 약 90MB · 다음부터는 빠릅니다)');
      const { WorkerBrowserConverter } = await import('@matbee/libreoffice-converter/browser');
      const fonts = await Promise.all(FONTS.map(async (filename) => {
        const res = await fetch(asset(`fonts/${filename}`));
        return { filename, data: new Uint8Array(await res.arrayBuffer()) };
      }));
      const converter = new WorkerBrowserConverter({
        sofficeJs: asset('lo/soffice.js'),
        sofficeWasm: await bigAsset('lo/soffice.wasm'),
        sofficeData: await bigAsset('lo/soffice.data'),
        sofficeWorkerJs: asset('lo/soffice.worker.js'),
        browserWorkerJs: asset('lo/browser.worker.js'),
        fonts,
        onProgress: (info) => status(`문서 변환 엔진 준비 중… ${Math.round(info.percent)}%`),
      });
      await converter.initialize();
      return converter;
    })().catch((e) => {
      officePromise = null;
      if (e instanceof ConvertError) throw e;
      throw new ConvertError(`문서 변환 엔진을 불러오지 못했습니다. (${e?.message || e})`);
    });
  }
  return officePromise;
}

// 파일 앞부분으로 진짜 문서인지 확인한다. (LibreOffice는 망가진 파일도 글자로 읽어 엉뚱한 결과를 낸다)
const SIGNATURES = {
  zip: [0x50, 0x4b], // docx, xlsx, pptx, odt, ods, odp
  ole: [0xd0, 0xcf, 0x11, 0xe0], // doc, xls, ppt
};
// doc/xls는 실제로는 HTML·RTF인 경우(은행 거래내역 등)가 많아 검사하지 않는다.
const EXPECTED_SIGNATURE = {
  docx: 'zip', xlsx: 'zip', pptx: 'zip', odt: 'zip', ods: 'zip', odp: 'zip', ppt: 'ole',
};

async function checkDocument(file) {
  const expected = EXPECTED_SIGNATURE[extOf(file.name)];
  if (!expected) return;
  const head = new Uint8Array(await file.slice(0, 8).arrayBuffer());
  const ok = [expected].flat().some((kind) => SIGNATURES[kind].every((b, i) => head[i] === b));
  if (!ok) throw new ConvertError('문서를 열 수 없습니다. 파일이 손상되었거나 확장자가 실제 형식과 다릅니다.');
}

async function convertOffice(file, target, { status }) {
  await checkDocument(file);
  const converter = await loadOffice(status);
  status('변환 중…');
  try {
    const data = new Uint8Array(await file.arrayBuffer());
    const result = await converter.convert(data, { outputFormat: target }, file.name);
    // 엑셀(윈도우)에서 한글 CSV가 깨지지 않도록 UTF-8 표시(BOM)를 붙인다
    const body = target === 'csv' ? new Blob(['\uFEFF', result.data], { type: MIME.csv }) : result.data;
    return [out(stemOf(file.name), target, body)];
  } catch (e) {
    const msg = String(e?.message || e);
    if (/password/i.test(msg)) throw new ConvertError('암호가 걸린 문서는 변환할 수 없습니다.');
    throw new ConvertError(`문서를 변환하지 못했습니다. 파일이 손상되었을 수 있습니다. (${msg})`);
  }
}

// ---------------------------------------------------------------------------

const ENGINES = { media: convertMedia, image: convertImage, pdf: convertPdf, office: convertOffice };

/**
 * @param {File} file
 * @param {string} target
 * @param {{status: (msg: string) => void, progress: (p: number) => void}} ctx
 * @returns {Promise<{name: string, blob: Blob}[]>}
 */
export function convertFile(file, engine, target, ctx) {
  return ENGINES[engine](file, target, ctx);
}

export { imagesToPdf };
