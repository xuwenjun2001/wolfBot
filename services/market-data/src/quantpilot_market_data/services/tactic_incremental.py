"""Five-session overlap validation; never joins incompatible adjusted-price windows."""

import os
import time
from datetime import date, timedelta
from decimal import Decimal, InvalidOperation

from quantpilot_market_data.tactics import quality

VERSION = "baostock:qfq:v1"


def enabled():
    return os.getenv("QUANTPILOT_TACTICS_INCREMENTAL_ENABLED", "1").lower() not in {
        "0",
        "false",
        "no",
        "off",
    }


def diagnostics():
    return {
        "version": 1,
        "mode": "full",
        "requests": 0,
        "rows": 0,
        "fetch_seconds": 0.0,
        "wait_seconds": 0.0,
        "validation_seconds": 0.0,
        "cache_seconds": 0.0,
        "persist_seconds": 0.0,
        "prepare_seconds": 0.0,
    }


def eligibility(window, target, sessions, listed_at):
    if not enabled():
        return "增量开关已关闭"
    if (
        not window
        or window.get("source") != "baostock"
        or window.get("acquisition_version") != VERSION
    ):
        return "无可核验的同源前复权缓存"
    bars = window.get("bars") or []
    day = str(window["trade_date"])
    if (
        day not in sessions
        or target not in sessions
        or not 1 <= sessions.index(target) - sessions.index(day) <= 3
    ):
        return "缓存日期不适合增量（须落后1至3个交易日）"
    full = str(window.get("last_full_trade_date"))
    if full not in sessions or full > day or sessions.index(target) - sessions.index(full) >= 20:
        return "到期全量核验或缺少全量基准日期"
    state, reason = quality(bars, day, sessions, listed_at, "1")
    if state != "ready":
        return "历史缓存不满足增量条件：" + reason
    if sum(b.get("trade_status") == "1" and (b.get("volume") or 0) > 0 for b in bars) < 60:
        return "历史有效K线不足"
    return None


def same_number(a, b):
    try:
        x, y = Decimal(str(a)), Decimal(str(b))
        return x.is_finite() and y.is_finite() and x == y
    except InvalidOperation, ValueError:
        return False


def merge_window(window, recent, target, sessions, listed_at, daily_status):
    days = [d for d in sessions if d <= target]
    dates = [b["date"] for b in recent]
    if not dates or dates != sorted(set(dates)) or dates[-1] != target:
        raise ValueError("增量响应为空、日期异常或缺少目标日")
    if any(d not in days[-5:] for d in dates) or set(days[-5:]) - set(dates):
        raise ValueError("增量窗口缺交易日或超出请求范围")
    old = {b["date"]: b for b in window["bars"]}
    overlap = [b for b in recent if b["date"] in old]
    traded = [
        b
        for b in overlap
        if b.get("trade_status") == old[b["date"]].get("trade_status") == "1"
        and (b.get("volume") or 0) > 0
        and (old[b["date"]].get("volume") or 0) > 0
    ]
    if len(traded) < 2:
        raise ValueError("有成交的重叠K线不足2根")
    for b in overlap:
        previous = old[b["date"]]
        for field in ("open", "high", "low", "close", "volume", "trade_status", "is_st", "amount"):
            a, c = previous.get(field), b.get(field)
            if field == "amount" and (a is None or c is None):
                continue
            equal = (
                a == c
                if field in {"trade_status", "is_st"} or a is None or c is None
                else same_number(a, c)
            )
            if not equal:
                raise ValueError("重叠数据变化：" + b["date"] + " " + field)
    old.update({b["date"]: b for b in recent})
    merged = [old[d] for d in sorted(old) if days[max(0, len(days) - 120)] <= d <= target]
    state, reason = quality(merged, target, sessions, listed_at, daily_status)
    if state == "gap" or reason == "有效日K不足60根":
        raise ValueError("合并窗口校验失败：" + reason)
    return merged


def prepare(window, member, target, sessions, daily_status, request, metrics):
    """request(start) owns retry/IO accounting. No persistence is performed here."""
    days = [d for d in sessions if d <= target]
    start = days[max(0, len(days) - 120)]
    listed = member.get("listed_at")

    def validate(bars):
        began = time.perf_counter()
        try:
            return quality(bars, target, sessions, listed, daily_status)
        finally:
            metrics["validation_seconds"] += time.perf_counter() - began

    if window and str(window["trade_date"]) == target and window.get("source") == "baostock":
        state, reason = validate(window["bars"])
        if state != "gap":
            metrics.update(
                mode="cached",
                last_full_trade_date=str(window.get("last_full_trade_date") or target),
            )
            return window["bars"], state, reason
    began = time.perf_counter()
    why = eligibility(window, target, sessions, listed)
    metrics["validation_seconds"] += time.perf_counter() - began
    if why is None:
        metrics["mode"] = "incremental"
        try:
            recent = request(days[-5:][0])
            began = time.perf_counter()
            try:
                bars = merge_window(window, recent, target, sessions, listed, daily_status)
            finally:
                metrics["validation_seconds"] += time.perf_counter() - began
            state, reason = validate(bars)
            metrics["last_full_trade_date"] = str(window["last_full_trade_date"])
            return bars, state, reason
        except InterruptedError:
            raise
        except Exception as error:
            # Propagate lease/control failures without classifying them as data gaps.
            if getattr(error, "tactic_control_error", False):
                raise
            metrics.update(mode="fallback", fallback_reason=str(error)[:500])
    else:
        metrics.update(mode="full", full_reason=why)
    bars = request(start)
    state, reason = validate(bars)
    if state == "excluded" and reason == "有效日K不足60根" and (listed or "1900") < start:
        bars = request((date.fromisoformat(target) - timedelta(days=365)).isoformat())
        state, reason = validate(bars)
    if state != "gap":
        metrics["last_full_trade_date"] = target
    return bars, state, reason
