"""Collect public CNINFO annual reports for the frozen research evaluation.

Only public issuer reports are downloaded. No app credentials or DB are used.
Raw files and holdout manifests stay under ignored data/. Re-running verifies
existing bytes; use the tracked development manifest to recover exact versions.
"""
import argparse
import hashlib
import json
import re
import time
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlencode
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[2]
BASE = ROOT / "data/research-agent-upgrade/dataset-v1"
HEADERS = {"User-Agent": "Mozilla/5.0", "Referer": "https://www.cninfo.com.cn/"}
DEVELOPMENT = [("600519.SH", "贵州茅台"), ("000858.SZ", "五粮液"),
               ("000333.SZ", "美的集团"), ("600309.SH", "万华化学")]


def request(url, data=None):
    body = urlencode(data).encode() if data else None
    with urlopen(Request(url, data=body, headers=HEADERS), timeout=45) as response:
        result = response.read(35_000_001)
    if len(result) > 35_000_000:
        raise ValueError("document too large")
    return result


def digest(data):
    return hashlib.sha256(data).hexdigest()


def collect(companies, split, base=BASE):
    mapping = json.loads(request("https://www.cninfo.com.cn/new/data/szse_stock.json"))
    orgs = {row["code"]: row["orgId"] for row in mapping["stockList"]}
    documents = []
    for symbol, name in companies:
        code = symbol[:6]
        payload = {"stock": f"{code},{orgs[code]}", "tabName": "fulltext", "pageSize": 30,
                   "pageNum": 1, "column": "", "category": "category_ndbg_szsh;",
                   "plate": "", "seDate": "2024-01-01~2025-06-30", "searchkey": "",
                   "secid": "", "sortName": "", "sortType": "", "isHLtitle": "true"}
        raw = request("https://www.cninfo.com.cn/new/hisAnnouncement/query", payload)
        items = json.loads(raw).get("announcements") or []
        for year in (2023, 2024):
            selected = [item for item in items if re.search(fr"{year}年?年度报告$", item["announcementTitle"])]
            if len(selected) != 1:
                raise ValueError(f"expected unique {symbol}/{year} original annual report")
            item = selected[0]
            url = "https://static.cninfo.com.cn/" + item["adjunctUrl"]
            directory = base / split / code
            directory.mkdir(parents=True, exist_ok=True)
            path = directory / f"{year}.pdf"
            content = path.read_bytes() if path.exists() else request(url)
            if not content.startswith(b"%PDF-"):
                raise ValueError("not a PDF")
            path.write_bytes(content)
            acquired = datetime.now(timezone.utc).isoformat()
            notice_date = datetime.fromtimestamp(item["announcementTime"] / 1000, timezone.utc).date().isoformat()
            documents.append({"id": f"{code}-{year}-annual", "symbol": symbol, "companyName": name,
                              "period": {"start": f"{year}-01-01", "end": f"{year}-12-31", "kind": "annual"},
                              "title": re.sub("<[^>]+>", "", item["announcementTitle"]),
                              "url": url, "announcementId": item["announcementId"],
                              "disclosedOn": notice_date, "disclosurePrecision": "date",
                              "availabilityRule": "available after end of disclosure day in Asia/Shanghai",
                              "disclosureEvidence": {"provider": "CNINFO", "query": payload,
                                                     "announcementTime": item["announcementTime"], "responseSha256": digest(raw)},
                              "bytesSha256": digest(content), "byteLength": len(content), "retrievedAt": acquired,
                              "path": path.relative_to(ROOT).as_posix() if split == "development" else path.as_posix(), "mediaType": "application/pdf",
                              "rights": "public issuer disclosure; research only; original URL retained"})
            (directory / f"{year}.announcement.json").write_text(json.dumps(item, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        time.sleep(0.2)
    manifest = {"schemaVersion": 1, "datasetVersion": "research-dev-v1" if split == "development" else "research-holdout-v1",
                "split": split, "asOf": "2025-06-30T15:59:59.999Z", "documents": documents}
    destination = base / split / "manifest.json"
    destination.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"{split}: {len(documents)} documents; manifest sha256={digest(destination.read_bytes())}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--holdout-registry", type=Path, help="controlled JSON company pairs outside tracked files")
    parser.add_argument("--holdout-root", type=Path, help="external controlled root; required for holdout")
    parser.add_argument("--restore-manifest", type=Path, help="recover exact public development bytes from the tracked manifest")
    args = parser.parse_args()
    if args.restore_manifest:
        saved = json.loads(args.restore_manifest.read_text(encoding="utf-8"))
        for doc in saved["documents"]:
            if not doc["url"].startswith("https://static.cninfo.com.cn/"):
                raise ValueError("not an official fixture URL")
            target = (ROOT / doc["path"]).resolve()
            if not target.is_relative_to(BASE):
                raise ValueError("fixture destination outside development directory")
            content = target.read_bytes() if target.exists() else request(doc["url"])
            if digest(content) != doc["bytesSha256"]:
                raise ValueError("upstream version changed; do not replace the frozen reference")
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(content)
        print("Recovered pinned development PDFs; regenerate page caches with extract-fixtures.ts")
        raise SystemExit(0)
    collect(DEVELOPMENT, "development")
    if args.holdout_registry:
        if not args.holdout_root or args.holdout_root.resolve().is_relative_to(ROOT):
            parser.error("holdout-root must be outside the repository")
        collect(json.loads(args.holdout_registry.read_text(encoding="utf-8")), "holdout", args.holdout_root)
