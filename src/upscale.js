// AI 화질 개선(업스케일). ONNX Runtime Web으로 브라우저 안에서 돌린다.
// 그래픽카드(WebGPU)를 쓸 수 있으면 빠르게, 없으면 CPU로 천천히 계산한다.
//
// 모델 = Real-ESRGAN(wdn-x4v3) + 충실도 보정.
// AI가 키운 결과를 원래 크기로 다시 줄였을 때 원본과 같아지도록 3번 되돌려 고친다(역투영).
// 그래서 AI가 없는 무늬를 지어내거나 얼굴·글자·색을 바꾸는 왜곡이 크게 줄어든다.
// 모델을 고른 근거와 측정 결과는 scripts/model/README.md 참고.
import { ConvertError, extOf, stemOf } from './formats.js';
import { MAX_PIXELS, asset, bigAsset, canvasBlob, decodeImage, loadFFmpegThreaded, out } from './engines.js';

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
          // 결과를 그래픽카드 메모리에 둔 채 받는다 (그래픽카드에서 바로 그림으로 바꾼 뒤 가져온다)
          const session = await ort.InferenceSession.create(await fetchModel(file, status),
            { executionProviders: ['webgpu'], preferredOutputLocation: 'gpu-buffer' });
          const device = await ort.env.webgpu.device;
          return { ort, session, gpu: true, device, painter: device ? new GpuPainter(device) : null };
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
 * AI 결과(그래픽카드 메모리의 숫자 배열)를 그래픽카드 안에서 바로 그림(RGBA 8비트)으로 바꾼다.
 * CPU로 수백만 개의 소수를 가져와 한 칸씩 옮기던 과정이 없어지고, 가져오는 양도 3분의 1로 준다.
 */
class GpuPainter {
  constructor(device) {
    this.device = device;
    this.pipeline = device.createComputePipeline({
      layout: 'auto',
      compute: {
        entryPoint: 'main',
        module: device.createShaderModule({ code: `
          struct P { tw: u32, th: u32, sx: u32, sy: u32, cw: u32, ch: u32, dx: u32, dy: u32 };
          @group(0) @binding(0) var<storage, read> src: array<f32>;
          @group(0) @binding(1) var dst: texture_storage_2d<rgba8unorm, write>;
          @group(0) @binding(2) var<uniform> p: P;
          @compute @workgroup_size(8, 8)
          fn main(@builtin(global_invocation_id) g: vec3u) {
            if (g.x >= p.cw || g.y >= p.ch) { return; }
            let plane = p.tw * p.th;
            let i = (g.y + p.sy) * p.tw + g.x + p.sx;
            let c = clamp(vec3f(src[i], src[plane + i], src[2u * plane + i]), vec3f(0.0), vec3f(1.0));
            textureStore(dst, vec2u(g.x + p.dx, g.y + p.dy), vec4f(c, 1.0));
          }` }),
      },
    });
    this.params = device.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.texture = null;
    this.readback = null;
  }

  /** w×h 크기의 그림판을 준비한다. 그래픽카드 한도를 넘으면 false. */
  begin(w, h) {
    if (w > this.device.limits.maxTextureDimension2D || h > this.device.limits.maxTextureDimension2D) return false;
    if (!this.texture || this.texture.width !== w || this.texture.height !== h) {
      this.texture?.destroy();
      this.texture = this.device.createTexture({
        size: [w, h], format: 'rgba8unorm', usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_SRC,
      });
      this.readback?.destroy();
      this.row = Math.ceil((w * 4) / 256) * 256; // 그래픽카드에서 가져올 때 줄 길이는 256바이트 단위
      this.readback = this.device.createBuffer({ size: this.row * h, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    }
    return true;
  }

  /** AI 결과 조각(tw×th)에서 (sx,sy)부터 cw×ch만큼을 그림판 (dx,dy)에 그린다. */
  paint(buffer, tw, th, sx, sy, cw, ch, dx, dy) {
    const { device } = this;
    device.queue.writeBuffer(this.params, 0, new Uint32Array([tw, th, sx, sy, cw, ch, dx, dy]));
    const group = device.createBindGroup({
      layout: this.pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer } },
        { binding: 1, resource: this.texture.createView() },
        { binding: 2, resource: { buffer: this.params } },
      ],
    });
    const enc = device.createCommandEncoder();
    const pass = enc.beginComputePass();
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, group);
    pass.dispatchWorkgroups(Math.ceil(cw / 8), Math.ceil(ch / 8));
    pass.end();
    device.queue.submit([enc.finish()]);
  }

  /** 다 그린 그림판을 가져온다. 줄 끝의 빈칸 때문에 그림 폭은 실제보다 넓을 수 있다. */
  async finish() {
    const { width, height } = this.texture;
    const enc = this.device.createCommandEncoder();
    enc.copyTextureToBuffer({ texture: this.texture }, { buffer: this.readback, bytesPerRow: this.row }, [width, height]);
    this.device.queue.submit([enc.finish()]);
    await this.readback.mapAsync(GPUMapMode.READ);
    const img = new ImageData(new Uint8ClampedArray(this.readback.getMappedRange().slice(0)), this.row / 4, height);
    this.readback.unmap();
    return img;
  }
}

/**
 * 화소(RGB 또는 RGBA)를 AI로 4배 키운 뒤 원하는 크기(outW×outH)로 맞춰 그린다.
 * 메모리를 아끼려고 조각(타일)마다 계산한다. result 캔버스를 주면 그 위에 그린다.
 */
async function enhance({ data, width: W, height: H, channels }, outW, outH, engine, fidelity, onTile, result = null) {
  const { ort, session, gpu, painter } = engine;
  const tile = gpu ? (W * H <= WHOLE ? Math.max(W, H) : 512) : 128;
  if (!result) result = makeCanvas(outW, outH);
  const rctx = result.getContext('2d');
  rctx.imageSmoothingQuality = 'high';
  // 그래픽카드 경로: 4배 결과 전체를 그래픽카드 그림판에 모은 뒤 한 번에 줄인다
  const onGpu = !!painter && painter.begin(W * 4, H * 4);
  const piece = onGpu ? null : makeCanvas(1, 1);
  const pctx = piece?.getContext('2d');
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
      const ow = tw * 4;
      const oh = th * 4;
      if (onGpu) {
        painter.paint(output.gpuBuffer, ow, oh, (x - x0) * 4, (y - y0) * 4, cw * 4, ch * 4, x * 4, y * 4);
      } else {
        const o = output.location === 'gpu-buffer' ? await output.getData() : output.data;
        const oplane = ow * oh;
        const img = new ImageData(ow, oh);
        const d = img.data;
        for (let q = 0, p = 0; q < oplane; q++, p += 4) {
          d[p] = o[q] * 255 + 0.5; // Uint8ClampedArray가 0~255로 잘라 준다
          d[p + 1] = o[oplane + q] * 255 + 0.5;
          d[p + 2] = o[2 * oplane + q] * 255 + 0.5;
          d[p + 3] = 255;
        }
        piece.width = ow;
        piece.height = oh;
        pctx.putImageData(img, 0, 0);
        const dx = Math.round(x * kx);
        const dy = Math.round(y * ky);
        const dw = Math.round((x + cw) * kx) - dx;
        const dh = Math.round((y + ch) * ky) - dy;
        rctx.drawImage(piece, (x - x0) * 4, (y - y0) * 4, cw * 4, ch * 4, dx, dy, dw, dh);
      }
      output.dispose?.();
      await onTile?.(r * cols + c + 1, rows * cols);
    }
  }
  if (onGpu) {
    const img = await painter.finish();
    const full = makeCanvas(img.width, img.height);
    full.getContext('2d').putImageData(img, 0, 0);
    rctx.drawImage(full, 0, 0, W * 4, H * 4, 0, 0, outW, outH);
  }
  return result;
}

/** 원하는 배율을 적용하되 너무 커지지 않게 줄인다. */
function fitSize(w, h, scale, maxPixels, maxLong = Infinity, maxShort = Infinity) {
  const k = Math.min(scale, Math.sqrt(maxPixels / (w * h)), maxLong / Math.max(w, h), maxShort / Math.min(w, h));
  return [Math.max(1, Math.round(w * k)), Math.max(1, Math.round(h * k))];
}

/** 동영상 결과 크기: 4K(3840×2160)를 넘지 않게, 짝수 크기로 (동영상 규격) */
function videoSize(w, h, scale) {
  const [ow, oh] = fitSize(w, h, scale, 3840 * 2160, 3840, 2160);
  return [ow - (ow % 2), oh - (oh % 2)];
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

/** 앞 장면과 사실상 같은 장면인지 (멈춘 화면·정지 장면은 AI 계산을 건너뛴다) */
function sameFrame(a, b) {
  if (!b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const d = a[i] - b[i];
    if (d > 2 || d < -2) return false;
  }
  return true;
}

/**
 * 장면을 하나씩 받아 AI로 키우는 도우미. 같은 장면이 이어지면 앞 결과를 다시 쓴다.
 * 결과는 캔버스 두 장을 번갈아 쓴다 (인코더가 앞 장면을 읽는 동안 다음 장면을 그릴 수 있게).
 */
function frameUpscaler(engine, ow, oh, onFrame) {
  const canvases = [makeCanvas(ow, oh), makeCanvas(ow, oh)];
  let prev = null;
  let prevCanvas = null;
  let n = 0;
  let skipped = 0;
  return {
    get skipped() { return skipped; },
    async next(frame) {
      let canvas;
      if (sameFrame(frame.data, prev)) {
        canvas = prevCanvas;
        skipped++;
      } else {
        canvas = await enhance(frame, ow, oh, engine, LOSSY, null, canvases[n++ % 2]);
      }
      prev = frame.data.slice();
      prevCanvas = canvas;
      await onFrame();
      return canvas;
    },
  };
}

/** 원하는 코덱(기본 H.264, 테스트용 VP9)과 그 코덱을 브라우저가 인코딩할 수 있는지 */
async function pickCodec(mb, w, h) {
  let codec = 'avc';
  try { if (localStorage.getItem('upscale-codec') === 'vp9') codec = 'vp9'; } catch { /* 무시 */ }
  const ok = await mb.canEncodeVideo(codec, { width: w, height: h, quality: mb.QUALITY_VERY_HIGH }).catch(() => false);
  return ok ? codec : null;
}

/**
 * 빠른 길: 브라우저(그래픽카드)가 직접 동영상을 풀고(디코딩) 다시 묶는다(인코딩). ffmpeg가 필요 없다.
 * 풀 수 없거나 묶을 수 없는 형식이면 null을 돌려준다.
 */
async function upscaleVideoWebCodecs(file, scale, { status, progress }) {
  if (!('VideoEncoder' in self) || !('VideoDecoder' in self)) return null;
  const mb = await import('mediabunny');
  const input = new mb.Input({ source: new mb.BlobSource(file), formats: mb.ALL_FORMATS });
  let conversion = null;
  try {
    let track;
    try { track = await input.getPrimaryVideoTrack(); } catch { return null; }
    if (!track || !(await track.canDecode())) return null;
    const W = track.displayWidth;
    const H = track.displayHeight;
    const [ow, oh] = videoSize(W, H, scale);
    const codec = await pickCodec(mb, ow, oh);
    if (!codec) return null;

    const engine = await loadEngine(status);
    const how = engine.gpu ? '그래픽카드' : 'CPU(그래픽카드 가속 없음, 매우 느릴 수 있음)';
    const duration = await input.computeDuration();
    const stats = await track.computePacketStats(120).catch(() => null);
    const total = Math.max(1, Math.round(duration * (stats?.averagePacketRate || 30)));
    const started = Date.now();
    let done = 0;
    const reader = makeCanvas(W, H).getContext('2d', { willReadFrequently: true });
    const upscaler = frameUpscaler(engine, ow, oh, async () => {
      done++;
      const skip = upscaler.skipped ? ` · 같은 장면 ${upscaler.skipped}개 건너뜀` : '';
      status(`AI가 화질을 높이는 중… 장면 ${done}/${Math.max(done, total)} · ${ow}×${oh} · ${how}${skip}${timeLeft(started, done, Math.max(done, total))}`);
      progress(Math.min(0.99, done / total));
      await nextFrame();
    });
    status(`AI가 화질을 높이는 중… ${W}×${H} → ${ow}×${oh} · ${how}`);

    const output = new mb.Output({ format: new mb.Mp4OutputFormat({ fastStart: 'in-memory' }), target: new mb.BufferTarget() });
    conversion = await mb.Conversion.init({
      input,
      output,
      tracks: 'primary',
      showWarnings: false,
      video: {
        codec,
        quality: mb.QUALITY_VERY_HIGH,
        forceTranscode: true,
        allowTransformationMetadata: false, // 휴대폰 세로 영상 회전을 장면에 반영한 뒤 AI에 넣는다
        keyFrameInterval: 2,
        processedWidth: ow,
        processedHeight: oh,
        process: async (sample) => {
          const w = sample.displayWidth;
          const h = sample.displayHeight;
          if (reader.canvas.width !== w || reader.canvas.height !== h) { reader.canvas.width = w; reader.canvas.height = h; }
          sample.draw(reader, 0, 0, w, h);
          const frame = { data: reader.getImageData(0, 0, w, h).data, width: w, height: h, channels: 4 };
          return upscaler.next(frame);
        },
      },
      audio: {}, // 소리는 가능하면 다시 압축하지 않고 그대로 옮긴다
    });
    // 소리를 옮길 수 없어 빠지게 되면 ffmpeg 길로 처리한다 (소리 없는 결과를 만들지 않는다)
    if (!conversion.isValid || conversion.discardedTracks.some((d) => d.track.type === 'audio')) return null;
    await conversion.execute();
    return [out(`${stemOf(file.name)}_고화질${scale}배`, 'mp4', output.target.buffer)];
  } finally {
    if (conversion && conversion.state === 'executing') await conversion.cancel?.().catch(() => {});
    input.dispose?.();
  }
}

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

/** 브라우저 인코더로 캔버스를 H.264(또는 테스트용 VP9) MP4로 묶는다. 쓸 수 없으면 null. */
async function makeEncoder(w, h, fps) {
  if (!('VideoEncoder' in self)) return null;
  const mb = await import('mediabunny');
  const codec = await pickCodec(mb, w, h);
  if (!codec) return null;
  const canvas = makeCanvas(w, h);
  const ctx = canvas.getContext('2d');
  const output = new mb.Output({ format: new mb.Mp4OutputFormat({ fastStart: 'in-memory' }), target: new mb.BufferTarget() });
  const source = new mb.CanvasSource(canvas, { codec, quality: mb.QUALITY_VERY_HIGH, keyFrameInterval: 2 });
  output.addVideoTrack(source, { frameRate: Number(fps) });
  await output.start();
  let n = 0;
  return {
    async add(frame) {
      ctx.drawImage(frame, 0, 0);
      await source.add(n / Number(fps), 1 / Number(fps));
      n++;
    },
    async finish() {
      await output.finalize();
      return new Uint8Array(output.target.buffer);
    },
    close() { if (output.state !== 'finalized' && output.state !== 'canceled') output.cancel().catch(() => {}); },
  };
}

/** 느린 길: ffmpeg로 동영상을 풀고, 브라우저 인코더가 없으면 ffmpeg로 다시 묶는다. */
async function upscaleVideoFFmpeg(file, scale, { status, progress }) {
  const ff = await loadFFmpegThreaded(status);
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
    const [ow, oh] = videoSize(W, H, scale);
    encoder = await makeEncoder(ow, oh, info.fps);
    const how = `${engine.gpu ? '그래픽카드' : 'CPU(그래픽카드 가속 없음, 매우 느릴 수 있음)'}${encoder ? '' : ' · 인코딩도 CPU'}`;
    const total = Math.max(1, Math.ceil(info.duration * Number(info.fps)));
    const frameBytes = W * H * 3;
    const chunk = Math.max(4, Math.min(240, Math.floor(CHUNK_BYTES / (frameBytes + (encoder ? 0 : ow * oh * 4)))));
    status(`AI가 화질을 높이는 중… ${W}×${H} → ${ow}×${oh} · ${how}`);

    const segments = [];
    let done = 0;
    const started = Date.now();
    const upscaler = frameUpscaler(engine, ow, oh, async () => {
      done++;
      progress(Math.min(0.99, done / total));
      const skip = upscaler.skipped ? ` · 같은 장면 ${upscaler.skipped}개 건너뜀` : '';
      status(`AI가 화질을 높이는 중… 장면 ${done}/${Math.max(done, total)} · ${ow}×${oh} · ${how}${skip}${timeLeft(started, done, Math.max(done, total))}`);
      await nextFrame();
    });
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
        const canvas = await upscaler.next({ data, width: W, height: H, channels: 3 });
        if (encoder) await encoder.add(canvas);
        else outFrames.set(canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, ow, oh).data, i * ow * oh * 4);
      }
      if (!encoder) {
        // 브라우저 인코더가 없으면 이번 묶음을 ffmpeg로 동영상 조각으로 만든다
        const seg = `seg${k}.mp4`;
        await ff.writeFile(`${work}/out.raw`, outFrames);
        log.length = 0;
        const enc = await ff.exec(['-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${ow}x${oh}`, '-framerate', info.fps,
          '-i', `${work}/out.raw`, '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '16', '-pix_fmt', 'yuv420p', `${work}/${seg}`]);
        await ff.deleteFile(`${work}/out.raw`).catch(() => {});
        if (enc !== 0) throw fail('동영상을 만들지 못했습니다.');
        segments.push(seg);
      }
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

export async function upscaleVideo(file, scale, ctx) {
  let result = null;
  try {
    result = await upscaleVideoWebCodecs(file, scale, ctx);
  } catch (e) {
    if (e instanceof ConvertError) throw e;
    console.warn('브라우저 동영상 처리 실패, ffmpeg로 다시 시도합니다', e);
  }
  return result ?? upscaleVideoFFmpeg(file, scale, ctx);
}
