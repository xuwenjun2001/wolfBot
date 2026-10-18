"""Pure, dated MA55 rules. No network, persistence or intraday inference."""

from __future__ import annotations

import math
from datetime import date, datetime, time, timedelta
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

from quantpilot_market_data.database_core import SHANGHAI_TZ

TACTIC_ID = "ma55-breakout-pullback"
UNIVERSE_ID = "cn-mainboard-a-share"


class TacticParameters(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)
    # Missing fields in historical snapshots always retain the original rules.
    rule_set: Literal["daily_v1", "discussion_v2"] = "daily_v1"
    change_pct: float = Field(default=5, ge=0.1, le=20)
    body_pct: float = Field(default=3, ge=0.1, le=20)
    volume_ratio: float = Field(default=1.5, ge=1, le=10)
    contraction_ratio: float = Field(default=0.8, gt=0, le=1)
    distance_min_pct: float = Field(default=-3, ge=-20, le=0)
    distance_max_pct: float = Field(default=1, ge=0, le=10)

    @model_validator(mode="after")
    def ordered(self):
        if self.distance_min_pct > self.distance_max_pct:
            raise ValueError("回踩偏离下限不能高于上限")
        return self


def is_mainboard(symbol: str) -> bool:
    code, _, exchange = symbol.upper().partition(".")
    return (
        len(code) == 6
        and code.isdigit()
        and (
            (exchange == "SH" and code[:3] in {"600", "601", "603", "605"})
            or (exchange == "SZ" and code[:3] in {"000", "001", "002", "003"})
        )
    )


def master_members(records: list[dict]) -> list[dict]:
    members = {}
    for r in records:
        exchange, _, code = str(r.get("code", "")).partition(".")
        symbol = f"{code}.{exchange.upper()}"
        if r.get("type") == "1" and r.get("status") == "1" and is_mainboard(symbol):
            members[symbol] = {
                "symbol": symbol,
                "name": r.get("code_name") or code,
                "listed_at": r.get("ipoDate") or None,
            }
    if not members:
        raise ValueError("证券主数据没有有效主板股票，保留原范围")
    return sorted(members.values(), key=lambda r: r["symbol"])


def scan_date_cutoff(now: datetime) -> date:
    """Freeze the latest potentially closed date; the calendar resolves holidays later."""
    local = now.astimezone(SHANGHAI_TZ)
    return local.date() - timedelta(days=int(local.time() < time(15)))


def resolve_trade_date(requested: date, calendar: list[dict], now: datetime) -> date:
    days = {date.fromisoformat(d["date"]): d["is_open"] for d in calendar}
    if requested not in days:
        raise ValueError("交易日历未覆盖请求日期")
    local = now.astimezone(SHANGHAI_TZ)
    if requested > local.date():
        raise ValueError("不能筛选未来交易日")
    if days[requested] and requested == local.date() and local.time() < time(15):
        raise ValueError("当日尚未收盘，请在15:00后运行")
    opened = sorted(d for d, flag in days.items() if flag and d <= requested)
    if not opened:
        raise ValueError("缺少已收盘交易日")
    if sum(flag and d > opened[-1] for d, flag in days.items()) < 2:
        raise ValueError("未来交易日历不足两个开市日")
    return opened[-1]


def quality(
    bars: list[dict],
    target: str,
    sessions: list[str],
    listed_at: str | None,
    daily_status: str | None = None,
) -> tuple[str, str]:
    if daily_status == "0" and (not bars or bars[-1]["date"] != target):
        return "excluded", "当日停牌（已核验当日证券状态）"
    if not bars or bars[-1]["date"] != target:
        return "gap", "目标交易日日K未就绪"
    dates = [b["date"] for b in bars]
    if dates != sorted(set(dates)) or any(d > target for d in dates):
        return "gap", "日K日期重复、乱序或超过目标日"
    for b in bars:
        if b.get("is_st") is None or b.get("trade_status") not in {"0", "1"}:
            return "gap", "缺少ST或交易状态"
        if b["trade_status"] == "0":
            continue
        values = [b.get(k) for k in ("open", "close", "high", "low", "volume")]
        if any(v is None or not math.isfinite(float(v)) for v in values):
            return "gap", "行情字段缺失或无效"
        o, c, h, low, v = map(float, values)
        if not (0 < low <= min(o, c) <= max(o, c) <= h and v >= 0):
            return "gap", "OHLC或成交量不合法"
    expected = [d for d in sessions if max(dates[0], listed_at or dates[0]) <= d <= target]
    if set(expected) - set(dates):
        return "gap", "历史交易日缺K线（不能将缺失视作停牌）"
    if bars[-1]["is_st"]:
        return "excluded", "ST股票"
    if bars[-1]["trade_status"] == "0":
        return "excluded", "当日停牌"
    if sum(b["trade_status"] == "1" and (b.get("volume") or 0) > 0 for b in bars) < 60:
        return "excluded", "有效日K不足60根"
    if float(bars[-1]["volume"]) <= 0:
        return "excluded", "当日无成交"
    return "ready", "数据就绪"


def indicators(bars: list[dict]) -> dict[str, dict]:
    valid = []
    result = {}
    for b in bars:
        r = dict(b)
        if b.get("trade_status") == "1" and (b.get("volume") or 0) > 0:
            valid.append(b)
            for n in (5, 10, 20, 55):
                r[f"ma{n}"] = (
                    sum(float(x["close"]) for x in valid[-n:]) / n if len(valid) >= n else None
                )
            r["prior_v5"] = (
                sum(float(x["volume"]) for x in valid[-6:-1]) / 5 if len(valid) >= 6 else None
            )
            r["change_pct"] = (
                (float(b["close"]) / float(valid[-2]["close"]) - 1) * 100
                if len(valid) >= 2 else None
            )
            result[b["date"]] = r
    return result


def trending(b: dict) -> bool:
    return (
        all(b.get(f"ma{n}") is not None for n in (5, 10, 20)) and b["ma5"] > b["ma10"] > b["ma20"]
    )


def is_breakout(previous: dict | None, b: dict, p: TacticParameters) -> bool:
    return bool(
        previous
        and previous.get("ma55")
        and b.get("ma55")
        and trending(b)
        and (
            p.rule_set == "daily_v1"
            or (
                float(previous["close"]) > 0
                and (b["close"] / previous["close"] - 1) * 100 >= p.change_pct - 1e-10
                and expanding_trend(previous, b)
            )
        )
        and not b.get("is_st")
        and not previous.get("is_st")
        and previous["close"] <= previous["ma55"]
        and b["close"] > b["ma55"]
        and b["close"] / b["open"] - 1 >= p.body_pct / 100 - 1e-10
        and (b.get("prior_v5") or 0) > 0
        and b["volume"] / b["prior_v5"] >= p.volume_ratio - 1e-10
    )


def expanding_trend(previous: dict, current: dict) -> bool:
    """Strict daily variant: all short MAs rise and both spreads widen."""
    if not all(previous.get(f"ma{n}") is not None for n in (5, 10, 20)):
        return False
    return all(current[f"ma{n}"] > previous[f"ma{n}"] for n in (5, 10, 20)) and all(
        current[f"ma{a}"] - current[f"ma{b}"] > previous[f"ma{a}"] - previous[f"ma{b}"]
        for a, b in ((5, 10), (10, 20))
    )


def support_broken(current: dict, p: TacticParameters) -> bool:
    # The lower tolerance is an explicit daily research rule, not an intraday stop fill.
    return bool(
        p.rule_set == "discussion_v2"
        and current.get("ma55")
        and current.get("low") is not None
        and (current["low"] / current["ma55"] - 1) * 100 < p.distance_min_pct - 1e-10
    )


def signal(breakout: dict, current: dict, p: TacticParameters) -> str:
    if not current.get("ma55"):
        return "insufficient"
    if p.rule_set == "discussion_v2":
        if current.get("low") is None:
            return "insufficient"
        if support_broken(current, p):
            return "support_broken"
        if current["close"] < current["ma55"] - 1e-10:
            return "below_support"
    distance = (current["close"] / current["ma55"] - 1) * 100
    if not p.distance_min_pct - 1e-10 <= distance <= p.distance_max_pct + 1e-10:
        return "outside_band"
    if current["volume"] / breakout["volume"] > p.contraction_ratio + 1e-10:
        return "not_contracted"
    return "pullback"


def evaluate(
    symbol: str,
    name: str,
    bars: list[dict],
    sessions: list[str],
    target: str,
    parameters: dict,
    version: int,
    existing: list[dict],
    daily_status: str | None = None,
) -> list[dict]:
    """Replay missed sessions, freeze event parameters, and never renew a window."""
    if not is_mainboard(symbol):
        return []
    enriched = indicators(bars)
    raw = {b["date"]: b for b in bars}
    if daily_status == "0" and target not in raw:
        # This is an explicit status observation, not an invented price bar.
        raw[target] = {"trade_status": "0"}
    upto = [d for d in sessions if d <= target]
    events = [dict(e) for e in existing]
    for d in upto[-3:]:
        i = sessions.index(d)
        # An expired/invalidated event still occupies its original calendar window.
        if any(str(e["breakout_date"]) <= d <= str(e["expires_date"]) for e in events):
            continue
        b = enriched.get(d)
        if (
            b
            and i
            and is_breakout(enriched.get(sessions[i - 1]), b, TacticParameters(**parameters))
        ):
            if i + 2 >= len(sessions):
                raise ValueError("未来交易日历不足，无法固定观察窗口")
            events.append(
                {
                    "id": f"{TACTIC_ID}:{symbol}:{d}",
                    "symbol": symbol,
                    "name": name,
                    "breakout_date": d,
                    "expires_date": sessions[i + 2],
                    "parameters": parameters,
                    "config_version": version,
                    "status": "observing",
                    "signal": "breakout",
                    "last_evaluated": d,
                    "evidence": {"breakout": b},
                }
            )
    output = []
    for e in events:
        if str(e["expires_date"]) < upto[-3] or str(e["last_evaluated"]) > target:
            continue
        e["evaluations"] = []
        p = TacticParameters(**e["parameters"])
        b = enriched.get(str(e["breakout_date"])) or e["evidence"]["breakout"]
        invalid_from = (
            e["evidence"].get("invalidated_at", str(e["last_evaluated"]))
            if e["status"] == "invalidated"
            else None
        )
        invalid_tag = e["evidence"].get("invalidation_signal", e["signal"])
        invalid = False
        for d in upto:
            if not str(e["breakout_date"]) <= d <= str(e["expires_date"]):
                continue
            current = enriched.get(d)
            r = raw.get(d)
            if invalid_from and d >= invalid_from:
                invalid = True
            if invalid:
                state, tag = "invalidated", invalid_tag
            elif r and r.get("is_st"):
                invalid, state, tag = True, "invalidated", "is_st"
            elif not current:
                state, tag = (
                    "observing",
                    "suspended" if r and r.get("trade_status") == "0" else "insufficient",
                )
            elif not trending(current):
                invalid, state, tag = True, "invalidated", "trend_invalid"
            elif d != str(e["breakout_date"]) and support_broken(current, p):
                invalid, state, tag = True, "invalidated", "support_broken"
            else:
                state, tag = (
                    "observing",
                    "breakout" if d == str(e["breakout_date"]) else signal(b, current, p),
                )
            if not invalid and d == str(e["expires_date"]):
                state = "expired"
            if invalid and not invalid_from:
                invalid_from, invalid_tag = d, tag
            evidence: dict[str, Any] = {
                "breakout": b,
                "current": current,
                "source": "baostock",
                "adjustment": "qfq",
            }
            if invalid:
                evidence.update(invalidated_at=invalid_from, invalidation_signal=invalid_tag)
            if current and current.get("ma55"):
                evidence.update(
                    distance_pct=(current["close"] / current["ma55"] - 1) * 100,
                    contraction_ratio=current["volume"] / b["volume"],
                )
            e.update(status=state, signal=tag, last_evaluated=d, evidence=evidence)
            e["evaluations"].append(
                {"date": d, "status": state, "signal": tag, "evidence": evidence}
            )
        output.append(e)
    return output


def display_status(event: dict, now: datetime) -> str:
    if event["status"] == "invalidated":
        return "invalidated"
    cutoff = datetime.combine(date.fromisoformat(str(event["expires_date"])), time(15), SHANGHAI_TZ)
    return "expired" if now.astimezone(SHANGHAI_TZ) >= cutoff else event["status"]
