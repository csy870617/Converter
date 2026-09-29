# 간단 파일 변환기

MP4 → MP3, Word → PDF, 아이폰 사진(HEIC) → JPG처럼 자주 쓰는 파일 변환을
**끌어다 놓고 → 형식 누르고 → 변환하기** 세 단계로 끝내는 프로그램입니다.

- 인터넷 사이트에 파일을 올리지 않습니다. 모든 변환은 **내 컴퓨터 안에서** 이루어집니다.
- 여러 파일을 한 번에 변환할 수 있고, 결과가 여러 개면 ZIP 하나로 받습니다.
- 사진 여러 장을 **PDF 한 개로 합치기**도 됩니다.

## 지원 형식

| 종류 | 이런 파일을 | 이렇게 바꿀 수 있어요 |
|---|---|---|
| 동영상 | MP4, MOV, AVI, MKV, WEBM, WMV … | **MP3**, WAV, M4A, FLAC, OGG, MP4, WEBM, GIF |
| 오디오 | MP3, WAV, M4A, AAC, FLAC, OGG, WMA … | MP3, WAV, M4A, FLAC, OGG |
| 이미지 | JPG, PNG, WEBP, **HEIC**, BMP, GIF, TIFF | JPG, PNG, WEBP, **PDF**, ICO |
| Word 문서 | DOC, DOCX, ODT, RTF, TXT | **PDF**, DOCX |
| 프레젠테이션 | PPT, PPTX, ODP | **PDF**, PPTX |
| 스프레드시트 | XLS, XLSX, ODS, CSV | **PDF**, XLSX, CSV |
| PDF | PDF | **DOCX(Word)**, JPG, PNG, TXT |

## 설치 및 실행

### 1. 준비물 (한 번만)

1. **Python** — <https://www.python.org/downloads/>
   (Windows는 설치 첫 화면에서 **"Add python.exe to PATH"를 꼭 체크**하세요.)
2. **LibreOffice** (무료) — <https://www.libreoffice.org/download/download/>
   Word·Excel·PowerPoint 문서를 변환할 때만 필요합니다. 동영상·오디오·이미지·PDF 변환은 없어도 됩니다.

### 2. 실행

이 폴더를 내려받은 뒤(GitHub의 **Code → Download ZIP** 후 압축 풀기):

- **Windows**: `start.bat` 더블클릭
- **Mac**: `start.command` 더블클릭
  (처음에 "확인되지 않은 개발자" 경고가 나오면 파일을 **우클릭 → 열기**)
- **Linux**: 터미널에서 `./start.command`

처음 실행할 때만 필요한 부품을 자동으로 설치하느라 몇 분 걸립니다.
준비가 끝나면 브라우저에 변환기 화면이 자동으로 열립니다.
검은 창(터미널)을 닫으면 프로그램이 종료됩니다.

## 명령줄로 쓰기 (선택)

```bash
.venv/bin/python converters.py mp3 강의.mp4
.venv/bin/python converters.py pdf 보고서.docx 발표.pptx -o 결과폴더
```

## 개발자용

```bash
python -m venv .venv && .venv/bin/pip install -r requirements.txt pytest
.venv/bin/python -m pytest tests
```

- `converters.py` — 변환 엔진 (ffmpeg / LibreOffice / Pillow / PyMuPDF / pdf2docx)
- `app.py` — 로컬 웹 서버 (127.0.0.1 에서만 열림)
- `templates/index.html` — 화면
