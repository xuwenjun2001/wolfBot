from __future__ import annotations

import math

import pytest

from app.screener import (
    ScreenRequest,
    Screener,
    ScreenerValidationError,
    screen_stocks,
)


def _row(symbol: str, *, date_value: str = "2026-08-28", **updates):
    row = {
        "symbol": symbol,
        "code": symbol[2:],
        "name": "Fixture " + symbol,
        "asset_type": "stock",
        "exchange": "SZ",
        "board": "main",
        "trade_date": date_value,
        "sample_count": 60,
        "close": 110.0,
        "open": 101.0,
        "high": 112.0,
        "low": 99.0,
        "previous_close": 100.0,
        "change_pct": 2.0,
        "previous_change_pct": 1.0,
        "amount": 200_000_000.0,
        "turnover": 3.0,
        "ma5": 108.0,
        "ma10": 105.0,
        "ma20": 100.0,
        "ma30": 95.0,
        "ma60": 90.0,
        "return_5d_pct": 4.0,
        "return_10d_pct": 7.0,
        "return_20d_pct": 10.0,
        "return_60d_pct": 20.0,
        "amount_ratio_20d": 1.3,
        "volatility_20d_pct": 20.0,
        "max_drawdown_20d_pct": -4.0,
        "max_drawdown_60d_pct": -10.0,
        "limit_up_count_4d": 1,
        "limit_up_count_10d": 2,
        "is_st": False,
        "is_limit_up": False,
        "is_limit_down": False,
        "trade_status": "active",
    }
    row.update(updates)
    return row


def test_three_presets_are_deterministic_and_keep_safety_gate() -> None:
    rows = [_row("sz000002"), _row("sz000003", return_20d_pct=3.0, limit_up_count_4d=0, ma5=95.0, ma10=100.0)]
    for mode in ("short_term", "limit_up_relay", "trend_liquidity"):
        result = screen_stocks(rows=rows, mode=mode, limit=10)
        assert result.status == "completed"
        assert result.matched_count == 1
        assert result.candidates[0]["symbol"] == "sz000002"
        assert result.candidates[0]["risk_warning"]
    unsafe = _row("sz000004", is_st=True)
    result = screen_stocks(rows=[_row("sz000002"), unsafe], mode="short_term")
    assert result.matched_count == 1
    assert result.excluded_reasons["is_st"] == 1


def test_custom_dsl_and_sorting() -> None:
    rows = [_row("sz000003", return_20d_pct=20.0), _row("sz000002", return_20d_pct=10.0)]
    request = {
        "universe_id": "fixture",
        "conditions": [
            {"field": "ma5", "op": "gt", "right_field": "ma10"},
            {"field": "return_20d_pct", "op": "gt", "value": 8},
            {"field": "is_st", "op": "eq", "value": False},
        ],
        "sort": [{"field": "return_20d_pct", "direction": "desc"}],
        "limit": 1,
    }
    result = screen_stocks(request, rows=rows)
    assert result.status == "completed"
    assert result.matched_count == 2
    assert result.candidates[0]["symbol"] == "sz000003"
    assert result.conditions[0]["right_field"] == "ma10"


@pytest.mark.parametrize(
    "payload",
    [
        {"conditions": []},
        {"conditions": [{"field": "unknown", "op": "eq", "value": 1}]},
        {"conditions": [{"field": "amount", "op": "eq", "value": float("inf")}]},
        {"conditions": [{"field": "amount", "op": "eq", "value": 1}], "limit": 21},
        {"conditions": [{"field": "ma5", "op": "gt", "right_field": "is_st"}]},
        {"conditions": [{"field": "amount", "op": "eq", "value": "1 OR 1=1"}]},
        {"conditions": [{"field": "amount", "op": "eq", "value": "1; DROP TABLE market_symbols"}]},
        {"or": [{"field": "amount", "op": "gt", "value": 1}], "conditions": [{"field": "amount", "op": "gt", "value": 1}]},
    ],
)
def test_dsl_rejects_unsafe_or_unknown_requests(payload) -> None:
    with pytest.raises(ScreenerValidationError):
        ScreenRequest.from_mapping(payload)


def test_coverage_shortfall_is_not_reported_as_zero_match() -> None:
    missing = _row("sz000002", is_limit_down=None)
    result = screen_stocks(rows=[_row("sz000001"), missing], mode="short_term")
    assert result.status == "insufficient_evidence"
    assert result.coverage_warning
    assert result.empty_result is False
    assert result.excluded_reasons["missing_limit_down"] == 1


def test_full_coverage_zero_match_is_structured_empty_result() -> None:
    result = screen_stocks(rows=[_row("sz000001", return_20d_pct=-5.0, limit_up_count_4d=0)], mode="trend_liquidity")
    assert result.status == "completed"
    assert result.matched_count == 0
    assert result.empty_result is True
    assert result.candidates == []
