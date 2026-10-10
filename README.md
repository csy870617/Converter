# 파일 변환기

MP4 → MP3, Word → PDF, PDF → Word, 한글(HWP) → PDF, 아이폰 사진(HEIC) → JPG처럼 자주 쓰는 파일 변환을
**끌어다 놓고 → 형식 누르고 → 변환하기** 세 단계로 끝내는 웹사이트입니다.

- 설치할 것이 없습니다. 주소만 열면 바로 사용합니다.
- 파일은 서버로 올라가지 않습니다. 모든 변환은 **사용자의 브라우저 안에서** 이루어집니다.
- 여러 파일을 한 번에 변환할 수 있고, 결과가 여러 개면 ZIP 하나로 받습니다.
- 사진 여러 장을 PDF 한 개로, PDF 여러 개를 하나로 합칠 수 있습니다.
- **PDF 도구**: 용량 줄이기, 쪽 나누기, 합치기, PDF 속 표를 엑셀로 꺼내기.
- **암호가 걸린 파일**(카드 명세서 PDF, 암호 걸린 엑셀·Word·한글 문서)은 암호를 물어서 변환합니다. 암호는 그 변환에만 쓰고 어디에도 저장하거나 보내지 않습니다.
- **AI 화질 개선**: 흐릿하거나 작은 사진·동영상을 2배/4배로 키우면서 선명하게 만듭니다.

## 지원 형식

| 종류 | 이런 파일을 | 이렇게 바꿀 수 있어요 |
|---|---|---|
| 동영상 | MP4, MOV, AVI, MKV, WEBM, WMV, FLV, M2TS·MTS(캠코더), VOB, RM·RMVB … | MP4, MOV, AVI, WEBM, GIF, **MP3**, WAV, M4A, **고화질 2배·4배** |
| 오디오 | MP3, WAV, M4A, AAC, FLAC, OGG, WMA, OPUS, AIFF, APE … | MP3, WAV, M4A, AAC, FLAC, OGG, OPUS, **M4R(아이폰 벨소리)** |
| 이미지 | JPG, PNG, WEBP, **HEIC**, AVIF, BMP, GIF, TIFF, SVG, ICO | JPG, PNG, WEBP, **PDF**, GIF, BMP, TIFF, ICO, **고화질 2배·4배** (움직이는 GIF → MP4) |
| Word 문서 | DOC, DOCX, ODT, RTF, TXT … | **PDF**, DOCX, DOC, ODT, RTF, TXT, JPG·PNG(쪽마다) |
| **한글 문서** | **HWP, HWPX** | **PDF**, DOCX(Word), JPG·PNG(쪽마다), TXT |
| 프레젠테이션 | PPT, PPTX, PPS, ODP … | **PDF**, PPTX, PPT, ODP, JPG·PNG(장마다) |
| 스프레드시트 | XLS, XLSX, XLSB, ODS, CSV | **PDF**, XLSX, XLS, ODS, CSV |
| PDF | PDF | **DOCX(Word)**, **XLSX(표)**, JPG, PNG, TXT, 용량 줄이기, 쪽 나누기, 여러 개 합치기 |

## 문서 변환이 정확하도록 한 것

- **PDF → Word**: [pdf2docx](https://github.com/ArtifexSoftware/pdf2docx)를 브라우저용 파이썬([Pyodide](https://pyodide.org/))에서 돌리고,
  자주 틀리던 곳을 고쳤습니다 (`src/pdf2word/convert.py`).
  - 띄어쓰기 없이 글자 위치로만 띄운 한글 PDF(한컴 오피스에서 만든 PDF 등)의 띄어쓰기를 되살립니다.
  - 문단 나누기·줄 간격·2단 편집·머리글/바닥글(쪽 번호)·표(테두리 없는 표 포함)·그림과 도표를 원본에 가깝게.
  - 한컴 오피스 보도자료처럼 촘촘한 표도 열 너비와 좁힌 자간을 그대로 옮겨, Word에서 칸 안의 글이 넘치거나 표가 그림이 되지 않게 합니다.
    칸마다 두 줄로 적힌 숫자('182.6' 아래 '(△35.4)')는 줄을 끊어 맞춤을 지키고, 이름표 없는 한컴 글꼴도 Word 글꼴 이름으로 바꿉니다.
    '도·소매업' 같은 가운뎃점 낱말과 '2026년' 같은 숫자 옆 띄어쓰기도 원본대로.
  - Word가 받아들이는 값(정수)만 적어, Word에서 '읽을 수 없는 내용' 경고가 뜨지 않게 합니다.
  - 글꼴은 Word에 있는 이름(맑은 고딕·바탕·Times New Roman 등)으로 바꿉니다.
- **Word·엑셀·파워포인트 → PDF** ([LibreOffice](https://www.libreoffice.org/)):
  - 문서에 적힌 글꼴이 없으면 모양이 비슷한 글꼴로 바꿉니다 (맑은 고딕·굴림·돋움 → 나눔고딕, 바탕·궁서·함초롬바탕 → 나눔명조,
    Calibri·Cambria·Arial·Times New Roman → 크기가 같은 대체 글꼴). 나눔 글꼴에 없는 한자도 빠지지 않습니다.
  - 크롬·엣지에서 **글꼴 사용**을 허락하면 내 컴퓨터에 있는 글꼴(맑은 고딕 등)을 그대로 써서 Word에서 본 것과 거의 같게 나옵니다.
    글꼴 파일은 컴퓨터 밖으로 나가지 않습니다.
- **한글(HWP·HWPX) → PDF** ([rhwp](https://github.com/edwardkim/rhwp)): 한컴 오피스 없이도 원본과 같은 줄바꿈·표·그림으로 그리고,
  글자는 글자로 넣어 복사·검색이 됩니다. 한글 → Word는 이 PDF를 다시 PDF → Word 엔진으로 바꿉니다.

알아 두면 좋은 점:
- 문서 변환은 처음 한 번 변환 엔진을 내려받느라 시간이 걸립니다 (Word·엑셀·PPT 약 80MB, PDF → Word 약 40MB,
  PDF 도구 약 20MB, 한글 약 10MB). 다음부터는 브라우저에 저장되어 빠릅니다.
- 동영상은 컴퓨터 성능으로 변환하므로 긴 영상의 다시 압축은 오래 걸릴 수 있고, 1GB가 넘는 파일은 실패할 수 있습니다.
  MP3 추출, H.264 영상의 MP4·MOV 변환은 다시 압축하지 않아 빠릅니다.
- 사진으로 찍은(스캔한) PDF는 글자가 그림이라 Word·엑셀로 바꿔도 그림으로 들어갑니다.
- AI 화질 개선은 [Real-ESRGAN](https://github.com/xinntao/Real-ESRGAN) 모델을 브라우저 안에서 돌립니다.
  - **원본을 훼손하지 않도록** AI 결과를 원래 크기로 다시 줄였을 때 원본과 같아지도록 바로잡습니다(역투영). 그래서 없는 무늬를 지어내거나 얼굴·글자·색이 바뀌는 왜곡이 크게 줄었습니다. 측정 결과는 [scripts/model/README.md](scripts/model/README.md)에 있습니다.
  - 세기는 **자연스럽게**(원본 충실, 기본)와 **강하게**(윤곽을 한 번 더 또렷하게) 중에 고를 수 있습니다. 1080p처럼 이미 괜찮은 영상은 강하게가 차이가 잘 보입니다.
  - 그래픽카드 가속(WebGPU)이 되는 크롬·엣지에서 빠르고, 안 되면 CPU로 계산합니다(느림). 모델은 약 5MB입니다.
  - 작은 사진(스마트폰 캡처, 옛날 사진, 웹 이미지)일수록 효과가 큽니다. 결과는 최대 6,400만 화소까지 커집니다(아이폰 사파리는 약 1,600만 화소).
  - 동영상은 장면을 한 장씩 처리하므로 오래 걸립니다. 크롬·엣지에서는 동영상을 푸는 것과 묶는 것 모두 그래픽카드가 하고(ffmpeg 없이), 멈춘 장면은 건너뜁니다. 결과는 최대 4K입니다.
- 크롬 또는 엣지 최신 버전을 권장합니다.

## 배포 (GitHub Pages)

`.github/workflows/deploy.yml`이 `main`에 코드가 올라올 때마다 자동으로 빌드하고, 실제 브라우저로 모든 변환을 시험한 뒤
GitHub Pages에 배포합니다 (시험이 하나라도 실패하면 배포하지 않습니다).

처음 한 번만 설정이 필요합니다:
1. GitHub 저장소 → **Settings → General → Default branch**를 `main`으로 변경
2. **Settings → Pages → Build and deployment → Source**를 **GitHub Actions**로 선택
3. **Actions** 탭에서 "GitHub Pages 배포" → **Run workflow** (이후에는 `main`에 올릴 때마다 자동 배포)

배포가 끝나면 <https://csy870617.github.io/Converter/> 에서 사용할 수 있습니다.

## 개발

```bash
npm install
npm run dev        # 개발 서버
npm run build      # dist/ 에 배포용 파일 생성
npm test           # 실제 브라우저로 모든 변환을 시험 (build 후 실행)
```

구성:
- `src/main.js`: 화면 (암호 묻기, 합칠 순서 바꾸기 포함)
- `src/formats.js`: 지원 형식 목록
- `src/engines.js`: 변환 엔진 ([ffmpeg.wasm](https://github.com/ffmpegwasm/ffmpeg.wasm), [LibreOffice WASM](https://github.com/matbeedotcom/libreoffice-document-converter), [PDF.js](https://mozilla.github.io/pdf.js/), [pdf-lib](https://pdf-lib.js.org/), [heic-to](https://github.com/hoppergee/heic-to), [UTIF.js](https://github.com/photopea/UTIF.js), [gifenc](https://github.com/mattdesl/gifenc))
- `src/hwp.js`: 한글 문서 → PDF ([rhwp](https://github.com/edwardkim/rhwp), [jsPDF](https://github.com/parallax/jsPDF), [svg2pdf.js](https://github.com/yWorks/svg2pdf.js))
- `src/pdf2word/`: 브라우저용 파이썬 작업자 — PDF → Word(`convert.py`, pdf2docx 고침), PDF 도구(`tools.py`, PyMuPDF), Office 암호 풀기(`officecrypto.py`, msoffcrypto-tool)
- `src/xlsx.js`: PDF에서 꺼낸 표로 엑셀 파일 만들기
- `src/localfonts.js`: 내 컴퓨터 글꼴 쓰기 (Local Font Access)
- `src/upscale.js`: AI 화질 개선 ([ONNX Runtime Web](https://onnxruntime.ai/), 동영상 풀기·묶기 [Mediabunny](https://mediabunny.dev/))
- `scripts/model/`: AI 모델 만들기(`build.py`)와 화질 측정(`evaluate.py`). 모델 파일은 `public/models/`
- `public/sw.js`: 서비스 워커. GitHub Pages에서 할 수 없는 보안 헤더 설정과 압축된 엔진 파일 풀기를 대신 합니다.
- `scripts/prepare-assets.mjs`: 큰 엔진 파일을 압축해 `public/`에 준비하고, 파이썬 휠 파일을 정해 둔 판만 받아 확인합니다.
- `public/fonts/`: 글꼴과 글꼴 대체표 ([public/fonts/README.txt](public/fonts/README.txt))

## 사용한 오픈 소스와 라이선스

| 이름 | 쓰는 곳 | 라이선스 |
|---|---|---|
| [PyMuPDF](https://github.com/pymupdf/PyMuPDF) / MuPDF | PDF → Word, PDF 도구 | **AGPL-3.0** |
| [pdf2docx](https://github.com/ArtifexSoftware/pdf2docx), python-docx | PDF → Word | MIT |
| [Pyodide](https://pyodide.org/) (numpy BSD, OpenCV Apache-2.0, lxml BSD, fontTools MIT 등) | 브라우저용 파이썬 | MPL-2.0 |
| [msoffcrypto-tool](https://github.com/nolze/msoffcrypto-tool), olefile, cryptography | Office 암호 풀기 | MIT, BSD, Apache-2.0/BSD |
| [LibreOffice](https://www.libreoffice.org/) (WASM) | Word·엑셀·PPT 변환 | MPL-2.0 |
| [rhwp](https://github.com/edwardkim/rhwp) | 한글 문서 | MIT |
| [FFmpeg](https://ffmpeg.org/) ([ffmpeg.wasm](https://github.com/ffmpegwasm/ffmpeg.wasm), x264 포함) | 동영상·오디오 | GPL-2.0 이상 |
| [PDF.js](https://mozilla.github.io/pdf.js/) | PDF 그리기·글 꺼내기 | Apache-2.0 |
| [pdf-lib](https://pdf-lib.js.org/), [jsPDF](https://github.com/parallax/jsPDF), [svg2pdf.js](https://github.com/yWorks/svg2pdf.js) | PDF 만들기 | MIT |
| [heic-to](https://github.com/hoppergee/heic-to) (libheif) | 아이폰 사진 | LGPL-3.0 |
| [Mediabunny](https://mediabunny.dev/) | 동영상 화질 개선 | MPL-2.0 |
| [ONNX Runtime Web](https://onnxruntime.ai/), [Real-ESRGAN](https://github.com/xinntao/Real-ESRGAN) | AI 화질 개선 | MIT, BSD-3-Clause |
| UTIF.js, gifenc, fflate | TIFF·GIF·ZIP | MIT |
| 나눔고딕·나눔명조, Liberation, Noto Serif/Sans KR(한자만), DejaVu Sans(기호만) | 글꼴 | SIL OFL 1.1, Bitstream Vera ([자세히](public/fonts/README.txt)) |

PyMuPDF(MuPDF)는 AGPL-3.0, FFmpeg(x264 포함)는 GPL로 배포됩니다. 이 사이트를 고쳐서 다른 곳에 공개할 때는
고친 소스 코드도 같은 조건으로 공개해야 합니다 (이 저장소처럼 소스를 공개해 두면 됩니다).
