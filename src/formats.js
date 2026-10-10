// 어떤 파일을 어떤 형식으로 바꿀 수 있는지 정의한다.
export const CATEGORIES = [
  {
    id: 'video', name: '동영상', engine: 'media',
    exts: ['mp4', 'mov', 'avi', 'mkv', 'webm', 'wmv', 'flv', 'm4v', '3gp', '3g2', 'mpg', 'mpeg', 'ts', 'm2ts', 'mts',
      'vob', 'ogv', 'asf', 'f4v', 'rm', 'rmvb', 'divx'],
    targets: ['mp4', 'mov', 'avi', 'webm', 'gif', 'mp3', 'wav', 'm4a', 'up2', 'up4'],
  },
  {
    id: 'audio', name: '오디오', engine: 'media',
    exts: ['mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg', 'oga', 'wma', 'opus', 'amr', 'aiff', 'aif', 'm4r', 'm4b', 'caf',
      'ac3', 'mp2', 'mka', 'ape', 'wv'],
    targets: ['mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg', 'opus', 'm4r'],
  },
  {
    id: 'image', name: '이미지', engine: 'image',
    exts: ['jpg', 'jpeg', 'jfif', 'jpe', 'png', 'webp', 'heic', 'heif', 'avif', 'bmp', 'gif', 'tif', 'tiff', 'svg', 'ico'],
    targets: ['jpg', 'png', 'webp', 'pdf', 'gif', 'bmp', 'tiff', 'ico', 'up2', 'up4'],
  },
  {
    id: 'word', name: 'Word 문서', engine: 'office',
    exts: ['doc', 'docx', 'docm', 'dot', 'dotx', 'odt', 'rtf', 'txt'],
    targets: ['pdf', 'docx', 'doc', 'odt', 'rtf', 'txt', 'jpg', 'png'],
  },
  {
    id: 'hwp', name: '한글 문서', engine: 'hwp',
    exts: ['hwp', 'hwpx'],
    targets: ['pdf', 'docx', 'jpg', 'png', 'txt'],
  },
  {
    id: 'slide', name: '프레젠테이션', engine: 'office',
    exts: ['ppt', 'pptx', 'pptm', 'pps', 'ppsx', 'odp'],
    targets: ['pdf', 'pptx', 'ppt', 'odp', 'jpg', 'png'],
  },
  {
    id: 'sheet', name: '스프레드시트', engine: 'office',
    exts: ['xls', 'xlsx', 'xlsm', 'xlsb', 'ods', 'csv'],
    targets: ['pdf', 'xlsx', 'xls', 'ods', 'csv'],
  },
  {
    id: 'pdf', name: 'PDF', engine: 'pdf',
    exts: ['pdf'],
    targets: ['docx', 'xlsx', 'jpg', 'png', 'txt', 'compress', 'split'],
  },
];

/** AI 화질 개선(업스케일) 선택지: 배율 */
export const UPSCALE = { up2: 2, up4: 4 };

/** PDF 도구: 형식은 그대로 두고 손보는 것 (결과는 PDF) */
export const TOOLS = { compress: '용량 줄이기', split: '쪽 나누기', merge: '하나로 합치기' };

/** 화면에 보여줄 이름 */
export const targetLabel = (t) => (UPSCALE[t] ? `고화질 ${UPSCALE[t]}배` : TOOLS[t] || t.toUpperCase());

const SAME = { jpeg: 'jpg', jfif: 'jpg', jpe: 'jpg', tif: 'tiff', heif: 'heic', oga: 'ogg' };
// 이 형식에는 맞지 않는 선택지 (SVG는 원래 선명한 그림이라 AI 화질 개선이 필요 없다)
const NOT_FOR = { svg: ['up2', 'up4'] };
// 이 형식에만 더 있는 선택지 (움직이는 GIF → 동영상)
const EXTRA_FOR = { gif: ['mp4'] };

export const extOf = (name) => (name.includes('.') ? name.split('.').pop().toLowerCase() : '');
export const stemOf = (name) => (name.includes('.') ? name.slice(0, name.lastIndexOf('.')) : name);

export function categoryOf(name) {
  const ext = extOf(name);
  return CATEGORIES.find((c) => c.exts.includes(ext)) || null;
}

export function targetsFor(name) {
  const cat = categoryOf(name);
  if (!cat) return [];
  const ext = extOf(name);
  const self = SAME[ext] || ext;
  return [...cat.targets, ...(EXTRA_FOR[ext] || [])].filter((t) => t !== self && !NOT_FOR[ext]?.includes(t));
}

export const MIME = {
  mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4', aac: 'audio/aac', flac: 'audio/flac', ogg: 'audio/ogg',
  opus: 'audio/ogg', m4r: 'audio/mp4', mp4: 'video/mp4', mov: 'video/quicktime', avi: 'video/x-msvideo', webm: 'video/webm', gif: 'image/gif', jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp',
  ico: 'image/x-icon', bmp: 'image/bmp', tiff: 'image/tiff', pdf: 'application/pdf', txt: 'text/plain;charset=utf-8', csv: 'text/csv;charset=utf-8',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  doc: 'application/msword', rtf: 'application/rtf', xls: 'application/vnd.ms-excel', ppt: 'application/vnd.ms-powerpoint',
  odt: 'application/vnd.oasis.opendocument.text', ods: 'application/vnd.oasis.opendocument.spreadsheet',
  odp: 'application/vnd.oasis.opendocument.presentation',
  zip: 'application/zip',
};

/** 사용자에게 그대로 보여줄 수 있는 오류 */
export class ConvertError extends Error {}

/** 암호가 필요하거나(wrong=false) 입력한 암호가 틀렸다(wrong=true). 화면에서 암호를 물어 다시 시도한다. */
export class PasswordError extends ConvertError {
  constructor(fileName, wrong = false) {
    super(wrong ? `${fileName}: 암호가 맞지 않습니다.` : `${fileName}: 암호가 걸려 있습니다.`);
    this.fileName = fileName;
    this.wrong = wrong;
  }
}
