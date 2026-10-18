from datetime import datetime
from decimal import Decimal
from unittest.mock import AsyncMock

import pytest

from quantpilot_market_data.models import KlineBar, KlineResponse
from quantpilot_market_data.providers.dashboard import SHANGHAI, DashboardUpstreamError
from quantpilot_market_data.providers.market_layout import MINUTES
from quantpilot_market_data.services.chart_data import (
    ChartDataService,
    build_session,
    chart_secid,
    parse_sessions,
)


@pytest.fixture
def anyio_backend():
    return "asyncio"


def data(lines=None):
    return {
        "code": "600519",
        "name": "贵州茅台",
        "preClose": 10,
        "trends": lines
        or [
            "2026-09-03 09:30,10,10,10,10,1,100,10",
            "2026-09-03 09:31,10,10,10,10,2,200,10",
            "2026-09-04 09:30,10,11,11,10,3,300,10",
            "2026-09-04 09:31,10,12,12,10,4,400,10",
        ],
    }


def test_values_and_comparison():
    result = build_session(
        data(), "1.600519", "2026-09-03", now=datetime(2026, 9, 4, 9, 31, tzinfo=SHANGHAI)
    )
    p = result.rows[-1]
    assert (p.minuteVolume, p.minuteAmount, p.amount, p.previous, p.difference) == (
        4,
        400,
        700,
        300,
        400,
    )
    assert p.changeAmountPct == pytest.approx(400 / 3)
    assert p.provisional
    assert not result.rows[0].provisional


def test_calendar_unknown_and_suspension_do_not_pick_older_day():
    for previous in (None, "2026-09-02"):
        result = build_session(data(), "1.600519", previous)
        assert result.rows[-1].amount == 700
        assert result.rows[-1].previous is None
        assert result.status == "partial"


def test_gaps_null_and_zero_remain_distinct():
    result = build_session(
        data(
            [
                "2026-09-03 09:30,10,10,10,10,0,0,10",
                "2026-09-04 09:30,10,11,11,10,0,0,10",
                "2026-09-04 09:32,10,11,11,10,-,10,10",
            ]
        ),
        "1.600519",
        "2026-09-03",
    )
    assert result.rows[0].minuteVolume == 0
    assert result.rows[0].difference == 0
    assert result.rows[0].changeAmountPct is None
    assert result.rows[1].minuteVolume is None
    assert result.rows[1].amount is None
    assert result.rows[1].minuteAmount == 10
    assert result.cutoff == "09:30"


def test_missing_opening_never_invents_cumulative():
    result = build_session(data(["2026-09-04 09:31,10,10,10,10,1,100,10"]), "1.600519", None)
    assert result.rows[0].amount is None
    assert result.rows[0].minuteAmount == 100


def test_lunch_break_is_not_a_gap_and_full_day_totals_align():
    raw = data(
        [
            f"{date} {minute},10,10,10,10,1,{amount},10"
            for date, amount in [("2026-09-03", 100), ("2026-09-04", 200)]
            for minute in MINUTES
        ]
    )
    result = build_session(raw, "1.600519", "2026-09-03")
    assert result.status == "available"
    assert result.cutoff == "15:00"
    assert result.rows[-1].amount == len(MINUTES) * 200
    assert result.rows[-1].changeAmountPct == 100


def test_session_route_preserves_explicit_identity_and_validates_unsupported_symbols():
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    from quantpilot_market_data.routers.quotes import create_quotes_router

    service = ChartDataService(AsyncMock())
    service._raw_session = AsyncMock(return_value=(data(), False))
    service.calendar = AsyncMock(return_value=["2026-09-03", "2026-09-04"])
    app = FastAPI()
    app.include_router(
        create_quotes_router(
            client=AsyncMock(),
            cache=AsyncMock(),
            intraday_redis_cache=AsyncMock(),
            symbol_cache_ttl_seconds=60,
            quote_cache_ttl_seconds=60,
            kline_cache_ttl_seconds=60,
            chart_service=service,
        )
    )
    with TestClient(app) as client:
        response = client.get("/api/v1/quotes/session/sh600519")
        assert response.status_code == 200
        assert response.json()["secid"] == "1.600519"
        assert response.json()["rows"][-1]["difference"] == 400
        assert client.get("/api/v1/quotes/session/920001").status_code == 400


def test_wrong_symbol_conflicts_and_explicit_markets():
    with pytest.raises(DashboardUpstreamError):
        parse_sessions(data(), "0.000001")
    with pytest.raises(DashboardUpstreamError):
        parse_sessions(
            data(
                ["2026-09-04 09:30,10,10,10,10,1,100,10", "2026-09-04 09:30,10,11,10,10,1,100,10"]
            ),
            "1.600519",
        )
    assert chart_secid("sz000001") == chart_secid("000001.SZ") == "0.000001"
    assert chart_secid("sh000001") == "1.000001"
    with pytest.raises(ValueError):
        chart_secid("920001")


@pytest.mark.anyio
async def test_short_cache_and_single_flight():
    import asyncio

    service = ChartDataService(AsyncMock())
    service._raw_session = AsyncMock(return_value=(data(), False))
    service.calendar = AsyncMock(return_value=["2026-09-03", "2026-09-04"])
    first, second = await asyncio.gather(service.session("600519"), service.session("600519"))
    assert first.rows == second.rows
    assert first.cacheHit is False and second.cacheHit is True
    service._raw_session.assert_awaited_once()


@pytest.mark.anyio
async def test_enrichment_keeps_prices_and_records_evidence(monkeypatch):
    service = ChartDataService(AsyncMock())
    monkeypatch.setattr(
        "quantpilot_market_data.services.chart_data.fetch_daily_amounts",
        AsyncMock(side_effect=DashboardUpstreamError("百度测试降级")),
    )
    monkeypatch.setattr(
        "quantpilot_market_data.services.chart_data.resolve_local_symbol",
        AsyncMock(return_value=None),
    )
    service.calendar = AsyncMock(return_value=["2026-09-03", "2026-09-04"])
    service.provider._json.return_value = {
        "rc": 0,
        "data": {
            "code": "600519",
            "name": "贵州茅台",
            "klines": ["2026-09-04,100,101,102,99,8,999,3,1,1,1"],
        },
    }
    response = KlineResponse(
        symbol="600519",
        secid="1.600519",
        period="daily",
        adjustment="qfq",
        source="tencent",
        fetched_at=datetime.now(SHANGHAI),
        bars=[KlineBar(date="2026-09-04", close=Decimal(10), volume=8)],
    )
    result = await service.enrich(response)
    assert result.bars[0].close == 10
    assert result.bars[0].amount == 999
    assert result.bars[0].metadata["previousTradeDate"] == "2026-09-03"
    assert result.bars[0].metadata["amountEvidence"]["source"] == "eastmoney"
    assert response.bars[0].amount is None
    assert result.metadata["volumeUnit"] == "手"
