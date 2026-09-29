"""파일 변환 엔진.

각 변환 함수는 (입력 파일, 출력 폴더)를 받아 만들어진 파일 경로 목록을 돌려준다.
외부 도구:
  - 동영상/오디오: ffmpeg (imageio-ffmpeg 패키지에 포함된 실행 파일을 우선 사용)
  - 문서(Word/Excel/PowerPoint): LibreOffice
  - 이미지: Pillow (+ pillow-heif 로 아이폰 HEIC 지원)
  - PDF: PyMuPDF, pdf2docx
"""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

VIDEO_EXTS = {"mp4", "mov", "avi", "mkv", "webm", "wmv", "flv", "m4v", "3gp", "mpg", "mpeg", "ts"}
AUDIO_EXTS = {"mp3", "wav", "m4a", "aac", "flac", "ogg", "wma", "opus", "amr"}
IMAGE_EXTS = {"jpg", "jpeg", "png", "webp", "heic", "heif", "bmp", "gif", "tif", "tiff", "ico"}
WORD_EXTS = {"doc", "docx", "odt", "rtf", "txt"}
SLIDE_EXTS = {"ppt", "pptx", "odp"}
SHEET_EXTS = {"xls", "xlsx", "ods", "csv"}
PDF_EXTS = {"pdf"}

AUDIO_TARGETS = ["mp3", "wav", "m4a", "flac", "ogg"]
VIDEO_TARGETS = ["mp4", "webm", "gif"] + AUDIO_TARGETS
IMAGE_TARGETS = ["jpg", "png", "webp", "pdf", "ico"]
WORD_TARGETS = ["pdf", "docx"]
SLIDE_TARGETS = ["pdf", "pptx"]
SHEET_TARGETS = ["pdf", "xlsx", "csv"]
PDF_TARGETS = ["docx", "jpg", "png", "txt"]

# 화면에 보여줄 분류 (이름, 확장자 집합, 변환 가능한 형식)
CATEGORIES = [
    ("동영상", VIDEO_EXTS, VIDEO_TARGETS),
    ("오디오", AUDIO_EXTS, AUDIO_TARGETS),
    ("이미지", IMAGE_EXTS, IMAGE_TARGETS),
    ("Word 문서", WORD_EXTS, WORD_TARGETS),
    ("프레젠테이션", SLIDE_EXTS, SLIDE_TARGETS),
    ("스프레드시트", SHEET_EXTS, SHEET_TARGETS),
    ("PDF", PDF_EXTS, PDF_TARGETS),
]

OFFICE_EXTS = WORD_EXTS | SLIDE_EXTS | SHEET_EXTS


class ConversionError(Exception):
    """사용자에게 그대로 보여줄 수 있는 변환 오류."""


def ext_of(path: str | Path) -> str:
    return Path(path).suffix.lower().lstrip(".")


def targets_for(filename: str) -> list[str]:
    """이 파일을 변환할 수 있는 형식 목록 (자기 자신의 형식은 제외)."""
    ext = ext_of(filename)
    for _, exts, targets in CATEGORIES:
        if ext in exts:
            ext = {"jpeg": "jpg", "tif": "tiff"}.get(ext, ext)
            return [t for t in targets if t != ext]
    return []


# ---------------------------------------------------------------------------
# 외부 프로그램 찾기
# ---------------------------------------------------------------------------

def find_ffmpeg() -> str | None:
    try:
        import imageio_ffmpeg

        return imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:
        return shutil.which("ffmpeg")


def find_soffice() -> str | None:
    for name in ("soffice", "libreoffice"):
        found = shutil.which(name)
        if found:
            return found
    candidates = []
    if sys.platform == "win32":
        for base in (os.environ.get("PROGRAMFILES"), os.environ.get("PROGRAMFILES(X86)")):
            if base:
                candidates.append(os.path.join(base, "LibreOffice", "program", "soffice.exe"))
    elif sys.platform == "darwin":
        candidates.append("/Applications/LibreOffice.app/Contents/MacOS/soffice")
    return next((c for c in candidates if os.path.exists(c)), None)


def unique_path(folder: Path, stem: str, ext: str) -> Path:
    path = folder / f"{stem}.{ext}"
    n = 2
    while path.exists():
        path = folder / f"{stem} ({n}).{ext}"
        n += 1
    return path


def _run(cmd: list[str], what: str, timeout: int = 60 * 60) -> None:
    kwargs = {}
    if sys.platform == "win32":
        kwargs["creationflags"] = subprocess.CREATE_NO_WINDOW
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, errors="replace", timeout=timeout, **kwargs)
    except subprocess.TimeoutExpired:
        raise ConversionError(f"{what} 변환 시간이 너무 오래 걸려 중단했습니다.")
    if proc.returncode != 0:
        tail = "\n".join((proc.stderr or proc.stdout).strip().splitlines()[-3:])
        raise ConversionError(f"{what} 변환에 실패했습니다.\n{tail}")


# ---------------------------------------------------------------------------
# 동영상 / 오디오 (ffmpeg)
# ---------------------------------------------------------------------------

FFMPEG_ARGS = {
    "mp3": ["-vn", "-c:a", "libmp3lame", "-q:a", "2"],
    "wav": ["-vn", "-c:a", "pcm_s16le"],
    "m4a": ["-vn", "-c:a", "aac", "-b:a", "192k"],
    "flac": ["-vn", "-c:a", "flac"],
    "ogg": ["-vn", "-c:a", "libvorbis", "-q:a", "5"],
    "mp4": ["-c:v", "libx264", "-preset", "fast", "-crf", "23", "-pix_fmt", "yuv420p",
            "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart"],
    "webm": ["-c:v", "libvpx-vp9", "-crf", "32", "-b:v", "0", "-deadline", "realtime",
             "-cpu-used", "8", "-c:a", "libopus"],
    "gif": ["-vf", "fps=12,scale='min(640,iw)':-2:flags=lanczos,split[a][b];[a]palettegen[p];[b][p]paletteuse",
            "-loop", "0"],
}


def convert_media(src: Path, out_dir: Path, target: str) -> list[Path]:
    ffmpeg = find_ffmpeg()
    if not ffmpeg:
        raise ConversionError("ffmpeg를 찾을 수 없습니다. 프로그램을 다시 설치해 주세요.")
    out = unique_path(out_dir, src.stem, target)
    _run([ffmpeg, "-hide_banner", "-y", "-i", str(src), *FFMPEG_ARGS[target], str(out)], "미디어")
    return [out]


# ---------------------------------------------------------------------------
# 문서 (LibreOffice)
# ---------------------------------------------------------------------------

OFFICE_FILTERS = {
    "pdf": "pdf",
    "docx": "docx:MS Word 2007 XML",
    "pptx": "pptx:Impress MS PowerPoint 2007 XML",
    "xlsx": "xlsx:Calc MS Excel 2007 XML",
    "csv": "csv:Text - txt - csv (StarCalc):44,34,76",
}


def convert_office(src: Path, out_dir: Path, target: str) -> list[Path]:
    soffice = find_soffice()
    if not soffice:
        raise ConversionError(
            "문서 변환에는 무료 프로그램 LibreOffice가 필요합니다.\n"
            "https://www.libreoffice.org 에서 설치한 뒤 다시 시도해 주세요."
        )
    with tempfile.TemporaryDirectory() as work:
        work = Path(work)
        # 이미 열려 있는 LibreOffice와 충돌하지 않도록 별도 사용자 프로필을 쓴다.
        profile = (work / "profile").as_uri()
        lo_out = work / "out"
        _run([soffice, f"-env:UserInstallation={profile}", "--headless", "--norestore",
              "--convert-to", OFFICE_FILTERS[target], "--outdir", str(lo_out), str(src)], "문서", timeout=10 * 60)
        made = sorted(lo_out.glob(f"*.{target}"))
        if not made:
            raise ConversionError("문서 변환 결과가 만들어지지 않았습니다. 파일이 손상되었거나 암호가 걸려 있을 수 있습니다.")
        out = unique_path(out_dir, src.stem, target)
        shutil.move(str(made[0]), out)
        return [out]


# ---------------------------------------------------------------------------
# 이미지 (Pillow)
# ---------------------------------------------------------------------------

def _open_image(src: Path):
    from PIL import Image, ImageOps

    try:
        import pillow_heif

        pillow_heif.register_heif_opener()
    except ImportError:
        pass
    try:
        img = Image.open(src)
        img.load()
    except Exception:
        raise ConversionError("이미지를 열 수 없습니다. 지원하지 않는 형식이거나 손상된 파일입니다.")
    return ImageOps.exif_transpose(img)  # 휴대폰 사진 회전 방향 보정


def _flatten(img):
    """투명 배경을 흰색으로 채운 RGB 이미지 (JPG/PDF용)."""
    from PIL import Image

    if img.mode in ("RGBA", "LA") or (img.mode == "P" and "transparency" in img.info):
        img = img.convert("RGBA")
        bg = Image.new("RGB", img.size, "white")
        bg.paste(img, mask=img.getchannel("A"))
        return bg
    return img.convert("RGB")


def convert_image(src: Path, out_dir: Path, target: str) -> list[Path]:
    img = _open_image(src)
    out = unique_path(out_dir, src.stem, target)
    if target == "jpg":
        _flatten(img).save(out, "JPEG", quality=92)
    elif target == "pdf":
        _flatten(img).save(out, "PDF", resolution=150)
    elif target == "png":
        img.save(out, "PNG")
    elif target == "webp":
        img.save(out, "WEBP", quality=90)
    elif target == "ico":
        sizes = [(s, s) for s in (16, 32, 48, 64, 128, 256) if s <= max(img.size)] or [(16, 16)]
        img.convert("RGBA").save(out, "ICO", sizes=sizes)
    return [out]


def images_to_single_pdf(sources: list[Path], out_dir: Path, name: str = "images") -> list[Path]:
    """여러 이미지를 한 개의 PDF로 합친다."""
    pages = [_flatten(_open_image(s)) for s in sources]
    out = unique_path(out_dir, name, "pdf")
    pages[0].save(out, "PDF", resolution=150, save_all=True, append_images=pages[1:])
    return [out]


# ---------------------------------------------------------------------------
# PDF
# ---------------------------------------------------------------------------

def convert_pdf(src: Path, out_dir: Path, target: str) -> list[Path]:
    if target == "docx":
        from pdf2docx import Converter

        out = unique_path(out_dir, src.stem, "docx")
        try:
            cv = Converter(str(src))
            try:
                cv.convert(str(out))
            finally:
                cv.close()
        except Exception as e:
            raise ConversionError(f"PDF를 Word로 바꾸지 못했습니다. ({e})")
        return [out]

    import pymupdf

    try:
        doc = pymupdf.open(src)
    except Exception:
        raise ConversionError("PDF를 열 수 없습니다. 손상되었거나 암호가 걸린 파일일 수 있습니다.")
    with doc:
        if doc.needs_pass:
            raise ConversionError("암호가 걸린 PDF는 변환할 수 없습니다.")
        if target == "txt":
            out = unique_path(out_dir, src.stem, "txt")
            out.write_text("\n\n".join(page.get_text() for page in doc), encoding="utf-8")
            return [out]
        outputs = []
        for i, page in enumerate(doc, start=1):
            stem = src.stem if len(doc) == 1 else f"{src.stem}-{i:0{len(str(len(doc)))}d}"
            out = unique_path(out_dir, stem, target)
            pix = page.get_pixmap(dpi=200, alpha=False)
            if target == "png":
                pix.save(out)
            else:
                pix.pil_save(out, format="JPEG", quality=92)
            outputs.append(out)
        return outputs


# ---------------------------------------------------------------------------
# 진입점
# ---------------------------------------------------------------------------

def convert(src: str | Path, out_dir: str | Path, target: str) -> list[Path]:
    src, out_dir = Path(src), Path(out_dir)
    target = target.lower()
    if target not in targets_for(src.name):
        raise ConversionError(f"'{src.name}' 파일은 {target.upper()}(으)로 변환할 수 없습니다.")
    out_dir.mkdir(parents=True, exist_ok=True)
    ext = ext_of(src)
    if ext in VIDEO_EXTS | AUDIO_EXTS:
        return convert_media(src, out_dir, target)
    if ext in IMAGE_EXTS:
        return convert_image(src, out_dir, target)
    if ext in OFFICE_EXTS:
        return convert_office(src, out_dir, target)
    if ext in PDF_EXTS:
        return convert_pdf(src, out_dir, target)
    raise ConversionError(f"지원하지 않는 파일 형식입니다: {src.name}")


def main(argv: list[str] | None = None) -> int:
    """명령줄 사용: python converters.py <형식> <파일...> [-o 출력폴더]"""
    import argparse

    p = argparse.ArgumentParser(description="간단 파일 변환기")
    p.add_argument("target", help="바꿀 형식 (예: mp3, pdf, jpg)")
    p.add_argument("files", nargs="+", help="변환할 파일")
    p.add_argument("-o", "--out", default=None, help="저장할 폴더 (기본: 원본과 같은 폴더)")
    args = p.parse_args(argv)
    failed = 0
    for f in args.files:
        try:
            for out in convert(f, args.out or Path(f).parent, args.target):
                print(f"✔ {f} → {out}")
        except ConversionError as e:
            failed += 1
            print(f"✘ {f}: {e}", file=sys.stderr)
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
