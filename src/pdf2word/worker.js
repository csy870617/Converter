// PDF 작업자: 브라우저용 파이썬(Pyodide)에서 PDF를 다룬다 (화면이 멈추지 않게 따로).
//  - docx: PDF → Word (pdf2docx)
//  - compress: PDF 용량 줄이기 (PyMuPDF)
//  - tables: PDF 속 표 꺼내기 (PyMuPDF)
//  - decrypt: PDF 암호 풀기 (합치기·나누기 전에)
//  - office: 암호 걸린 Office 문서 풀기 (msoffcrypto-tool)
// 처음 한 번 필요한 엔진을 받고, 그 뒤로는 브라우저 저장소에서 바로 쓴다.
// 일마다 필요한 것만 받는다: PDF 도구는 PyMuPDF(약 20MB), Word 변환은 나머지(약 20MB)를 더, Office 암호 풀기는 약 2MB.
import convertSource from './convert.py?raw';
import toolsSource from './tools.py?raw';
import officeCryptoSource from './officecrypto.py?raw';

let pyodide = null; // Promise<{py, dir, sizes}>
const loaded = new Set(); // 이미 불러온 휠 파일
let current = null; // 지금 하는 일의 id (진행 소식에 붙인다)

const post = (msg) => self.postMessage({ id: current, ...msg });
// 일마다 필요한 휠 파일
const PDF_TOOLS = /^(pymupdf|fonttools)-/;
const NEEDS = {
  docx: /^(numpy|opencv_python|lxml|fonttools|typing_extensions|pymupdf|python_docx|pdf2docx)-/,
  compress: PDF_TOOLS,
  tables: PDF_TOOLS,
  decrypt: PDF_TOOLS,
  office: /^(cryptography|cffi|pycparser|six|libopenssl|olefile|msoffcrypto_tool)-/,
};
// 파이썬 패키지가 아니라 함께 쓰는 라이브러리(.zip)는 이름으로 불러야 제자리에 놓인다
const BY_NAME = { 'libopenssl-1.1.1w.zip': 'libopenssl' };

/** 내려받기 진행률을 알 수 있게 fetch를 감싼다 (Pyodide가 휠 파일을 받을 때 쓴다). */
function trackDownloads(total) {
  let received = 0;
  const original = self.fetch.bind(self);
  self.fetch = async (input, init) => {
    const res = await original(input, init);
    const url = typeof input === 'string' ? input : input.url;
    if (!/\.(whl|zip)$/.test(url) || !res.body) return res;
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
  py.FS.writeFile('/home/pyodide/office_crypto.py', officeCryptoSource);
  return { py, dir, sizes };
}

/** 이 일에 필요한 휠만 받아 불러온다. */
async function ready(base, task) {
  if (!pyodide) pyodide = startPython(base).catch((e) => { pyodide = null; throw e; });
  const { py, dir, sizes } = await pyodide;
  const need = Object.keys(sizes).filter((name) => !loaded.has(name) && NEEDS[task].test(name));
  if (need.length) {
    const restore = trackDownloads(need.reduce((sum, name) => sum + sizes[name], 0));
    try {
      // 라이브러리를 먼저 (cryptography가 openssl을 쓴다)
      const libs = need.filter((name) => BY_NAME[name]).map((name) => BY_NAME[name]);
      if (libs.length) await py.loadPackage(libs, { messageCallback: () => {} });
      await py.loadPackage(need.filter((name) => !BY_NAME[name]).map((name) => dir + name), { messageCallback: () => {} });
    } finally {
      restore();
    }
    need.forEach((name) => loaded.add(name));
  }
  return py;
}

self.onmessage = async (event) => {
  const { id, base, buffer, task = 'docx', password = null } = event.data;
  current = id;
  let stage = 'load';
  try {
    const py = await ready(base, task);
    stage = 'convert';
    post({ type: 'progress', stage, value: 0 });
    py.FS.writeFile('/in', new Uint8Array(buffer));
    const report = (p) => post({ type: 'progress', stage, value: p });
    try {
      if (task === 'tables') {
        const json = py.pyimport('pdf_tools').tables('/in', report, password);
        self.postMessage({ id, type: 'done', tables: JSON.parse(json) });
        return;
      }
      if (task === 'office' && !py.pyimport('office_crypto').decrypt('/in', '/out', password)) {
        self.postMessage({ id, type: 'done', decrypted: false }); // 암호가 걸려 있지 않다
        return;
      }
      let failed = [];
      if (task === 'compress' || task === 'decrypt') {
        py.pyimport('pdf_tools')[task]('/in', '/out', report, password);
      } else if (task === 'docx') {
        const result = py.pyimport('pdf2word_convert').convert('/in', '/out', report, password);
        failed = Array.from(result.toJs());
        result.destroy();
      }
      const out = py.FS.readFile('/out');
      py.FS.unlink('/out');
      self.postMessage({ id, type: 'done', buffer: out.buffer, failed, decrypted: true }, [out.buffer]);
    } finally {
      try { py.FS.unlink('/in'); } catch { /* 이미 지웠으면 그만 */ }
    }
  } catch (e) {
    const message = String(e?.message || e);
    const code = stage === 'load' ? 'load' : /PASSWORD_REQUIRED/.test(message) ? 'password' : 'convert';
    console.error(e);
    self.postMessage({ id, type: 'error', code, message: message.slice(-500) });
  }
};
