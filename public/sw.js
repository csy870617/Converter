// 서비스 워커: GitHub Pages에서 할 수 없는 두 가지를 대신 해 준다.
//  1) COOP/COEP 헤더를 붙여 SharedArrayBuffer를 쓸 수 있게 한다 (문서 변환 엔진에 필요).
//  2) 큰 WebAssembly 파일은 .gz로 올려 두고, 요청이 오면 받아서 풀어 준다.
const GZIPPED = ['lo/soffice.wasm', 'lo/soffice.data', 'ffmpeg/ffmpeg-core.wasm', 'ffmpeg-mt/ffmpeg-core.wasm', 'ort/ort-wasm-simd-threaded.asyncify.wasm'];

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

function withIsolation(response, extra = {}) {
  if (response.status === 0) return response; // opaque 응답은 건드릴 수 없다
  const headers = new Headers(response.headers);
  headers.set('Cross-Origin-Opener-Policy', 'same-origin');
  headers.set('Cross-Origin-Embedder-Policy', 'require-corp');
  headers.set('Cross-Origin-Resource-Policy', 'same-origin');
  for (const [k, v] of Object.entries(extra)) headers.set(k, v);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

// 큰 파일을 받는 동안 페이지에 진행 상황을 알린다 (엔진을 띄우는 쪽은 이 파일을 직접 받지 않아 알 길이 없다).
async function report(path, loaded, total) {
  for (const client of await self.clients.matchAll({ type: 'window' })) client.postMessage({ type: 'download', path, loaded, total });
}

function counted(body, rel, total) {
  let loaded = 0;
  let last = 0;
  return body.pipeThrough(new TransformStream({
    transform(chunk, controller) {
      loaded += chunk.byteLength;
      if (Date.now() - last > 250) { last = Date.now(); report(rel, loaded, total); }
      controller.enqueue(chunk);
    },
    flush() { report(rel, loaded, loaded); },
  }));
}

async function gunzip(url, rel) {
  const res = await fetch(`${url.href}.gz`);
  if (!res.ok) return res;
  // 서버가 이미 풀어서 보냈다면(Content-Encoding: gzip) 그대로 쓴다.
  const alreadyDecoded = /gzip/i.test(res.headers.get('Content-Encoding') || '');
  const raw = counted(res.body, rel, alreadyDecoded ? 0 : Number(res.headers.get('Content-Length')) || 0);
  const body = alreadyDecoded ? raw : raw.pipeThrough(new DecompressionStream('gzip'));
  const type = rel.endsWith('.wasm') ? 'application/wasm' : 'application/octet-stream';
  const headers = new Headers({ 'Content-Type': type });
  return withIsolation(new Response(body, { status: 200, headers }));
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.cache === 'only-if-cached' && req.mode !== 'same-origin') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  const rel = url.pathname.slice(new URL(self.registration.scope).pathname.length);
  if (GZIPPED.includes(rel)) {
    event.respondWith(gunzip(url, rel));
    return;
  }
  event.respondWith(fetch(req).then((res) => withIsolation(res)));
});
