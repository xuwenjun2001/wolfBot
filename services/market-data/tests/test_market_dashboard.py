from __future__ import annotations

import asyncio
import copy
from datetime import UTC, datetime, timedelta

import httpx
import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

from quantpilot_market_data.providers.dashboard import (
    INDEX_SYMBOLS,
    DashboardProvider,
    DashboardUpstreamError,
    number,
    stock_symbol,
)
from quantpilot_market_data.routers.market_dashboard import (
    create_market_dashboard_router,
    validate_params,
)
from quantpilot_market_data.services.market_dashboard import MarketDashboardService


class MemoryCache:
    def __init__(self):
        self.values = {}

    async def read(self, key):
        return copy.deepcopy(self.values.get(key))

    async def write(self, key, *, ttl_seconds, payload):
        self.values[key] = copy.deepcopy(payload)

    async def close(self):
        pass


def test_full_app_starts_with_dashboard_router_and_lifespan(monkeypatch):
    monkeypatch.setenv("QUANTPILOT_MARKET_ADMIN_TOKEN", "test-only-token")
    from quantpilot_market_data.api import create_app

    with TestClient(create_app()) as client:
        assert client.get("/health").status_code == 200
        assert client.get("/api/v1/market-dashboard/overview").status_code == 401


class QuoteProvider:
    def __init__(self):
        self.calls = 0
        self.fail = False

    async def quotes(self, etfs=False):
        self.calls += 1
        await asyncio.sleep(0.01)
        if self.fail:
            raise RuntimeError("secret upstream internals")
        return {
            "rows": [{"name": "真实报价", "price": 1}],
            "source": "fixture",
            "tradeDate": "2026-06-18",
            "note": "历史报价",
        }

    async def close(self):
        pass


def test_concurrent_requests_coalesce_and_cache_historical_dates():
    async def run():
        provider, cache = QuoteProvider(), MemoryCache()
        service = MarketDashboardService(provider, cache)
        results = await asyncio.gather(*(service.get("overview", {}) for _ in range(8)))
        assert provider.calls == 1
        assert all(x["tradeDate"] == "2026-06-18" and x["stale"] for x in results)
        assert results[-1]["cacheHit"]
        assert results[0]["dateStatus"] == "historical"
        # A separate service process can reuse the shared cache contract.
        second = MarketDashboardService(provider, cache)
        assert (await second.get("overview", {}))["cacheHit"]
        assert provider.calls == 1

    asyncio.run(run())


def test_failed_refresh_retains_original_date_and_throttles_retries():
    async def run():
        provider, cache = QuoteProvider(), MemoryCache()
        service = MarketDashboardService(provider, cache)
        await service.get("overview", {})
        old = (datetime.now(UTC) - timedelta(seconds=60)).isoformat()
        for entry in cache.values.values():
            entry["fetchedAt"] = old
        provider.fail = True
        failed = await service.get("overview", {})
        assert failed["status"] == "stale"
        assert failed["fetchedAt"] == old
        assert failed["tradeDate"] == "2026-06-18"
        assert "secret" not in str(failed)
        await service.get("overview", {})
        assert provider.calls == 2

    asyncio.run(run())


def test_failed_upstream_is_never_a_successful_empty_market():
    async def run():
        provider = QuoteProvider()
        provider.fail = True
        service = MarketDashboardService(provider, MemoryCache())
        response = await service.get("overview", {})
        assert response["status"] == "unavailable"
        assert response["rows"] == []
        assert response["tradeDate"] is None
        await service.get("overview", {})
        assert provider.calls == 1

    asyncio.run(run())


@pytest.mark.parametrize(
    ("resource", "pairs"),
    [
        ("unknown", []),
        ("overview", [("url", "http://127.0.0.1")]),
        ("sectors", [("page", "11")]),
        ("sectors", [("kind", "arbitrary")]),
        ("minute", [("code", "../../file")]),
        ("minute", [("code", "832982")]),
        ("sector-history", [("code", "600519")]),
        ("limits", [("date", "2026-02-30")]),
        ("limits", [("date", "2099-01-01")]),
        ("themes", [("page", "1"), ("page", "2")]),
        ("institutions", [("refresh", "1")]),
    ],
)
def test_invalid_query_never_reaches_provider(resource, pairs):
    with pytest.raises(HTTPException):
        validate_params(resource, pairs)


def test_backend_enforces_service_token(monkeypatch):
    monkeypatch.setenv("QUANTPILOT_MARKET_ADMIN_TOKEN", "test-only-token")
    app = FastAPI()
    app.include_router(
        create_market_dashboard_router(MarketDashboardService(QuoteProvider(), MemoryCache()))
    )
    with TestClient(app) as client:
        assert client.get("/api/v1/market-dashboard/overview").status_code == 401
        assert (
            client.get(
                "/api/v1/market-dashboard/overview",
                headers={"X-QuantPilot-Admin-Token": "test-only-token"},
            ).status_code
            == 200
        )


def test_stock_market_and_missing_numbers_are_not_guessed():
    assert stock_symbol("510300") == "sh510300"
    assert stock_symbol("159915") == "sz159915"
    assert stock_symbol("920001") == "bj920001"
    assert stock_symbol("sh000001") == "sh000001"
    assert number("-") is None and number(None) is None and number("NaN") is None
    assert number("0") == 0


def test_quote_universe_includes_star_market_index():
    assert "sh000688" in INDEX_SYMBOLS


def test_tencent_gbk_quote_units_and_business_timestamp():
    values = [""] * 55
    for key, value in {
        1: "上证指数",
        3: "3100",
        4: "3090",
        6: "100",
        30: "20260904150000",
        32: "0.32",
        37: "10000",
        38: "1",
    }.items():
        values[key] = value

    async def run():
        client = httpx.AsyncClient(
            transport=httpx.MockTransport(
                lambda request: httpx.Response(
                    200, content=('v_sh000001="' + "~".join(values) + '";').encode("gbk")
                )
            )
        )
        provider = DashboardProvider(client)
        data = await provider.quotes()
        assert data["rows"][0]["name"] == "上证指数"
        assert data["rows"][0]["amount"] == 100_000_000
        assert data["tradeDate"] == "2026-09-04"
        assert data["partial"]
        await provider.close()

    asyncio.run(run())


def test_three_day_sum_uses_only_three_actual_daily_nodes():
    async def run():
        client = httpx.AsyncClient(
            transport=httpx.MockTransport(
                lambda request: httpx.Response(
                    200,
                    json={
                        "rc": 0,
                        "data": {
                            "klines": [
                                "2026-09-01,999",
                                "2026-09-02,10",
                                "2026-09-03,-20",
                                "2026-09-04,30",
                            ]
                        },
                    },
                )
            )
        )
        provider = DashboardProvider(client)
        data = await provider.sector_history("BK0486", "3d")
        assert [x["cumulative"] for x in data["rows"]] == [10, -10, 20]
        assert data["tradeDate"] == "2026-09-04"
        await provider.close()

    asyncio.run(run())


def test_theme_uses_industry_name_field_not_return_percentage():
    async def run():
        client = httpx.AsyncClient(
            transport=httpx.MockTransport(
                lambda request: httpx.Response(
                    200,
                    json={
                        "rc": 0,
                        "data": {
                            "total": 1,
                            "diff": [
                                {
                                    "f12": "600519",
                                    "f14": "贵州茅台",
                                    "f100": "白酒",
                                    "f127": "-1.5",
                                    "f62": "-",
                                    "f124": 1788508800,
                                }
                            ],
                        },
                    },
                )
            )
        )
        provider = DashboardProvider(client)
        data = await provider.sectors("concept", 1, "BK0896")
        assert data["rows"][0]["industry"] == "白酒"
        assert data["rows"][0]["mainNet"] is None
        await provider.close()

    asyncio.run(run())


@pytest.mark.parametrize("host", ["push2", "push2his"])
def test_transport_retry_is_bounded_and_keeps_query(monkeypatch, host):
    async def run():
        seen = []

        def reply(request):
            seen.append(request)
            if len(seen) == 1:
                raise httpx.RemoteProtocolError("connection closed", request=request)
            return httpx.Response(200, json={"rc": 0, "data": {"klines": []}})

        provider = DashboardProvider(httpx.AsyncClient(transport=httpx.MockTransport(reply)))
        await provider._json(
            f"https://{host}.eastmoney.com/api/qt/stock/fflow/daykline/get", {"secid": "90.BK0486"}
        )
        assert len(seen) == 2
        assert seen[1].url.host == (
            "push2delay.eastmoney.com" if host == "push2" else "push2his.eastmoney.com"
        )
        assert seen[0].url.params == seen[1].url.params
        assert seen[0].url.path == seen[1].url.path
        await provider.close()

    asyncio.run(run())


def test_failed_transport_stops_after_one_retry():
    async def run():
        seen = []

        def reply(request):
            seen.append(request)
            raise httpx.RemoteProtocolError("connection closed", request=request)

        provider = DashboardProvider(httpx.AsyncClient(transport=httpx.MockTransport(reply)))
        with pytest.raises(httpx.RemoteProtocolError):
            await provider._json("https://push2his.eastmoney.com/api/qt/stock/fflow/daykline/get")
        assert len(seen) == 2
        await provider.close()

    asyncio.run(run())


def test_limits_never_substitutes_another_trading_day():
    async def run():
        provider = DashboardProvider(
            httpx.AsyncClient(
                transport=httpx.MockTransport(
                    lambda request: httpx.Response(
                        200,
                        json={
                            "rc": 0,
                            "data": {"qdate": "20260904", "pool": [{"c": "003040", "n": "楚天龙"}]},
                        },
                    )
                )
            )
        )
        with pytest.raises(DashboardUpstreamError, match="其他业务日期"):
            await provider.limits("up", "2026-09-06")
        await provider.close()

    asyncio.run(run())


def test_dated_query_discards_wrong_day_cache_on_refresh_failure():
    async def run():
        provider, cache = QuoteProvider(), MemoryCache()
        service = MarketDashboardService(provider, cache)
        service._load = lambda resource, params: provider.quotes()
        params = {"date": "2026-06-19"}
        # Simulate an entry written before provider date validation was added.
        await service.get("limits", params)
        provider.fail = True
        response = await service.get("limits", params)
        assert response["status"] == "unavailable"
        assert response["rows"] == [] and response["tradeDate"] is None
        assert provider.calls == 2

    asyncio.run(run())
