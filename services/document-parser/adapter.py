"""Docling/RapidOCR adapter. Geometry and merged cells come only from engine output."""
import hashlib
import importlib.metadata
import io
import json
import os
from functools import lru_cache
from pathlib import Path


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


@lru_cache
def parser_identity():
    root = Path(os.environ["DOCUMENT_PARSER_MODELS"])
    weights = sorted(p for p in root.rglob("*") if p.is_file() and p.suffix in {".onnx", ".safetensors", ".pt", ".json"})
    if not weights:
        raise RuntimeError("Models not provisioned; run bootstrap.py first")
    manifest = [(str(p.relative_to(root)), digest(p.read_bytes())) for p in weights]
    versions = {p: importlib.metadata.version(p) for p in ["docling", "rapidocr", "onnxruntime", "torch", "pypdfium2"]}
    sources = {name: digest(Path(__file__).with_name(name).read_bytes()) for name in ["adapter.py", "native_text.py", "worker.py"]}
    fingerprint = digest(json.dumps([versions, manifest, sources], sort_keys=True).encode())[:20]
    return {"name": "docling-rapidocr-cpu", "version": f"adapter-v2-{fingerprint}"}


def normalize_box(box, width, height):
    if not box or width <= 0 or height <= 0:
        return None
    x0, x1 = sorted([float(box.l) / width, float(box.r) / width])
    y0, y1 = sorted([float(box.t) / height, float(box.b) / height])
    if str(getattr(box.coord_origin, "value", box.coord_origin)).upper() == "BOTTOMLEFT":
        y0, y1 = 1 - y1, 1 - y0
    if not (0 <= x0 < x1 <= 1 and 0 <= y0 < y1 <= 1):
        return None
    return {"x0": x0, "y0": y0, "x1": x1, "y1": y1}


@lru_cache(maxsize=2)
def converter(force_ocr):
    from docling.backend.pypdfium2_backend import PyPdfiumDocumentBackend
    from docling.datamodel.accelerator_options import AcceleratorOptions
    from docling.datamodel.base_models import InputFormat
    from docling.datamodel.pipeline_options import OcrMode, PdfPipelineOptions, RapidOcrOptions
    from docling.document_converter import DocumentConverter, PdfFormatOption

    options = PdfPipelineOptions(
        artifacts_path=Path(os.environ["DOCUMENT_PARSER_MODELS"]),
        accelerator_options=AcceleratorOptions(device="cpu", num_threads=2),
        do_ocr=True,
        do_table_structure=True,
        ocr_options=RapidOcrOptions(backend="onnxruntime", lang=["ch"], mode=OcrMode.FULL_PAGE if force_ocr else OcrMode.DEFAULT),
        enable_remote_services=False,
    )
    # Pin the existing PDFium backend on every platform. Docling's implicit default
    # may change; its threaded docling_parse Windows extension access-violated on
    # the real scan probes. Layout, tables and OCR still use the same pipeline.
    return DocumentConverter(format_options={InputFormat.PDF: PdfFormatOption(pipeline_options=options, backend=PyPdfiumDocumentBackend)})


def convert_page(pdf_bytes, page_number, original_sha, force_ocr=False):
    import pypdfium2 as pdfium
    from docling.datamodel.base_models import DocumentStream
    from docling_core.types.doc import TableItem

    with pdfium.PdfDocument(pdf_bytes) as pdf:
        page = pdf[page_number - 1]
        width, height = page.get_size()
        if width * height * 9 > 30_000_000:
            raise ValueError("Page exceeds raster pixel budget")
        native_failed = False
        try:
            text_page = page.get_textpage()
            try:
                native = text_page.get_text_range()
            finally:
                text_page.close()
        except Exception:  # noqa: BLE001 - preserve a failed text layer as an OCR quality flag
            native, native_failed = "", True
        finally:
            page.close()
    scanned = len(native.strip()) < 30 or native.count("\ufffd") / max(1, len(native)) > .02
    result = converter(force_ocr or scanned).convert(
        DocumentStream(name="original.pdf", stream=io.BytesIO(pdf_bytes)),
        page_range=(page_number, page_number), raises_on_error=True,
    )
    blocks = []
    for item, _level in result.document.iterate_items():
        if not item.prov:
            continue
        prov = item.prov[0]
        box = normalize_box(prov.bbox, width, height)
        table = None
        text = getattr(item, "text", "")
        # The default pipeline may OCR individual regions even on a native page.
        # Its reconstructed output cannot prove that an individual block was native.
        flags = ["ocr_requires_review"] if force_ocr or scanned else ["ocr_or_layout_requires_review"]
        if native_failed:
            flags.append("native_text_extraction_failed")
        if isinstance(item, TableItem):
            data = item.data
            cells = []
            for c in data.table_cells:
                cell = {"row": c.start_row_offset_idx, "column": c.start_col_offset_idx,
                        "rowSpan": c.end_row_offset_idx - c.start_row_offset_idx,
                        "columnSpan": c.end_col_offset_idx - c.start_col_offset_idx,
                        "text": c.text, "header": bool(c.column_header or c.row_header)}
                cell_box = normalize_box(c.bbox, width, height)
                if cell_box:
                    cell["box"] = cell_box
                cells.append(cell)
            text = "\n".join(c["text"] for c in cells if c["text"].strip())
            table = {"id": "pending", "rows": data.num_rows, "columns": data.num_cols, "cells": cells}
            flags += ["table_structure_requires_review", "cross_page_table_not_auto_merged"]
        if not text.strip():
            continue
        block_id = "b_" + digest(f"{original_sha}:{parser_identity()['version']}:{page_number}:{len(blocks)}:{text}".encode())[:32]
        locator = {"kind": "block", "filePage": page_number, "blockId": block_id}
        if box:
            locator["box"] = box
        block = {"id": block_id, "order": len(blocks), "kind": "table" if table else "text", "text": text,
                 "locator": locator, "quality": "needs_review" if flags else "native", "flags": flags}
        if table:
            table["id"] = "t_" + block_id[2:]
            block["table"] = table
        blocks.append(block)
    page = {"filePage": page_number, "text": "\n".join(b["text"] for b in blocks), "blocks": blocks, "nativeText": native}
    return page, result.document.export_to_dict()


def make_receipt(original_sha, page_count, pages, failed, truncated, warnings):
    readable = any(p["blocks"] for p in pages)
    review = any(b["quality"] != "native" for p in pages for b in p["blocks"])
    return {"schemaVersion": 2, "originalSha256": original_sha, "mediaType": "application/pdf",
            "parser": parser_identity(), "pageCount": page_count, "pages": pages or [{"filePage": 1, "text": "", "blocks": []}],
            "failedPages": sorted(set(failed)), "truncatedPages": sorted(set(truncated)), "warnings": warnings,
            "status": "unreadable" if not readable else "partial" if failed or truncated or review else "ready"}
