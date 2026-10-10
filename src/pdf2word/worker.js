// PDF → Word 변환 작업자. 브라우저용 파이썬(Pyodide)에서 pdf2docx를 돌린다 (화면이 멈추지 않게 따로).
// 처음 한 번 엔진(약 40MB)을 받고, 그 뒤로는 브라우저 저장소에서 바로 쓴다.
import convertSource from './convert.py?raw';

let ready = null; // Promise<pyodide>
let current = null; // 지금 하는 일의 id (진행 소식에 붙인다)

const post = (msg) => self.postMessage({ id: current, ...msg });

/** 내려받기 진행률을 알 수 있게 fetch를 감싼다 (Pyodide가 휠 파일을 받을 때 쓴다). */
function trackDownloads(total) {
  let loaded = 0;
  const original = self.fetch.bind(self);
  self.fetch = async (input, init) => {
    const res = await original(input, init);
    const url = typeof input === 'string' ? input : input.url;
    if (!/\.whl$/.test(url) || !res.body) return res;
    const reader = res.body.getReader();
    const stream = new ReadableStream({
      async pull(controller) {
        const { done, value } = await reader.read();
        if (done) { controller.close(); return; }
        loaded += value.byteLength;
        post({ type: 'progress', stage: 'load', value: Math.min(0.99, loaded / total) });
        controller.enqueue(value);
      },
      cancel(reason) { reader.cancel(reason); },
    });
    return new Response(stream, { status: res.status, statusText: res.statusText, headers: res.headers });
  };
  return () => { self.fetch = original; };
}

async function load(base) {
  const dir = `${base}pyodide/`;
  const sizes = await (await fetch(`${dir}wheels.json`)).json();
  const total = Object.values(sizes).reduce((a, b) => a + b, 0);
  const { loadPyodide } = await import(/* @vite-ignore */ `${dir}pyodide.mjs`);
  const py = await loadPyodide({ indexURL: dir });
  const restore = trackDownloads(total);
  try {
    await py.loadPackage(Object.keys(sizes).map((name) => dir + name), { messageCallback: () => {} });
  } finally {
    restore();
  }
  py.FS.writeFile('/home/pyodide/pdf2word_convert.py', convertSource);
  py.convert = py.pyimport('pdf2word_convert').convert;
  return py;
}

self.onmessage = async (event) => {
  const { id, base, buffer } = event.data;
  current = id;
  let stage = 'load';
  try {
    if (!ready) ready = load(base);
    const py = await ready.catch((e) => { ready = null; throw e; });
    stage = 'convert';
    post({ type: 'progress', stage, value: 0 });
    py.FS.writeFile('/in.pdf', new Uint8Array(buffer));
    const report = (p) => post({ type: 'progress', stage, value: p });
    const result = py.convert('/in.pdf', '/out.docx', report);
    const failed = result.toJs();
    result.destroy();
    const out = py.FS.readFile('/out.docx');
    py.FS.unlink('/in.pdf');
    py.FS.unlink('/out.docx');
    self.postMessage({ id, type: 'done', buffer: out.buffer, failed: Array.from(failed) }, [out.buffer]);
  } catch (e) {
    const message = String(e?.message || e);
    const code = stage === 'load' ? 'load' : /PASSWORD_REQUIRED/.test(message) ? 'password' : 'convert';
    console.error(e);
    self.postMessage({ id, type: 'error', code, message: message.slice(-500) });
  }
};
