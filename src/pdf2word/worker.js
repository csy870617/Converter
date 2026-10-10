// PDF 작업자: 브라우저용 파이썬(Pyodide)에서 PDF를 다룬다 (화면이 멈추지 않게 따로).
//  - docx: PDF → Word (pdf2docx)
//  - compress: PDF 용량 줄이기 (PyMuPDF)
//  - tables: PDF 속 표 꺼내기 (PyMuPDF)
// 처음 한 번 필요한 엔진을 받고, 그 뒤로는 브라우저 저장소에서 바로 쓴다.
// 용량 줄이기·표 꺼내기는 PyMuPDF만 받고(약 20MB), Word 변환은 나머지(약 20MB)를 더 받는다.
import convertSource from './convert.py?raw';
import toolsSource from './tools.py?raw';

let pyodide = null; // Promise<{py, dir, sizes}>
const loaded = new Set(); // 이미 불러온 휠 파일
let current = null; // 지금 하는 일의 id (진행 소식에 붙인다)

const post = (msg) => self.postMessage({ id: current, ...msg });
const TOOLS_WHEELS = /^(pymupdf|fonttools)-/;

/** 내려받기 진행률을 알 수 있게 fetch를 감싼다 (Pyodide가 휠 파일을 받을 때 쓴다). */
function trackDownloads(total) {
  let received = 0;
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
        received += value.byteLength;
        post({ type: 'progress', stage: 'load', value: Math.min(0.99, received / total) });
        controller.enqueue(value);
      },
      cancel(reason) { reader.cancel(reason); },
    });
    return new Response(stream, { status: res.status, statusText: res.statusText, headers: res.headers });
  };
  return () => { self.fetch = original; };
}

async function startPython(base) {
  const dir = `${base}pyodide/`;
  const sizes = await (await fetch(`${dir}wheels.json`)).json();
  const { loadPyodide } = await import(/* @vite-ignore */ `${dir}pyodide.mjs`);
  // 파이썬이 찍는 진행 기록(pdf2docx 로그)은 개발자 도구의 '자세히' 수준으로만 남긴다
  const py = await loadPyodide({ indexURL: dir, stdout: (t) => console.debug(t), stderr: (t) => console.debug(t) });
  py.FS.writeFile('/home/pyodide/pdf2word_convert.py', convertSource);
  py.FS.writeFile('/home/pyodide/pdf_tools.py', toolsSource);
  return { py, dir, sizes };
}

/** 이 일에 필요한 휠만 받아 불러온다. */
async function ready(base, task) {
  if (!pyodide) pyodide = startPython(base).catch((e) => { pyodide = null; throw e; });
  const { py, dir, sizes } = await pyodide;
  const need = Object.keys(sizes).filter((name) => !loaded.has(name) && (task === 'docx' || TOOLS_WHEELS.test(name)));
  if (need.length) {
    const restore = trackDownloads(need.reduce((sum, name) => sum + sizes[name], 0));
    try {
      await py.loadPackage(need.map((name) => dir + name), { messageCallback: () => {} });
    } finally {
      restore();
    }
    need.forEach((name) => loaded.add(name));
  }
  return py;
}

self.onmessage = async (event) => {
  const { id, base, buffer, task = 'docx' } = event.data;
  current = id;
  let stage = 'load';
  try {
    const py = await ready(base, task);
    stage = 'convert';
    post({ type: 'progress', stage, value: 0 });
    py.FS.writeFile('/in.pdf', new Uint8Array(buffer));
    const report = (p) => post({ type: 'progress', stage, value: p });
    try {
      if (task === 'tables') {
        const json = py.pyimport('pdf_tools').tables('/in.pdf', report);
        self.postMessage({ id, type: 'done', tables: JSON.parse(json) });
        return;
      }
      let failed = [];
      if (task === 'compress') {
        py.pyimport('pdf_tools').compress('/in.pdf', '/out', report);
      } else {
        const result = py.pyimport('pdf2word_convert').convert('/in.pdf', '/out', report);
        failed = Array.from(result.toJs());
        result.destroy();
      }
      const out = py.FS.readFile('/out');
      py.FS.unlink('/out');
      self.postMessage({ id, type: 'done', buffer: out.buffer, failed }, [out.buffer]);
    } finally {
      try { py.FS.unlink('/in.pdf'); } catch { /* 이미 지웠으면 그만 */ }
    }
  } catch (e) {
    const message = String(e?.message || e);
    const code = stage === 'load' ? 'load' : /PASSWORD_REQUIRED/.test(message) ? 'password' : 'convert';
    console.error(e);
    self.postMessage({ id, type: 'error', code, message: message.slice(-500) });
  }
};
