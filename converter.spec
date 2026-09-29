# PyInstaller 설정: 파이썬 설치 없이 실행되는 단일 실행 파일을 만든다.
#   pyinstaller converter.spec
import sys

from PyInstaller.utils.hooks import collect_all

datas = [("templates", "templates")]
binaries = []
hiddenimports = []
for pkg in ("imageio_ffmpeg", "pillow_heif", "pymupdf", "pdf2docx"):
    d, b, h = collect_all(pkg)
    datas += d
    binaries += b
    hiddenimports += h

a = Analysis(
    ["app.py"],
    datas=datas,
    binaries=binaries,
    hiddenimports=hiddenimports,
    excludes=["tkinter", "matplotlib", "pytest"],
)
pyz = PYZ(a.pure)
exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.datas,
    name="FileConverter",
    console=True,  # 검은 창을 닫으면 프로그램이 종료된다
    upx=False,
    icon="icon.ico" if sys.platform == "win32" else None,
)
