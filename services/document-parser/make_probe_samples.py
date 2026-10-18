"""Create a labelled synthetic two-page OCR stress sample, outside frozen fixtures."""
import json
import os
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont


def main():
    root = Path(os.environ["DOCUMENT_PARSER_PROBE"])
    root.mkdir(parents=True, exist_ok=True)
    font = ImageFont.truetype(os.environ["DOCUMENT_PARSER_PROBE_FONT"], 26)
    pages = []
    for n in [1, 2]:
        image = Image.new("RGB", (1240, 1754), "white")
        draw = ImageDraw.Draw(image)
        draw.text((100, 90), "合成 OCR 测试；不代表任何公司财务", font=font, fill="black")
        draw.text((100, 150), "2024 年度合并报表片段（测试）", font=font, fill="black")
        xs, ys = [100, 580, 850, 1140], [230, 300, 380, 470, 560, 650]
        for y in ys:
            draw.line((100, y, 1140, y), fill="black", width=2)
        draw.line((100, 230, 100, 650), fill="black", width=2)
        draw.line((1140, 230, 1140, 650), fill="black", width=2)
        for x in xs[1:-1]:
            draw.line((x, 300, x, 650), fill="black", width=2)
        draw.text((300, 250), "合并口径    单位：万元", font=font, fill="black")
        for x, label in zip(xs[:-1], ["项目", "2024年", "2023年"], strict=True):
            draw.text((x + 15, 325), label, font=font, fill="black")
        rows = [["营业收入", "(1,234.50)", "-2,000.00"], ["归母净利润", "-56.78", "-100.00"], ["经营现金流净额", "0.00", "123.45"]]
        if n == 2:
            rows = [["营业成本", "567.89", "500.00"], ["财务费用", "(12.34)", "10.00"], ["其他收益", "5.60", "0.00"]]
        for y, row in zip(ys[2:-1], rows, strict=True):
            for x, label in zip(xs[:-1], row, strict=True):
                draw.text((x + 15, y + 25), label, font=font, fill="black")
        draw.text((100, 750), "跨页表保留两套页/表定位；不自动合并或补值。", font=font, fill="black")
        draw.text((100, 1630), f"第 {n} 页，共 2 页", font=font, fill="black")
        image.save(root / f"synthetic-table-p{n}.png")
        pages.append(image)
    pages[0].save(root / "synthetic-table-scan.pdf", save_all=True, append_images=pages[1:], resolution=150)
    (root / "synthetic-expected.json").write_text(json.dumps({"kind": "synthetic", "unit": "万元", "page1": ["(1,234.50)", "-2,000.00", "-56.78", "-100.00", "0.00", "123.45"], "page2": ["567.89", "500.00", "(12.34)", "10.00", "5.60", "0.00"], "humanReview": "pending"}, ensure_ascii=False), "utf-8")


if __name__ == "__main__":
    main()
