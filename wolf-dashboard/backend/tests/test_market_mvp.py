from __future__ import annotations

from datetime import date, timedelta

from app.market_data import (
    DailyBar,
    MarketDataError,
    compute_features,
    default_catalog,
    parse_tencent_history_payload,
    parse_tencent_response,
    resolve_symbol,
)


def _bars(symbol: str = "sz000001", count: int = 60, adjustment: str = "qfq") -> list[DailyBar]:
    start = date(2026, 1, 2)
    return [
        DailyBar(
            trade_date=(start + timedelta(days=index)).isoformat(),
            open=float(index + 1),
            high=float(index + 2),
            low=float(index),
            close=float(index + 1),
            volume=1000,
            amount=200_000_000,
            previous_close=float(index) if index else None,
            change_pct=1.0,
            trade_status="active",
            is_st=False,
            is_limit_up=index in {55, 58},
            is_limit_down=False,
            symbol=symbol,
            adjustment=adjustment,
            fetched_at="2026-08-29T00:00:00+00:00",
        )
        for index in range(count)
    ]


def test_symbol_fixtures_and_bare_code_ambiguity() -> None:
    catalog = default_catalog()
    result = resolve_symbol("000001", catalog=catalog)
    assert result.status == "ambiguous"
    assert {candidate.symbol for candidate in result.candidates} == {"sh000001", "sz000001"}
    assert resolve_symbol("sh000001", catalog=catalog).candidates[0].asset_type == "index"
    assert resolve_symbol("sz000001", catalog=catalog).candidates[0].asset_type == "stock"
    assert resolve_symbol("159919", catalog=catalog).candidates[0].asset_type == "etf"
    assert resolve_symbol("920002", catalog=catalog).candidates[0].exchange == "BJ"


def test_tencent_quote_and_qfq_series_are_explicit() -> None:
    body = 'v_sh600519="1~Test~600519~1300~1290~1295~100~";'
    quote = parse_tencent_response(body, "2026-08-29T00:00:00+00:00")[0]
    assert quote.symbol == "sh600519"
    assert quote.price == 1300
    assert quote.previous_close == 1290
    assert quote.change_pct == round((1300 / 1290 - 1) * 100, 6)

    payload = {
        "code": 0,
        "data": {
            "sh600519": {
                "day": [["2026-08-28", "10", "11", "12", "9", "100"]],
                "qfqday": [["2026-08-28", "20", "21", "22", "19", "100"]],
            }
        },
    }
    qfq = parse_tencent_history_payload(payload, symbol="sh600519", adjustment="qfq")
    none = parse_tencent_history_payload(payload, symbol="sh600519", adjustment="none")
    assert qfq[0].close == 21
    assert none[0].close == 11
    with __import__("pytest").raises(MarketDataError):
        parse_tencent_history_payload(payload, symbol="sh600519", adjustment="hfq")


def test_features_are_deterministic_and_adjustment_isolation() -> None:
    bars = _bars()
    features1 = compute_features(bars, symbol="sz000001", adjustment="qfq")
    features2 = compute_features(list(reversed(bars)), symbol="sz000001", adjustment="qfq")
    assert features1 == features2
    assert features1.ma5 == 58.0
    assert features1.ma60 == 30.5
    assert features1.return_5d_pct == round((60 / 55 - 1) * 100, 6)
    assert features1.limit_up_count_4d == 1
    assert features1.limit_up_count_10d == 2
    with __import__("pytest").raises(MarketDataError):
        compute_features(bars[:2] + [DailyBar(**{**bars[2].as_dict(), "adjustment": "none"})], symbol="sz000001", adjustment="qfq")
