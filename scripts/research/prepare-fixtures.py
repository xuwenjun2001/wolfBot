"""Freeze source-checked development references, never label them human golden."""
import hashlib
import json
from decimal import Decimal, ROUND_HALF_UP
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
TRACKED = ROOT / "fixtures/company-research"
BASE = ROOT / "data/research-agent-upgrade/dataset-v1/development"


def write(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def main():
    manifest = json.loads((BASE / "manifest.json").read_text(encoding="utf-8"))
    # Transcribed from the original major accounting data tables, not model outputs.
    values = {
        "600519": {"pages": [5, 5], "unit": "yuan", "riskPages": [21, 22],
                   "numbers": [["147693604994.14", "74734071550.75", "66593247721.09"], ["170899152276.34", "86228146421.62", "92463692168.43"]],
                   "riskQuotes": ["一是宏观经济风险；二是安全风险；三是舆情风险；四是环境保护风险。"] * 2,
                   "riskAnswer": "两期均列宏观经济、安全、舆情、环境保护四类风险；不能据此断言风险程度未变化。"},
        "000858": {"pages": [7, 7], "unit": "yuan", "riskPages": [22, 21],
                   "numbers": [["83272067317.19", "30210585269.30", "41742479908.23"], ["89175178322.70", "31853172533.98", "33939755192.78"]],
                   "riskQuotes": ["一是内外部环境不确定性风险；二是有效需求恢复不及预期的风险；三是行业竞争尤其是头部企业", "一是内外部环境不确定性风险；二是消费需求持续低迷、恢复不及预期；三是行业竞争加剧尤其是"],
                   "riskAnswer": "不确定性、需求和头部竞争延续；2024 年需求描述新增持续低迷，不等同于新增独立风险类别。"},
        "000333": {"pages": [10, 9], "unit": "thousand_yuan", "riskPages": [68, 65],
                   "numbers": [["372037280", "33719935", "57902611"], ["407149600", "38537237", "60511572"]],
                   "riskQuotes": ["（5）贸易摩擦和关税壁垒带来市场风险", "和加征关税等措施引起的贸易摩擦，加重了企业的经营成本"],
                   "riskAnswer": "宏观、要素价格、海外配置、汇兑、贸易壁垒风险延续；2024 文本增加加征关税表述，不能把整类风险说成首次出现。"},
        "600309": {"pages": [7, 7], "unit": "yuan", "riskPages": [32, 33],
                   "numbers": [["175360935668.36", "16815755534.31", "26796752552.51"], ["182069119160.94", "13033066612.84", "30053435178.33"]],
                   "riskQuotes": ["2.组织绩效管理跟不上业务发展的风险", "2.激励体系与业务发展不匹配的风险"],
                   "riskAnswer": "安全和人才风险延续；第二项从绩效管理适应性改为激励体系适配，属于表述与关注变化，不能断言旧风险消除。"},
    }
    questions = ["比较两期营业收入与归母净利润及增幅，说明口径。", "比较两期经营活动现金流量净额及增幅，与利润方向是否一致？解释须有证据。", "比较主要风险的延续与表述变化，引用两期原文；不要把未发现写成风险消失。"]
    cases = []
    for code, reference in values.items():
        docs = [next(d for d in manifest["documents"] if d["id"] == f"{code}-{year}-annual") for year in [2023, 2024]]
        facts = []
        risks = []
        for index, doc in enumerate(docs):
            pages = json.loads((ROOT / doc["pagesPath"]).read_text(encoding="utf-8"))
            page = pages[reference["pages"][index] - 1]
            for metric, raw in zip(["revenue", "parent_net_profit", "operating_cash_flow"], reference["numbers"][index]):
                # Keep exact source text and file page, not invented coordinates.
                formatted = f"{Decimal(raw):,.2f}" if reference["unit"] == "yuan" else f"{int(raw):,}"
                offset = page["text"].index(formatted)
                quote = page["text"][max(0, offset - 95):offset + len(formatted) + 100]
                facts.append({"metric": metric, "period": doc["period"], "rawValue": raw, "unit": reference["unit"], "currency": "CNY", "scope": "consolidated", "basis": "cumulative",
                              "normalizedYuan": str(Decimal(raw) * (1000 if reference["unit"] == "thousand_yuan" else 1)),
                              "citation": {"documentId": doc["id"], "bytesSha256": doc["bytesSha256"], "filePage": page["page"], "quote": quote}})
            risk_page = pages[reference["riskPages"][index] - 1]
            risk_quote = reference["riskQuotes"][index]
            if "".join(risk_quote.split()) not in "".join(risk_page["text"].split()):
                raise ValueError(f"risk quote missing for {doc['id']}")
            risks.append({"documentId": doc["id"], "bytesSha256": doc["bytesSha256"], "filePage": risk_page["page"], "quote": risk_quote})
        changes = []
        for metric_index, metric in enumerate(["revenue", "parent_net_profit", "operating_cash_flow"]):
            before, after = [Decimal(row[metric_index]) for row in reference["numbers"]]
            changes.append({"metric": metric, "percentage": str(((after - before) / abs(before) * 100).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP))})
        cases.append({"id": f"dev-{code}", "company": {"symbol": docs[0]["symbol"], "name": docs[0]["companyName"]}, "documentIds": [d["id"] for d in docs],
                      "asOf": manifest["asOf"], "questions": [{"id": f"q{i+1}", "text": q} for i, q in enumerate(questions)],
                      "reference": {"status": "source_checked_agent_reference", "humanReview": "pending", "facts": facts, "changes": changes, "riskCitations": risks, "riskAnswer": reference["riskAnswer"]}})
    write(TRACKED / "development.json", {"schemaVersion": 1, "datasetVersion": "research-dev-v1", "cases": cases})
    write(TRACKED / "documents.json", manifest)
    print("Frozen 4 development companies / 12 questions / 24 source-checked numeric facts")


if __name__ == "__main__":
    main()
