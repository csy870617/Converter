import io
import subprocess
import zipfile

import pytest
from PIL import Image

import converters
from app import app


@pytest.fixture
def video(tmp_path):
    path = tmp_path / "영상 샘플.mp4"
    subprocess.run(
        [converters.find_ffmpeg(), "-hide_banner", "-loglevel", "error",
         "-f", "lavfi", "-i", "testsrc=duration=1:size=320x240:rate=10",
         "-f", "lavfi", "-i", "sine=frequency=440:duration=1",
         "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", str(path)],
        check=True,
    )
    return path


@pytest.fixture
def png(tmp_path):
    path = tmp_path / "사진.png"
    Image.new("RGBA", (64, 48), (255, 0, 0, 128)).save(path)
    return path


def test_targets_exclude_own_format():
    assert "mp3" in converters.targets_for("a.MP4")
    assert "jpg" not in converters.targets_for("a.jpeg")
    assert "pdf" in converters.targets_for("report.docx")
    assert converters.targets_for("unknown.xyz") == []


@pytest.mark.parametrize("target", ["mp3", "wav", "m4a", "gif", "webm"])
def test_video(video, tmp_path, target):
    [out] = converters.convert(video, tmp_path / "out", target)
    assert out.suffix == f".{target}" and out.stat().st_size > 0


def test_audio_chain(video, tmp_path):
    [mp3] = converters.convert(video, tmp_path / "a", "mp3")
    [flac] = converters.convert(mp3, tmp_path / "b", "flac")
    assert flac.stat().st_size > 0


@pytest.mark.parametrize("target", ["jpg", "webp", "pdf", "ico"])
def test_image(png, tmp_path, target):
    [out] = converters.convert(png, tmp_path / "out", target)
    assert out.stat().st_size > 0


def test_images_merge_into_one_pdf(png, tmp_path):
    [pdf] = converters.images_to_single_pdf([png, png], tmp_path, "합본")
    import pymupdf
    with pymupdf.open(pdf) as doc:
        assert len(doc) == 2


def test_pdf_to_images_and_text(png, tmp_path):
    [pdf] = converters.images_to_single_pdf([png, png], tmp_path, "doc")
    pages = converters.convert(pdf, tmp_path / "img", "png")
    assert [p.name for p in pages] == ["doc-1.png", "doc-2.png"]
    [txt] = converters.convert(pdf, tmp_path / "txt", "txt")
    assert txt.exists()


def test_wrong_target_rejected(png, tmp_path):
    with pytest.raises(converters.ConversionError):
        converters.convert(png, tmp_path, "mp3")


needs_office = pytest.mark.skipif(converters.find_soffice() is None, reason="LibreOffice 없음")


@needs_office
def test_office_roundtrip(tmp_path):
    txt = tmp_path / "메모.txt"
    txt.write_text("안녕하세요\nHello", encoding="utf-8")
    [docx] = converters.convert(txt, tmp_path / "a", "docx")
    [pdf] = converters.convert(docx, tmp_path / "b", "pdf")
    [back] = converters.convert(pdf, tmp_path / "c", "docx")
    assert pdf.read_bytes().startswith(b"%PDF") and back.stat().st_size > 0


@needs_office
def test_spreadsheet(tmp_path):
    csv = tmp_path / "표.csv"
    csv.write_text("이름,점수\n철수,90\n", encoding="utf-8")
    [xlsx] = converters.convert(csv, tmp_path / "a", "xlsx")
    [pdf] = converters.convert(xlsx, tmp_path / "b", "pdf")
    assert pdf.stat().st_size > 0


def test_web_single_and_zip(video, png):
    client = app.test_client()
    assert client.get("/").status_code == 200

    res = client.post("/convert", data={
        "target": "mp3", "files": [(video.open("rb"), video.name)],
    }, content_type="multipart/form-data")
    assert res.status_code == 200
    assert "영상 샘플.mp3" in res.headers["Content-Disposition"] or "filename*" in res.headers["Content-Disposition"]

    res = client.post("/convert", data={
        "target": "jpg", "files": [(png.open("rb"), "a.png"), (png.open("rb"), "b.png")],
    }, content_type="multipart/form-data")
    assert res.status_code == 200
    names = zipfile.ZipFile(io.BytesIO(res.data)).namelist()
    assert sorted(names) == ["a.jpg", "b.jpg"]


def test_web_error_message(png):
    res = app.test_client().post("/convert", data={
        "target": "mp3", "files": [(png.open("rb"), png.name)],
    }, content_type="multipart/form-data")
    assert res.status_code == 400 and "변환할 수 없습니다" in res.get_json()["error"]
