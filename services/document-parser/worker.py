"""One persistent model process; main process may terminate it at timeout/cancel."""
import json
import os
from pathlib import Path

from adapter import convert_page, digest
from native_text import extract_native_page


def worker(requests, responses):
    os.environ["HF_HUB_OFFLINE"] = "1"
    os.environ["TRANSFORMERS_OFFLINE"] = "1"
    while True:
        pdf_path, settings, identity = requests.get()
        pdf_bytes = Path(pdf_path).read_bytes()
        sha = digest(pdf_bytes)
        import pypdfium2 as pdfium

        pdf = pdfium.PdfDocument(pdf_bytes)
        count = len(pdf)
        if not 1 <= count <= 10000:
            pdf.close()
            responses.put(("error", "page_count_limit"))
            continue
        responses.put(("count", count))
        cache = Path(os.environ["DOCUMENT_PARSER_CACHE"]) / digest(f"{sha}:{identity}:{settings['forceOcr']}:{settings.get('preferNative', False)}".encode())
        cache.mkdir(parents=True, exist_ok=True)
        for n in range(1, min(count, settings["maxPages"]) + 1):
            page_path = cache / f"page-{n}.json"
            try:
                if page_path.exists():
                    try:
                        page = json.loads(page_path.read_text("utf-8"))
                    except (ValueError, OSError):
                        page = None
                else:
                    page = None
                if page is None:
                    if settings.get("preferNative") and not settings["forceOcr"]:
                        try:
                            page = extract_native_page(pdf, n, sha, identity)
                        except Exception:  # noqa: BLE001 - OCR can recover a failed native text layer
                            page = None
                    if page is None or len(page["text"].strip()) < 30 or any(b["quality"] != "native" for b in page["blocks"]):
                        page, raw = convert_page(pdf_bytes, n, sha, settings["forceOcr"] or settings.get("preferNative", False))
                        (cache / f"raw-{n}.json").write_text(json.dumps(raw, ensure_ascii=False), "utf-8")
                    if not page["text"].strip() or not page["blocks"]:
                        raise ValueError("No readable page text")
                    temp = page_path.with_suffix(".tmp")
                    temp.write_text(json.dumps(page, ensure_ascii=False), "utf-8")
                    temp.replace(page_path)
                responses.put(("page", page))
            except Exception as error:  # noqa: BLE001 - engine failure is recorded per page, never hidden
                # No empty successful page, and no invisible OCR/native fallback.
                responses.put(("failed", {"page": n, "reason": type(error).__name__}))
        pdf.close()
        responses.put(("done", None))
