from __future__ import annotations

import json
import re
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any, Iterable

import requests

from .config import Settings, settings
from .db import Database, utc_now


class MarketError(RuntimeError):
    pass


def normalize_ticker(value: str) -> str:
    raw = str(value or "").strip().lower()
    if not raw:
        raise ValueError("代码不能为空")
    if raw[:2] in {"sh", "sz", "bj"} and re.fullmatch(r"\d{6}", raw[2:]):
        return raw
    match = re.fullmatch(r"(\d{6})(?:\.(sh|sz|bj))?", raw)
    if not match:
        raise ValueError(f"无法识别证券代码: {value}")
    code, suffix = match.groups()
    if suffix:
        return f"{suffix}{code}"
    # Indices and Shanghai ETFs need explicit handling before generic rules.
    if code in {"000001", "000016", "000300", "000905", "000852", "000688", "000989"} or code.startswith("5"):
        return f"sh{code}"
    if code.startswith(("15", "16")):
        return f"sz{code}"
    if code.startswith("399"):
        return f"sz{code}"
    if code.startswith(("4", "8", "92")):
        return f"bj{code}"
    if code.startswith(("6", "68", "9")):
        return f"sh{code}"
    if code.startswith(("0", "3")):
        return f"sz{code}"
    raise ValueError(f"无法推断交易所: {value}")


def _float(value: Any) -> float | None:
    if value is None:
        return None
    text = str(value).replace(",", "").strip()
    if not text or text in {"-", "--", "N/A", "null"}:
        return None
    try:
        return float(text)
    except ValueError:
        return None


@dataclass(frozen=True)
class MarketSnapshot:
    code: str
    snapshot_at: str
    source: str
    price: float | None
    change_pct: float | None
    extra: dict[str, Any]
    status: str = "ok"
    error: str = ""


def parse_tencent_response(body: str, snapshot_at: str | None = None) -> list[MarketSnapshot]:
    result: list[MarketSnapshot] = []
    when = snapshot_at or utc_now()
    for match in re.finditer(r'v_([a-z]{2}\d{6})="([^"]*)"', body, re.I):
        code = match.group(1).lower()
        fields = match.group(2).split("~")
        name = fields[1] if len(fields) > 1 else code
        price = _float(fields[3] if len(fields) > 3 else None)
        previous = _float(fields[4] if len(fields) > 4 else None)
        change = ((price - previous) / previous * 100) if price is not None and previous else None
        if change is None and len(fields) > 32:
            change = _float(fields[32])
        result.append(
            MarketSnapshot(
                code=code,
                snapshot_at=when,
                source="tencent",
                price=price,
                change_pct=change,
                extra={
                    "name": name,
                    "previous_close": previous,
                    "asof_basis": "previous_close from Tencent quote",
                    "raw_fields": fields[:12],
                },
                status="ok" if price is not None else "error",
                error="报价字段缺失" if price is None else "",
            )
        )
    return result


class MarketClient:
    def __init__(self, config: Settings = settings, session: requests.Session | None = None):
        self.config = config
        self.session = session or requests.Session()
        self.session.headers.update(
            {
                "User-Agent": "Mozilla/5.0 (WolfDashboard; local)",
                "Referer": "https://gu.qq.com/",
            }
        )

    def tencent_quotes(self, codes: Iterable[str]) -> list[MarketSnapshot]:
        normalized = [normalize_ticker(code) for code in codes]
        if not normalized:
            return []
        url = "https://qt.gtimg.cn/q=" + ",".join(normalized)
        try:
            response = self.session.get(url, timeout=self.config.request_timeout)
            response.raise_for_status()
            body = response.content.decode("gb18030", errors="replace")
            snapshots = parse_tencent_response(body)
            found = {item.code for item in snapshots}
            for code in normalized:
                if code not in found:
                    snapshots.append(
                        MarketSnapshot(code, utc_now(), "tencent", None, None, {}, "error", "行情接口未返回该代码")
                    )
            return snapshots
        except Exception as exc:
            return [MarketSnapshot(code, utc_now(), "tencent", None, None, {}, "error", str(exc)) for code in normalized]

    def previous_day_bar(self, code: str, asof_date: str | None = None) -> dict[str, Any]:
        """Read the latest completed daily bar for a premarket baseline."""
        normalized = normalize_ticker(code)
        response = self.session.get(
            "https://web.ifzq.gtimg.cn/appstock/app/kline/kline",
            params={"param": f"{normalized},day,,,320"},
            timeout=self.config.request_timeout,
        )
        response.raise_for_status()
        body = response.json()
        series = (((body.get("data") or {}).get(normalized) or {}).get("day") or [])
        cutoff = asof_date or datetime.now(timezone(timedelta(hours=8))).date().isoformat()
        completed = [row for row in series if isinstance(row, list) and row and str(row[0]) < cutoff]
        if not completed:
            raise MarketError(f"{normalized} 没有可用的上一交易日 K 线")
        row = completed[-1]
        if len(row) < 6:
            raise MarketError(f"{normalized} 上一交易日 K 线字段不完整")
        return {
            "date": str(row[0]),
            "open": _float(row[1]),
            "close": _float(row[2]),
            "high": _float(row[3]),
            "low": _float(row[4]),
            "volume": _float(row[5]),
            "source": "Tencent daily K-line",
        }


def persist_snapshots(db: Database, snapshots: Iterable[MarketSnapshot]) -> None:
    with db.transaction() as conn:
        for snapshot in snapshots:
            conn.execute(
                """INSERT INTO market_snapshots(code,snapshot_at,source,price,change_pct,extra_json,status,error)
                VALUES(?,?,?,?,?,?,?,?)""",
                (
                    snapshot.code,
                    snapshot.snapshot_at,
                    snapshot.source,
                    snapshot.price,
                    snapshot.change_pct,
                    json.dumps(snapshot.extra, ensure_ascii=False),
                    snapshot.status,
                    snapshot.error,
                ),
            )


def watchlist_codes(db: Database) -> list[str]:
    rows = db.query("SELECT code FROM watchlist WHERE enabled=1 ORDER BY code")
    codes = [str(row["code"]) for row in rows]
    if not codes:
        codes = ["sh000001", "sz399001", "sz399006", "sh000300"]
    return codes


def update_watchlist_snapshots(db: Database, client: MarketClient | None = None) -> list[MarketSnapshot]:
    client = client or MarketClient()
    snapshots = client.tencent_quotes(watchlist_codes(db))
    enriched: list[MarketSnapshot] = []
    for snapshot in snapshots:
        extra = dict(snapshot.extra)
        try:
            extra["previous_day"] = client.previous_day_bar(snapshot.code)
        except Exception as exc:
            extra["previous_day_error"] = str(exc)
        enriched.append(
            MarketSnapshot(
                snapshot.code,
                snapshot.snapshot_at,
                snapshot.source,
                snapshot.price,
                snapshot.change_pct,
                extra,
                snapshot.status,
                snapshot.error,
            )
        )
    snapshots = enriched
    persist_snapshots(db, snapshots)
    db.add_event(
        "market",
        {"count": len(snapshots), "errors": sum(snapshot.status != "ok" for snapshot in snapshots)},
    )
    return snapshots


def latest_snapshots(db: Database) -> list[dict[str, Any]]:
    rows = db.query(
        """SELECT m.* FROM market_snapshots m
        JOIN (SELECT code, MAX(id) AS id FROM market_snapshots GROUP BY code) latest
        ON latest.id=m.id ORDER BY m.code"""
    )
    return [
        {
            "code": row["code"],
            "snapshot_at": row["snapshot_at"],
            "source": row["source"],
            "price": row["price"],
            "change_pct": row["change_pct"],
            "extra": json.loads(row["extra_json"] or "{}"),
            "status": row["status"],
            "error": row["error"],
        }
        for row in rows
    ]
