// AI 화질 개선(업스케일). Real-ESRGAN 모델을 ONNX Runtime Web으로 브라우저 안에서 돌린다.
// 그래픽카드(WebGPU)를 쓸 수 있으면 빠르게, 없으면 CPU로 천천히 계산한다.
// 단순히 크기만 늘리는 보간과 달리, 흐린 윤곽과 뭉개진 질감을 AI가 새로 그려 넣어 선명해진다.
import { ConvertError, extOf, stemOf } from './formats.js';
import { MAX_PIXELS, asset, bigAsset, canvasBlob, decodeImage, loadFFmpeg, out } from './engines.js';

const MODELS = {
  // 사진용: 가장 선명하지만 무겁다 (그래픽카드가 있을 때만 사용)
  photo: { file: 'models/realesrgan-x4plus.onnx', size: '67MB', gpuTile: 192, cpuTile: 64 },
  // 범용·동영상용: 가볍고 빠르다
  fast: { file: 'models/realesr-general-x4v3.onnx', size: '5MB', gpuTile: 384, cpuTile: 128 },
};
const PAD = 16; // 타일 경계가 티 나지 않도록 주변을 겹쳐서 계산한다
const PHOTO_MAX_INPUT = 2_000_000; // 이보다 큰 사진은 무거운 모델로는 너무 오래 걸린다

let ortPromise = null;
let gpuPromise = null;
const sessions = new Map();

function loadOrt() {
  ortPromise ??= (async () => {
    const ort = await import(/* @vite-ignore */ asset('ort/ort.webgpu.min.mjs'));
    ort.env.wasm.wasmPaths = {
      mjs: asset('ort/ort-wasm-simd-threaded.asyncify.mjs'),
      wasm: await bigAsset('ort/ort-wasm-simd-threaded.asyncify.wasm'),
    };
    return ort;
  })().catch((e) => { ortPromise = null; throw e; });
  return ortPromise;
}

function hasGpu() {
  gpuPromise ??= (async () => {
    try { return !!(await navigator.gpu?.requestAdapter()); } catch { return false; }
  })();
  return gpuPromise;
}

async function fetchModel(model, status) {
  const res = await fetch(asset(model.file));
  if (!res.ok) throw new ConvertError('AI 모델을 받지 못했습니다. 인터넷 연결을 확인해 주세요.');
  const total = Number(res.headers.get('Content-Length')) || 0;
  const reader = res.body.getReader();
  const chunks = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    got += value.length;
    if (total) status(`AI 모델을 내려받는 중… ${Math.round((got / total) * 100)}% (처음 한 번, 약 ${model.size})`);
  }
  return new Uint8Array(await new Blob(chunks).arrayBuffer());
}

async function loadModel(kind, status) {
  if (!sessions.has(kind)) {
    const promise = (async () => {
      const model = MODELS[kind];
      status(`AI 모델을 준비하는 중… (처음 한 번, 약 ${model.size})`);
      const ort = await loadOrt();
      const data = await fetchModel(model, status);
      const gpu = await hasGpu();
      if (gpu) {
        try {
          const session = await ort.InferenceSession.create(data, { executionProviders: ['webgpu'] });
          return { ort, session, gpu: true, tile: model.gpuTile };
        } catch (e) {
          console.warn('WebGPU 사용 불가, CPU로 계산합니다', e);
        }
      }
      const session = await ort.InferenceSession.create(data, { executionProviders: ['wasm'] });
      return { ort, session, gpu: false, tile: model.cpuTile };
    })().catch((e) => {
      sessions.delete(kind);
      if (e instanceof ConvertError) throw e;
      throw new ConvertError(`AI 모델을 불러오지 못했습니다. (${e?.message || e})`);
    });
    sessions.set(kind, promise);
  }
  return sessions.get(kind);
}

function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

/**
 * 이미지를 AI로 4배 키운 뒤 원하는 크기(outW×outH)로 맞춰 그린다.
 * 메모리를 아끼려고 조각(타일)마다 계산해서 바로 결과 캔버스에 그린다.
 */
async function enhance(source, outW, outH, engine, onTile) {
  const { ort, session, tile } = engine;
  const W = source.width;
  const H = source.height;
  const src = makeCanvas(W, H).getContext('2d', { willReadFrequently: true });
  src.drawImage(source, 0, 0);
  const pixels = src.getImageData(0, 0, W, H).data;

  const result = makeCanvas(outW, outH);
  const rctx = result.getContext('2d');
  rctx.imageSmoothingQuality = 'high';
  const piece = makeCanvas(1, 1);
  const pctx = piece.getContext('2d');
  const kx = outW / W;
  const ky = outH / H;
  const cols = Math.ceil(W / tile);
  const rows = Math.ceil(H / tile);

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const x = c * tile;
      const y = r * tile;
      const cw = Math.min(tile, W - x);
      const ch = Math.min(tile, H - y);
      const x0 = Math.max(0, x - PAD);
      const y0 = Math.max(0, y - PAD);
      const tw = Math.min(W, x + cw + PAD) - x0;
      const th = Math.min(H, y + ch + PAD) - y0;

      const plane = tw * th;
      const input = new Float32Array(3 * plane);
      for (let j = 0; j < th; j++) {
        let p = ((y0 + j) * W + x0) * 4;
        for (let i = 0; i < tw; i++, p += 4) {
          const q = j * tw + i;
          input[q] = pixels[p] / 255;
          input[plane + q] = pixels[p + 1] / 255;
          input[2 * plane + q] = pixels[p + 2] / 255;
        }
      }
      const feeds = { input: new ort.Tensor('float32', input, [1, 3, th, tw]) };
      const { output } = await session.run(feeds);
      const o = output.data;
      const ow = tw * 4;
      const oh = th * 4;
      const oplane = ow * oh;
      const img = new ImageData(ow, oh);
      const d = img.data;
      for (let q = 0, p = 0; q < oplane; q++, p += 4) {
        d[p] = o[q] * 255 + 0.5; // Uint8ClampedArray가 0~255로 잘라 준다
        d[p + 1] = o[oplane + q] * 255 + 0.5;
        d[p + 2] = o[2 * oplane + q] * 255 + 0.5;
        d[p + 3] = 255;
      }
      output.dispose?.();
      piece.width = ow;
      piece.height = oh;
      pctx.putImageData(img, 0, 0);

      const dx = Math.round(x * kx);
      const dy = Math.round(y * ky);
      const dw = Math.round((x + cw) * kx) - dx;
      const dh = Math.round((y + ch) * ky) - dy;
      rctx.drawImage(piece, (x - x0) * 4, (y - y0) * 4, cw * 4, ch * 4, dx, dy, dw, dh);
      await onTile(r * cols + c + 1, rows * cols);
    }
  }

  // 투명한 부분이 있으면 원본의 투명도를 그대로 살린다
  let transparent = false;
  for (let p = 3; p < pixels.length; p += 4) if (pixels[p] < 255) { transparent = true; break; }
  if (transparent) {
    const alpha = makeCanvas(outW, outH).getContext('2d', { willReadFrequently: true });
    alpha.imageSmoothingQuality = 'high';
    alpha.drawImage(source, 0, 0, outW, outH);
    const a = alpha.getImageData(0, 0, outW, outH).data;
    const full = rctx.getImageData(0, 0, outW, outH);
    for (let p = 3; p < a.length; p += 4) full.data[p] = a[p];
    rctx.putImageData(full, 0, 0);
  }
  return result;
}

/** 원하는 배율을 적용하되 너무 커지지 않게 줄인다. */
function fitSize(w, h, scale, maxPixels, maxLong = Infinity, maxShort = Infinity) {
  const k = Math.min(scale, Math.sqrt(maxPixels / (w * h)), maxLong / Math.max(w, h), maxShort / Math.min(w, h));
  return [Math.max(1, Math.round(w * k)), Math.max(1, Math.round(h * k))];
}

function timeLeft(started, done, total) {
  if (done < 1) return '';
  const sec = ((Date.now() - started) / done) * (total - done) / 1000;
  if (sec < 60) return ` · 약 ${Math.max(1, Math.round(sec))}초 남음`;
  if (sec < 3600) return ` · 약 ${Math.round(sec / 60)}분 남음`;
  return ` · 약 ${(sec / 3600).toFixed(1)}시간 남음`;
}

const nextFrame = () => new Promise((r) => setTimeout(r, 0)); // 화면이 멈추지 않게 잠깐 양보

// ---------------------------------------------------------------------------
// 사진
// ---------------------------------------------------------------------------

export async function upscaleImage(file, scale, { status, progress }) {
  const bitmap = await decodeImage(file);
  const inputPixels = bitmap.width * bitmap.height;
  const kind = (await hasGpu()) && inputPixels <= PHOTO_MAX_INPUT ? 'photo' : 'fast';
  const engine = await loadModel(kind, status);
  const [w, h] = fitSize(bitmap.width, bitmap.height, scale, MAX_PIXELS);
  const how = engine.gpu ? '그래픽카드' : 'CPU(그래픽카드 가속 없음, 느릴 수 있음)';
  status(`AI가 화질을 높이는 중… ${bitmap.width}×${bitmap.height} → ${w}×${h} · ${how}`);
  const started = Date.now();
  const canvas = await enhance(bitmap, w, h, engine, async (i, n) => {
    status(`AI가 화질을 높이는 중… ${w}×${h} · ${how}${timeLeft(started, i, n)}`);
    progress(i / n);
    await nextFrame();
  });

  const ext = extOf(file.name);
  const name = `${stemOf(file.name)}_고화질${scale}배`;
  if (ext === 'jpg' || ext === 'jpeg') return [out(name, 'jpg', await canvasBlob(canvas, 'image/jpeg', 0.95))];
  if (ext === 'webp') {
    const blob = await canvasBlob(canvas, 'image/webp', 0.95);
    if (blob.type === 'image/webp') return [out(name, 'webp', blob)];
  }
  return [out(name, 'png', await canvasBlob(canvas, 'image/png'))];
}

// ---------------------------------------------------------------------------
// 동영상: 장면(프레임)을 한 장씩 AI로 키운 뒤 다시 동영상으로 묶는다
// ---------------------------------------------------------------------------

const CHUNK = 48; // 한 번에 풀어 두는 프레임 수 (메모리 절약)
let videoJob = 0;

function probe(log) {
  const text = log.join('\n');
  const dur = /Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/.exec(text);
  const video = log.find((l) => /Stream #.*Video:/.test(l));
  if (!video) return null;
  const fps = /(\d+(?:\.\d+)?) fps/.exec(video) || /(\d+(?:\.\d+)?) tbr/.exec(video);
  return {
    duration: dur ? Number(dur[1]) * 3600 + Number(dur[2]) * 60 + Number(dur[3]) : 0,
    fps: fps && Number(fps[1]) > 0 && Number(fps[1]) <= 120 ? fps[1] : '30',
    audio: log.some((l) => /Stream #.*Audio:/.test(l)),
  };
}

export async function upscaleVideo(file, scale, { status, progress }) {
  const ff = await loadFFmpeg(status);
  const id = ++videoJob;
  const dir = `/up${id}`;
  const work = `/upw${id}`;
  const input = `${dir}/${file.name}`;
  const output = `/upout${id}.mp4`;
  const log = [];
  const onLog = ({ message }) => { log.push(message); if (log.length > 200) log.shift(); };
  const fail = (msg) => {
    const reason = log.filter((l) => /error|invalid/i.test(l)).slice(-2).join('\n');
    return new ConvertError(`${msg}${reason ? `\n(${reason})` : ''}`);
  };

  await ff.createDir(dir);
  await ff.createDir(work);
  await ff.mount('WORKERFS', { files: [file] }, dir);
  ff.on('log', onLog);
  try {
    await ff.exec(['-hide_banner', '-i', input]); // 정보만 읽는다 (출력이 없어 실패 코드는 정상)
    const info = probe(log);
    if (!info) throw new ConvertError('동영상을 열 수 없습니다. 파일이 손상되었거나 영상이 없는 파일입니다.');
    const engine = await loadModel('fast', status);
    const how = engine.gpu ? '그래픽카드' : 'CPU(그래픽카드 가속 없음, 매우 느릴 수 있음)';
    const total = Math.max(1, Math.ceil(info.duration * Number(info.fps)));

    const segments = [];
    let done = 0;
    let size = null;
    const started = Date.now();
    for (let k = 0; ; k++) {
      log.length = 0;
      const start = ((k * CHUNK) / Number(info.fps)).toFixed(6);
      const code = await ff.exec(['-ss', start, '-i', input, '-map', '0:v:0', '-vf', `fps=${info.fps}`,
        '-frames:v', String(CHUNK), `${work}/f%05d.png`]); // (이 ffmpeg의 JPEG 인코더는 멈추므로 PNG)
      const frames = (await ff.listDir(work)).map((e) => e.name).filter((n) => /^f\d+\.png$/.test(n)).sort();
      if (!frames.length) {
        if (k === 0) throw fail(code === 0 ? '동영상에서 장면을 읽지 못했습니다.' : '동영상을 읽지 못했습니다. 파일이 손상되었을 수 있습니다.');
        break;
      }
      for (const [i, name] of frames.entries()) {
        const bitmap = await createImageBitmap(new Blob([await ff.readFile(`${work}/${name}`)], { type: 'image/png' }));
        await ff.deleteFile(`${work}/${name}`);
        if (!size) {
          // 4K(3840×2160)를 넘지 않게, 짝수 크기로 (동영상 규격)
          const [w, h] = fitSize(bitmap.width, bitmap.height, scale, 3840 * 2160, 3840, 2160);
          size = [w - (w % 2), h - (h % 2)];
          status(`AI가 화질을 높이는 중… ${bitmap.width}×${bitmap.height} → ${size[0]}×${size[1]} · ${how}`);
        }
        const canvas = await enhance(bitmap, size[0], size[1], engine, nextFrame);
        bitmap.close();
        const jpg = await canvasBlob(canvas, 'image/jpeg', 0.95);
        await ff.writeFile(`${work}/o${String(i + 1).padStart(5, '0')}.jpg`, new Uint8Array(await jpg.arrayBuffer()));
        done++;
        progress(Math.min(0.99, done / total));
        status(`AI가 화질을 높이는 중… 장면 ${done}/${Math.max(done, total)} · ${size[0]}×${size[1]} · ${how}${timeLeft(started, done, Math.max(done, total))}`);
      }
      // 이번 묶음을 동영상 조각으로 만들고 사진들은 지운다
      const seg = `seg${k}.mp4`;
      log.length = 0;
      const enc = await ff.exec(['-framerate', info.fps, '-i', `${work}/o%05d.jpg`, '-c:v', 'libx264', '-preset', 'veryfast',
        '-crf', '18', '-pix_fmt', 'yuv420p', '-r', info.fps, `${work}/${seg}`]);
      for (let i = 1; i <= frames.length; i++) await ff.deleteFile(`${work}/o${String(i).padStart(5, '0')}.jpg`).catch(() => {});
      if (enc !== 0) throw fail('동영상을 만들지 못했습니다.');
      segments.push(seg);
      if (frames.length < CHUNK) break;
    }

    status('동영상으로 묶는 중…');
    await ff.writeFile(`${work}/list.txt`, segments.map((s) => `file '${s}'`).join('\n'));
    log.length = 0;
    const args = ['-f', 'concat', '-safe', '0', '-i', `${work}/list.txt`];
    if (info.audio) args.push('-i', input, '-map', '0:v', '-map', '1:a:0', '-c:a', 'aac', '-b:a', '192k', '-shortest');
    const code = await ff.exec([...args, '-c:v', 'copy', '-movflags', '+faststart', output]);
    if (code !== 0) throw fail('동영상을 만들지 못했습니다.');
    const data = await ff.readFile(output);
    await ff.deleteFile(output);
    return [out(`${stemOf(file.name)}_고화질${scale}배`, 'mp4', data)];
  } finally {
    ff.off('log', onLog);
    for (const e of await ff.listDir(work).catch(() => [])) {
      if (!e.isDir) await ff.deleteFile(`${work}/${e.name}`).catch(() => {});
    }
    await ff.deleteDir(work).catch(() => {});
    await ff.unmount(dir).catch(() => {});
    await ff.deleteDir(dir).catch(() => {});
  }
}
