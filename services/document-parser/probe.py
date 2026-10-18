"""Development-only OCR/table probe. Reads public frozen inputs, never the holdout."""
import json
import os
import time
from pathlib import Path

import pypdfium2 as pdfium

from adapter import convert_page, digest, make_receipt, parser_identity


def main():
    root = Path(os.environ["DOCUMENT_PARSER_PROBE"])
    root.mkdir(parents=True, exist_ok=True)
    cases = [
        ("scan-maotai-p5", "data/research-agent-upgrade/dataset-v1/derived/maotai-2024-p5-scan.pdf", 1, True),
        ("native-maotai-p5", "data/research-agent-upgrade/dataset-v1/development/600519/2024.pdf", 5, False),
        ("native-midea-p9", "data/research-agent-upgrade/dataset-v1/development/000333/2024.pdf", 9, False),
    ]
    results = []
    for name, source, n, force in cases:
        data = Path(source).read_bytes()
        with pdfium.PdfDocument(data) as pdf:
            count = len(pdf)
            page_image = pdf[n - 1]
            bitmap = page_image.render(scale=1.5)
            bitmap.to_pil().save(root / f"{name}.png")
            bitmap.close()
            page_image.close()
        start = time.monotonic()
        page, raw = convert_page(data, n, digest(data), force)
        receipt = make_receipt(digest(data), count, [page], [], [p for p in range(1, count + 1) if p != n], [])
        output = json.dumps(receipt, ensure_ascii=False).encode()
        (root / f"{name}.json").write_bytes(output)
        (root / f"{name}.raw.json").write_text(json.dumps(raw, ensure_ascii=False), "utf-8")
        results.append({"case": name, "source": source, "originalSha256": digest(data), "filePage": n,
                        "elapsedMs": round((time.monotonic() - start) * 1000), "receiptSha256": digest(output),
                        "blocks": len(page["blocks"]), "tables": sum(b["kind"] == "table" for b in page["blocks"]),
                        "humanReview": "pending"})
        print(json.dumps(results[-1]), flush=True)
    (root / "report.json").write_text(json.dumps({"parser": parser_identity(), "cases": results}, indent=2), "utf-8")


if __name__ == "__main__":
    main()
