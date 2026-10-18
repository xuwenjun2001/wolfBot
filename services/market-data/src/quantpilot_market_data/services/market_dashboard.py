from __future__ import annotations

import asyncio
import copy
import hashlib
import json
import logging
import time
from collections import OrderedDict
from contextlib import asynccontextmanager
from datetime import UTC, datetime
from typing import Any

from quantpilot_market_data.cache import RedisJsonCache
from quantpilot_market_data.providers.dashboard import SHANGHAI, DashboardProvider
from quantpilot_market_data.services.dashboard_collector import DashboardCollector
from quantpilot_market_data.services.market_layout import MarketLayoutService

logger = logging.getLogger(__name__)


class MarketDashboardService:
    """Bounded single-flight queries, shared Redis cache, and explicit stale data."""

    def __init__(
        self, provider: DashboardProvider | None = None, cache: RedisJsonCache | None = None
    ) -> None:
        self.provider = provider or DashboardProvider()
        self.cache = cache or RedisJsonCache()
        self.layout = MarketLayoutService(self.provider, self.cache)
        self.collector = DashboardCollector(self.layout)
        self._locks = [asyncio.Lock() for _ in range(64)]
        self._queries = asyncio.Semaphore(4)
        self._memory: OrderedDict[str, tuple[float, dict]] = OrderedDict()

    async def close(self) -> None:
        await self.collector.close()
        await self.layout.close()
        await self.provider.close()
        await self.cache.close()

    @asynccontextmanager
    async def lifespan(self, _app: Any):
        self.collector.start()
        try:
            yield
        finally:
            await self.close()

    async def _load(self, resource: str, params: dict) -> dict:
        match resource:
            case "index-session":
                return await self.layout.index_session(params["index"])
            case "market-turnover":
                return await self.layout.turnover()
            case "overview" | "etfs":
                return await self.provider.quotes(resource == "etfs")
            case "sectors" | "themes" | "theme-stocks":
                return await self.provider.sectors(
                    "concept" if resource != "sectors" else params["kind"],
                    params["page"],
                    params["code"] if resource == "theme-stocks" else None,
                )
            case "sector-history":
                return await self.provider.sector_history(params["code"], params["period"])
            case "limits":
                return await self.provider.limits(params["pool"], params["date"])
            case "watch":
                return await self.provider.watch()
            case "dragon-tiger" | "seats":
                return await self.provider.dragon_tiger(params["date"], params.get("code"))
            case "institutions" | "strong":
                return await self.provider.institutions(resource == "strong")
            case "minute" | "kline":
                return await self.provider.minute(params["code"], resource == "kline")
            case _:
                raise ValueError("Unsupported dashboard resource")

    async def get(self, resource: str, params: dict[str, Any]) -> dict:
        if resource == "index-breadth":
            return await self.layout.breadth(params["index"])
        digest = hashlib.sha256(json.dumps([resource, params], sort_keys=True).encode()).hexdigest()
        key = f"dashboard-v2:{digest}"
        ttl = (
            60
            if resource in ("index-session", "market-turnover")
            else 30
            if resource in ("overview", "etfs", "minute")
            else 300
            if resource
            in (
                "institutions",
                "dragon-tiger",
                "seats",
                "kline",
                "theme-stocks",
            )
            else 120
        )
        # Waiting for another query is bounded too; a timeout starts no extra work.
        try:
            async with asyncio.timeout(24):
                async with self._locks[int(digest[:8], 16) % len(self._locks)]:
                    entry = await self.cache.read(key)
                    if not entry:
                        local = self._memory.get(key)
                        entry = local[1] if local and time.monotonic() - local[0] < 1800 else None
                    # Older cache entries may predate strict upstream date checks.
                    # Never retain a different trading day under a dated query.
                    if (
                        entry
                        and params.get("date")
                        and entry.get("tradeDate")
                        and entry["tradeDate"] != params["date"]
                    ):
                        entry = None
                    age = self._age(entry)
                    if entry and entry.get("retryAfter", 0) > time.time():
                        return {**copy.deepcopy(entry), "cacheHit": True}
                    if entry and age < (20 if entry.get("status") == "unavailable" else ttl):
                        return {**copy.deepcopy(entry), "cacheHit": True}
                    previous = (
                        entry
                        if entry and entry.get("status") != "unavailable" and age < 1800
                        else None
                    )
                    try:
                        async with self._queries, asyncio.timeout(20):
                            data = await self._load(resource, params)
                        trade_date = data.get("tradeDate")
                        today = datetime.now(SHANGHAI).date().isoformat()
                        historical = bool(trade_date and trade_date < today)
                        has_data = bool(data.get("rows") or data.get("sections"))
                        status = (
                            "stale"
                            if data.get("archiveStale")
                            else "partial"
                            if data.get("partial")
                            else "available"
                            if has_data
                            else "empty"
                        )
                        entry = {
                            **data,
                            "resource": resource,
                            "status": status,
                            "fetchedAt": data.get("dataFetchedAt") or datetime.now(UTC).isoformat(),
                            "cacheHit": False,
                            "stale": historical or not trade_date or bool(data.get("archiveStale")),
                            "fallbackReason": data.get("dataWarning"),
                            **(
                                {"retryAfter": time.time() + 20} if data.get("archiveStale") else {}
                            ),
                            "dateStatus": "historical"
                            if historical
                            else "current"
                            if trade_date
                            else "unknown",
                        }
                    except Exception as error:
                        logger.warning(
                            "dashboard resource=%s failed type=%s", resource, type(error).__name__
                        )
                        reason = "数据源暂不可用或该日期尚未发布，请稍后重试。"
                        if previous:
                            stale = {
                                **copy.deepcopy(previous),
                                "status": "stale",
                                "stale": True,
                                "cacheHit": True,
                                "fallbackReason": reason,
                                "retryAfter": time.time() + 20,
                            }
                            self._memory[key] = (time.monotonic(), copy.deepcopy(stale))
                            await self.cache.write(
                                key, ttl_seconds=max(1, int(1800 - age)), payload=stale
                            )
                            return stale
                        entry = {
                            "resource": resource,
                            "rows": [],
                            "source": "",
                            "tradeDate": None,
                            "status": "unavailable",
                            "fetchedAt": datetime.now(UTC).isoformat(),
                            "cacheHit": False,
                            "stale": True,
                            "dateStatus": "unknown",
                            "fallbackReason": reason,
                            "note": "未使用内置历史快照。",
                        }
                    self._memory[key] = (time.monotonic(), copy.deepcopy(entry))
                    self._memory.move_to_end(key)
                    while len(self._memory) > 512:
                        self._memory.popitem(last=False)
                    await self.cache.write(
                        key,
                        ttl_seconds=20 if entry["status"] == "unavailable" else 1800,
                        payload=entry,
                    )
                    return entry
        except TimeoutError:
            return {
                "resource": resource,
                "rows": [],
                "source": "",
                "tradeDate": None,
                "status": "unavailable",
                "fetchedAt": datetime.now(UTC).isoformat(),
                "cacheHit": False,
                "stale": True,
                "dateStatus": "unknown",
                "fallbackReason": "行情请求繁忙，请稍后重试。",
                "note": "",
            }

    @staticmethod
    def _age(entry: dict | None) -> float:
        try:
            return max(
                0, (datetime.now(UTC) - datetime.fromisoformat(entry["fetchedAt"])).total_seconds()
            )
        except TypeError, KeyError, ValueError:
            return float("inf")
