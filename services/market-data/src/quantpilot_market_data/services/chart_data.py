"""Read-only chart enrichment and two-session data for generated dashboards."""

from __future__ import annotations

import asyncio
import copy
import re
import time
from collections import OrderedDict
from datetime import UTC, datetime, timedelta
from decimal import Decimal

from pydantic import BaseModel, Field

from quantpilot_market_data.models import KlineResponse
from quantpilot_market_data.providers.baidu_chart import fetch_daily_amounts, supports_amount
from quantpilot_market_data.providers.dashboard import (
    SHANGHAI,
    DashboardProvider,
    DashboardUpstreamError,
    day,
    number,
)
from quantpilot_market_data.providers.eastmoney import normalize_secid, parse_kline_payload
from quantpilot_market_data.providers.market_layout import MINUTES, cumulative
from quantpilot_market_data.repositories.bars import get_local_kline, resolve_local_symbol
from quantpilot_market_data.repositories.foundation import list_trading_calendar_days


class SessionPoint(BaseModel):
    time: str
    price: float | None = None
    changePct: float | None = None
    minuteVolume: float | None = None
    minuteAmount: float | None = None
    amount: float | None = None
    previous: float | None = None
    difference: float | None = None
    changeAmountPct: float | None = None
    provisional: bool = False


class SecuritySessionResponse(BaseModel):
    symbol: str
    secid: str
    name: str
    market: str
    timezone: str = "Asia/Shanghai"
    source: str = "eastmoney"
    fetchedAt: str
    tradeDate: str | None = None
    previousDate: str | None = None
    previousClose: float | None = None
    volumeUnit: str = "手"
    amountUnit: str = "元"
    cacheHit: bool = False
    status: str = "available"
    reason: str | None = None
    cutoff: str | None = None
    rows: list[SessionPoint] = Field(default_factory=list)


def chart_secid(symbol: str) -> str:
    # Preserve explicit market prefixes; the legacy resolver strips some prefixes.
    match = re.fullmatch(r"(?i)(sh|sz)(\d{6})", symbol.strip())
    suffix = re.fullmatch(r"(?i)(\d{6})\.(sh|sz)", symbol.strip())
    if match:
        secid = ("1" if match[1].lower() == "sh" else "0") + "." + match[2]
    elif suffix:
        secid = ("1" if suffix[2].lower() == "sh" else "0") + "." + suffix[1]
    else:
        secid = normalize_secid(symbol)
    if not re.fullmatch(r"[01]\.\d{6}", secid) or secid[2:].startswith(("4", "8", "92")):
        raise ValueError("分时图暂支持沪深股票、ETF和指数，请使用明确的市场代码")
    return secid


def nonnegative(value):
    parsed = number(value)
    return parsed if parsed is not None and parsed >= 0 else None


def parse_sessions(data: dict, secid: str) -> dict[str, dict[str, dict]]:
    if not isinstance(data, dict) or not isinstance(data.get("trends"), list):
        raise DashboardUpstreamError("分时源未返回有效序列")
    if str(data.get("code", "")) != secid[2:]:
        raise DashboardUpstreamError("分时源标的与请求不匹配")
    days: dict[str, dict[str, dict]] = {}
    for line in data["trends"]:
        parts = str(line).split(",")
        if len(parts) < 8:
            continue
        date, minute = day(parts[0]), parts[0][11:16]
        if not date or minute not in MINUTES:
            continue
        row = {
            "time": minute,
            "price": number(parts[2]),
            "minuteVolume": nonnegative(parts[5]),
            "minuteAmount": nonnegative(parts[6]),
        }
        old = days.setdefault(date, {}).get(minute)
        if old is not None and old != row:
            raise DashboardUpstreamError("同一分钟返回冲突记录")
        days[date][minute] = row
    if not days:
        raise DashboardUpstreamError("没有有效交易时段数据")
    return days


def build_session(
    data: dict, secid: str, previous_date: str | None, *, now: datetime | None = None
) -> SecuritySessionResponse:
    now = now or datetime.now(SHANGHAI)
    days = parse_sessions(data, secid)
    current = max(days)
    current_amounts = cumulative(days[current])
    previous_amounts = cumulative(days.get(previous_date, {})) if previous_date else {}
    preclose = number(data.get("preClose"))
    rows = []
    for minute, raw in sorted(days[current].items()):
        amount, before = current_amounts.get(minute), previous_amounts.get(minute)
        difference = amount - before if amount is not None and before is not None else None
        price = raw["price"]
        rows.append(
            SessionPoint(
                **raw,
                amount=amount,
                previous=before,
                changePct=(price / preclose - 1) * 100
                if price is not None and preclose and preclose > 0
                else None,
                difference=difference,
                changeAmountPct=difference / before * 100
                if difference is not None and before and before > 0
                else None,
                provisional=current == now.date().isoformat() and minute >= now.strftime("%H:%M"),
            )
        )
    aligned = [row.time for row in rows if row.difference is not None]
    reason = None
    if previous_date is None:
        reason = "交易日历不足，无法确认上一交易日；仅展示可核验的当日数据。"
    elif previous_date not in days:
        reason = "缺少上一交易日分时数据；未使用更早日期代替。"
    elif not aligned or aligned[-1] != rows[-1].time:
        reason = "分钟数据有缺口，仅在连续累计的区间比较。"
    return SecuritySessionResponse(
        symbol=secid[2:],
        secid=secid,
        name=str(data.get("name") or secid[2:]),
        market="SH" if secid.startswith("1.") else "SZ",
        fetchedAt=now.astimezone(UTC).isoformat(),
        tradeDate=current,
        previousDate=previous_date,
        previousClose=preclose,
        rows=rows,
        status="partial" if reason else "available",
        reason=reason,
        cutoff=aligned[-1] if aligned else None,
    )


class ChartDataService:
    def __init__(self, provider: DashboardProvider):
        self.provider = provider
        self._locks = [asyncio.Lock() for _ in range(32)]
        self._cache: OrderedDict[str, tuple[float, object]] = OrderedDict()
        self._calendar_cache: tuple[float, list[str]] | None = None

    async def _cached(self, key, loader, ttl=60, refresh=False):
        async with self._locks[hash(key) % len(self._locks)]:
            cached = self._cache.get(key)
            if not refresh and cached and time.monotonic() - cached[0] < ttl:
                result = copy.deepcopy(cached[1])
                if isinstance(result, SecuritySessionResponse):
                    result.cacheHit = True
                return result
            result = await loader()
            self._cache[key] = (time.monotonic(), copy.deepcopy(result))
            self._cache.move_to_end(key)
            while len(self._cache) > 256:
                self._cache.popitem(last=False)
            return result

    async def calendar(self, start: str, end: str) -> list[str]:
        try:
            async with asyncio.timeout(3):
                days = await list_trading_calendar_days(start=start, end=end, limit=1000)
            # Inferred dates from sparse security bars cannot prove adjacency.
            known = [d for d in days if not d.metadata.get("inferred")]
            dates = {d.trade_date.isoformat() for d in known}
            expected = (datetime.fromisoformat(end) - datetime.fromisoformat(start)).days + 1
            if len(dates) == expected:
                return sorted({d.trade_date.isoformat() for d in known if d.is_open})
        except Exception:
            pass  # Unavailable calendar must never turn an arbitrary older day into yesterday.
        # A continuously traded broad index is independent of security suspensions.
        # Verify actual benchmark observations, never manufacture weekday calendars.
        try:
            cached = self._calendar_cache
            if cached and time.monotonic() - cached[0] < 300:
                observed = cached[1]
            else:
                async with asyncio.timeout(4):
                    payload = await self.provider._json(
                        "https://web.ifzq.gtimg.cn/appstock/app/fqkline/get",
                        {"param": "sh000001,day,,,1000,"},
                    )
                node = (payload.get("data") or {}).get("sh000001", {})
                observed = sorted(
                    {
                        str(row[0])
                        for row in node.get("day", [])
                        if isinstance(row, list) and len(row) >= 6 and day(row[0])
                    }
                )
                if payload.get("code") != 0 or not observed:
                    return []
                self._calendar_cache = (time.monotonic(), observed)
            if observed[0] <= start and observed[-1] >= end:
                return [d for d in observed if start <= d <= end]
        except Exception:
            pass
        return []

    async def _raw_session(self, secid: str) -> tuple[dict, bool]:
        params = {
            "secid": secid,
            "fields1": "f1,f2,f3,f4,f5,f6,f7,f8,f9,f10,f11,f12,f13",
            "fields2": "f51,f52,f53,f54,f55,f56,f57,f58",
            "ndays": 2,
            "iscr": 0,
            "iscca": 0,
        }
        for host in ("push2his", "push2delay"):
            try:
                async with asyncio.timeout(3.5):
                    payload = await self.provider._json(
                        f"https://{host}.eastmoney.com/api/qt/stock/trends2/get", params
                    )
                data = payload.get("data")
                parse_sessions(data, secid)
                return data, host == "push2delay"
            except Exception:
                if host == "push2delay":
                    raise
        raise DashboardUpstreamError("分时不可用")

    async def session(self, symbol: str, *, refresh=False) -> SecuritySessionResponse:
        secid = chart_secid(symbol)

        async def load():
            try:
                started = time.monotonic()
                async with asyncio.timeout(7.1):
                    data, delayed = await self._raw_session(secid)
                current = max(parse_sessions(data, secid))
                start = (datetime.fromisoformat(current) - timedelta(days=20)).date().isoformat()
                try:
                    async with asyncio.timeout(max(0.1, 8 - (time.monotonic() - started))):
                        dates = await self.calendar(start, current)
                except TimeoutError:
                    dates = []  # Keep valid current-day data even if calendar lookup is slow.
                previous = (
                    max((d for d in dates if d < current), default=None)
                    if current in dates
                    else None
                )
                result = build_session(data, secid, previous)
                if delayed:
                    result.source = "eastmoney-delayed"
                    result.reason = "使用延迟行情源。" + (result.reason or "")
                return result
            except Exception:
                return SecuritySessionResponse(
                    symbol=secid[2:],
                    secid=secid,
                    name=secid[2:],
                    market="SH" if secid.startswith("1.") else "SZ",
                    fetchedAt=datetime.now(UTC).isoformat(),
                    status="unavailable",
                    reason="分时数据源暂不可用，请稍后手动刷新。",
                )

        return await self._cached("session:" + secid, load, refresh=refresh)

    async def enrich(self, response: KlineResponse, *, refresh=False) -> KlineResponse:
        if response.period != "daily" or not response.bars:
            return response
        key = "daily:" + response.secid + ":" + response.bars[0].date + ":" + response.bars[-1].date

        async def load():
            amounts = {}
            warnings = []
            try:
                async with asyncio.timeout(3):
                    local_symbol = await resolve_local_symbol(response.secid)
                    if local_symbol:
                        local = await get_local_kline(
                            symbol=local_symbol,
                            timeframe="daily",
                            adjustment="none",
                            limit=min(1000, len(response.bars) + 20),
                            end_ts=datetime.fromisoformat(
                                response.bars[-1].date[:10] + "T23:59:59"
                            ).replace(tzinfo=SHANGHAI),
                        )
                        amounts = {
                            b.ts.astimezone(SHANGHAI).date().isoformat(): {
                                "value": b.amount,
                                "source": "timescaledb",
                                "fetchedAt": str(local.fetched_at),
                            }
                            for b in local.bars
                            if b.amount is not None and b.amount >= 0
                        }
            except Exception:
                warnings.append("本地成交额不可用")
            if supports_amount(response.secid, response.asset_type) and any(
                b.amount is None and b.date not in amounts for b in response.bars
            ):
                try:
                    async with asyncio.timeout(8):
                        extra_amounts = await fetch_daily_amounts(self.provider, response.secid)
                    for trading_date, item in extra_amounts.items():
                        amounts.setdefault(trading_date, item)
                except Exception:
                    warnings.append("百度历史成交额暂不可用")
            if any(b.amount is None and b.date not in amounts for b in response.bars):
                try:
                    async with asyncio.timeout(5):
                        payload = await self.provider._json(
                            "https://push2his.eastmoney.com/api/qt/stock/kline/get",
                            {
                                "secid": response.secid,
                                "fields1": "f1,f2,f3,f4,f5,f6",
                                "fields2": "f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61",
                                "klt": 101,
                                "fqt": 0,
                                "end": response.bars[-1].date.replace("-", ""),
                                "lmt": min(1000, len(response.bars) + 20),
                            },
                        )
                        if str((payload.get("data") or {}).get("code")) != response.secid[2:]:
                            raise DashboardUpstreamError("成交额补充源标的不匹配")
                        extra = parse_kline_payload(response.secid, "daily", "none", payload)
                        for b in extra.bars:
                            if b.amount is not None and b.amount >= 0:
                                amounts.setdefault(
                                    b.date,
                                    {
                                        "value": b.amount,
                                        "source": "eastmoney",
                                        "fetchedAt": str(extra.fetched_at),
                                    },
                                )
                except Exception:
                    warnings.append("东方财富成交额不可用，缺失值未估算")
            start = (
                (datetime.fromisoformat(response.bars[0].date[:10]) - timedelta(days=20))
                .date()
                .isoformat()
            )
            dates = await self.calendar(start, response.bars[-1].date[:10])
            return amounts, dates, warnings

        amounts, dates, warnings = await self._cached(key, load, ttl=300, refresh=refresh)
        previous = {date: dates[i - 1] for i, date in enumerate(dates) if i}
        bars = []
        for bar in response.bars:
            metadata = dict(bar.metadata)
            metadata["previousTradeDate"] = previous.get(bar.date)
            amount = bar.amount
            if amount is None and bar.date in amounts:
                extra = amounts[bar.date]
                amount = Decimal(str(extra["value"]))
                metadata["amountEvidence"] = {k: v for k, v in extra.items() if k != "value"}
            bars.append(bar.model_copy(update={"amount": amount, "metadata": metadata}))
        metadata = {
            **response.metadata,
            "amountUnit": "元",
            "chartDataVersion": 1,
            "amountEnrichmentVersion": 2,
            "amountCoverage": sum(b.amount is not None for b in bars),
            "chartWarnings": warnings,
            "amountSources": sorted(
                {
                    b.metadata.get("amountEvidence", {}).get("source", response.source)
                    for b in bars
                    if b.amount is not None
                }
            ),
        }
        # Known providers use hands; unknown volume units stay explicit.
        unit = response.metadata.get("volume_unit")
        metadata["volumeUnit"] = (
            "手"
            if unit == "hands" or response.source in {"tencent", "eastmoney", "baostock"}
            else "股"
            if unit == "shares"
            else "单位待确认"
        )
        return response.model_copy(update={"bars": bars, "metadata": metadata})
