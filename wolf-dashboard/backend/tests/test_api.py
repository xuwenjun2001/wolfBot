from __future__ import annotations

from fastapi.testclient import TestClient

from app.config import Settings
from app.db import Database
from app.main import create_app
from app.market import normalize_ticker


def test_api_status_and_watchlist(tmp_path) -> None:
    config = Settings(database_path=tmp_path / "api.sqlite3", scheduler_enabled=False)
    app = create_app(Database(config.database_path), config)
    with TestClient(app) as client:
        response = client.get("/api/status")
        assert response.status_code == 200
        assert response.json()["configuration"]["tid"] == 47288722
        response = client.put("/api/watchlist", json={"items": [{"code": "600519.SH", "name": "测试"}]})
        assert response.status_code == 200
        assert response.json()["items"][0]["code"] == "sh600519"
        assert client.get("/api/aliases").status_code == 200
        response = client.delete("/api/watchlist/600519.SH")
        assert response.status_code == 200
        assert response.json()["items"] == []
        assert client.get("/api/posts?date=all").status_code == 200


def test_market_code_routing() -> None:
    assert normalize_ticker("920002") == "bj920002"
    assert normalize_ticker("832982.BJ") == "bj832982"
    assert normalize_ticker("000001") == "sh000001"
    assert normalize_ticker("159919") == "sz159919"
