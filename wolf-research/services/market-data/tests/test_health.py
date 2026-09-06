from fastapi.testclient import TestClient

from quantpilot_market_data.api import create_app


def test_health_is_available() -> None:
    response = TestClient(create_app()).get("/health")

    assert response.status_code == 200
    assert response.json() == {
        "status": "ok",
        "service": "wolf-research-market-data",
    }


def test_readiness_does_not_fake_market_availability() -> None:
    response = TestClient(create_app()).get("/ready")

    assert response.status_code == 200
    assert response.json() == {
        "ok": False,
        "service": "wolf-research-market-data",
        "code": "DATABASE_NOT_CONFIGURED",
        "message": (
            "未配置 WOLF_RESEARCH_MARKET_DATABASE_URL 或 DATABASE_URL，市场数据库功能不可用。"
        ),
        "retryable": False,
    }
