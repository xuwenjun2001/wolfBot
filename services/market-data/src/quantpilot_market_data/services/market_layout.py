from __future__ import annotations

import asyncio
import copy
import logging
import time
from datetime import UTC, datetime, timedelta

from quantpilot_market_data.providers.dashboard import BACKGROUND_QUERY, SHANGHAI, result
from quantpilot_market_data.providers.market_layout import MarketLayoutProvider
from quantpilot_market_data.repositories.dashboard_sessions import (
    DashboardSessionArchive,
    merge_day,
    session_from_archive,
)
from quantpilot_market_data.services.chart_data import ChartDataService
from quantpilot_market_data.services.turnover_comparison import (
    legacy_comparison,
    metric_comparisons,
)

logger = logging.getLogger(__name__)
BREADTH_TIMEOUT_SECONDS = 180


def age(entry: dict | None) -> float:
    try:
        return (datetime.now(UTC) - datetime.fromisoformat(entry["fetchedAt"])).total_seconds()
    except TypeError, KeyError, ValueError:
        return float("inf")


def envelope(data: dict, status: str = "available") -> dict:
    date = data.get("tradeDate")
    historical = bool(date and date < datetime.now(SHANGHAI).date().isoformat())
    return {
        **data,
        "resource": "index-breadth",
        "status": status,
        "fetchedAt": datetime.now(UTC).isoformat(),
        "cacheHit": False,
        "stale": historical or not date,
        "fallbackReason": None,
        "dateStatus": "historical" if historical else "current" if date else "unknown",
    }


class MarketLayoutService:
    def __init__(self, provider, cache, archive=None, calendar=None):
        self.provider = MarketLayoutProvider(provider)
        self.cache = cache
        self._sessions = {}
        self._locks = {key: asyncio.Lock() for key in ("sh", "sz", "cy", "kc")}
        self._breadth = {}
        self._tasks = {}
        self._worker = asyncio.Lock()
        self._closed = False
        self.archive = archive or (DashboardSessionArchive() if provider is not None else None)
        self.calendar = calendar or (ChartDataService(provider) if provider is not None else None)
        self._calendar_cache = {}
        self._calendar_lock = asyncio.Lock()

    async def trading_dates(self, current: str) -> list[str]:
        if self.calendar is None:
            return []
        async with self._calendar_lock:
            entry = self._calendar_cache.get(current)
            if entry and time.monotonic() - entry[0] < 60:
                return entry[1]
            end = datetime.fromisoformat(current)
            try:
                dates = await self.calendar.calendar(
                    (end - timedelta(days=60)).date().isoformat(), current
                )
            except Exception as error:
                logger.warning("dashboard calendar unavailable type=%s", type(error).__name__)
                dates = []
            self._calendar_cache = {current: (time.monotonic(), dates)}
            return dates

    async def close(self):
        self._closed = True
        for task in self._tasks.values():
            task.cancel()
        await asyncio.gather(*self._tasks.values(), return_exceptions=True)

    async def session(self, index: str, *, force=False) -> dict:
        async with self._locks[index]:
            key = f"dashboard-layout-session-v2:{index}"
            entry = await self.cache.read(key) or self._sessions.get(index)
            if not force and age(entry) < 60:
                return copy.deepcopy(entry["session"])
            archived, archive_error = {}, None
            if self.archive:
                try:
                    async with asyncio.timeout(3):
                        archived = await self.archive.read(index)
                except Exception as error:
                    archive_error = "历史留存暂不可用，恢复后自动重试。"
                    logger.warning(
                        "dashboard archive read index=%s type=%s", index, type(error).__name__
                    )
            try:
                data = await self.provider.session(index)
                data["fetchedAt"] = datetime.now(UTC).isoformat()
            except Exception as error:
                data = (
                    copy.deepcopy(entry["session"])
                    if entry
                    else session_from_archive(index, archived)
                )
                if not data:
                    raise
                data["archiveStale"] = True
                data["dataWarning"] = "更新失败，保留上次有效分时数据；稍后自动重试。"
                logger.warning(
                    "dashboard session retained index=%s type=%s", index, type(error).__name__
                )
            # Merge in-memory history too, so temporary database outages do not erase baselines.
            all_days = {d: p["minutes"] for d, p in archived.items()}
            if entry:
                for d, rows in entry["session"]["days"].items():
                    all_days[d] = merge_day(all_days.get(d, {}), rows)
            for d, rows in data["days"].items():
                incoming = {
                    t: {**r, "fetchedAt": r.get("fetchedAt", data["fetchedAt"])}
                    for t, r in rows.items()
                }
                all_days[d] = merge_day(all_days.get(d, {}), incoming)
            # An older response must not replace a newer known trading day.
            latest = max(all_days)
            if latest > data["tradeDate"]:
                retained = (
                    entry["session"]
                    if entry and entry["session"]["tradeDate"] == latest
                    else session_from_archive(index, archived)
                )
                data = {
                    **retained,
                    "archiveStale": True,
                    "dataWarning": "数据源尚未更新，保留最近交易日数据。",
                }
            data["days"] = all_days
            data["rows"] = list(
                sorted(all_days[data["tradeDate"]].values(), key=lambda r: r["time"])
            )
            dates = await self.trading_dates(data["tradeDate"])
            if not dates:
                # Previously verified dates remain valid through this same trading day.
                dates = archived.get(data["tradeDate"], {}).get("tradingDates", [])
                if not dates and entry and entry["session"]["tradeDate"] == data["tradeDate"]:
                    dates = entry["session"].get("tradingDates", [])
            keep = [d for d in dates if d <= data["tradeDate"]][-6:]
            # A sparse calendar must never authorize cleanup.
            keep = keep if len(keep) == 6 and keep[-1] == data["tradeDate"] else []
            data["tradingDates"] = dates
            if self.archive and not data.get("archiveStale"):
                try:
                    async with asyncio.timeout(3):
                        saved = await self.archive.save(index, data, keep)
                    data["days"] = {d: p["minutes"] for d, p in saved.items()}
                    archive_error = None
                except Exception as error:
                    archive_error = "历史留存暂不可用，当前数据仍可查看；恢复后自动重试。"
                    logger.warning(
                        "dashboard archive write index=%s type=%s", index, type(error).__name__
                    )
            if keep:
                data["days"] = {d: rows for d, rows in data["days"].items() if d in keep}
            data["rows"] = [dict(r) for _, r in sorted(data["days"][data["tradeDate"]].items())]
            preclose = data.get("previousClose")
            for row in data["rows"]:
                for field, target in (("price", "changePct"), ("leading", "leadingPct")):
                    row[target] = (
                        (row[field] / preclose - 1) * 100
                        if row.get(field) is not None and preclose and preclose > 0
                        else None
                    )
            data["archiveWarning"] = archive_error
            entry = {"session": data, "fetchedAt": datetime.now(UTC).isoformat()}
            self._sessions[index] = entry
            await self.cache.write(key, ttl_seconds=60, payload=entry)
            return copy.deepcopy(data)

    async def index_session(self, index: str):
        data = await self.session(index)
        metrics = metric_comparisons([data], data.get("tradingDates", []))
        comparison = legacy_comparison(metrics["amount"])
        return result(
            data["rows"],
            "东方财富",
            data["tradeDate"],
            "实际指数按昨收计算涨跌幅；领先线为源提供的数值，不代表已验证的等权指数。"
            + ("历史接口暂不可用，当前使用延迟行情源。" if data.get("fallback") else ""),
            name=data["name"],
            previousClose=data["previousClose"],
            comparison=comparison,
            metrics=metrics,
            dataFetchedAt=data.get("fetchedAt"),
            dataWarning=data.get("dataWarning") or data.get("archiveWarning"),
            archiveStale=data.get("archiveStale", False),
            partial=any(
                not m["ma5Status"]["complete"] or m["reason"] or m["retained"]
                for m in metrics.values()
            ),
        )

    async def turnover(self):
        # No nested MarketDashboardService.get calls: avoid striped-lock deadlocks.
        sessions = await asyncio.gather(self.session("sh"), self.session("sz"))
        dates = sorted(set.intersection(*(set(s.get("tradingDates", [])) for s in sessions)))
        metrics = metric_comparisons(sessions, dates)
        comparison = legacy_comparison(metrics["amount"])
        return result(
            comparison["rows"],
            "东方财富",
            comparison["currentDate"],
            "沪深市场合计，不重复计入创业板；按两个交易日共同分钟比较。",
            comparison=comparison,
            metrics=metrics,
            dataFetchedAt=min(s.get("fetchedAt", "") for s in sessions),
            dataWarning=next(
                (
                    s.get("dataWarning") or s.get("archiveWarning")
                    for s in sessions
                    if s.get("dataWarning") or s.get("archiveWarning")
                ),
                None,
            ),
            archiveStale=any(s.get("archiveStale") for s in sessions),
            partial=any(
                not m["ma5Status"]["complete"] or m["reason"] or m["retained"]
                for m in metrics.values()
            ),
        )

    async def breadth(self, index: str):
        key = f"dashboard-layout-breadth-v1:{index}"
        entry = await self.cache.read(key) or self._breadth.get(index)
        if entry and (
            entry.get("retryAfter", 0) > time.time()
            or age(entry) < (20 if entry.get("status") == "unavailable" else 300)
        ):
            return {**copy.deepcopy(entry), "cacheHit": True}
        task = self._tasks.get(index)
        if (task is None or task.done()) and not self._closed:
            self._tasks[index] = asyncio.create_task(self._refresh(index, entry))
        if entry and age(entry) < 1800 and entry.get("complete"):
            return {
                **copy.deepcopy(entry),
                "cacheHit": True,
                "refreshing": True,
                "stale": True,
                "fallbackReason": "正在更新涨跌统计，下方为上次完整结果。",
            }
        return envelope(
            result(
                [],
                "东方财富",
                note="后台分页统计中，完成前不展示部分家数。",
                complete=False,
                refreshing=True,
            ),
            "pending",
        )

    async def _refresh(self, index: str, previous: dict | None):
        key = f"dashboard-layout-breadth-v1:{index}"
        try:
            async with self._worker:
                async with asyncio.timeout(BREADTH_TIMEOUT_SECONDS):
                    token = BACKGROUND_QUERY.set(True)
                    try:
                        data = await self.provider.breadth(index)
                    finally:
                        BACKGROUND_QUERY.reset(token)
                entry = envelope(data)
        except asyncio.CancelledError:
            raise
        except Exception as error:
            logger.warning("dashboard breadth index=%s failed type=%s", index, type(error).__name__)
            if previous and age(previous) < 1800 and previous.get("complete"):
                entry = {
                    **previous,
                    "status": "stale",
                    "stale": True,
                    "refreshing": False,
                    "retryAfter": time.time() + 20,
                    "fallbackReason": "涨跌统计未完成，保留上次完整结果。",
                }
            else:
                entry = envelope(
                    result(
                        [],
                        "东方财富",
                        note="分页未完整返回，未发布部分统计。",
                        complete=False,
                        refreshing=False,
                    ),
                    "unavailable",
                )
                entry["fallbackReason"] = "涨跌统计暂不可用，请稍后重试。"
        self._breadth[index] = entry
        await self.cache.write(
            key,
            ttl_seconds=20 if entry["status"] in ("unavailable", "stale") else 1800,
            payload=entry,
        )
