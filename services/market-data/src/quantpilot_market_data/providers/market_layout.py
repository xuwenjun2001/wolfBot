"""Index sessions and complete market breadth; all amounts are CNY."""

from __future__ import annotations

import time
from datetime import datetime

import httpx

from quantpilot_market_data.providers.dashboard import (
    SHANGHAI,
    DashboardProvider,
    DashboardUpstreamError,
    day,
    number,
    result,
)

INDICES = {
    "sh": ("1.000001", "上证指数", "m:1+t:2,m:1+t:23", "沪市A股"),
    "sz": ("0.399001", "深证成指", "m:0+t:6,m:0+t:80", "深市A股"),
    "cy": ("0.399006", "创业板指", "m:0+t:80", "创业板全体"),
    "kc": ("1.000688", "科创50", "m:1+t:23", "科创板全体"),
}
MINUTES = [f"{m // 60:02}:{m % 60:02}" for m in range(570, 691)] + [
    f"{m // 60:02}:{m % 60:02}" for m in range(781, 901)
]


def parse_session(data: dict, index: str) -> dict:
    if not isinstance(data, dict) or not isinstance(data.get("trends"), list):
        raise DashboardUpstreamError("指数分时格式不兼容")
    days: dict[str, dict[str, dict]] = {}
    for line in data["trends"]:
        parts = str(line).split(",")
        if len(parts) < 8:
            continue
        date = day(parts[0])
        minute = parts[0][11:16]
        if not date or minute not in MINUTES:
            continue
        row = {
            "time": minute,
            "price": number(parts[2]),
            "leading": number(parts[7]),
            "minuteAmount": number(parts[6]),
            "minuteVolume": number(parts[5]),
        }
        existing = days.setdefault(date, {}).get(minute)
        if existing is not None and existing != row:
            raise DashboardUpstreamError("指数分钟记录冲突")
        days[date][minute] = row
    if not days:
        raise DashboardUpstreamError("指数未返回有效盘中数据")
    current = max(days)
    pre_close = number(data.get("preClose"))
    rows = []
    for _minute, row in sorted(days[current].items()):
        price, leading = row["price"], row["leading"]
        rows.append(
            {
                **row,
                "changePct": (price / pre_close - 1) * 100
                if price is not None and pre_close and pre_close > 0
                else None,
                "leadingPct": (leading / pre_close - 1) * 100
                if leading is not None and pre_close and pre_close > 0
                else None,
            }
        )
    return {
        "days": days,
        "rows": rows,
        "tradeDate": current,
        "name": INDICES[index][1],
        "previousClose": pre_close,
    }


def cumulative(rows: dict[str, dict], field: str = "minuteAmount") -> dict[str, float]:
    """Only a contiguous prefix is safe: never invent zero turnover for gaps."""
    total = 0.0
    values = {}
    # Auction turnover can be nonzero; a missing opening node is a real gap.
    for minute in MINUTES:
        row = rows.get(minute)
        amount = number(row.get(field)) if row else None
        if amount is None or amount < 0:
            break
        total += amount
        values[minute] = total
    return values


def compare_amounts(sessions: list[dict]) -> dict:
    common = sorted(set.intersection(*(set(s["days"]) for s in sessions)))
    current_dates = {s["tradeDate"] for s in sessions}
    current_values = [cumulative(s["days"][s["tradeDate"]]) for s in sessions]
    current_times = sorted(set.intersection(*(set(v) for v in current_values)))
    current_cutoff = current_times[-1] if current_times and len(current_dates) == 1 else None
    current_total = sum(v[current_cutoff] for v in current_values) if current_cutoff else None
    empty = {
        "rows": [],
        "currentDate": max((s["tradeDate"] for s in sessions), default=None),
        "previousDate": None,
        "cutoff": None,
        "complete": False,
        "reason": "缺少可对齐的最近两个交易日数据。",
        "currentTotal": current_total,
        "currentCutoff": current_cutoff,
    }
    if len(common) < 2 or any(s["tradeDate"] != common[-1] for s in sessions):
        return empty
    previous, current = common[-2:]
    values = [cumulative(s["days"][d]) for s in sessions for d in (current, previous)]
    times = sorted(set.intersection(*(set(v) for v in values)))
    rows = []
    for minute in times:
        now, before = sum(v[minute] for v in values[::2]), sum(v[minute] for v in values[1::2])
        rows.append(
            {
                "time": minute,
                "current": now,
                "previous": before,
                "difference": now - before,
                "changePct": (now - before) / before * 100 if before > 0 else None,
            }
        )
    cutoff = rows[-1]["time"] if rows else None
    expected = min(max(s["days"][current]) for s in sessions)
    complete = cutoff == expected
    return {
        "rows": rows,
        "currentDate": current,
        "previousDate": previous,
        "cutoff": cutoff,
        "complete": complete,
        "reason": None if complete else "分钟数据存在缺口，仅显示可连续累计并对齐的区间。",
        "currentTotal": current_total,
        "currentCutoff": current_cutoff,
    }


class MarketLayoutProvider:
    def __init__(self, provider: DashboardProvider):
        self.provider = provider
        self._history_retry_after = 0.0

    async def session(self, index: str) -> dict:
        params = {
            "secid": INDICES[index][0],
            "fields1": "f1,f2,f3,f4,f5,f6,f7,f8,f9,f10,f11,f12,f13",
            "fields2": "f51,f52,f53,f54,f55,f56,f57,f58",
            "ndays": 5,
            "iscr": 0,
            "iscca": 0,
        }
        fallback = False
        try:
            if time.monotonic() < self._history_retry_after:
                raise DashboardUpstreamError("历史接口退避中")
            payload = await self.provider._json(
                "https://push2his.eastmoney.com/api/qt/stock/trends2/get", params
            )
            data = parse_session(payload.get("data"), index)
        except httpx.HTTPError, DashboardUpstreamError, ValueError:
            # A current-day fallback can keep the index visible, but must never
            # fabricate a previous day or a complete turnover comparison.
            if time.monotonic() >= self._history_retry_after:
                self._history_retry_after = time.monotonic() + 300
            payload = await self.provider._json(
                "https://push2delay.eastmoney.com/api/qt/stock/trends2/get", params
            )
            data = parse_session(payload.get("data"), index)
            fallback = True
        data["fallback"] = fallback
        return data

    async def breadth(self, index: str) -> dict:
        started_day = datetime.now(SHANGHAI).date()
        seen, dates, expected = {}, set(), None
        for page in range(1, 81):
            payload = await self.provider._json(
                "https://push2.eastmoney.com/api/qt/clist/get",
                {
                    "fid": "f12",
                    "po": 0,
                    "pz": 100,
                    "pn": page,
                    "np": 1,
                    "fltt": 2,
                    "invt": 2,
                    "fs": INDICES[index][2],
                    "fields": "f12,f13,f3,f124",
                },
            )
            data = payload.get("data")
            if not isinstance(data, dict) or not isinstance(data.get("diff"), list):
                raise DashboardUpstreamError("涨跌统计分页不可用")
            count = number(data.get("total"))
            if count is None or not 0 < count <= 8000 or count != int(count):
                raise DashboardUpstreamError("涨跌统计数量无效")
            if expected is not None and count != expected:
                raise DashboardUpstreamError("涨跌统计范围发生变化")
            expected = int(count)
            for row in data["diff"]:
                code = str(row.get("f12", ""))
                if not code or code in seen:
                    continue
                pct = number(row.get("f3"))
                stamp = number(row.get("f124"))
                if pct is not None:
                    if not stamp or not 1e9 < stamp < 4e9:
                        raise DashboardUpstreamError("有效报价缺少业务日期")
                    dates.add(datetime.fromtimestamp(stamp, SHANGHAI).date().isoformat())
                seen[code] = pct
            if len(dates) > 1 or datetime.now(SHANGHAI).date() != started_day:
                raise DashboardUpstreamError("涨跌统计跨业务日期")
            if len(seen) == expected:
                break
            if not data["diff"] or len(seen) > expected:
                raise DashboardUpstreamError("涨跌统计分页不完整")
        if len(seen) != expected or len(dates) != 1:
            raise DashboardUpstreamError("涨跌统计未完成")
        counts = {"up": 0, "down": 0, "flat": 0, "missing": 0}
        for pct in seen.values():
            counts[
                "missing" if pct is None else "up" if pct > 0 else "down" if pct < 0 else "flat"
            ] += 1
        return result(
            [{**counts, "total": len(seen), "name": INDICES[index][3]}],
            "东方财富",
            next(iter(dates)),
            "市场范围分页统计，非指数成分股；无报价不等于停牌。",
            complete=True,
            refreshing=False,
        )
