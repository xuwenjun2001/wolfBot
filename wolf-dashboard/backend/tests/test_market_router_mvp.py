from __future__ import annotations

from datetime import date, timedelta

from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.db import Database
from app.market_data import DailyBar, default_catalog
from app.market_router import create_market_router
from app.market_store import MarketStore


def _bars(symbol: str, count: int = 60) -> list[DailyBar]:
    first = date(2026, 1, 2)
    return [
        DailyBar(
            trade_date=(first + timedelta(days=index)).isoformat(),
            open=float(index + 1),
            high=float(index + 2),
            low=float(index),
            close=float(index + 1),
            volume=1000,
            amount=200_000_000,
            symbol=symbol,
            adjustment="qfq",
            fetched_at="2026-08-29T00:00:00+00:00",
        )
        for index in range(count)
    ]


class FakeProvider:
    def __init__(self, bars):
        self._bars = bars

    def realtime(self, symbol):
        from app.market_data import Quote

        return Quote(symbol, symbol[2:], "Fixture", "stock", "SZ", 10, 9, 11.11, fetched_at="now")

    def history(self, symbol, *, adjustment="qfq", limit=240):
        return [DailyBar(**{**bar.as_dict(), "symbol": symbol, "adjustment": adjustment}) for bar in self._bars[-limit:]]


def test_market_router_exposes_read_only_contracts(tmp_path) -> None:
    db = Database(tmp_path / "market.sqlite")
    store = MarketStore(db)
    security = default_catalog()[1]
    store.upsert_symbols([security])
    app = FastAPI()
    app.include_router(create_market_router(store=store, provider=FakeProvider(_bars(security.symbol))))
    with TestClient(app) as client:
        assert client.get("/api/v1/symbols/resolve?query=000001").status_code == 200
        assert client.get("/api/v1/quotes/realtime/sz000001").json()["asset_type"] == "stock"
        history = client.get("/api/v1/quotes/history/sz000001?adjustment=qfq&limit=10")
        assert history.status_code == 200
        assert history.json()["adjustment"] == "qfq"
        indicators = client.get("/api/v1/indicators/technical/sz000001?limit=60")
        assert indicators.status_code == 200
        assert indicators.json()["summary"]["ma5"] is not None
        assert client.get("/api/v1/research/universes/summary").status_code == 200
