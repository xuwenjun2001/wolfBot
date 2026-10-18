"""One persistent model process; main process may terminate it at timeout/cancel."""
import json
import os
from pathlib import Path

from adapter import convert_page, digest


def worker(requests, responses):
    os.environ["HF_HUB_OFFLINE"] = "1"
    os.environ["TRANSFORMERS_OFFLINE"] = "1"
    while True:
        pdf_path, settings, identity = requests.get()
        pdf_bytes = Path(pdf_path).read_bytes()
        sha = digest(pdf_bytes)
        import pypdfium2 as pdfium

        with pdfium.PdfDocument(pdf_bytes) as pdf:
            count = len(pdf)
        if not 1 <= count <= 10000:
            responses.put(("error", "page_count_limit"))
            continue
        responses.put(("count", count))
        cache = Path(os.environ["DOCUMENT_PARSER_CACHE"]) / digest(f"{sha}:{identity}:{settings['forceOcr']}".encode())
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
                    page, raw = convert_page(pdf_bytes, n, sha, settings["forceOcr"])
                    (cache / f"raw-{n}.json").write_text(json.dumps(raw, ensure_ascii=False), "utf-8")
                    temp = page_path.with_suffix(".tmp")
                    temp.write_text(json.dumps(page, ensure_ascii=False), "utf-8")
                    temp.replace(page_path)
                responses.put(("page", page))
            except Exception as error:  # noqa: BLE001 - engine failure is recorded per page, never hidden
                # No empty successful page, and no invisible OCR/native fallback.
                responses.put(("failed", {"page": n, "reason": type(error).__name__}))
        responses.put(("done", None))
