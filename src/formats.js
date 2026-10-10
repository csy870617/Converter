// 어떤 파일을 어떤 형식으로 바꿀 수 있는지 정의한다.
export const CATEGORIES = [
  {
    id: 'video', name: '동영상', engine: 'media',
    exts: ['mp4', 'mov', 'avi', 'mkv', 'webm', 'wmv', 'flv', 'm4v', '3gp', 'mpg', 'mpeg', 'ts'],
    targets: ['mp3', 'wav', 'm4a', 'mp4', 'gif', 'up2', 'up4'],
  },
  {
    id: 'audio', name: '오디오', engine: 'media',
    exts: ['mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg', 'wma', 'opus', 'amr'],
    targets: ['mp3', 'wav', 'm4a', 'flac', 'ogg'],
  },
  {
    id: 'image', name: '이미지', engine: 'image',
    exts: ['jpg', 'jpeg', 'png', 'webp', 'heic', 'heif', 'avif', 'bmp', 'gif', 'tif', 'tiff'],
    targets: ['jpg', 'png', 'webp', 'pdf', 'ico', 'up2', 'up4'],
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

const SAME = { jpeg: 'jpg', tif: 'tiff', heif: 'heic' };

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
  return cat.targets.filter((t) => t !== self);
}

export const MIME = {
  mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4', flac: 'audio/flac', ogg: 'audio/ogg',
  mp4: 'video/mp4', gif: 'image/gif', jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp',
  ico: 'image/x-icon', pdf: 'application/pdf', txt: 'text/plain;charset=utf-8', csv: 'text/csv;charset=utf-8',
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
