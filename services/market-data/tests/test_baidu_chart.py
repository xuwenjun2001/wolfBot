from datetime import datetime
from decimal import Decimal
from unittest.mock import AsyncMock

import pytest

from quantpilot_market_data.models import KlineBar, KlineResponse
from quantpilot_market_data.providers.baidu_chart import parse_daily_amounts, supports_amount
from quantpilot_market_data.providers.dashboard import SHANGHAI, DashboardUpstreamError
from quantpilot_market_data.services.chart_data import ChartDataService


@pytest.fixture
def anyio_backend():
    return "asyncio"


def payload(rows="2026-09-03,1199800937.00;2026-09-04,2035782077.00"):
    return {
        "ResultCode": "0",
        "Result": {
            "newMarketData": {
                "keys": ["time", "amount"],
                "marketData": rows,
            }
        },
    }


def test_amount_is_exact_decimal_and_zero_is_not_missing():
    result = parse_daily_amounts(
        payload("2026-09-03,0;2026-09-04,2035782077.01"), "1.601919", "now"
    )
    assert result["2026-09-03"]["value"] == 0
    assert result["2026-09-04"]["value"] == Decimal("2035782077.01")
    assert result["2026-09-04"]["unit"] == "元"
    assert result["2026-09-04"]["secid"] == "1.601919"


@pytest.mark.parametrize("value", ["--", "", "NaN", "Infinity", "-1"])
def test_invalid_amounts_are_not_filled(value):
    assert parse_daily_amounts(payload("2026-09-04," + value), "1.601919", "now") == {}


def test_conflicting_dates_and_invalid_schema_fail_closed():
    for data in [
        payload("2026-09-04,1;2026-09-04,2"),
        payload("2026-02-30,1"),
        payload("2026-09-04,1,extra"),
        {"ResultCode": "1"},
    ]:
        with pytest.raises(DashboardUpstreamError):
            parse_daily_amounts(data, "1.601919", "now")
    assert supports_amount("1.601919", "stock")
    assert supports_amount("0.000657", "stock")
    assert not supports_amount("1.000001", "index")
    assert not supports_amount("1.510300", "etf")
    assert not supports_amount("0.920001", "stock")


@pytest.mark.anyio
async def test_baidu_enrichment_preserves_ohlcv_and_existing_amount(monkeypatch):
    monkeypatch.setattr(
        "quantpilot_market_data.services.chart_data.resolve_local_symbol",
        AsyncMock(return_value=None),
    )
    fetch = AsyncMock(return_value=parse_daily_amounts(payload(), "1.601919", "now"))
    monkeypatch.setattr("quantpilot_market_data.services.chart_data.fetch_daily_amounts", fetch)
    provider = AsyncMock()
    service = ChartDataService(provider)
    service.calendar = AsyncMock(return_value=["2026-09-03", "2026-09-04"])
    original = KlineResponse(
        symbol="601919",
        secid="1.601919",
        asset_type="stock",
        source="tencent",
        period="daily",
        adjustment="qfq",
        fetched_at=datetime.now(SHANGHAI),
        bars=[
            KlineBar(date="2026-09-03", open=10, close=11, high=12, low=9, volume=111, amount=555),
            KlineBar(date="2026-09-04", open=12, close=13, high=14, low=11, volume=222),
        ],
    )
    result = await service.enrich(original)
    assert result.bars[0].amount == 555
    assert result.bars[1].amount == 2035782077
    for before, after in zip(original.bars, result.bars, strict=True):
        for field in ("date", "open", "close", "high", "low", "volume"):
            assert getattr(before, field) == getattr(after, field)
    assert original.bars[1].amount is None
    assert result.adjustment == "qfq"
    assert result.metadata["volumeUnit"] == "手"
    assert result.metadata["amountSources"] == ["baidu", "tencent"]
    assert result.metadata["amountCoverage"] == 2
    assert (
        result.bars[1].metadata["amountEvidence"]["identityBasis"]
        == "validated-market-code-request"
    )
    provider._json.assert_not_awaited()  # No failing Eastmoney call when Baidu covers the gaps.


@pytest.mark.anyio
async def test_baidu_failure_does_not_erase_original_data(monkeypatch):
    monkeypatch.setattr(
        "quantpilot_market_data.services.chart_data.resolve_local_symbol",
        AsyncMock(return_value=None),
    )
    monkeypatch.setattr(
        "quantpilot_market_data.services.chart_data.fetch_daily_amounts",
        AsyncMock(side_effect=ValueError("unavailable")),
    )
    provider = AsyncMock()
    provider._json.side_effect = ValueError("unavailable")
    service = ChartDataService(provider)
    service.calendar = AsyncMock(return_value=[])
    original = KlineResponse(
        symbol="601919",
        secid="1.601919",
        period="daily",
        adjustment="qfq",
        fetched_at=datetime.now(SHANGHAI),
        bars=[KlineBar(date="2026-09-04", close=13, volume=222)],
    )
    result = await service.enrich(original)
    assert result.bars[0].amount is None
    assert result.bars[0].close == 13
    assert result.metadata["amountCoverage"] == 0
    assert any("百度" in warning for warning in result.metadata["chartWarnings"])
