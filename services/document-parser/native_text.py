"""PDFium text layers, with stable page locations and conservative glyph diagnostics."""
import re
import unicodedata


def text_flags(text):
    flags = []
    if any(c == "\ufffd" or (ord(c) < 32 and c not in "\n\r\t") for c in text):
        flags.append("unmapped_text_glyphs")
    if any(unicodedata.category(c) == "Co" for c in text):
        flags.append("private_use_text_glyphs")
    visible = [c for c in text if not c.isspace()]
    numbers = sum(unicodedata.category(c).startswith("N") for c in visible)
    letters = sum(unicodedata.category(c).startswith("L") for c in visible)
    if numbers >= 8 and letters <= max(2, int(len(visible) * .015)) and numbers / len(visible) > .35:
        flags.append("sparse_text_layer_requires_review")
    return flags


def extract_native_page(pdf, page_number, original_sha, identity):
    from adapter import digest

    page = pdf[page_number - 1]
    image_layer = False
    try:
        textpage = page.get_textpage()
        try:
            text = textpage.get_text_range().replace("\r\n", "\n").replace("\r", "\n")
        finally:
            textpage.close()
        if len(text.strip()) < 100:
            width, height = page.get_size()
            image_layer = any(obj.type == 3 and abs((obj.get_bounds()[2] - obj.get_bounds()[0]) * (obj.get_bounds()[3] - obj.get_bounds()[1])) > width * height * .5 for obj in page.get_objects())
    finally:
        page.close()
    flags = text_flags(text)
    if image_layer:
        flags.append("image_dominates_text_layer_requires_review")
    blocks = []
    for line in text.splitlines():
        for part in re.findall(r"[\s\S]{1,1800}", line.strip()):
            block_id = "b_" + digest(f"{original_sha}:{identity}:{page_number}:{len(blocks)}:{part}".encode())[:32]
            blocks.append({"id": block_id, "order": len(blocks), "kind": "text", "text": part,
                           "locator": {"kind": "block", "filePage": page_number, "blockId": block_id},
                           "quality": "needs_review" if flags else "native", "flags": flags})
    return {"filePage": page_number, "text": text, "nativeText": text, "blocks": blocks}
