// AI 화질 개선(업스케일). ONNX Runtime Web으로 브라우저 안에서 돌린다.
// 그래픽카드(WebGPU)를 쓸 수 있으면 빠르게, 없으면 CPU로 천천히 계산한다.
//
// 모델(models/fidelity-x4.onnx) = Real-ESRGAN realesr-general-wdn-x4v3 + 충실도 보정.
// AI가 키운 결과를 원래 크기로 다시 줄였을 때 원본과 같아지도록 3번 되돌려 고친다(역투영).
// 그래서 AI가 없는 무늬를 지어내거나 얼굴·글자·색을 바꾸는 왜곡이 크게 줄어든다.
// 모델을 고른 근거와 측정 결과는 scripts/model/README.md 참고.
import { ConvertError, extOf, stemOf } from './formats.js';
import { MAX_PIXELS, asset, bigAsset, canvasBlob, decodeImage, loadFFmpeg, out } from './engines.js';

const MODEL = { file: 'models/fidelity-x4.onnx', half: 'models/fidelity-x4-fp16.onnx', size: '5MB' };
// 원본과 얼마나 엄격하게 맞출지. 무손실 원본(PNG 등)은 그대로 맞추고, 손실 압축 원본(JPEG·동영상)은
// 압축 흔적·잡음까지 되살리지 않도록 작은 차이는 무시하고 큰 차이(모양·색 왜곡)만 고친다.
const STRICT = { core: 0, soft: 0 };
const LOSSY = { core: 0.015, soft: 1 };
const LOSSLESS = ['png', 'bmp', 'tif', 'tiff', 'gif'];
const PAD = 16; // 타일 경계가 티 나지 않도록 주변을 겹쳐서 계산한다
const WHOLE = 400_000; // 그래픽카드에서는 이 화소 수까지 한 번에 계산한다 (조각내면 느려진다)

let ortPromise = null;
let enginePromise = null;

function loadOrt() {
  ortPromise ??= (async () => {
    const ort = await import(/* @vite-ignore */ asset('ort/ort.webgpu.min.mjs'));
    ort.env.wasm.wasmPaths = {
      mjs: asset('ort/ort-wasm-simd-threaded.asyncify.mjs'),
      wasm: await bigAsset('ort/ort-wasm-simd-threaded.asyncify.wasm'),
    };
    // CPU로 계산할 때 모든 코어를 쓴다 (기본값은 절반)
    ort.env.wasm.numThreads = Math.min(16, navigator.hardwareConcurrency || 4);
    return ort;
  })().catch((e) => { ortPromise = null; throw e; });
  return ortPromise;
}

async function fetchModel(file, status) {
  const res = await fetch(asset(file));
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
    if (total) status(`AI 모델을 내려받는 중… ${Math.round((got / total) * 100)}% (처음 한 번, 약 ${MODEL.size})`);
  }
  return new Uint8Array(await new Blob(chunks).arrayBuffer());
}

function loadEngine(status) {
  enginePromise ??= (async () => {
    status(`AI 모델을 준비하는 중… (처음 한 번, 약 ${MODEL.size})`);
    const ort = await loadOrt();
    let adapter = null;
    try { adapter = await navigator.gpu?.requestAdapter(); } catch { /* 그래픽카드 가속 없음 */ }
    if (adapter) {
      // 반정밀도(fp16)를 지원하는 그래픽카드는 2배 가까이 빠르다. 결과 차이는 눈으로 구분되지 않는다(평균 0.1/255).
      const files = adapter.features.has('shader-f16') ? [MODEL.half, MODEL.file] : [MODEL.file];
      for (const file of files) {
        try {
          const session = await ort.InferenceSession.create(await fetchModel(file, status), { executionProviders: ['webgpu'] });
          return { ort, session, gpu: true };
        } catch (e) {
          console.warn(`WebGPU로 ${file}을(를) 쓸 수 없습니다`, e);
        }
      }
    }
    const session = await ort.InferenceSession.create(await fetchModel(MODEL.file, status), { executionProviders: ['wasm'] });
    return { ort, session, gpu: false };
  })().catch((e) => {
    enginePromise = null;
    if (e instanceof ConvertError) throw e;
    throw new ConvertError(`AI 모델을 불러오지 못했습니다. (${e?.message || e})`);
  });
  return enginePromise;
}

function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

/**
 * 화소(RGB 또는 RGBA)를 AI로 4배 키운 뒤 원하는 크기(outW×outH)로 맞춰 그린다.
 * 메모리를 아끼려고 조각(타일)마다 계산해서 바로 결과 캔버스에 그린다.
 */
async function enhance({ data, width: W, height: H, channels }, outW, outH, engine, fidelity, onTile) {
  const { ort, session, gpu } = engine;
  const tile = gpu ? (W * H <= WHOLE ? Math.max(W, H) : 512) : 128;
  const result = makeCanvas(outW, outH);
  const rctx = result.getContext('2d');
  rctx.imageSmoothingQuality = 'high';
  const piece = makeCanvas(1, 1);
  const pctx = piece.getContext('2d');
  const kx = outW / W;
  const ky = outH / H;
  const cols = Math.ceil(W / tile);
  const rows = Math.ceil(H / tile);
  const core = new ort.Tensor('float32', new Float32Array([fidelity.core]), [1]);
  const soft = new ort.Tensor('float32', new Float32Array([fidelity.soft]), [1]);

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
        let p = ((y0 + j) * W + x0) * channels;
        for (let i = 0; i < tw; i++, p += channels) {
          const q = j * tw + i;
          input[q] = data[p] / 255;
          input[plane + q] = data[p + 1] / 255;
          input[2 * plane + q] = data[p + 2] / 255;
        }
      }
      const feeds = { input: new ort.Tensor('float32', input, [1, 3, th, tw]), core, soft };
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
      await onTile?.(r * cols + c + 1, rows * cols);
    }
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
  const engine = await loadEngine(status);
  const W = bitmap.width;
  const H = bitmap.height;
  const [w, h] = fitSize(W, H, scale, MAX_PIXELS);
  const src = makeCanvas(W, H).getContext('2d', { willReadFrequently: true });
  src.drawImage(bitmap, 0, 0);
  const pixels = src.getImageData(0, 0, W, H).data;
  const ext = extOf(file.name);
  const fidelity = LOSSLESS.includes(ext) ? STRICT : LOSSY;

  const how = engine.gpu ? '그래픽카드' : 'CPU(그래픽카드 가속 없음, 느릴 수 있음)';
  status(`AI가 화질을 높이는 중… ${W}×${H} → ${w}×${h} · ${how}`);
  const started = Date.now();
  const canvas = await enhance({ data: pixels, width: W, height: H, channels: 4 }, w, h, engine, fidelity, async (i, n) => {
    status(`AI가 화질을 높이는 중… ${w}×${h} · ${how}${timeLeft(started, i, n)}`);
    progress(i / n);
    await nextFrame();
  });

  // 투명한 부분이 있으면 원본의 투명도를 그대로 살린다
  let transparent = false;
  for (let p = 3; p < pixels.length; p += 4) if (pixels[p] < 255) { transparent = true; break; }
  if (transparent) {
    const rctx = canvas.getContext('2d');
    const alpha = makeCanvas(w, h).getContext('2d', { willReadFrequently: true });
    alpha.imageSmoothingQuality = 'high';
    alpha.drawImage(bitmap, 0, 0, w, h);
    const a = alpha.getImageData(0, 0, w, h).data;
    const full = rctx.getImageData(0, 0, w, h);
    for (let p = 3; p < a.length; p += 4) full.data[p] = a[p];
    rctx.putImageData(full, 0, 0);
  }

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

const CHUNK_BYTES = 160_000_000; // 한 번에 풀어 두는 장면의 메모리 한도
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

/** 앞 장면과 사실상 같은 장면인지 (멈춘 화면·정지 장면은 AI 계산을 건너뛴다) */
function sameFrame(a, b) {
  if (!b) return false;
  for (let i = 0; i < a.length; i++) {
    const d = a[i] - b[i];
    if (d > 2 || d < -2) return false;
  }
  return true;
}

/**
 * 그래픽카드의 동영상 인코더(WebCodecs)를 쓸 수 있으면 준비한다. 없으면 null (ffmpeg로 인코딩).
 * 하드웨어 인코더는 ffmpeg(libx264)보다 수십 배 빠르다.
 */
async function makeEncoder(width, height, fps) {
  if (!('VideoEncoder' in self)) return null;
  const { Muxer, ArrayBufferTarget } = await import('mp4-muxer');
  const bitrate = Math.round(Math.min(80e6, Math.max(3e6, width * height * Number(fps) * 0.15)));
  // 호환성이 가장 좋은 H.264. (테스트용으로 VP9을 강제할 수 있다: 오픈소스 크로미움에는 H.264 인코더가 없다)
  let codecs = [['avc', 'avc1.640033'], ['avc', 'avc1.4d0033'], ['avc', 'avc1.420033']];
  try { if (localStorage.getItem('upscale-codec') === 'vp9') codecs = [['vp9', 'vp09.00.51.08']]; } catch { /* 무시 */ }
  for (const [kind, codec] of codecs) {
    for (const hardwareAcceleration of ['prefer-hardware', 'no-preference']) {
      const config = { codec, width, height, bitrate, framerate: Number(fps), hardwareAcceleration, latencyMode: 'quality' };
      if (kind === 'avc') config.avc = { format: 'avc' };
      let ok = false;
      try { ok = (await VideoEncoder.isConfigSupported(config)).supported; } catch { /* 지원 안 함 */ }
      if (!ok) continue;
      const muxer = new Muxer({
        target: new ArrayBufferTarget(),
        video: { codec: kind, width, height, frameRate: Number(fps) },
        fastStart: 'in-memory',
      });
      let failure = null;
      const encoder = new VideoEncoder({
        output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
        error: (e) => { failure = e; },
      });
      encoder.configure(config);
      const gop = Math.max(1, Math.round(Number(fps) * 2));
      let n = 0;
      return {
        kind,
        async add(canvas) {
          if (failure) throw failure;
          const frame = new VideoFrame(canvas, { timestamp: Math.round((n * 1e6) / Number(fps)), duration: Math.round(1e6 / Number(fps)) });
          encoder.encode(frame, { keyFrame: n % gop === 0 });
          frame.close();
          n++;
          while (encoder.encodeQueueSize > 4) await new Promise((r) => setTimeout(r, 1));
        },
        async finish() {
          await encoder.flush();
          if (failure) throw failure;
          encoder.close();
          muxer.finalize();
          return new Uint8Array(muxer.target.buffer);
        },
        close() { if (encoder.state !== 'closed') encoder.close(); },
      };
    }
  }
  return null;
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
  let encoder = null;

  await ff.createDir(dir);
  await ff.createDir(work);
  await ff.mount('WORKERFS', { files: [file] }, dir);
  ff.on('log', onLog);
  try {
    await ff.exec(['-hide_banner', '-i', input]); // 정보만 읽는다 (출력이 없어 실패 코드는 정상)
    const info = probe(log);
    if (!info) throw new ConvertError('동영상을 열 수 없습니다. 파일이 손상되었거나 영상이 없는 파일입니다.');
    // 첫 장면으로 실제 크기를 확인한다 (휴대폰 세로 영상의 회전 정보까지 반영된 크기)
    // (이 ffmpeg의 JPEG 인코더는 멈추므로 PNG)
    log.length = 0;
    await ff.exec(['-i', input, '-map', '0:v:0', '-frames:v', '1', `${work}/first.png`]);
    let first;
    try {
      first = await createImageBitmap(new Blob([await ff.readFile(`${work}/first.png`)], { type: 'image/png' }));
      await ff.deleteFile(`${work}/first.png`);
    } catch {
      throw fail('동영상을 읽지 못했습니다. 파일이 손상되었을 수 있습니다.');
    }
    const W = first.width;
    const H = first.height;
    first.close();
    const engine = await loadEngine(status);
    // 4K(3840×2160)를 넘지 않게, 짝수 크기로 (동영상 규격)
    let [ow, oh] = fitSize(W, H, scale, 3840 * 2160, 3840, 2160);
    ow -= ow % 2;
    oh -= oh % 2;
    encoder = await makeEncoder(ow, oh, info.fps);
    const how = `${engine.gpu ? '그래픽카드' : 'CPU(그래픽카드 가속 없음, 매우 느릴 수 있음)'}${encoder ? '' : ' · 인코딩도 CPU'}`;
    const total = Math.max(1, Math.ceil(info.duration * Number(info.fps)));
    const frameBytes = W * H * 3;
    const chunk = Math.max(4, Math.min(240, Math.floor(CHUNK_BYTES / (frameBytes + (encoder ? 0 : ow * oh * 4)))));
    status(`AI가 화질을 높이는 중… ${W}×${H} → ${ow}×${oh} · ${how}`);

    const segments = [];
    let done = 0;
    let skipped = 0;
    let prev = null;
    let prevCanvas = null;
    const started = Date.now();
    for (let k = 0; ; k++) {
      log.length = 0;
      // 압축하지 않은 화소 그대로 받는다 (PNG로 바꿨다 푸는 시간을 없앤다)
      const start = ((k * chunk) / Number(info.fps)).toFixed(6);
      await ff.exec(['-ss', start, '-i', input, '-map', '0:v:0', '-vf', `fps=${info.fps}`,
        '-frames:v', String(chunk), '-f', 'rawvideo', '-pix_fmt', 'rgb24', `${work}/in.raw`]);
      let raw;
      try {
        raw = await ff.readFile(`${work}/in.raw`);
        await ff.deleteFile(`${work}/in.raw`);
      } catch {
        raw = new Uint8Array(0);
      }
      const n = Math.floor(raw.length / frameBytes);
      if (!n) {
        if (k === 0) throw fail('동영상에서 장면을 읽지 못했습니다.');
        break;
      }
      const outFrames = encoder ? null : new Uint8Array(n * ow * oh * 4);
      for (let i = 0; i < n; i++) {
        const data = raw.subarray(i * frameBytes, (i + 1) * frameBytes);
        let canvas;
        if (sameFrame(data, prev)) {
          canvas = prevCanvas;
          skipped++;
        } else {
          canvas = await enhance({ data, width: W, height: H, channels: 3 }, ow, oh, engine, LOSSY);
        }
        prev = data;
        prevCanvas = canvas;
        if (encoder) await encoder.add(canvas);
        else outFrames.set(canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, ow, oh).data, i * ow * oh * 4);
        done++;
        progress(Math.min(0.99, done / total));
        const skip = skipped ? ` · 같은 장면 ${skipped}개 건너뜀` : '';
        status(`AI가 화질을 높이는 중… 장면 ${done}/${Math.max(done, total)} · ${ow}×${oh} · ${how}${skip}${timeLeft(started, done, Math.max(done, total))}`);
        await nextFrame();
      }
      if (!encoder) {
        // 하드웨어 인코더가 없으면 이번 묶음을 ffmpeg로 동영상 조각으로 만든다
        const seg = `seg${k}.mp4`;
        await ff.writeFile(`${work}/out.raw`, outFrames);
        log.length = 0;
        const enc = await ff.exec(['-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${ow}x${oh}`, '-framerate', info.fps,
          '-i', `${work}/out.raw`, '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '16', '-pix_fmt', 'yuv420p', `${work}/${seg}`]);
        await ff.deleteFile(`${work}/out.raw`).catch(() => {});
        if (enc !== 0) throw fail('동영상을 만들지 못했습니다.');
        segments.push(seg);
      }
      prev = prev && prev.slice(); // 다음 묶음과 비교할 수 있게 복사 (raw는 곧 버린다)
      if (n < chunk) break;
    }

    status('동영상으로 묶는 중…');
    let video;
    if (encoder) {
      await ff.writeFile(`${work}/video.mp4`, await encoder.finish());
      encoder = null;
      video = ['-i', `${work}/video.mp4`];
    } else {
      await ff.writeFile(`${work}/list.txt`, segments.map((s) => `file '${s}'`).join('\n'));
      video = ['-f', 'concat', '-safe', '0', '-i', `${work}/list.txt`];
    }
    // 소리는 가능하면 다시 압축하지 않고 그대로 옮긴다 (음질 손실 없음)
    const mux = (audio) => ff.exec([...video, ...(info.audio ? ['-i', input, '-map', '0:v', '-map', '1:a:0', ...audio, '-shortest'] : []),
      '-c:v', 'copy', '-movflags', '+faststart', output]);
    log.length = 0;
    let code = await mux(['-c:a', 'copy']);
    if (code !== 0 && info.audio) {
      await ff.deleteFile(output).catch(() => {});
      code = await mux(['-c:a', 'aac', '-b:a', '192k']);
    }
    if (code !== 0) throw fail('동영상을 만들지 못했습니다.');
    const data = await ff.readFile(output);
    await ff.deleteFile(output);
    return [out(`${stemOf(file.name)}_고화질${scale}배`, 'mp4', data)];
  } finally {
    encoder?.close();
    ff.off('log', onLog);
    for (const e of await ff.listDir(work).catch(() => [])) {
      if (!e.isDir) await ff.deleteFile(`${work}/${e.name}`).catch(() => {});
    }
    await ff.deleteDir(work).catch(() => {});
    await ff.unmount(dir).catch(() => {});
    await ff.deleteDir(dir).catch(() => {});
  }
}
