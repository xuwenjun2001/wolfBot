import queue
from types import SimpleNamespace

import pypdfium2 as pdfium
import pytest

import worker as engine
from native_text import extract_native_page, text_flags


def test_generic_glyph_diagnostics():
    assert "sparse_text_layer_requires_review" in text_flags("2023A\n1\n2\n3.11.1\n2.5%")
    assert "unmapped_text_glyphs" in text_flags("正文 \ufffd 123")
    assert "unmapped_text_glyphs" in text_flags("正文 \x00 123")
    assert "private_use_text_glyphs" in text_flags("正文 \ue001 123")
    for text in ["项目 收入 123,456.00", "Revenue 123,456.00", "二零二三年年报"]:
        assert text_flags(text) == []


@pytest.mark.parametrize("force_ocr", [False, True])
def test_docling_pins_existing_pdfium_backend_and_keeps_ocr_policy(monkeypatch, tmp_path, force_ocr):
    import docling.document_converter as converters
    from docling.backend.pypdfium2_backend import PyPdfiumDocumentBackend
    from docling.datamodel.base_models import InputFormat
    from docling.datamodel.pipeline_options import OcrMode

    from adapter import converter

    monkeypatch.setenv("DOCUMENT_PARSER_MODELS", str(tmp_path))
    monkeypatch.setenv("HF_HUB_OFFLINE", "1")
    monkeypatch.setenv("TRANSFORMERS_OFFLINE", "1")
    monkeypatch.setattr(converters, "DocumentConverter", lambda **kwargs: kwargs)
    converter.cache_clear()
    try:
        option = converter(force_ocr)["format_options"][InputFormat.PDF]
        assert option.backend is PyPdfiumDocumentBackend
        assert option.pipeline_options.do_ocr is True
        assert option.pipeline_options.do_table_structure is True
        assert option.pipeline_options.enable_remote_services is False
        assert option.pipeline_options.accelerator_options.device == "cpu"
        assert option.pipeline_options.ocr_options.mode == (OcrMode.FULL_PAGE if force_ocr else OcrMode.DEFAULT)
    finally:
        converter.cache_clear()


class FakePdf:
    def __init__(self, texts, image=False):
        self.texts, self.image, self.closed = texts, image, False

    def __len__(self):
        return len(self.texts)

    def __getitem__(self, index):
        return SimpleNamespace(get_textpage=lambda: SimpleNamespace(get_text_range=lambda: self.texts[index], close=lambda: None),
                               get_size=lambda: (100, 100), close=lambda: None,
                               get_objects=lambda: [SimpleNamespace(type=3, get_bounds=lambda: (0, 0, 100, 100))] if self.image else [])

    def close(self):
        self.closed = True


def test_stable_native_pages_keep_source_text_and_only_real_page_locations():
    source = "金额 123\r\n普通正文\r\n" + "长文" * 1000
    pdf = FakePdf([source])
    page = extract_native_page(pdf, 1, "a" * 64, "fixture-v2")
    assert page == extract_native_page(pdf, 1, "a" * 64, "fixture-v2")
    assert page["text"] == source.replace("\r\n", "\n")
    assert page["nativeText"] == page["text"]
    assert max(len(b["text"]) for b in page["blocks"]) == 1800
    assert all(b["quality"] == "native" and b["locator"]["filePage"] == 1 and "box" not in b["locator"] for b in page["blocks"])
    assert extract_native_page(FakePdf(["只有图像下的编号 123"], image=True), 1, "a" * 64, "v2")["blocks"][0]["quality"] == "needs_review"


def run_worker(monkeypatch, tmp_path, texts, convert, **settings):
    original = tmp_path / "original.pdf"
    original.write_bytes(b"%PDF-test-fixture")
    monkeypatch.setenv("DOCUMENT_PARSER_CACHE", str(tmp_path / "cache"))
    pdf = FakePdf(texts)
    monkeypatch.setattr(pdfium, "PdfDocument", lambda _bytes: pdf)
    monkeypatch.setattr(engine, "convert_page", convert)
    requests, responses = queue.Queue(), queue.Queue()
    requests.put((str(original), {"forceOcr": False, "preferNative": True, "maxPages": 100, **settings}, "fixture-v2"))
    real_get = requests.get

    def get():
        if requests.empty():
            raise KeyboardInterrupt
        return real_get()

    requests.get = get
    with pytest.raises(KeyboardInterrupt):
        engine.worker(requests, responses)
    assert pdf.closed
    return list(responses.queue)


def test_native_first_avoids_models_and_keeps_page_limits(monkeypatch, tmp_path):
    def no_model(*args):
        raise AssertionError("Native page must not invoke OCR")

    result = run_worker(monkeypatch, tmp_path, ["正常中文正文 " * 10] * 2, no_model, maxPages=1)
    assert [kind for kind, _ in result] == ["count", "page", "done"]
    assert result[0] == ("count", 2)
    assert result[1][1]["filePage"] == 1


def test_bad_native_layer_uses_forced_ocr_but_never_promotes_its_quality(monkeypatch, tmp_path):
    calls = []

    def convert(_bytes, number, _sha, force):
        calls.append((number, force))
        page = extract_native_page(FakePdf(["OCR 识别后的页面正文 " * 4]), 1, "a" * 64, "v2")
        for block in page["blocks"]:
            block.update(quality="needs_review", flags=["ocr_requires_review"])
        return page, {}

    result = run_worker(monkeypatch, tmp_path, ["2023A 1234567890"], convert)
    assert calls == [(1, True)]
    assert result[1][1]["blocks"][0]["quality"] == "needs_review"


def test_blank_ocr_is_failed_and_never_cached_as_a_success(monkeypatch, tmp_path):
    def convert(*args):
        return {"filePage": 1, "text": "", "blocks": []}, {}

    result = run_worker(monkeypatch, tmp_path, [""], convert)
    assert [kind for kind, _ in result] == ["count", "failed", "done"]
    assert result[1][1] == {"page": 1, "reason": "ValueError"}
    assert not list((tmp_path / "cache").rglob("page-*.json"))
