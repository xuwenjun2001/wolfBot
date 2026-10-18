import copy
from datetime import date, timedelta

import pytest

from quantpilot_market_data.services.tactic_incremental import (
    VERSION,
    diagnostics,
    eligibility,
    merge_window,
    prepare,
)
from quantpilot_market_data.tactics import TacticParameters, evaluate, indicators


@pytest.fixture
def case(monkeypatch):
    monkeypatch.setenv("QUANTPILOT_TACTICS_INCREMENTAL_ENABLED", "1")
    days = []
    day = date(2026, 1, 1)
    while len(days) < 140:
        if day.weekday() < 5 and day.isoformat() not in {"2026-05-01", "2026-05-04", "2026-05-05"}:
            days.append(day.isoformat())
        day += timedelta(days=1)
    bars = [
        {
            "date": d,
            "open": 10 + i / 10,
            "high": 11 + i / 10,
            "low": 9 + i / 10,
            "close": 10.5 + i / 10,
            "volume": 1000,
            "amount": 100000,
            "trade_status": "1",
            "is_st": False,
        }
        for i, d in enumerate(days)
    ]
    window = {
        "source": "baostock",
        "acquisition_version": VERSION,
        "trade_date": days[-2],
        "last_full_trade_date": days[-3],
        "bars": copy.deepcopy(bars[-121:-1]),
    }
    return days, bars, window


def run(case, request=None, window=None):
    days, bars, old = case
    metrics = diagnostics()
    calls = []

    def fetch(start):
        calls.append(start)
        return request(start) if request else [b for b in bars if b["date"] >= start]

    result = prepare(
        old if window is None else window,
        {"listed_at": "2000-01-01"},
        days[-1],
        days,
        "1",
        fetch,
        metrics,
    )
    return result, metrics, calls


@pytest.mark.parametrize("gap", [1, 2, 3])
def test_increment_matches_full_prices_indicators_and_signals(case, gap):
    days, bars, window = case
    window.update(
        last_full_trade_date=days[-gap - 2],
        trade_date=days[-gap - 1],
        bars=copy.deepcopy(bars[-120 - gap : -gap]),
    )
    result, metrics, calls = run(case)
    assert calls == [days[-5]] and metrics["mode"] == "incremental"
    assert result[0] == bars[-120:]
    assert indicators(result[0]) == indicators(bars[-120:])
    args = ("000001.SZ", "test", days, days[-1], TacticParameters().model_dump(), 1, [], "1")
    assert evaluate(args[0], args[1], result[0], *args[2:]) == evaluate(
        args[0], args[1], bars[-120:], *args[2:]
    )
    assert metrics["last_full_trade_date"] == days[-gap - 2]


@pytest.mark.parametrize(
    "field,value",
    [("close", 20), ("volume", 2000), ("amount", 123), ("is_st", True), ("trade_status", "0")],
)
def test_changed_overlap_falls_back(case, field, value):
    days, bars, _ = case

    def request(start):
        result = copy.deepcopy([b for b in bars if b["date"] >= start])
        if start == days[-5]:
            result[0][field] = value
        return result

    result, metrics, calls = run(case, request)
    assert metrics["mode"] == "fallback" and field in metrics["fallback_reason"]
    assert calls == [days[-5], days[-120]] and result[0] == bars[-120:]


@pytest.mark.parametrize(
    "failure", ["empty", "missing", "duplicate", "timeout", "insufficient_overlap"]
)
def test_incomplete_increment_falls_back(case, failure):
    days, bars, window = case
    if failure == "insufficient_overlap":
        for b in window["bars"][-4:-1]:
            b["volume"] = 0

    def request(start):
        if start != days[-5]:
            return bars[-120:]
        if failure == "timeout":
            raise TimeoutError("timeout")
        if failure == "empty":
            return []
        if failure == "missing":
            return bars[-4:]
        if failure == "duplicate":
            return bars[-5:] + bars[-1:]
        return bars[-5:]

    result, metrics, calls = run(case, request)
    assert metrics["mode"] == "fallback" and result[1] == "ready" and len(calls) == 2


@pytest.mark.parametrize(
    "why", ["old", "version", "source", "periodic", "insufficient", "disabled"]
)
def test_ineligible_uses_full(case, why, monkeypatch):
    days, bars, window = case
    if why == "old":
        window["trade_date"] = days[-5]
    if why == "version":
        window["acquisition_version"] = None
    if why == "source":
        window["source"] = "tencent"
    if why == "periodic":
        window["last_full_trade_date"] = days[-21]
    if why == "insufficient":
        window["bars"] = window["bars"][-40:]
    if why == "disabled":
        monkeypatch.setenv("QUANTPILOT_TACTICS_INCREMENTAL_ENABLED", "0")
    result, metrics, calls = run(case)
    assert metrics["mode"] == "full" and calls == [days[-120]] and result[1] == "ready"


def test_same_day_no_fetch_and_missing_amount_allowed(case):
    days, bars, window = case
    window.update(trade_date=days[-1], bars=bars[-120:])
    _, metrics, calls = run(case)
    assert metrics["mode"] == "cached" and not calls
    window.update(trade_date=days[-2], bars=copy.deepcopy(bars[-121:-1]))
    for b in window["bars"]:
        b.pop("amount")
    result, metrics, _ = run(case)
    assert metrics["mode"] == "incremental" and result[0][-1]["amount"] == 100000


def test_full_failure_and_control_interrupt_do_not_mutate_cache(case):
    before = copy.deepcopy(case[2])

    def failed(_):
        raise TimeoutError("source unavailable")

    with pytest.raises(TimeoutError):
        run(case, failed)
    assert case[2] == before

    def interrupted(_):
        raise InterruptedError()

    with pytest.raises(InterruptedError):
        run(case, interrupted)
    from quantpilot_market_data.repositories.tactics import LeaseLost

    def lost(_):
        raise LeaseLost()

    with pytest.raises(LeaseLost):
        run(case, lost)


def test_suspended_target_and_short_new_listing(case):
    days, bars, window = case
    bars[-1].update(trade_status="0", volume=0)
    result, metrics, _ = run(case)
    assert result[1:] == ("excluded", "当日停牌") and metrics["mode"] == "incremental"
    bars[-1].update(trade_status="1", volume=1000)
    result, metrics, calls = run(case, lambda _: bars[-30:], window={})
    assert result[1:] == ("excluded", "有效日K不足60根") and len(calls) == 2


def test_holiday_calendar_gap_uses_sessions_not_calendar_days(case):
    days, bars, window = case
    target = days.index("2026-05-06")
    window.update(trade_date="2026-04-30", last_full_trade_date="2026-04-29", bars=bars[:target])
    assert eligibility(window, days[target], days, "2000-01-01") is None
    assert (
        merge_window(window, bars[target - 4 : target + 1], days[target], days, "2000-01-01", "1")[
            -1
        ]["date"]
        == "2026-05-06"
    )
