// 실제 변환 엔진. 모든 변환은 브라우저 안에서 이루어지며 파일은 어디로도 전송되지 않는다.
// 무거운 엔진(ffmpeg, LibreOffice, PDF.js 등)은 필요할 때 처음 한 번만 불러온다.
import { ConvertError, MIME, UPSCALE, categoryOf, extOf, stemOf } from './formats.js';
import { localFontsFor } from './localfonts.js';

export const asset = (path) => new URL(path, document.baseURI).href;

/**
 * 인터넷이 끊기거나 사이트가 새로 바뀌어(예전 파일이 지워짐) 필요한 파일을 받지 못했을 때의 안내.
 * 브라우저는 한 번 못 받은 파일을 기억해 두어서, 새로고침하기 전에는 다시 시도해도 같은 오류가 난다.
 */
export const LOAD_FAILED = '필요한 파일을 받지 못했습니다. 인터넷 연결을 확인하고 페이지를 새로고침해 주세요.';
export const isLoadFailure = (e) =>
  /dynamically imported module|module script failed|failed to fetch|networkerror|load failed/i.test(String(e?.message ?? e));

const bigAssets = new Map();

/** .gz로 올려 둔 큰 파일의 주소. 서비스 워커가 없으면 직접 받아서 풀고, 한 번 푼 것은 다시 쓴다. */
export function bigAsset(path) {
  if (navigator.serviceWorker?.controller) return Promise.resolve(asset(path));
  if (!bigAssets.has(path)) {
    bigAssets.set(path, (async () => {
      const res = await fetch(asset(`${path}.gz`));
      if (!res.ok) throw new ConvertError('변환 엔진 파일을 받지 못했습니다. 인터넷 연결을 확인해 주세요.');
      const blob = await new Response(res.body.pipeThrough(new DecompressionStream('gzip'))).blob();
      return URL.createObjectURL(blob);
    })().catch((e) => { bigAssets.delete(path); throw e; }));
  }
  return bigAssets.get(path);
}

// 서비스 워커가 알려 주는 큰 파일 내려받기 진행 상황. 엔진이 직접 받는 파일은 이것으로만 알 수 있다.
const downloads = new Map(); // 경로 → {loaded, total}
let onDownload = () => {};
navigator.serviceWorker?.addEventListener('message', (e) => {
  if (e.data?.type !== 'download') return;
  downloads.set(e.data.path, e.data);
  onDownload(e.data.path);
});

/** 받는 중인 파일들의 진행률 (0~1, 아직 크기를 모르면 null) */
function downloadedPart(paths) {
  let loaded = 0;
  let total = 0;
  for (const p of paths) {
    const d = downloads.get(p);
    if (d?.total) { loaded += d.loaded; total += d.total; }
  }
  return total ? loaded / total : null;
}

export const out = (name, ext, data) => ({ name: `${name}.${ext}`, blob: data instanceof Blob ? data : new Blob([data], { type: MIME[ext] }) });

// ---------------------------------------------------------------------------
// 동영상 / 오디오 (ffmpeg.wasm)
// ---------------------------------------------------------------------------

const RINGTONE_SECONDS = 40; // 아이폰 벨소리는 40초까지만 쓸 수 있다

const FFMPEG_ARGS = {
  mp3: ['-vn', '-c:a', 'libmp3lame', '-q:a', '2'],
  wav: ['-vn', '-c:a', 'pcm_s16le'],
  m4a: ['-vn', '-c:a', 'aac', '-b:a', '192k'],
  aac: ['-vn', '-c:a', 'aac', '-b:a', '192k'],
  flac: ['-vn', '-c:a', 'flac'],
  ogg: ['-vn', '-c:a', 'libvorbis', '-q:a', '5'],
  opus: ['-vn', '-c:a', 'libopus', '-b:a', '128k'],
  m4r: ['-vn', '-t', String(RINGTONE_SECONDS), '-c:a', 'aac', '-b:a', '192k', '-f', 'ipod'],
  avi: ['-c:v', 'mpeg4', '-vtag', 'xvid', '-q:v', '4', '-pix_fmt', 'yuv420p', '-c:a', 'libmp3lame', '-q:a', '4'],
  webm: ['-c:v', 'libvpx', '-deadline', 'realtime', '-cpu-used', '8', '-crf', '10', '-b:v', '2M', '-auto-alt-ref', '0',
    '-pix_fmt', 'yuv420p', '-c:a', 'libopus', '-b:a', '128k'],
  mp4: ['-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '24', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart'],
  gif: ['-vf', "fps=10,scale='min(480,iw)':-2:flags=lanczos,split[a][b];[a]palettegen[p];[b][p]paletteuse", '-loop', '0'],
};

// 결과를 브라우저·휴대폰에서 바로 재생할 수 있게: 이 코덱들만 다시 압축하지 않고 그대로 MP4에 옮긴다.
// (예: AVI 안의 옛날 코덱(Xvid)을 그대로 옮기면 크롬·엣지에서 재생되지 않는다)
const MP4_COPY_AUDIO = ['aac', 'mp3'];
const ENCODE_VIDEO = ['mp4', 'mov', 'gif', 'avi', 'webm']; // 영상을 다시 압축할 수 있는 변환 (여러 코어 ffmpeg)
const EVEN = ['-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2']; // H.264는 가로·세로가 짝수여야 한다

/** ffmpeg 정보(로그)에서 MP4로 옮기는 방법을 정한다. */
function mp4Plan(log) {
  const video = log.find((l) => /Stream #.*Video:/.test(l)) || '';
  const audio = log.find((l) => /Stream #.*Audio:/.test(l));
  const v = /Video: (\w+)/.exec(video)?.[1];
  const a = audio && /Audio: (\w+)/.exec(audio)?.[1];
  // H.264는 일반 8비트 영상만(10비트·4:4:4는 재생 안 되는 기기가 많다), HEVC(아이폰 영상)는 애플 방식 표시를 붙여 옮긴다
  const copyVideo = (v === 'h264' && /yuvj?420p[(,\s]/.test(video)) || v === 'hevc';
  return { copyVideo, tag: v === 'hevc' ? ['-tag:v', 'hvc1'] : [], copyAudio: !a || MP4_COPY_AUDIO.includes(a) };
}

/** WEBM에 그대로 담을 수 있는지 (VP8·VP9·AV1 영상 + Opus·Vorbis 소리) */
function webmCopy(log) {
  const video = log.find((l) => /Stream #.*Video:/.test(l)) || '';
  const audio = log.find((l) => /Stream #.*Audio:/.test(l));
  return /Video: (vp8|vp9|av1)/.test(video) && (!audio || /Audio: (opus|vorbis)/.test(audio));
}

/** ffmpeg 정보에서 길이(초) */
function duration(log) {
  const m = /Duration: (\d+):(\d+):([\d.]+)/.exec(log.join('\n'));
  return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : 0;
}

let ffmpegPromise = null;
let ffmpegMtPromise = null;
let mediaJob = 0;

export function loadFFmpeg(status) {
  if (!ffmpegPromise) {
    status('준비 중…');
    ffmpegPromise = (async () => {
      const { FFmpeg } = await import('@ffmpeg/ffmpeg');
      const ff = new FFmpeg();
      await ff.load({ coreURL: asset('ffmpeg/ffmpeg-core.js'), wasmURL: await bigAsset('ffmpeg/ffmpeg-core.wasm') });
      return ff;
    })().catch((e) => {
      ffmpegPromise = null;
      if (e instanceof ConvertError) throw e;
      console.error(e);
      throw new ConvertError('변환 엔진을 불러오지 못했습니다. 인터넷 연결을 확인하고 페이지를 새로고침해 주세요.');
    });
  }
  return ffmpegPromise;
}

/**
 * 여러 코어를 쓰는 ffmpeg (인코딩이 1.5배 이상 빠르다). 동영상 화질 개선에서 브라우저 인코더가 없을 때만 쓴다.
 * 보안 헤더(서비스 워커)가 없거나 불러오지 못하면 보통 ffmpeg를 쓴다.
 */
export function loadFFmpegThreaded(status) {
  if (!self.crossOriginIsolated) return loadFFmpeg(status);
  if (!ffmpegMtPromise) {
    status('준비 중…');
    ffmpegMtPromise = (async () => {
      const { FFmpeg } = await import('@ffmpeg/ffmpeg');
      const ff = new FFmpeg();
      await ff.load({
        coreURL: asset('ffmpeg-mt/ffmpeg-core.js'),
        wasmURL: await bigAsset('ffmpeg-mt/ffmpeg-core.wasm'),
        workerURL: asset('ffmpeg-mt/ffmpeg-core.worker.js'),
      });
      return ff;
    })().catch((e) => {
      console.warn('여러 코어용 ffmpeg를 불러오지 못해 보통 ffmpeg를 씁니다', e);
      return loadFFmpeg(status);
    }).catch((e) => { ffmpegMtPromise = null; throw e; }); // 둘 다 못 불러오면 다음에 처음부터 다시 시도한다
  }
  return ffmpegMtPromise;
}

async function convertMedia(file, target, { status, progress }) {
  // 영상을 다시 압축하는 변환(MP4·GIF 등)은 여러 코어를 쓰는 ffmpeg로 (2배 이상 빠르다)
  const ff = await (ENCODE_VIDEO.includes(target) ? loadFFmpegThreaded(status) : loadFFmpeg(status));
  const dir = `/job${++mediaJob}`;
  const input = `${dir}/${file.name}`;
  const output = `/out${mediaJob}.${target}`;
  const log = [];
  const onLog = ({ message }) => { log.push(message); if (log.length > 200) log.shift(); };
  const onProgress = ({ progress: p }) => { if (p >= 0 && p <= 1) progress(p); };

  await ff.createDir(dir);
  await ff.mount('WORKERFS', { files: [file] }, dir); // 파일을 통째로 메모리에 복사하지 않는다
  ff.on('log', onLog);
  ff.on('progress', onProgress);
  try {
    status('변환 중…');
    let code = 1;
    let note = '';
    await ff.exec(['-hide_banner', '-i', input]); // 정보만 읽는다 (출력이 없어 실패 코드는 정상)
    const tryCopy = async (args) => {
      code = await ff.exec(['-i', input, '-map', '0:v:0', '-map', '0:a:0?', ...args, output]);
      if (code !== 0) await ff.deleteFile(output).catch(() => {});
    };
    if (target === 'mp4' || target === 'mov') {
      // 재생 호환되는 코덱(H.264·HEVC)이면 다시 압축하지 않고 담기만 한다 (훨씬 빠르고 화질 손실 없음)
      const plan = mp4Plan(log);
      if (plan.copyVideo) {
        await tryCopy(['-c:v', 'copy', ...plan.tag, ...(plan.copyAudio ? ['-c:a', 'copy'] : ['-c:a', 'aac', '-b:a', '160k']),
          '-movflags', '+faststart']);
      }
      if (code !== 0) {
        code = await ff.exec(['-i', input, '-map', '0:v:0', '-map', '0:a:0?', ...EVEN, ...FFMPEG_ARGS.mp4, output]);
      }
    } else if (target === 'webm') {
      if (webmCopy(log)) await tryCopy(['-c', 'copy']);
      if (code !== 0) code = await ff.exec(['-i', input, '-map', '0:v:0', '-map', '0:a:0?', ...EVEN, ...FFMPEG_ARGS.webm, output]);
    } else if (target === 'avi') {
      code = await ff.exec(['-i', input, '-map', '0:v:0', '-map', '0:a:0?', ...EVEN, ...FFMPEG_ARGS.avi, output]);
    } else {
      code = await ff.exec(['-i', input, ...FFMPEG_ARGS[target], output]);
      if (target === 'm4r' && duration(log) > RINGTONE_SECONDS + 0.5) {
        note = `아이폰 벨소리는 ${RINGTONE_SECONDS}초까지만 쓸 수 있어 앞부분 ${RINGTONE_SECONDS}초만 담았습니다.`;
      }
    }
    if (code !== 0) {
      console.warn('ffmpeg 기록', log.join('\n'));
      const video = categoryOf(file.name)?.id === 'video';
      throw new ConvertError(video && FFMPEG_ARGS[target]?.[0] === '-vn'
        ? '변환하지 못했습니다. 파일이 손상되었거나 소리가 없는 영상일 수 있습니다.'
        : '변환하지 못했습니다. 파일이 손상되었을 수 있습니다.');
    }
    const data = await ff.readFile(output);
    await ff.deleteFile(output);
    const result = out(stemOf(file.name), target, data);
    if (note) result.note = note;
    return [result];
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

// 아이폰 사파리는 약 1,670만 화소보다 큰 캔버스에 오류 없이 빈 그림만 그린다. 컴퓨터 브라우저는 훨씬 크게 된다.
const SAFE_PIXELS = 16_000_000; // 어느 브라우저에서나 되는 크기
export const MAX_PIXELS = 64_000_000; // 다룰 수 있는 가장 큰 사진 (6,400만 화소: 최신 카메라·휴대폰 대부분)

/** 이 캔버스에 실제로 그려지는지 확인한다 (너무 크면 브라우저가 조용히 못 그린다). */
function canvasWorks(canvas) {
  const ctx = canvas.getContext('2d');
  if (!ctx) return false;
  const x = canvas.width - 1;
  const y = canvas.height - 1;
  ctx.fillStyle = '#000';
  ctx.fillRect(x, y, 1, 1);
  const ok = ctx.getImageData(x, y, 1, 1).data[3] === 255;
  ctx.clearRect(x, y, 1, 1);
  return ok;
}

/**
 * w×h(최대 limit 화소) 캔버스를 만든다. 이 브라우저가 못 그리는 크기면 비율을 유지하며 줄인다.
 * 줄었을 수 있으니 실제 크기는 canvas.width/height로 확인한다.
 */
export function makeCanvas(w, h, limit = MAX_PIXELS) {
  const make = (k) => {
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(w * k));
    c.height = Math.max(1, Math.round(h * k));
    return c;
  };
  const c = make(Math.min(1, Math.sqrt(limit / (w * h))));
  if (c.width * c.height <= SAFE_PIXELS || canvasWorks(c)) return c;
  c.width = 0; // 메모리를 바로 돌려준다
  c.height = 0;
  return make(Math.sqrt(SAFE_PIXELS / (w * h)));
}

// SVG의 width·height 값(단위 포함)을 화면 점(px)으로
const SVG_UNITS = { px: 1, pt: 4 / 3, pc: 16, mm: 96 / 25.4, cm: 96 / 2.54, in: 96 };
function svgLength(value) {
  const m = /^\s*([\d.]+)\s*(px|pt|pc|mm|cm|in)?\s*$/i.exec(value || '');
  return m ? Number(m[1]) * SVG_UNITS[(m[2] || 'px').toLowerCase()] : 0;
}

/** SVG 파일을 읽어 그림 크기(px)와 함께 돌려준다. 크기가 없으면 viewBox로 정한다. */
async function readSvg(file) {
  const doc = new DOMParser().parseFromString(await file.text(), 'image/svg+xml');
  const svg = doc.documentElement;
  if (svg.nodeName !== 'svg' || doc.querySelector('parsererror')) throw new ConvertError('SVG 파일을 읽을 수 없습니다. 손상되었을 수 있습니다.');
  const box = (svg.getAttribute('viewBox') || '').split(/[\s,]+/).map(Number);
  const hasBox = box.length === 4 && box[2] > 0 && box[3] > 0;
  let w = svgLength(svg.getAttribute('width'));
  let h = svgLength(svg.getAttribute('height'));
  if (!w && !h) [w, h] = hasBox ? [box[2], box[3]] : [300, 150];
  else if (!w) w = hasBox ? (h * box[2]) / box[3] : h;
  else if (!h) h = hasBox ? (w * box[3]) / box[2] : w;
  if (!hasBox) svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
  return { svg, width: w, height: h };
}

/** SVG → 그림. 작은 아이콘도 또렷하게 긴 변을 1,024px 이상으로 그린다. */
async function decodeSvg(file) {
  const { svg, width, height } = await readSvg(file);
  const k = Math.min(8192 / Math.max(width, height), Math.max(1, 1024 / Math.max(width, height)));
  svg.setAttribute('width', String(Math.round(width * k)));
  svg.setAttribute('height', String(Math.round(height * k)));
  const url = URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(svg)], { type: 'image/svg+xml' }));
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return await createImageBitmap(img);
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** 글자가 없는 SVG → 확대해도 깨지지 않는 PDF (글자가 있으면 글꼴 문제로 그림으로 넣는다) */
async function svgToPdf(file) {
  const { svg, width, height } = await readSvg(file);
  if (svg.querySelector('text, foreignObject')) return null;
  const [{ jsPDF }, { svg2pdf }] = await Promise.all([import('jspdf'), import('svg2pdf.js')]);
  const w = width * 0.75; // px → pt
  const h = height * 0.75;
  const pdf = new jsPDF({ unit: 'pt', format: [w, h], orientation: w > h ? 'landscape' : 'portrait', compress: true });
  const holder = document.createElement('div');
  holder.style.cssText = 'position:fixed;left:-100000px;top:0;width:10px;height:10px;overflow:hidden;visibility:hidden';
  holder.append(svg);
  document.body.append(holder);
  try {
    await svg2pdf(svg, pdf, { x: 0, y: 0, width: w, height: h });
  } finally {
    holder.remove();
  }
  return out(stemOf(file.name), 'pdf', pdf.output('blob'));
}

/** 24비트 BMP (투명한 곳은 흰색) */
function makeBmp(canvas) {
  const { width: w, height: h } = canvas;
  const { data } = canvas.getContext('2d').getImageData(0, 0, w, h);
  const row = Math.ceil((w * 3) / 4) * 4;
  const size = 54 + row * h;
  const buf = new ArrayBuffer(size);
  const v = new DataView(buf);
  const u = new Uint8Array(buf);
  u[0] = 0x42; // 'BM'
  u[1] = 0x4d;
  v.setUint32(2, size, true);
  v.setUint32(10, 54, true);
  v.setUint32(14, 40, true);
  v.setInt32(18, w, true);
  v.setInt32(22, h, true);
  v.setUint16(26, 1, true);
  v.setUint16(28, 24, true);
  v.setUint32(34, row * h, true);
  v.setInt32(38, 3780, true); // 96dpi
  v.setInt32(42, 3780, true);
  for (let y = 0; y < h; y++) {
    let o = 54 + (h - 1 - y) * row; // 아래 줄부터
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      u[o++] = data[i + 2];
      u[o++] = data[i + 1];
      u[o++] = data[i];
    }
  }
  return new Blob([buf], { type: MIME.bmp });
}

/** TIFF (압축 없음, 투명도 유지) */
async function makeTiff(canvas) {
  const UTIF = (await import('utif2')).default;
  const { width: w, height: h } = canvas;
  const { data } = canvas.getContext('2d').getImageData(0, 0, w, h);
  return new Blob([UTIF.encodeImage(data.buffer, w, h, { t338: [2], t305: ['File Converter'] })], { type: MIME.tiff });
}

/** GIF (256색, 투명도 유지) */
async function makeGif(canvas) {
  const { GIFEncoder, quantize, applyPalette } = await import('gifenc');
  const { width: w, height: h } = canvas;
  const { data } = canvas.getContext('2d').getImageData(0, 0, w, h);
  const transparent = data.some((v, i) => i % 4 === 3 && v < 128);
  const palette = quantize(data, 256, transparent ? { format: 'rgba4444', oneBitAlpha: true } : {});
  const index = applyPalette(data, palette, transparent ? 'rgba4444' : 'rgb565');
  const clear = transparent ? palette.findIndex((c) => c[3] === 0) : -1;
  const gif = GIFEncoder();
  gif.writeFrame(index, w, h, { palette, transparent: clear >= 0, transparentIndex: Math.max(0, clear) });
  gif.finish();
  return new Blob([gif.bytes()], { type: MIME.gif });
}

export async function decodeImage(file) {
  const ext = extOf(file.name);
  try {
    if (ext === 'svg') return await decodeSvg(file);
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
    if (isLoadFailure(e)) throw new ConvertError(LOAD_FAILED);
    throw new ConvertError('이미지를 열 수 없습니다. 지원하지 않는 형식이거나 손상된 파일입니다.');
  }
}

function toCanvas(bitmap, { white = false } = {}) {
  const canvas = makeCanvas(bitmap.width, bitmap.height);
  const w = canvas.width;
  const h = canvas.height;
  const ctx = canvas.getContext('2d');
  if (white) {
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, w, h);
  }
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, 0, 0, w, h);
  return canvas;
}

export function canvasBlob(canvas, type, quality) {
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

async function convertImage(file, target, ctx) {
  if (target === 'mp4') return convertMedia(file, 'mp4', ctx); // 움직이는 GIF → 동영상
  if (target === 'pdf') {
    const vector = extOf(file.name) === 'svg' ? await svgToPdf(file).catch((e) => { console.warn('SVG를 그림으로 넣습니다', e); return null; }) : null;
    return [vector || await imagesToPdf([file], stemOf(file.name))];
  }
  const bitmap = await decodeImage(file);
  let blob;
  if (target === 'ico') blob = await makeIco(bitmap);
  else if (target === 'gif') blob = await makeGif(toCanvas(bitmap));
  else if (target === 'bmp') blob = makeBmp(toCanvas(bitmap, { white: true }));
  else if (target === 'tiff') blob = await makeTiff(toCanvas(bitmap));
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
    if (isLoadFailure(e)) throw new ConvertError(LOAD_FAILED); // PDF.js 작업 파일을 못 받은 경우
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

// PDF → Word·용량 줄이기·표 꺼내기는 따로 된 작업자(src/pdf2word, 브라우저용 파이썬)에서 한다.
// 처음 한 번 엔진(용량 줄이기·표는 약 20MB, Word는 약 40MB)을 받는다.
let pdfWorker = null;
let pdfJob = 0;

const PDF_TASK_ERRORS = {
  docx: 'PDF를 Word로 바꾸지 못했습니다. 손상되었거나 특수한 PDF일 수 있습니다.',
  compress: 'PDF 용량을 줄이지 못했습니다. 손상되었거나 특수한 PDF일 수 있습니다.',
  tables: 'PDF에서 표를 꺼내지 못했습니다. 손상되었거나 특수한 PDF일 수 있습니다.',
};

/** 작업자에게 PDF 일을 맡긴다. task: 'docx' | 'compress' | 'tables' */
function pdfTask(file, task, ctx, working = '변환 중…') {
  ctx.status(task === 'docx' ? '준비 중… (처음 한 번 1~2분)' : '준비 중…');
  if (!pdfWorker) pdfWorker = new Worker(new URL('./pdf2word/worker.js', import.meta.url), { type: 'module' });
  const worker = pdfWorker;
  const id = ++pdfJob;
  const reset = () => { worker.terminate(); if (pdfWorker === worker) pdfWorker = null; };
  return new Promise((resolve, reject) => {
    const done = () => {
      worker.removeEventListener('message', onMessage);
      worker.removeEventListener('error', onError);
    };
    const onMessage = ({ data: m }) => {
      if (m.id !== id) return;
      if (m.type === 'progress') {
        if (m.stage === 'load') ctx.status(`준비 중… ${Math.round(m.value * 100)}%`);
        else { ctx.status(working); ctx.progress(m.value); }
      } else if (m.type === 'done') {
        done();
        resolve(m);
      } else if (m.type === 'error') {
        done();
        if (m.code === 'load') { reset(); reject(new ConvertError(LOAD_FAILED)); return; }
        console.warn(`PDF 작업(${task}) 오류`, m.message);
        reject(new ConvertError(m.code === 'password' ? '암호가 걸린 PDF는 변환할 수 없습니다.' : PDF_TASK_ERRORS[task]));
      }
    };
    const onError = (e) => {
      done();
      reset();
      console.error(e);
      reject(new ConvertError(LOAD_FAILED));
    };
    worker.addEventListener('message', onMessage);
    worker.addEventListener('error', onError);
    file.arrayBuffer().then((buffer) => {
      worker.postMessage({ id, task, base: new URL('.', document.baseURI).href, buffer }, [buffer]);
    }, (e) => { done(); reject(e); });
  });
}

const prettyMB = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}MB` : `${Math.max(1, Math.round(n / 1e3))}KB`);

/** pdf-lib으로 PDF를 연다 (암호·손상 안내 포함) */
async function loadPdfLib(file) {
  const { PDFDocument } = await import('pdf-lib');
  try {
    return { PDFDocument, doc: await PDFDocument.load(await file.arrayBuffer(), { updateMetadata: false }) };
  } catch (e) {
    if (/encrypt/i.test(String(e?.message))) throw new ConvertError('암호가 걸린 PDF는 다룰 수 없습니다.');
    throw new ConvertError('PDF를 열 수 없습니다. 손상된 파일일 수 있습니다.');
  }
}

/** 여러 PDF를 목록 순서대로 하나로 합친다. */
export async function mergePdfs(files, name, ctx) {
  const { PDFDocument } = await import('pdf-lib');
  const merged = await PDFDocument.create();
  for (const [i, file] of files.entries()) {
    ctx.status(`합치는 중… (${i + 1}/${files.length})`);
    let doc;
    try {
      ({ doc } = await loadPdfLib(file));
    } catch (e) {
      throw new ConvertError(`${file.name}: ${e.message}`);
    }
    for (const page of await merged.copyPages(doc, doc.getPageIndices())) merged.addPage(page);
    ctx.progress((i + 1) / files.length);
  }
  return out(name, 'pdf', new Blob([await merged.save()], { type: MIME.pdf }));
}

async function convertPdf(file, target, ctx) {
  const stem = stemOf(file.name);
  if (target === 'docx') {
    const { buffer, failed } = await pdfTask(file, 'docx', ctx);
    const result = out(stem, 'docx', new Blob([buffer], { type: MIME.docx }));
    if (failed?.length) result.warning = `${failed.join(', ')}쪽은 변환하지 못해 빠졌습니다.`;
    return [result];
  }
  if (target === 'compress') {
    const { buffer } = await pdfTask(file, 'compress', ctx, '줄이는 중…');
    if (buffer.byteLength >= file.size * 0.97) {
      const result = out(`${stem}_압축`, 'pdf', file);
      result.note = '이미 작게 만들어진 PDF라 더 줄이지 못했습니다. 원본과 같은 파일입니다.';
      return [result];
    }
    const result = out(`${stem}_압축`, 'pdf', new Blob([buffer], { type: MIME.pdf }));
    result.note = `${prettyMB(file.size)} → ${prettyMB(buffer.byteLength)} (${Math.round((1 - buffer.byteLength / file.size) * 100)}% 줄임)`;
    return [result];
  }
  if (target === 'xlsx') {
    const { tables } = await pdfTask(file, 'tables', ctx, '표를 찾는 중…');
    if (!tables.length) throw new ConvertError('PDF에서 글자를 찾지 못했습니다. 사진으로 찍은(스캔한) PDF는 표를 꺼낼 수 없습니다.');
    const { makeXlsx, tablesToSheets } = await import('./xlsx.js');
    const result = out(stem, 'xlsx', new Blob([makeXlsx(tablesToSheets(tables))], { type: MIME.xlsx }));
    if (tables.every((t) => t.text)) result.note = '표 모양을 찾지 못해 글줄마다 한 행으로 넣었습니다.';
    return [result];
  }
  if (target === 'split') {
    ctx.status('나누는 중…');
    const { PDFDocument, doc: src } = await loadPdfLib(file);
    const count = src.getPageCount();
    const digits = String(count).length;
    const results = [];
    for (let i = 0; i < count; i++) {
      const one = await PDFDocument.create();
      const [page] = await one.copyPages(src, [i]);
      one.addPage(page);
      results.push(out(`${stem}-${String(i + 1).padStart(digits, '0')}`, 'pdf', new Blob([await one.save()], { type: MIME.pdf })));
      ctx.progress((i + 1) / count);
    }
    return results;
  }
  const { doc, close } = await openPdf(file);
  try {
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

// 나눔 글꼴에는 한자가 없어 한자만 담은 Noto 글꼴을 함께 넣는다.
// fc_local.conf: 글꼴 대체표 (한글 글꼴 이름 → 나눔 글꼴 등). 엔진의 같은 이름 파일을 덮어쓴다.
const LO_FILES = ['lo/soffice.wasm', 'lo/soffice.data'];
const FONTS = ['NanumGothic-Regular.ttf', 'NanumGothic-Bold.ttf', 'NanumMyeongjo-Regular.ttf', 'NanumMyeongjo-Bold.ttf',
  'NotoSerifKR-Hanja.ttf', 'NotoSansKR-Hanja.ttf', 'fc_local.conf'];
let officePromise = null;
let officeConverter = null;
const officeLocalFonts = []; // 엔진에 넣은 '내 컴퓨터 글꼴' ({filename, data, id})
let officeReport = () => {}; // 엔진이 보내는 진행 소식을 지금 하는 일(준비/변환)에 맞게 보여준다
let officeHeard = 0; // 엔진에게서 마지막으로 소식을 들은 시각

// LibreOffice가 문서를 여는 도중 가끔 멈춘다(라이브러리 문제, 수십 초~무한정). 소식이 이만큼 끊기면
// 멈춘 것으로 보고 엔진을 끈 뒤 새로 띄워 다시 시도한다.
const OFFICE_STALLED = new Error('LibreOffice stalled');
const OFFICE_RETRIES = 3;
const OFFICE_SETTLE = 5_000;

export const officeSupported = () => self.crossOriginIsolated === true;

/** 엔진을 바로 끈다. 멈춘 엔진은 destroy()에도 응답하지 않으므로 작업자(worker)를 직접 끝낸다. */
function stopOffice() {
  try { officeConverter?.worker?.terminate(); } catch { /* 무시 */ }
  officeConverter = null;
  officePromise = null;
}

// 페이지를 떠날 때(새로고침 포함) 엔진을 바로 끈다. 남아 있던 엔진이 다음 페이지의 엔진과 부딪혀 멈추는 일을 줄인다.
addEventListener('pagehide', () => stopOffice());

/** promise가 끝나기를 기다리되, 엔진 소식이 limit()(ms) 동안 없으면 OFFICE_STALLED로 끝낸다. */
function watchOffice(promise, limit) {
  officeHeard = Date.now();
  return new Promise((resolve, reject) => {
    const timer = setInterval(() => {
      if (Date.now() - officeHeard > limit()) { clearInterval(timer); reject(OFFICE_STALLED); }
    }, 1000);
    promise.then((v) => { clearInterval(timer); resolve(v); }, (e) => { clearInterval(timer); reject(e); });
  });
}

function loadOffice(status, localFonts = []) {
  // 처음 보는 '내 컴퓨터 글꼴'이 필요하면 엔진을 그 글꼴까지 넣어 새로 띄운다 (글꼴은 시작할 때만 넣을 수 있다)
  const fresh = localFonts.filter((f) => !officeLocalFonts.some((o) => o.id === f.id));
  if (fresh.length) {
    officeLocalFonts.push(...fresh);
    if (officePromise) stopOffice();
  }
  if (!officeSupported()) {
    // 서비스 워커는 준비됐는데 아직 적용 전이면(처음 방문 직후 파일을 바로 고른 경우) 새로고침하면 된다
    let reloaded = false;
    try { reloaded = !!sessionStorage.getItem('sw-reloaded'); } catch { /* 무시 */ }
    return Promise.reject(new ConvertError(navigator.serviceWorker?.controller && !reloaded
      ? '문서 변환을 준비하려면 페이지를 한 번 새로고침해 주세요.'
      : '이 브라우저에서는 문서 변환을 할 수 없습니다. 최신 크롬·엣지·사파리에서 열어 주세요.'));
  }
  officeReport = (info) => status(`준비 중… ${Math.round(info.percent)}%`);
  if (!officePromise) {
    officePromise = (async () => {
      status('준비 중… (처음 한 번 1~2분)');
      const { WorkerBrowserConverter } = await import('@matbee/libreoffice-converter/browser');
      const fonts = await Promise.all(FONTS.map(async (filename) => {
        const res = await fetch(asset(`fonts/${filename}`));
        if (!res.ok) throw new ConvertError(LOAD_FAILED);
        return { filename, data: new Uint8Array(await res.arrayBuffer()) };
      }));
      fonts.push(...officeLocalFonts.map(({ filename, data }) => ({ filename, data })));
      const converter = new WorkerBrowserConverter({
        sofficeJs: asset('lo/soffice.js'),
        sofficeWasm: await bigAsset('lo/soffice.wasm'),
        sofficeData: await bigAsset('lo/soffice.data'),
        sofficeWorkerJs: asset('lo/soffice.worker.js'),
        browserWorkerJs: asset('lo/browser.worker.js'),
        fonts,
        onProgress: (info) => { officeHeard = Date.now(); officeReport(info); },
      });
      officeConverter = converter;
      // 처음엔 엔진 파일(약 80MB)을 받는다. 받는 동안은 서비스 워커가 진행 상황을 알려 주므로
      // 받기가 멈추거나 엔진이 1분 동안 아무 소식이 없을 때만 멈춘 것으로 본다
      let shown = 0;
      onDownload = (path) => {
        if (!LO_FILES.includes(path)) return;
        officeHeard = Date.now();
        shown = Math.max(shown, Math.round((downloadedPart(LO_FILES) ?? 0) * 100));
        status(`준비 중… 엔진 받는 중 ${shown}%`);
      };
      try {
        await watchOffice(converter.initialize(), () => 60_000);
      } finally {
        onDownload = () => {};
      }
      // '준비 완료' 직후 바로 문서를 열면 LibreOffice가 자주 멈춘다(시험: 24번 중 13번). 5초 쉬면 한 번도
      // 멈추지 않았다(24번 중 0번). 처음 한 번만 기다리고, 그래도 멈추면 아래 감시가 다시 시작한다.
      status('준비 중… 거의 다 됐어요');
      await new Promise((r) => setTimeout(r, OFFICE_SETTLE));
      return converter;
    })().catch((e) => {
      stopOffice();
      if (e instanceof ConvertError || e === OFFICE_STALLED) throw e;
      console.error(e);
      throw new ConvertError('문서 변환 엔진을 불러오지 못했습니다. 인터넷 연결을 확인하고 페이지를 새로고침해 주세요.');
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
  docx: 'zip', docm: 'zip', dotx: 'zip', xlsx: 'zip', xlsm: 'zip', xlsb: 'zip', pptx: 'zip', pptm: 'zip', ppsx: 'zip',
  odt: 'zip', ods: 'zip', odp: 'zip', ppt: 'ole', pps: 'ole',
};

async function checkDocument(file) {
  const expected = EXPECTED_SIGNATURE[extOf(file.name)];
  if (!expected) return;
  const head = new Uint8Array(await file.slice(0, 8).arrayBuffer());
  const ok = [expected].flat().some((kind) => SIGNATURES[kind].every((b, i) => head[i] === b));
  if (!ok) throw new ConvertError('문서를 열 수 없습니다. 파일이 손상되었거나 확장자가 실제 형식과 다릅니다.');
}

async function convertOffice(file, target, ctx) {
  // 쪽마다 그림(JPG·PNG): PDF로 바꾼 뒤 쪽을 그린다
  if (target === 'jpg' || target === 'png') {
    const [pdf] = await convertOffice(file, 'pdf', { ...ctx, progress: (p) => ctx.progress(p * 0.7) });
    const pdfFile = new File([pdf.blob], `${stemOf(file.name)}.pdf`, { type: MIME.pdf });
    return convertPdf(pdfFile, target, { ...ctx, progress: (p) => ctx.progress(0.7 + p * 0.3) });
  }
  const { status, progress } = ctx;
  await checkDocument(file);
  // 문서가 쓰는 글꼴이 이 컴퓨터에 있으면(허락한 경우) 그 글꼴로 그린다
  let localFonts = [];
  try { localFonts = await localFontsFor([file], status); } catch (e) { console.warn('내 컴퓨터 글꼴을 읽지 못했습니다', e); }
  const data = new Uint8Array(await file.arrayBuffer());
  // 멈추는 곳은 '문서 여는' 단계(진행 30%)다. 평소엔 1~2초라 그 단계에서만 짧게 지켜본다
  // (큰 문서는 크기만큼 늘린다). 그 뒤의 실제 변환은 큰 문서면 오래 걸릴 수 있으니 넉넉히 기다린다.
  const openLimit = 20_000 + (file.size / 1_000_000) * 10_000;
  for (let attempt = 1; ; attempt++) {
    try {
      const converter = await loadOffice(status, localFonts);
      status('변환 중…');
      let percent = 0;
      officeReport = (info) => { percent = info.percent; progress(info.percent / 100); };
      const limit = () => (percent < 50 ? openLimit : 600_000);
      const result = await watchOffice(converter.convert(data, { outputFormat: target }, file.name), limit);
      // 엑셀(윈도우)에서 한글 CSV가 깨지지 않도록 UTF-8 표시(BOM)를 붙인다
      const body = target === 'csv' ? new Blob(['\uFEFF', result.data], { type: MIME.csv }) : result.data;
      return [out(stemOf(file.name), target, body)];
    } catch (e) {
      if (e === OFFICE_STALLED) {
        stopOffice();
        if (attempt < OFFICE_RETRIES) {
          console.warn(`문서 변환 엔진이 멈춰 다시 시작합니다 (${attempt}번째)`);
          status('잠시 멈춰서 다시 시도하는 중…');
          continue;
        }
        throw new ConvertError('문서 변환 엔진이 응답하지 않습니다. 페이지를 새로고침한 뒤 다시 시도해 주세요.');
      }
      if (e instanceof ConvertError) throw e;
      const msg = String(e?.message || e);
      if (/password/i.test(msg)) throw new ConvertError('암호가 걸린 문서는 변환할 수 없습니다.');
      console.error(e);
      throw new ConvertError('문서를 변환하지 못했습니다. 파일이 손상되었을 수 있습니다.');
    }
  }
}

// ---------------------------------------------------------------------------
// 한글 문서 (rhwp WebAssembly): 먼저 PDF로 그린 뒤, 다른 형식은 PDF에서 바꾼다
// ---------------------------------------------------------------------------

async function convertHwp(file, target, ctx) {
  const stem = stemOf(file.name);
  // 진행 막대: PDF 만들기와 그다음 변환(Word 등)을 나눠 보여 준다
  const share = target === 'pdf' ? 1 : target === 'docx' ? 0.3 : 0.6;
  let pdf;
  try {
    const { hwpToPdf, hwpToText } = await import('./hwp.js');
    if (target === 'txt') {
      ctx.status('변환 중…');
      return [out(stem, 'txt', new Blob([await hwpToText(file)], { type: MIME.txt }))];
    }
    pdf = await hwpToPdf(file, { status: ctx.status, progress: (p) => ctx.progress(p * share) }, { forWord: target === 'docx' });
  } catch (e) {
    if (e instanceof ConvertError) throw e;
    if (isLoadFailure(e)) throw new ConvertError(LOAD_FAILED);
    console.error(e);
    throw new ConvertError('한글 문서를 변환하지 못했습니다. 파일이 손상되었거나 아직 지원하지 않는 기능이 들어 있을 수 있습니다.');
  }
  if (target === 'pdf') return [out(stem, 'pdf', pdf)];
  const pdfFile = new File([pdf], `${stem}.pdf`, { type: MIME.pdf });
  return convertPdf(pdfFile, target, { ...ctx, progress: (p) => ctx.progress(share + p * (1 - share)) });
}

// ---------------------------------------------------------------------------

const ENGINES = { media: convertMedia, image: convertImage, pdf: convertPdf, office: convertOffice, hwp: convertHwp };

/**
 * @param {File} file
 * @param {string} target
 * @param {{status: (msg: string) => void, progress: (p: number) => void}} ctx
 * @returns {Promise<{name: string, blob: Blob}[]>}
 */
export async function convertFile(file, engine, target, ctx) {
  const up = UPSCALE[target];
  if (up) {
    const { upscaleImage, upscaleVideo } = await import('./upscale.js');
    return (engine === 'image' ? upscaleImage : upscaleVideo)(file, up, ctx);
  }
  return ENGINES[engine](file, target, ctx);
}

export { imagesToPdf };
