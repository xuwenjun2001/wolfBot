from datetime import datetime, timedelta

import pytest

from quantpilot_market_data.database_core import SHANGHAI_TZ
from quantpilot_market_data.services.tactic_reports import validate_report
from quantpilot_market_data.tactic_reviews import (
    performance,
    post_pullback_performance,
    select_knowledge,
    statistics,
)
from quantpilot_market_data.tactics import TacticParameters


def sample():
    days = [(datetime(2026, 6, 1) + timedelta(days=i)).date().isoformat() for i in range(63)]
    bars = [
        dict(
            date=d,
            open=10 + i / 10,
            high=11 + i / 10,
            low=9 + i / 10,
            close=10 + i / 10,
            volume=100,
            trade_status="1",
            is_st=False,
        )
        for i, d in enumerate(days)
    ]
    event = dict(
        id="event",
        symbol="000001.SZ",
        name="sample",
        breakout_date=days[60],
        expires_date=days[62],
        config_version=1,
        parameters=TacticParameters().model_dump(),
        evidence={"breakout": bars[60]},
        created_at=datetime.fromisoformat(days[60]).replace(tzinfo=SHANGHAI_TZ),
    )
    return days, bars, event


def test_independent_horizons_and_pending_no_future_prices():
    days, bars, event = sample()
    rows = performance(event, bars, days, days[61])
    assert rows[0]["status"] == "ready"
    assert rows[0]["return_pct"] == pytest.approx(0.625)
    assert rows[1]["status"] == "pending" and rows[1]["return_pct"] is None
    assert rows[0]["origin"] == "tracked"


def test_suspension_does_not_hide_valid_b2_and_invalidated_keeps_return():
    days, bars, event = sample()
    bars[61]["trade_status"] = "0"
    bars[62].update(close=3, low=2, open=4)
    rows = performance(event, bars, days, days[-1])
    assert rows[0]["status"] == "suspended"
    assert rows[1]["status"] == "ready" and rows[1]["return_pct"] < 0
    assert rows[1]["signal"] == "trend_invalid"
    assert rows[1]["high_pct"] is None


def test_missing_reference_never_splices_original_evidence_and_backfill_classification():
    days, bars, event = sample()
    event["created_at"] = datetime.fromisoformat(days[62]).replace(tzinfo=SHANGHAI_TZ)
    rows = performance(event, bars[:60] + bars[61:], days, days[-1])
    assert all(r["status"] == "gap" and r["origin"] == "retrospective" for r in rows)


def test_returns_unchanged_under_uniform_adjustment_and_bad_prices_rejected():
    days, bars, event = sample()
    expected = performance(event, bars, days, days[-1])[1]["return_pct"]
    for bar in bars:
        for field in ("open", "high", "low", "close"):
            bar[field] *= 0.8
    assert performance(event, bars, days, days[-1])[1]["return_pct"] == expected
    bars[-1]["close"] = float("nan")
    assert performance(event, bars, days, days[-1])[1]["status"] == "gap"


def test_duplicate_prices_rejected_and_bad_indicator_history_not_used():
    days, bars, event = sample()
    assert performance(event, bars + [bars[-1]], days, days[-1])[1]["status"] == "gap"
    bars[30]["close"] = None
    rows = performance(event, bars, days, days[-1])
    assert rows[1]["status"] == "ready" and rows[1]["signal"] == "insufficient"


def test_delisted_event_keeps_price_performance_without_reviving_signal():
    days, bars, event = sample()
    event.update(status="invalidated", signal="delisted", last_evaluated=days[-2])
    rows = performance(event, bars, days, days[-1])
    assert rows[1]["status"] == "ready" and rows[1]["signal"] == "delisted"


def test_statistics_flat_in_denominator_and_gaps_excluded():
    rows = [dict(horizon=2, status="ready", return_pct=v) for v in (1, -3, 0)]
    rows += [dict(horizon=2, status=s, return_pct=None) for s in ("gap", "suspended", "pending")]
    stat = statistics(rows)[1]
    assert stat["win_rate"] == pytest.approx(100 / 3)
    assert stat["flat"] == 1 and stat["valid"] == 3 and stat["total"] == 6
    assert statistics([])[0]["win_rate"] is None


def test_post_pullback_uses_subsequent_interval_not_prior_gain():
    rows = [
        dict(
            event_id="a",
            horizon=h,
            status="ready",
            return_pct=pct,
            signal=signal,
            origin="tracked",
            config_version=1,
        )
        for h, pct, signal in [(1, 10, "pullback"), (2, 5, "outside_band")]
    ]
    assert post_pullback_performance(rows)[0]["return_pct"] == pytest.approx(-100 / 22)
    rows[0]["signal"] = "outside_band"
    rows[1]["signal"] = "pullback"
    assert post_pullback_performance(rows) == []


def test_first_pullback_is_retained_and_trend_failure_does_not_revive():
    days, bars, event = sample()
    for i, bar in enumerate(bars):
        bar.update(open=10 + i / 100, close=10 + i / 100, high=11 + i / 100, low=9 + i / 100)
    event["parameters"]["distance_max_pct"] = 10
    event["parameters"]["contraction_ratio"] = 1
    rows = performance(event, bars, days, days[-1])
    assert rows[0]["signal"] == rows[1]["signal"] == "pullback"
    assert rows[1]["first_pullback_date"] == days[-2]
    bars[-2].update(close=3, low=2, open=4)
    rows = performance(event, bars, days, days[-1])
    assert rows[1]["signal"] == "trend_invalid"


def test_actual_market_sessions_cross_weekend():
    days, bars, event = sample()
    replaced = ["2026-09-04", "2026-09-07", "2026-09-08"]
    for index, day in zip(range(60, 63), replaced, strict=True):
        days[index] = day
        bars[index]["date"] = day
    event.update(breakout_date=replaced[0], expires_date=replaced[-1])
    rows = performance(event, bars, days, "2026-09-07")
    assert rows[0]["trade_date"] == "2026-09-07"
    assert rows[1]["trade_date"] == "2026-09-08" and rows[1]["status"] == "pending"


def reports():
    return [
        dict(
            id=f"r{i}",
            trade_date=f"2026-09-{i:02}",
            revision=1,
            summary="摘要" * 500,
            created_at=datetime(2026, 9, i, 18, tzinfo=SHANGHAI_TZ),
            knowledge_enabled=True,
        )
        for i in range(1, 10)
    ]


def test_knowledge_temporal_cutoff_latest_disabled_not_revived_budget_and_dedupe():
    history = reports()
    history.append({**history[0], "id": "revision", "revision": 2, "knowledge_enabled": False})
    history.append(
        {
            **history[1],
            "id": "future-edit",
            "revision": 2,
            "created_at": datetime(2026, 9, 11, 18, tzinfo=SHANGHAI_TZ),
        }
    )
    chunks = [
        dict(
            id=f"c{i}",
            report_id="r2",
            content="历史观点" * 1000,
            event_ids=["e"],
            symbols=["000001.SZ"],
            rule_tags=["trend"],
            config_versions=[1],
        )
        for i in range(4)
    ]
    refs = select_knowledge(
        history, chunks, [dict(event_id="e", symbol="000001.SZ", config_version=1)], "2026-09-10"
    )
    assert len(refs) == 6
    assert sum(len(r["content"]) for r in refs) <= 16000
    assert refs[-1]["report_id"] == "r2"
    assert all(r["report_id"] not in ("r1", "revision", "future-edit") for r in refs)
    assert all(r["trade_date"] < "2026-09-10" for r in refs)


def test_report_contract_rejects_hallucinated_references_and_missing_stocks():
    payload = dict(snapshot={"current": [{"event_id": "e"}], "statistics": {}}, knowledge=[])
    result = dict(
        summary="摘要",
        sections=[
            dict(title="复盘", content="分析", event_ids=["e"], citations=[], rule_tags=["trend"])
        ],
    )
    assert validate_report(result, payload)["summary"] == "摘要"
    result["sections"][0]["citations"] = ["invented"]
    with pytest.raises(ValueError):
        validate_report(result, payload)
    result["sections"][0].update(citations=[], event_ids=[])
    with pytest.raises(ValueError):
        validate_report(result, payload)
