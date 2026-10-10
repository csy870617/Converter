// 표(행·열 글자)로 엑셀 파일(XLSX)을 만든다. 숫자는 숫자로 넣어 바로 계산할 수 있게 한다.
import { zipSync, strToU8 } from 'fflate';

const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
  // XML에 넣을 수 없는 제어 문자는 뺀다
  .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '');

/** 열 번호(0부터) → A, B, …, Z, AA … */
function colName(i) {
  let s = '';
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

// 1,234 / -12.5 / 0.75 같은 숫자 (0으로 시작하는 번호 '007'이나 전화번호는 글자로 둔다)
const NUMBER = /^[-+]?(?:0|[1-9]\d{0,2}(?:,\d{3})+|[1-9]\d*)(?:\.\d+)?$/;

/** 글자 폭 (한글·한자는 두 칸) */
const width = (s) => [...s].reduce((w, c) => w + (c.charCodeAt(0) > 0x2e80 ? 2 : 1), 0);

function sheetXml(rows) {
  const cols = Math.max(1, ...rows.map((r) => r.length));
  const widths = Array(cols).fill(6);
  const body = rows.map((row, r) => {
    const cells = row.map((value, c) => {
      if (value === null || value === undefined || value === '') return '';
      const text = String(value);
      const ref = `${colName(c)}${r + 1}`;
      for (const line of text.split('\n')) widths[c] = Math.max(widths[c], Math.min(60, width(line) + 2));
      if (NUMBER.test(text)) {
        const style = text.includes(',') ? (text.includes('.') ? 3 : 2) : 1;
        return `<c r="${ref}" s="${style}"><v>${Number(text.replace(/,/g, ''))}</v></c>`;
      }
      return `<c r="${ref}" s="1" t="inlineStr"><is><t xml:space="preserve">${esc(text)}</t></is></c>`;
    }).join('');
    return `<row r="${r + 1}">${cells}</row>`;
  }).join('');
  const colXml = widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('');
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
    + `<cols>${colXml}</cols><sheetData>${body}</sheetData></worksheet>`;
}

const STYLES = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
  + '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
  + '<fonts count="1"><font><sz val="11"/><name val="맑은 고딕"/><family val="3"/><charset val="129"/></font></fonts>'
  + '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>'
  + '<borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border>'
  + '<border><left style="thin"><color auto="1"/></left><right style="thin"><color auto="1"/></right>'
  + '<top style="thin"><color auto="1"/></top><bottom style="thin"><color auto="1"/></bottom><diagonal/></border></borders>'
  + '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
  + '<cellXfs count="4"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>'
  + '<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf>'
  + '<xf numFmtId="3" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1" applyAlignment="1"><alignment vertical="center"/></xf>'
  + '<xf numFmtId="4" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1" applyAlignment="1"><alignment vertical="center"/></xf>'
  + '</cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>';

/**
 * @param {{name: string, rows: (string|null)[][]}[]} sheets
 * @returns {Uint8Array} XLSX 파일
 */
export function makeXlsx(sheets) {
  const files = {
    '[Content_Types].xml': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
      + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
      + '<Default Extension="xml" ContentType="application/xml"/>'
      + '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
      + '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'
      + sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')
      + '</Types>',
    '_rels/.rels': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
      + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>'
      + '</Relationships>',
    'xl/workbook.xml': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
      + `<sheets>${sheets.map((s, i) => `<sheet name="${esc(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>`,
    'xl/_rels/workbook.xml.rels': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
      + sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')
      + `<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>`
      + '</Relationships>',
    'xl/styles.xml': STYLES,
  };
  sheets.forEach((s, i) => { files[`xl/worksheets/sheet${i + 1}.xml`] = sheetXml(s.rows); });
  return zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strToU8(v)])));
}

/**
 * PDF에서 꺼낸 표들을 시트로 묶는다. 쪽마다 이어지는 같은 모양의 표(거래내역 등)는 한 시트에 잇고,
 * 쪽마다 되풀이되는 머리글 행은 한 번만 남긴다. 모양이 다른 표는 새 시트로.
 * @param {{page: number, rows: (string|null)[][]}[]} tables
 */
export function tablesToSheets(tables) {
  const sheets = [];
  let last = null;
  for (const t of tables) {
    const cols = Math.max(0, ...t.rows.map((r) => r.length));
    if (last && last.cols === cols) {
      const header = JSON.stringify(last.rows[0]);
      const rows = JSON.stringify(t.rows[0]) === header ? t.rows.slice(1) : t.rows;
      last.rows.push(...rows);
      continue;
    }
    last = { name: `표${sheets.length + 1}`, cols, rows: [...t.rows] };
    sheets.push(last);
  }
  return sheets;
}
