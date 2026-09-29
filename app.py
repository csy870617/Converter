"""간단 파일 변환기 - 내 컴퓨터에서만 동작하는 웹 화면.

실행하면 브라우저가 자동으로 열린다. 파일은 인터넷으로 나가지 않는다.
"""

from __future__ import annotations

import json
import re
import shutil
import socket
import sys
import tempfile
import threading
import webbrowser
import zipfile
from pathlib import Path
from urllib.parse import quote

from flask import Flask, jsonify, render_template, request, send_file

import converters

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = 4 * 1024**3  # 4GB


def safe_name(name: str) -> str:
    """한글 이름은 살리고, 경로나 윈도우에서 금지된 문자만 제거한다."""
    name = Path(name.replace("\\", "/")).name
    name = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", name).strip(" .")
    return name or "file"


@app.get("/")
def index():
    categories = [
        {"name": name, "exts": sorted(exts), "targets": targets}
        for name, exts, targets in converters.CATEGORIES
    ]
    return render_template(
        "index.html",
        categories=categories,
        office_exts=sorted(converters.OFFICE_EXTS),
        has_office=converters.find_soffice() is not None,
    )


@app.post("/convert")
def convert():
    target = (request.form.get("target") or "").lower()
    merge = request.form.get("merge") == "1"
    uploads = request.files.getlist("files")
    if not uploads or not target:
        return jsonify(error="파일과 변환 형식을 선택해 주세요."), 400

    work = Path(tempfile.mkdtemp(prefix="converter-"))
    try:
        in_dir, out_dir = work / "in", work / "out"
        in_dir.mkdir()
        out_dir.mkdir()
        sources = []
        for up in uploads:
            path = converters.unique_path(in_dir, *_split(safe_name(up.filename or "file")))
            up.save(path)
            sources.append(path)

        outputs, errors = [], []
        if merge and target == "pdf" and len(sources) > 1 and all(
            converters.ext_of(s) in converters.IMAGE_EXTS for s in sources
        ):
            try:
                outputs = converters.images_to_single_pdf(sources, out_dir, sources[0].stem)
            except converters.ConversionError as e:
                errors.append(f"{sources[0].name}: {e}")
        else:
            for src in sources:
                try:
                    outputs += converters.convert(src, out_dir, target)
                except converters.ConversionError as e:
                    errors.append(f"{src.name}: {e}")
                except Exception as e:  # 예상치 못한 오류도 화면에 알려준다
                    errors.append(f"{src.name}: 알 수 없는 오류 ({e})")

        if not outputs:
            shutil.rmtree(work, ignore_errors=True)
            return jsonify(error="\n\n".join(errors) or "변환된 파일이 없습니다."), 400

        if len(outputs) == 1:
            result = outputs[0]
        else:
            result = work / "변환결과.zip"
            with zipfile.ZipFile(result, "w", zipfile.ZIP_DEFLATED) as zf:
                for out in outputs:
                    zf.write(out, out.name)

        response = send_file(result, as_attachment=True, download_name=result.name)
        if errors:
            response.headers["X-Convert-Errors"] = quote(json.dumps(errors, ensure_ascii=False))
        response.call_on_close(lambda: shutil.rmtree(work, ignore_errors=True))
        return response
    except Exception:
        shutil.rmtree(work, ignore_errors=True)
        raise


def _split(name: str) -> tuple[str, str]:
    p = Path(name)
    return p.stem, p.suffix.lstrip(".")


@app.errorhandler(413)
def too_large(_):
    return jsonify(error="파일이 너무 큽니다. (최대 4GB)"), 413


def free_port(start: int = 8765) -> int:
    for port in range(start, start + 50):
        with socket.socket() as s:
            try:
                s.bind(("127.0.0.1", port))
                return port
            except OSError:
                continue
    raise RuntimeError("사용 가능한 포트를 찾지 못했습니다.")


def main() -> None:
    port = free_port()
    url = f"http://127.0.0.1:{port}"
    print(f"\n  파일 변환기가 실행되었습니다 → {url}")
    print("  이 창을 닫으면 프로그램이 종료됩니다.\n")
    if "--no-browser" not in sys.argv:
        threading.Timer(1.0, lambda: webbrowser.open(url)).start()
    app.run(host="127.0.0.1", port=port, threaded=True)


if __name__ == "__main__":
    main()
