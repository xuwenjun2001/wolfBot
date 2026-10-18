import asyncio
from datetime import UTC, datetime
from unittest.mock import AsyncMock

import pytest

from quantpilot_market_data.models import KlineBar, KlineResponse
from quantpilot_market_data.services import tactic_charts as module
from quantpilot_market_data.services.chart_data import SecuritySessionResponse


@pytest.fixture
def anyio_backend():
    return "asyncio"


def response():
    return KlineResponse(
        symbol="002837",
        secid="0.002837",
        source="tencent",
        period="daily",
        adjustment="qfq",
        fetched_at=datetime.now(UTC),
        bars=[KlineBar(date="2026-09-08", open=10, high=12, low=9, close=11, volume=100)],
    )


@pytest.mark.anyio
async def test_refresh_bypasses_cache_and_coalesces(monkeypatch):
    gate = asyncio.Event()

    async def fetch(*args, **kwargs):
        assert kwargs["refresh"] is True
        assert kwargs["limit"] == 320
        await gate.wait()
        return response()

    fetcher = AsyncMock(side_effect=fetch)
    monkeypatch.setattr(module, "get_history_quote", fetcher)
    saved = []
    monkeypatch.setattr(module, "persist_chart", lambda *args: saved.append(args))
    charts = AsyncMock()
    charts.enrich.side_effect = lambda r, **kwargs: r
    service = module.TacticChartService(None, None, None, charts)
    first = asyncio.create_task(service.refresh("002837.SZ", "daily"))
    second = asyncio.create_task(service.refresh("002837.SZ", "daily"))
    await asyncio.sleep(0)
    gate.set()
    a, b = await asyncio.gather(first, second)
    assert a == b
    assert fetcher.await_count == 1 and len(saved) == 1
    assert charts.enrich.call_args.kwargs == {"refresh": True}


@pytest.mark.anyio
async def test_failed_session_and_invalid_symbol_data_never_replace_cache(monkeypatch):
    saved = []
    monkeypatch.setattr(module, "persist_chart", lambda *args: saved.append(args))
    charts = AsyncMock()
    charts.session.return_value = SecuritySessionResponse(
        symbol="002837",
        secid="0.002837",
        name="英维克",
        market="SZ",
        fetchedAt="2026-09-08T08:00:00Z",
        status="unavailable",
    )
    service = module.TacticChartService(None, None, None, charts)
    with pytest.raises(ValueError):
        await service.refresh("002837.SZ", "session")
    charts.session.assert_awaited_once_with("002837.SZ", refresh=True)
    bad = response().model_copy(update={"secid": "1.600000"})
    monkeypatch.setattr(module, "get_history_quote", AsyncMock(return_value=bad))
    with pytest.raises(ValueError):
        await service.refresh("002837.SZ", "daily")
    assert saved == []


@pytest.mark.anyio
@pytest.mark.parametrize("failure", [TimeoutError("timeout"), ValueError("source failed"), None])
async def test_daily_failures_preserve_saved_chart(monkeypatch, failure):
    saved = []
    monkeypatch.setattr(module, "persist_chart", lambda *args: saved.append(args))
    fetch = (
        AsyncMock(side_effect=failure)
        if failure
        else AsyncMock(return_value=response().model_copy(update={"bars": []}))
    )
    monkeypatch.setattr(module, "get_history_quote", fetch)
    service = module.TacticChartService(None, None, None, AsyncMock())
    with pytest.raises((TimeoutError, ValueError)):
        await service.refresh("002837.SZ", "daily")
    assert saved == []
    await asyncio.sleep(0)
    assert not service.pending


@pytest.mark.anyio
async def test_source_overdelivery_keeps_latest_320(monkeypatch):
    from datetime import date, timedelta

    data = response()
    data.bars = [
        data.bars[0].model_copy(update={"date": (date(2025, 1, 1) + timedelta(days=i)).isoformat()})
        for i in range(321)
    ]
    monkeypatch.setattr(module, "get_history_quote", AsyncMock(return_value=data))
    monkeypatch.setattr(module, "persist_chart", lambda *args: None)
    charts = AsyncMock()
    charts.enrich.side_effect = lambda r, **kwargs: r
    result = await module.TacticChartService(None, None, None, charts).refresh("002837.SZ", "daily")
    assert len(result["bars"]) == 320
    assert result["bars"][0]["date"] == "2025-01-02"
    assert result["bars"][-1]["date"] == data.bars[-1].date
