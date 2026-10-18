import copy
import json
from datetime import date, datetime, timedelta
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from quantpilot_market_data.database_core import SHANGHAI_TZ
from quantpilot_market_data.routers import tactics as router_module
from quantpilot_market_data.tactics import (
    TacticParameters,
    display_status,
    evaluate,
    indicators,
    is_breakout,
    is_mainboard,
    master_members,
    quality,
    resolve_trade_date,
    scan_date_cutoff,
)


@pytest.fixture
def sample():
    return json.loads((Path(__file__).parent / "fixtures/ma55/002837.json").read_text())["bars"]


def sessions_for(bars):
    return [b["date"] for b in bars] + ["2026-09-09", "2026-09-10", "2026-09-11"]


@pytest.mark.parametrize("interrupted", [False, True])
def test_source_hard_deadline_and_shutdown_kill_blocked_child(interrupted):
    import multiprocessing
    import time

    from quantpilot_market_data.providers.tactics_source import TacticsSource

    ctx = multiprocessing.get_context("spawn")
    source = TacticsSource(timeout=0.01, interrupted=lambda: interrupted)
    source.pipe, child = ctx.Pipe()
    process = ctx.Process(target=time.sleep, args=(30,), daemon=True)
    process.start()
    source.process = process
    try:
        with pytest.raises(InterruptedError if interrupted else TimeoutError):
            source.request("master")
        assert not process.is_alive()
        assert source.pipe is None
    finally:
        source.close()
        child.close()


@pytest.mark.parametrize(
    "symbol",
    [
        "600000.SH",
        "601318.SH",
        "603618.SH",
        "605117.SH",
        "000001.SZ",
        "001309.SZ",
        "002837.SZ",
        "003816.SZ",
    ],
)
def test_mainboard_includes_former_sme(symbol):
    assert is_mainboard(symbol)


@pytest.mark.parametrize(
    "symbol",
    [
        "300750.SZ",
        "301001.SZ",
        "688001.SH",
        "689009.SH",
        "920001.BJ",
        "830001.BJ",
        "000001.SH",
        "510300.SH",
        "159915.SZ",
        "900901.SH",
        "200002.SZ",
        "600000.SZ",
        "000001",
        "../../000001.SZ",
    ],
)
def test_other_boards_and_ambiguous_identity_rejected(symbol):
    assert not is_mainboard(symbol)


def test_master_filters_type_status_and_duplicates():
    valid = {"code": "sz.002837", "code_name": "英维克", "type": "1", "status": "1"}
    rows = [
        valid,
        valid,
        {**valid, "code": "sz.300750"},
        {**valid, "type": "2"},
        {**valid, "status": "0"},
    ]
    assert [x["symbol"] for x in master_members(rows)] == ["002837.SZ"]
    with pytest.raises(ValueError):
        master_members([])


def test_real_breakout_and_pullback_then_expiry(sample):
    sessions = sessions_for(sample)
    p = TacticParameters().model_dump()

    def run(d, old=None):
        return evaluate(
            "002837.SZ",
            "英维克",
            [b for b in sample if b["date"] <= d],
            sessions,
            d,
            p,
            1,
            old or [],
        )

    first = run("2026-08-27")
    assert len(first) == 1
    assert first[0]["expires_date"] == "2026-08-31"
    second = run("2026-08-28", first)
    assert second[0]["signal"] == "pullback"
    assert second[0]["status"] == "observing"
    last = run("2026-08-31", second)
    assert last[0]["status"] == "expired"
    assert last[0]["id"] == first[0]["id"]
    # Missed runs recover the same event and the intervening daily evidence.
    recovered = run("2026-08-31")
    assert recovered[0]["expires_date"] == first[0]["expires_date"]
    assert recovered[0]["evaluations"][1]["signal"] == "pullback"


def test_existing_event_freezes_parameters_and_blocks_renewal(sample):
    sessions = sessions_for(sample)
    p = TacticParameters().model_dump()
    first = evaluate("002837.SZ", "英维克", sample[:], sessions, "2026-08-27", p, 1, [])
    out = evaluate(
        "002837.SZ",
        "英维克",
        sample[:],
        sessions,
        "2026-08-28",
        {**p, "contraction_ratio": 0.01},
        2,
        first,
    )
    assert out[0]["signal"] == "pullback"
    assert out[0]["config_version"] == 1
    assert out[0]["expires_date"] == first[0]["expires_date"]


def test_no_future_data_used(sample):
    p = TacticParameters().model_dump()
    original = evaluate("002837.SZ", "英维克", sample, sessions_for(sample), "2026-08-28", p, 1, [])
    changed = copy.deepcopy(sample)
    for b in changed:
        if b["date"] > "2026-08-28":
            b.update(close=999999, volume=999999999)
    assert (
        evaluate("002837.SZ", "英维克", changed, sessions_for(sample), "2026-08-28", p, 1, [])
        == original
    )


def test_missed_trend_failure_cannot_resurrect(sample):
    p = TacticParameters().model_dump()
    rows = copy.deepcopy(sample)
    for b in rows:
        if b["date"] == "2026-08-28":
            b["is_st"] = True
    result = evaluate("002837.SZ", "英维克", rows, sessions_for(rows), "2026-08-31", p, 1, [])
    assert result[0]["status"] == "invalidated"
    repeated = evaluate(
        "002837.SZ", "英维克", sample, sessions_for(sample), "2026-08-31", p, 1, result
    )
    assert repeated[0]["status"] == "invalidated"
    assert repeated[0]["evaluations"][0]["signal"] == "breakout"
    assert repeated[0]["evaluations"][1]["signal"] == "is_st"


def test_breakout_boundaries_and_gap_up_not_big_body():
    p = TacticParameters()
    previous = {"close": 10, "ma55": 10}
    b = {
        "open": 10,
        "close": 10.3,
        "volume": 150,
        "prior_v5": 100,
        "ma5": 10.3,
        "ma10": 10.2,
        "ma20": 10.1,
        "ma55": 10,
    }
    assert is_breakout(previous, b, p)
    assert not is_breakout(previous, {**b, "open": 10.2}, p)
    assert not is_breakout(previous, {**b, "prior_v5": 0}, p)
    assert not is_breakout(previous, {**b, "ma5": 10.2}, p)
    assert not is_breakout({"close": 10.1, "ma55": 10}, b, p)


def test_data_quality_missing_is_not_suspension(sample):
    sessions = sessions_for(sample)
    assert quality(sample, "2026-09-08", sessions, "2016-12-29")[0] == "ready"
    assert quality(sample[:-1], "2026-09-08", sessions, None)[0] == "gap"
    assert quality(sample[:20] + sample[21:], "2026-09-08", sessions, None)[0] == "gap"
    broken = copy.deepcopy(sample)
    broken[-1]["is_st"] = None
    assert quality(broken, "2026-09-08", sessions, None)[0] == "gap"
    broken[-1].update(is_st=False, trade_status="0", volume=None)
    assert quality(broken, "2026-09-08", sessions, None) == ("excluded", "当日停牌")
    assert "2026-09-08" not in indicators(broken)


def test_calendar_real_sessions_and_shanghai_expiry():
    days = [
        {"date": (date(2026, 9, 4) + timedelta(days=i)).isoformat(), "is_open": i not in (1, 2)}
        for i in range(7)
    ]
    assert resolve_trade_date(
        date(2026, 9, 6), days, datetime(2026, 9, 6, 12, tzinfo=SHANGHAI_TZ)
    ) == date(2026, 9, 4)
    with pytest.raises(ValueError, match="尚未收盘"):
        resolve_trade_date(date(2026, 9, 4), days, datetime(2026, 9, 4, 14, tzinfo=SHANGHAI_TZ))
    with pytest.raises(ValueError, match="未来交易日历"):
        resolve_trade_date(date(2026, 9, 4), days[:3], datetime(2026, 9, 4, 16, tzinfo=SHANGHAI_TZ))
    event = {"status": "observing", "expires_date": "2026-09-08"}
    assert display_status(event, datetime.fromisoformat("2026-09-08T06:59:00+00:00")) == "observing"
    assert display_status(event, datetime.fromisoformat("2026-09-08T07:00:00+00:00")) == "expired"


@pytest.mark.parametrize(
    ("instant", "expected"),
    [
        ("2026-09-08T23:59:00+08:00", "2026-09-08"),
        ("2026-09-09T00:00:00+08:00", "2026-09-08"),
        ("2026-09-09T01:44:00+08:00", "2026-09-08"),
        ("2026-09-09T06:59:59+00:00", "2026-09-08"),
        ("2026-09-09T07:00:00+00:00", "2026-09-09"),
    ],
)
def test_submit_freezes_closed_date_even_without_cached_calendar(monkeypatch, instant, expected):
    from quantpilot_market_data.services import tactics as service

    now = datetime.fromisoformat(instant)

    class Clock(datetime):
        @classmethod
        def now(cls, tz=None):
            return now.astimezone(tz)

    monkeypatch.setattr(service, "datetime", Clock)
    monkeypatch.setattr(service.repo, "enqueue", lambda requested, actor: (requested, actor))
    assert service.submit("user") == (date.fromisoformat(expected), "user")


@pytest.mark.parametrize("instant", ["2026-09-05T01:00:00+08:00", "2026-09-07T14:59:00+08:00"])
def test_preclose_weekend_uses_real_calendar(instant):
    now = datetime.fromisoformat(instant)
    days = [
        {"date": (date(2026, 9, 4) + timedelta(days=i)).isoformat(), "is_open": i not in (1, 2)}
        for i in range(7)
    ]
    cutoff = scan_date_cutoff(now)
    assert resolve_trade_date(cutoff, days, now) == date(2026, 9, 4)
    # A delayed worker still evaluates the original closed date after the next close.
    assert resolve_trade_date(cutoff, days, datetime(2026, 9, 7, 16, tzinfo=SHANGHAI_TZ)) == date(
        2026, 9, 4
    )


def test_preclose_does_not_guess_holiday_sessions():
    now = datetime(2026, 10, 9, 10, tzinfo=SHANGHAI_TZ)
    days = [
        {"date": (date(2026, 9, 30) + timedelta(days=i)).isoformat(), "is_open": i in (0, 9, 12)}
        for i in range(13)
    ]
    assert resolve_trade_date(scan_date_cutoff(now), days, now) == date(2026, 9, 30)


def test_routes_require_token_and_disallow_board_override(monkeypatch):
    monkeypatch.setenv("QUANTPILOT_MARKET_ADMIN_TOKEN", "test-token")
    app = FastAPI()
    app.include_router(router_module.router)
    with TestClient(app) as client:
        assert client.get("/api/v1/tactics").status_code == 401
        assert (
            client.post(
                "/api/v1/tactics/runs",
                headers={"X-QuantPilot-Admin-Token": "test-token"},
                json={"actor": "x", "board": "growth"},
            ).status_code
            == 422
        )


def test_parameter_rejects_nan_unknown_and_out_of_range():
    for params in ({"body_pct": float("nan")}, {"volume_ratio": 0}, {"board": "growth"}):
        with pytest.raises(ValueError):
            TacticParameters(**params)


def test_missing_current_bar_can_only_be_excluded_with_confirmed_suspension(sample):
    rows = sample[:-1]
    assert quality(rows, "2026-09-08", sessions_for(sample), None, "1")[0] == "gap"
    assert quality(rows, "2026-09-08", sessions_for(sample), None, "0")[0] == "excluded"
