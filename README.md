# 간단 파일 변환기

MP4 → MP3, Word → PDF, 아이폰 사진(HEIC) → JPG처럼 자주 쓰는 파일 변환을
**끌어다 놓고 → 형식 누르고 → 변환하기** 세 단계로 끝내는 웹사이트입니다.

- 설치할 것이 없습니다. 주소만 열면 바로 사용합니다.
- 파일은 서버로 올라가지 않습니다. 모든 변환은 **사용자의 브라우저 안에서** 이루어집니다.
- 여러 파일을 한 번에 변환할 수 있고, 결과가 여러 개면 ZIP 하나로 받습니다.
- 사진 여러 장을 PDF 한 개로 합칠 수 있습니다.

## 지원 형식

| 종류 | 이런 파일을 | 이렇게 바꿀 수 있어요 |
|---|---|---|
| 동영상 | MP4, MOV, AVI, MKV, WEBM, WMV … | **MP3**, WAV, M4A, MP4, GIF |
| 오디오 | MP3, WAV, M4A, AAC, FLAC, OGG, WMA … | MP3, WAV, M4A, FLAC, OGG |
| 이미지 | JPG, PNG, WEBP, **HEIC**, AVIF, BMP, GIF, TIFF | JPG, PNG, WEBP, **PDF**, ICO |
| Word 문서 | DOC, DOCX, ODT, RTF, TXT | **PDF**, DOCX |
| 프레젠테이션 | PPT, PPTX, ODP | **PDF**, PPTX |
| 스프레드시트 | XLS, XLSX, ODS, CSV | **PDF**, XLSX, CSV |
| PDF | PDF | **DOCX(Word)**, JPG, PNG, TXT |

알아 두면 좋은 점:
- 문서(Word·PPT·Excel) 변환은 처음 한 번 변환 엔진(약 90MB)을 내려받느라 1~2분 걸립니다. 다음부터는 브라우저에 저장되어 빠릅니다.
- 동영상은 컴퓨터 성능으로 변환하므로 긴 영상의 MP4 변환은 오래 걸릴 수 있고, 1GB가 넘는 파일은 실패할 수 있습니다. MP3 추출은 빠릅니다.
- 한글 문서는 나눔고딕·나눔명조 글꼴로 변환됩니다. 원본 글꼴과 모양이 조금 다를 수 있습니다.
- 크롬 또는 엣지 최신 버전을 권장합니다.

## 배포 (GitHub Pages)

`.github/workflows/deploy.yml`이 코드가 올라올 때마다 자동으로 빌드·테스트한 뒤 GitHub Pages에 배포합니다.

처음 한 번만 설정이 필요합니다:
1. GitHub 저장소 → **Settings → Pages**
2. **Build and deployment → Source**를 **GitHub Actions**로 선택
3. **Actions** 탭에서 "GitHub Pages 배포"를 실행하거나(Run workflow) 코드를 올리면 배포됩니다.

배포가 끝나면 `https://<사용자이름>.github.io/<저장소이름>/` 주소로 접속할 수 있습니다.

## 개발

```bash
npm install
npm run dev        # 개발 서버
npm run build      # dist/ 에 배포용 파일 생성
npm test           # 실제 브라우저로 모든 변환을 시험 (build 후 실행)
```

구성:
- `src/main.js`: 화면
- `src/engines.js`: 변환 엔진 ([ffmpeg.wasm](https://github.com/ffmpegwasm/ffmpeg.wasm), [LibreOffice WASM](https://github.com/matbeedotcom/libreoffice-document-converter), [PDF.js](https://mozilla.github.io/pdf.js/), [pdf-lib](https://pdf-lib.js.org/), [heic-to](https://github.com/hoppergee/heic-to))
- `src/formats.js`: 지원 형식 목록
- `public/sw.js`: 서비스 워커. GitHub Pages에서 할 수 없는 보안 헤더 설정과 압축된 엔진 파일 풀기를 대신 합니다.
- `scripts/prepare-assets.mjs`: 큰 엔진 파일을 압축해 `public/`에 준비합니다 (GitHub Pages 파일당 100MB 제한 대응).
- `public/fonts/`: 나눔글꼴 ([SIL Open Font License](public/fonts/OFL.txt))
