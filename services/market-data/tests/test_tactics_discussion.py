"""Discussion variant regression: price bases, support, and frozen event replay."""

from copy import deepcopy
from datetime import date, timedelta

import pytest

from quantpilot_market_data.tactic_reviews import performance
from quantpilot_market_data.tactics import TacticParameters, evaluate, is_breakout, signal


def breakout_pair():
    previous = dict(close=10, ma55=10.1, ma5=10, ma10=9.9, ma20=9.85)
    current = dict(
        open=10.05, close=10.5, low=10, high=10.6, volume=150, prior_v5=100,
        ma55=10.11, ma5=10.2, ma10=10.05, ma20=9.95,
    )
    return previous, current


def strict(**values):
    return TacticParameters(rule_set="discussion_v2", distance_min_pct=-1, **values)


def test_legacy_snapshots_default_to_original_rules():
    previous, current = breakout_pair()
    current.update(open=9.9, close=10.3)
    assert is_breakout(previous, current, TacticParameters())
    assert not is_breakout(previous, current, strict())


def test_five_percent_change_does_not_replace_positive_body_requirement():
    previous, current = breakout_pair()
    assert is_breakout(previous, current, strict())  # inclusive 5%, inclusive 1.5x volume
    assert not is_breakout(previous, {**current, "close": 10.499}, strict())
    assert not is_breakout(previous, {**current, "open": 10.8}, strict())
    assert not is_breakout(previous, {**current, "volume": 149.9}, strict())


@pytest.mark.parametrize("changes", [{"ma20": 9.8}, {"ma5": 10.1}, {"ma10": 10.15}])
def test_alignment_alone_is_not_upward_expansion(changes):
    previous, current = breakout_pair()
    assert not is_breakout(previous, {**current, **changes}, strict())


def test_pullback_requires_support_reclaim_and_rejects_deep_wick():
    base = {"volume": 200}
    current = dict(ma55=10, close=10.05, low=9.9, volume=100)
    assert signal(base, current, strict()) == "pullback"
    assert signal(base, {**current, "close": 9.95}, strict()) == "below_support"
    assert signal(base, {**current, "low": 9.899}, strict()) == "support_broken"
    assert signal(base, {**current, "low": None}, strict()) == "insufficient"
    assert signal(base, {**current, "close": 10.2}, strict()) == "outside_band"
    assert signal(base, {**current, "volume": 161}, strict()) == "not_contracted"
    # Old events keep the original close-only band interpretation.
    assert signal(base, {**current, "low": 9.5, "close": 9.8}, TacticParameters()) == "pullback"


def test_broken_support_cannot_revive_in_scan_or_review_and_new_config_is_not_retroactive():
    sessions = [(date(2026, 6, 1) + timedelta(days=i)).isoformat() for i in range(63)]
    bars = [dict(date=d, open=10 + i / 10, high=11 + i / 10, low=9 + i / 10,
                 close=10 + i / 10, volume=100, trade_status="1", is_st=False)
            for i, d in enumerate(sessions)]
    # A deep wick on B+1 with the close and trend intact; B+2 recovers.
    bars[61]["low"] = 10
    event = dict(id="event", symbol="000001.SZ", name="sample", breakout_date=sessions[60],
                 expires_date=sessions[62], config_version=1, parameters=strict().model_dump(),
                 evidence={"breakout": bars[60]}, last_evaluated=sessions[60],
                 status="observing", signal="breakout")
    fresh_config = TacticParameters().model_dump()
    result = evaluate(event["symbol"], "sample", bars, sessions, sessions[-1],
                      fresh_config, 2, [deepcopy(event)])[0]
    assert result["parameters"] == event["parameters"]
    assert result["config_version"] == 1
    assert result["status"] == "invalidated"
    assert [r["signal"] for r in result["evaluations"]] == [
        "breakout", "support_broken", "support_broken",
    ]
    review = performance(event, bars, sessions, sessions[-1])
    assert [r["signal"] for r in review] == ["support_broken", "support_broken"]
    assert all(r["first_pullback_date"] is None for r in review)
    assert all(r["return_pct"] is not None for r in review)
    # A persisted invalidation remains invalid if later historical quotes change.
    bars[61]["low"] = 15
    rerun = evaluate(event["symbol"], "sample", bars, sessions, sessions[-1],
                     fresh_config, 3, [result])[0]
    assert rerun["signal"] == "support_broken"


def test_discussion_parameters_reject_unknown_modes_and_nonfinite_thresholds():
    with pytest.raises(ValueError):
        TacticParameters(rule_set="future")
    with pytest.raises(ValueError):
        strict(change_pct=float("nan"))
