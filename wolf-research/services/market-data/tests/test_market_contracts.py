from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager
from dataclasses import replace
from datetime import UTC, date, datetime, timedelta
from decimal import Decimal
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Any

import httpx
import pytest
from fastapi.testclient import TestClient

import quantpilot_market_data.services.research as research_service
from quantpilot_market_data.api import create_app
from quantpilot_market_data.cache import MarketDataCache
from quantpilot_market_data.config import MarketSettings, get_settings
from quantpilot_market_data.errors import ProviderError
from quantpilot_market_data.models import KlineBar, KlineResponse
from quantpilot_market_data.providers.eastmoney import EastMoneyClient
from quantpilot_market_data.services.backtests import (
    build_ma_crossover_backtest,
)
from quantpilot_market_data.services.indicators import build_technical_indicators
from quantpilot_market_data.services.quotes import get_history_quote
from quantpilot_market_data.services.research import (
    get_local_bars,
    get_universe_summary,
    screen_short_term_candidates,
)


def make_settings(tmp_path) -> MarketSettings:
    return replace(
        get_settings(),
        database_url="",
        cache_enabled=False,
        cache_dir=tmp_path,
        provider_max_retries=1,
    )


def test_eastmoney_quote_adapter_retries_and_normalizes_payload(tmp_path) -> None:
    settings = make_settings(tmp_path)
    calls = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        if calls == 1:
            return httpx.Response(503, request=request, text="temporary upstream failure")
        return httpx.Response(
            200,
            request=request,
            json={
                "rc": 0,
                "data": {
                    "diff": [
                        {
                            "f12": "600519",
                            "f13": 1,
                            "f14": "贵州茅台",
                            "f2": "1600.10",
                            "f3": "0.80",
                            "f4": "12.70",
                            "f5": "100000",
                            "f6": "160000000",
                            "f7": "2.10",
                            "f8": "1.20",
                            "f9": "18.50",
                            "f15": "1610",
                            "f16": "1570",
                            "f17": "1580",
                            "f18": "1587.40",
                            "f20": "2000000000000",
                            "f21": "1800000000000",
                            "f23": "2.60",
                            "f100": "白酒",
                            "f102": "贵州",
                            "f103": "消费,白酒,消费",
                            "f124": "2026-09-04 15:00:00",
                        }
                    ]
                },
            },
        )

    client = EastMoneyClient(settings)
    client._client = lambda: httpx.AsyncClient(
        transport=httpx.MockTransport(handler),
        timeout=settings.provider_timeout_seconds,
        headers=client.headers,
    )

    quote = asyncio.run(client.get_realtime_quote("600519"))

    assert calls == 2
    assert quote.symbol == "600519"
    assert quote.secid == "1.600519"
    assert quote.market == "SH"
    assert quote.price == Decimal("1600.10")
    assert quote.concepts == ["消费", "白酒"]
    assert quote.data_quality.status == "ok"


def test_eastmoney_adapter_exposes_invalid_upstream_payload(tmp_path) -> None:
    settings = make_settings(tmp_path)

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, request=request, json={"rc": 0, "data": {"diff": {}}})

    client = EastMoneyClient(settings)
    client._client = lambda: httpx.AsyncClient(transport=httpx.MockTransport(handler))

    with pytest.raises(ProviderError) as error:
        asyncio.run(client.get_realtime_quote("600519"))

    assert error.value.code == "QUOTE_PAYLOAD_INVALID"
    assert error.value.retryable is True


def test_tencent_kline_fallback_uses_source_contract_and_parses_qfqday(
    monkeypatch, tmp_path
) -> None:
    settings = make_settings(tmp_path)
    client = EastMoneyClient(settings)
    requests: list[tuple[tuple[str, ...], dict[str, Any]]] = []

    async def fake_get_json(
        urls: tuple[str, ...], params: dict[str, Any]
    ) -> dict[str, Any]:
        requests.append((urls, params))
        if len(requests) == 1:
            raise ProviderError("东方财富不可用。", code="KLINE_UPSTREAM_UNAVAILABLE")
        return {
            "code": 0,
            "data": {
                "sh600030": {
                    "qfqday": [
                        ["2026-09-03", "20.00", "21.00", "22.00", "19.00", "1000"],
                        ["2026-09-04", "21.00", "22.00", "23.00", "20.00", "1200"],
                    ],
                    "qt": {"sh600030": ["", "中信证券"]},
                }
            },
        }

    monkeypatch.setattr(client, "_get_json", fake_get_json)

    result = asyncio.run(
        client.get_kline(
            "600030",
            period="daily",
            adjustment="qfq",
            limit=120,
            end="20500101",
        )
    )

    assert requests[1][1]["param"] == "sh600030,day,,,120,qfq"
    assert result.source == "tencent"
    assert result.name == "中信证券"
    assert len(result.bars) == 2
    assert result.bars[1].previous_close == Decimal("21.00")
    assert result.bars[1].change_percent == pytest.approx(Decimal("4.7619047619"))


def test_index_history_normalizes_adjustment_before_provider_and_cache(tmp_path) -> None:
    with TemporaryDirectory(prefix="wolf-research-cache-") as cache_dir:
        settings = replace(
            make_settings(tmp_path),
            cache_enabled=True,
            cache_dir=Path(cache_dir),
        )
        cache = MarketDataCache(settings)
        stale_key = cache.build_key(
            "quote-history",
            {
                "symbol": "000300",
                "period": "daily",
                "adjustment": "qfq",
                "limit": 120,
                "end": "20500101",
            },
        )
        cache.write(
            stale_key,
            KlineResponse(
                symbol="000300",
                name="沪深300",
                secid="1.000300",
                asset_type="index",
                market="SH",
                period="daily",
                adjustment="qfq",
                bars=[],
            ),
            settings.kline_cache_ttl_seconds,
        )
        client = EastMoneyClient(settings)
        provider_adjustments: list[str] = []

        async def fake_get_kline(
            symbol: str,
            *,
            period: str,
            adjustment: str,
            limit: int,
            end: str,
        ) -> KlineResponse:
            provider_adjustments.append(adjustment)
            return KlineResponse(
                symbol=symbol,
                name="沪深300",
                secid="1.000300",
                asset_type="index",
                market="SH",
                period=period,
                adjustment=adjustment,
                bars=[
                    KlineBar(
                        date="2026-09-04",
                        open=Decimal("4500"),
                        high=Decimal("4520"),
                        low=Decimal("4480"),
                        close=Decimal("4510"),
                    )
                ],
            )

        client.get_kline = fake_get_kline  # type: ignore[method-assign]
        first = asyncio.run(
            get_history_quote(
                client,
                cache,
                settings,
                symbol="000300",
                period="daily",
                adjustment="qfq",
                limit=120,
                end="20500101",
            )
        )
        second = asyncio.run(
            get_history_quote(
                client,
                cache,
                settings,
                symbol="000300",
                period="daily",
                adjustment="none",
                limit=120,
                end="20500101",
            )
        )

        assert provider_adjustments == ["none"]
        assert first.adjustment == "none"
        assert first.bars
        assert first.fetch.cache_status == "miss"
        assert second.adjustment == "none"
        assert second.fetch.cache_status == "hit"
        assert second.fetch.cache_key == first.fetch.cache_key


def test_stock_history_preserves_requested_adjustment(tmp_path) -> None:
    settings = make_settings(tmp_path)
    cache = MarketDataCache(settings)
    client = EastMoneyClient(settings)
    provider_adjustments: list[str] = []

    async def fake_get_kline(
        symbol: str,
        *,
        period: str,
        adjustment: str,
        limit: int,
        end: str,
    ) -> KlineResponse:
        provider_adjustments.append(adjustment)
        return KlineResponse(
            symbol=symbol,
            secid="1.600519",
            asset_type="stock",
            market="SH",
            period=period,
            adjustment=adjustment,
            bars=[],
        )

    client.get_kline = fake_get_kline  # type: ignore[method-assign]
    result = asyncio.run(
        get_history_quote(
            client,
            cache,
            settings,
            symbol="600519",
            period="daily",
            adjustment="qfq",
            limit=120,
            end="20500101",
        )
    )

    assert provider_adjustments == ["qfq"]
    assert result.adjustment == "qfq"


def make_kline(count: int = 80) -> KlineResponse:
    bars = []
    for index in range(count):
        close = Decimal("100") + Decimal(index) * Decimal("0.75")
        bars.append(
            KlineBar(
                date=(date(2026, 1, 1) + timedelta(days=index)).isoformat(),
                open=close - Decimal("0.20"),
                high=close + Decimal("1"),
                low=close - Decimal("1"),
                close=close,
                previous_close=close - Decimal("0.75"),
                volume=1000 + index,
                amount=close * Decimal(1000 + index),
            )
        )
    return KlineResponse(
        symbol="600519",
        name="贵州茅台",
        secid="1.600519",
        market="SH",
        period="daily",
        adjustment="qfq",
        bars=bars,
    )


def test_technical_indicators_compute_ma_and_quality() -> None:
    result = build_technical_indicators(make_kline())

    assert len(result.points) == 80
    assert result.points[19].ma20 == Decimal("107.1250")
    assert result.summary.latest_close == Decimal("159.2500")
    assert result.summary.ma60 is not None
    assert result.data_quality.status == "ok"


def test_ma_crossover_backtest_rejects_invalid_windows_and_returns_curve() -> None:
    kline = make_kline()

    with pytest.raises(ValueError, match="fast_window"):
        build_ma_crossover_backtest(
            kline=kline,
            fast_window=20,
            slow_window=20,
            initial_cash=Decimal("100000"),
            fee_bps=Decimal("5"),
        )

    result = build_ma_crossover_backtest(
        kline=kline,
        fast_window=5,
        slow_window=20,
        initial_cash=Decimal("100000"),
        fee_bps=Decimal("5"),
    )

    assert len(result.equity_curve) == 80
    assert result.summary.sample_count == 80
    assert result.summary.initial_cash == Decimal("100000")
    assert result.summary.final_equity > Decimal("0")
    assert result.summary.benchmark_return_pct is not None


class FakeCursor:
    def __init__(self, rows: list[dict[str, Any]]) -> None:
        self.rows = rows
        self.executions: list[tuple[str, tuple[Any, ...] | None]] = []

    async def __aenter__(self) -> FakeCursor:
        return self

    async def __aexit__(self, *_args: object) -> None:
        return None

    async def execute(self, query: str, params: tuple[Any, ...] | None = None) -> None:
        self.executions.append((query, params))

    async def fetchall(self) -> list[dict[str, Any]]:
        return self.rows

    async def fetchone(self) -> dict[str, Any] | None:
        return self.rows[0] if self.rows else {"total": 0}


class FakeConnection:
    def __init__(self, rows: list[dict[str, Any]]) -> None:
        self.rows = rows

    def cursor(self) -> FakeCursor:
        return FakeCursor(self.rows)


def make_screener_rows() -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    start = datetime(2026, 8, 11, tzinfo=UTC)
    for symbol, name in (("600519", "贵州茅台"), ("000001", "*ST 测试")):
        for index in range(25):
            close = Decimal("100") + Decimal(index)
            rows.append(
                {
                    "symbol": symbol,
                    "code": symbol,
                    "name": name,
                    "exchange": "SH" if symbol == "600519" else "SZ",
                    "security_metadata": {"industry": "白酒"},
                    "ts": start + timedelta(days=index),
                    "open": close - Decimal("0.5"),
                    "high": close + Decimal("1"),
                    "low": close - Decimal("1"),
                    "close": close,
                    "previous_close": close - Decimal("1"),
                    "volume": Decimal("100000"),
                    "amount": Decimal("10000000"),
                    "change_percent": Decimal("1"),
                    "turnover": Decimal("1"),
                    "trade_status": "1",
                    "is_st": False,
                    "limit_up": False,
                    "limit_down": False,
                    "provider": "test",
                }
            )
    return rows


def test_screener_uses_postgres_rows_and_explicitly_excludes_st_symbol(
    monkeypatch, tmp_path
) -> None:
    rows = make_screener_rows()

    @asynccontextmanager
    async def fake_connection(_settings: MarketSettings):
        yield FakeConnection(rows)

    monkeypatch.setattr(research_service, "connection", fake_connection)
    result = asyncio.run(
        screen_short_term_candidates(
            make_settings(tmp_path),
            universe_id="a-share-sample-research-pool",
            trade_date=date(2026, 9, 4),
            limit=20,
            sector=None,
        )
    )

    assert result.scanned_symbols == 2
    assert result.eligible_symbols == 1
    assert [candidate.symbol for candidate in result.candidates] == ["600519"]
    assert result.excluded_reasons["name_st_marker"] == 1
    assert result.analytics.engine == "postgresql"


def test_empty_database_is_warning_and_unavailable_database_is_error(monkeypatch, tmp_path) -> None:
    @asynccontextmanager
    async def empty_connection(_settings: MarketSettings):
        yield FakeConnection([])

    monkeypatch.setattr(research_service, "connection", empty_connection)
    summary = asyncio.run(get_universe_summary(make_settings(tmp_path)))
    assert summary.universes == []
    assert summary.data_quality.status == "warning"
    assert summary.data_quality.missing_fields == ["universes"]
    local_bars = asyncio.run(
        get_local_bars(make_settings(tmp_path), symbol="600519", limit=120)
    )
    assert local_bars.bars == []
    assert local_bars.data_quality.status == "warning"
    monkeypatch.undo()

    unavailable = replace(
        make_settings(tmp_path),
        database_url="postgresql://wolf_research:invalid@127.0.0.1:1/wolf_research",
    )
    client = TestClient(create_app(unavailable))
    readiness = client.get("/ready")
    assert readiness.status_code == 200
    assert readiness.json()["ok"] is False
    assert readiness.json()["code"] == "DATABASE_CONNECTION_FAILED"

    response = client.get("/api/v1/research/universes/summary")
    assert response.status_code == 503
    assert response.json()["error"]["code"] == "DATABASE_CONNECTION_FAILED"
    assert response.json()["error"]["retryable"] is True
