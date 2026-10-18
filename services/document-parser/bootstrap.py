"""Explicit model provisioning. Runtime uses only this directory, with no remote services."""
import os
from pathlib import Path


def main():
    from docling.utils.model_downloader import download_models

    root = Path(os.getenv("DOCUMENT_PARSER_MODELS", "../../data/document-parser/models")).resolve()
    root.mkdir(parents=True, exist_ok=True)
    download_models(
        output_dir=root,
        with_layout=True,
        with_tableformer=True,
        with_code_formula=False,
        with_picture_classifier=False,
        with_rapidocr=True,
        rapidocr_models=["onnxruntime:ch"],
        rapidocr_model_size="small",
    )
    print(f"Models ready: {root}")


if __name__ == "__main__":
    main()
