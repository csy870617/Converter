# PDF 도구 (브라우저용 파이썬에서 PyMuPDF로): 용량 줄이기, 표 꺼내기(PDF → 엑셀)
import json
import re

import pymupdf


def _open(src, password=None):
    doc = pymupdf.open(src)
    if doc.needs_pass and not doc.authenticate(password or ''):
        raise RuntimeError('PASSWORD_REQUIRED')
    return doc


def compress(src, dst, report=lambda p: None, password=None):
    """사진을 화면·인쇄에 충분한 해상도로 줄이고, 글꼴은 쓰는 글자만 남기고, 겹친 데이터를 정리해 저장한다."""
    doc = _open(src, password)
    report(0.05)
    # 150dpi보다 훨씬 큰 사진은 150dpi로 줄이고, 사진(컬러·회색)은 JPEG 품질 75로 다시 저장한다
    doc.rewrite_images(dpi_threshold=200, dpi_target=150, quality=75, lossy=True, lossless=True, bitonal=False)
    report(0.6)
    try:
        doc.subset_fonts()
    except Exception:  # 글꼴을 줄이지 못해도 나머지는 그대로 줄인다
        pass
    report(0.8)
    doc.save(dst, garbage=4, clean=True, deflate=True, deflate_images=True, deflate_fonts=True,
             use_objstms=1, encryption=pymupdf.PDF_ENCRYPT_KEEP)
    report(1.0)


def decrypt(src, dst, report=lambda p: None, password=None):
    """암호를 풀어 다시 저장한다 (합치기·나누기는 암호 걸린 PDF를 그대로 다루지 못한다)."""
    doc = _open(src, password)
    doc.save(dst, garbage=1, deflate=True, encryption=pymupdf.PDF_ENCRYPT_NONE)
    report(1.0)


# ---------------------------------------------------------------------------
# 표 꺼내기
# ---------------------------------------------------------------------------

def _clean(cell):
    if cell is None:
        return None
    text = re.sub(r'[ \t]+', ' ', str(cell)).strip()
    return text


def _text_rows(page):
    """선도 줄 맞춤도 없는 쪽: 글줄 하나를 한 행으로, 넓은 간격으로 칸을 나눈다."""
    rows = []
    for block in page.get_text('dict')['blocks']:
        for line in block.get('lines', []):
            spans = [s for s in line['spans'] if s['text'].strip()]
            if not spans:
                continue
            cells = [spans[0]['text']]
            for prev, s in zip(spans, spans[1:]):
                gap = s['bbox'][0] - prev['bbox'][2]
                if gap > s['size'] * 1.5:
                    cells.append(s['text'])
                else:
                    cells[-1] += (' ' if gap > s['size'] * 0.15 else '') + s['text']
            rows.append([_clean(c) for c in cells])
    return rows


def tables(src, report=lambda p: None, password=None):
    """PDF의 표를 [{page, rows}] JSON으로. 선으로 그린 표를 먼저 찾고, 없으면 글자 줄 맞춤으로 찾는다."""
    doc = _open(src, password)
    n = len(doc)
    found = []
    for i, page in enumerate(doc):
        for t in page.find_tables().tables:
            rows = [[_clean(c) for c in row] for row in t.extract()]
            if any(any(c for c in row) for row in rows):
                found.append({'page': i + 1, 'rows': rows})
        report((i + 1) / n * (0.5 if not found else 1.0))
    if not found:
        # 선이 없는 표 (은행 거래내역 등): 글자가 세로로 줄을 맞춘 곳을 표로 본다
        for i, page in enumerate(doc):
            for t in page.find_tables(strategy='text').tables:
                rows = [[_clean(c) for c in row] for row in t.extract()]
                if t.row_count >= 2 and t.col_count >= 2 and any(any(c for c in row) for row in rows):
                    found.append({'page': i + 1, 'rows': rows})
            report(0.5 + (i + 1) / n * 0.5)
    if not found:
        for i, page in enumerate(doc):
            rows = _text_rows(page)
            if rows:
                found.append({'page': i + 1, 'rows': rows, 'text': True})
    return json.dumps(found, ensure_ascii=False)
