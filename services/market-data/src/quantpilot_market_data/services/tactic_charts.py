"""Read-only chart snapshots and explicit, coalesced refreshes, separate from tactic evidence."""

import asyncio
import copy
import math
from datetime import UTC, datetime
from zoneinfo import ZoneInfo

from psycopg.types.json import Jsonb

from quantpilot_market_data.repositories import tactics as repo
from quantpilot_market_data.services.quotes import get_history_quote
from quantpilot_market_data.tactics import is_mainboard


def cache_parameters(mode):
    return "daily:qfq:320:v1" if mode == "daily" else "session:none:2:v1"


def event(event_id):
    result = repo.event_detail(event_id)
    if not result or not is_mainboard(result["symbol"]):
        raise ValueError("观察事件不存在或非主板股票")
    return result


def cached_chart(e, mode):
    with repo.connection() as conn:
        row = conn.execute(
            "SELECT payload FROM quant.tactic_chart_cache WHERE symbol=%s AND mode=%s "
            "AND parameters=%s",
            (e["symbol"], mode, cache_parameters(mode)),
        ).fetchone()
        if row:
            return {**row["payload"], "cacheKind": "saved"}
        if mode == "session":
            return {"mode": mode, "cacheKind": "empty", "session": None}
        bars = copy.deepcopy(e["bars"])
        dates = [b["date"] for b in bars]
        local = (
            conn.execute(
                "SELECT DISTINCT ON ((ts AT TIME ZONE 'Asia/Shanghai')::date) "
                "(ts AT TIME ZONE 'Asia/Shanghai')::date AS trade_day,amount,provider FROM "
                "quant.canonical_stock_bars WHERE symbol=%s AND timeframe='daily' AND "
                "(ts AT TIME ZONE 'Asia/Shanghai')::date=ANY(%s::date[]) AND amount IS NOT NULL "
                "ORDER BY (ts AT TIME ZONE 'Asia/Shanghai')::date,adjustment",
                (e["symbol"], dates),
            ).fetchall()
            if dates
            else []
        )
        amounts = {str(r["trade_day"]): r for r in local}
        for b in bars:
            if b.get("amount") is None and b["date"] in amounts:
                r = amounts[b["date"]]
                if math.isfinite(float(r["amount"])) and r["amount"] >= 0:
                    b["amount"] = float(r["amount"])
                    b["metadata"] = {"amountEvidence": {"source": r["provider"]}}
        return {
            "mode": mode,
            "cacheKind": "snapshot",
            "bars": bars,
            "source": "baostock",
            "fetchedAt": "",
            "tradeDate": max(dates, default=None),
            "metadata": {"volumeUnit": "手", "amountUnit": "元"},
        }


def persist_chart(symbol, mode, payload):
    with repo.connection() as conn:
        conn.execute(
            "INSERT INTO quant.tactic_chart_cache(symbol,mode,parameters,payload,fetched_at) "
            "VALUES(%s,%s,%s,%s,%s) ON CONFLICT(symbol,mode,parameters) DO UPDATE SET "
            "payload=EXCLUDED.payload,fetched_at=EXCLUDED.fetched_at "
            "WHERE quant.tactic_chart_cache.fetched_at<=EXCLUDED.fetched_at",
            (symbol, mode, cache_parameters(mode), Jsonb(payload), payload["fetchedAt"]),
        )


class TacticChartService:
    def __init__(self, client, cache, intraday_cache, charts):
        self.client, self.cache = client, cache
        self.intraday_cache, self.charts = intraday_cache, charts
        self.pending = {}

    async def refresh(self, symbol, mode):
        key = (symbol, mode)
        task = self.pending.get(key)
        if task is None:
            task = asyncio.create_task(self._refresh(symbol, mode))
            self.pending[key] = task

            def done(completed):
                self.pending.pop(key, None)
                if not completed.cancelled():
                    completed.exception()

            task.add_done_callback(done)
        return await asyncio.shield(task)

    async def _refresh(self, symbol, mode):
        async with asyncio.timeout(22):
            if mode == "session":
                response = await self.charts.session(symbol, refresh=True)
                if response.status == "unavailable" or not response.rows:
                    raise ValueError(response.reason or "分时数据暂不可用")
                payload = {
                    "mode": mode,
                    "cacheKind": "refreshed",
                    "session": response.model_dump(mode="json"),
                    "fetchedAt": response.fetchedAt,
                    "tradeDate": response.tradeDate,
                }
            else:
                response = await get_history_quote(
                    self.client,
                    self.cache,
                    self.intraday_cache,
                    symbol=symbol,
                    period="daily",
                    adjustment="qfq",
                    limit=320,
                    end="20500101",
                    refresh=True,
                    ttl_seconds=60,
                )
                expected = ("1." if symbol.endswith(".SH") else "0.") + symbol[:6]
                if response.secid != expected or not response.bars or response.adjustment != "qfq":
                    raise ValueError("日K为空或证券/复权口径不匹配")
                response = response.model_copy(update={"bars": response.bars[-320:]})
                dates = [b.date for b in response.bars]
                if dates != sorted(set(dates)):
                    raise ValueError("日K日期异常，保留原缓存")
                for b in response.bars:
                    values = [b.open, b.close, b.high, b.low]
                    if any(v is None or not math.isfinite(float(v)) or v <= 0 for v in values):
                        raise ValueError("日K价格不完整，保留原缓存")
                    if not b.low <= min(b.open, b.close) <= max(b.open, b.close) <= b.high:
                        raise ValueError("日K价格结构异常，保留原缓存")
                response = await self.charts.enrich(response, refresh=True)
                fetched = response.fetched_at.astimezone(ZoneInfo("Asia/Shanghai"))
                for b in response.bars:
                    b.metadata = {
                        **(b.metadata or {}),
                        "tacticProvisional": b.date == fetched.date().isoformat()
                        and fetched.hour < 15,
                    }
                payload = {
                    "mode": mode,
                    "cacheKind": "refreshed",
                    "bars": [b.model_dump(mode="json") for b in response.bars],
                    "source": response.source,
                    "metadata": response.metadata,
                    "fetchedAt": str(response.fetched_at),
                    "tradeDate": dates[-1],
                }
            # Store the actual successful fetch time, never the time of a cache read.
            payload["fetchedAt"] = payload.get("fetchedAt") or datetime.now(UTC).isoformat()
            await asyncio.to_thread(persist_chart, symbol, mode, payload)
            return payload
