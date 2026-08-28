from __future__ import annotations

from app.config import Settings
from app.db import Database
from app.strategy import StrategyService, validate_aliases, validate_items


def test_validate_items_rejects_unknown_or_incomplete_citations() -> None:
    payload = {
        "items": [
            {"title": "bad", "citations": [{"post_pids": ["missing"], "rule_ids": ["E25-01"]}]},
            {"title": "good", "citations": [{"post_pids": ["123"], "rule_ids": ["E25-01"], "quote": "x"}]},
        ]
    }
    items, errors = validate_items(payload, {"123"}, {"E25-01"})
    assert len(items) == 1
    assert items[0]["citations"][0]["post_pid"] == "123"
    assert errors


def test_validate_aliases_keeps_highest_confidence_and_normalizes_codes() -> None:
    aliases, errors = validate_aliases(
        {
            "aliases": [
                {"alias": "茅台", "code": "600519.SH", "confidence": 0.6},
                {"alias": "茅台", "code": "600519.SH", "confidence": 0.9},
                {"alias": "坏代码", "code": "not-a-code", "confidence": 1},
            ]
        }
    )
    assert aliases == [{"alias": "茅台", "code": "sh600519", "confidence": 0.9, "source": "ai"}]
    assert errors


def test_no_key_creates_explicit_fallback_version(tmp_path) -> None:
    config = Settings(database_path=tmp_path / "strategy.sqlite3", scheduler_enabled=False, openai_api_key="")
    db = Database(config.database_path)
    db.init()
    db.execute(
        "INSERT INTO posts(tid,pid,author_id,post_at,body,discovered_at) VALUES(?,?,?,?,?,?)",
        (47288722, "123", "150058", "2026-08-28 08:00", "指数先行，量价确认", "now"),
    )
    service = StrategyService(db, config)
    result = service.generate("2026-08-28")
    assert result["status"] == "needs_configuration"
    assert result["items"][0]["citations"][0]["post_pid"] == "123"
    version = service.list_versions("2026-08-28")[0]
    assert version["status"] == "needs_configuration"


def test_baseline_continues_previous_view_when_yesterday_is_empty(tmp_path) -> None:
    config = Settings(database_path=tmp_path / "continuation.sqlite3", scheduler_enabled=False, openai_api_key="")
    db = Database(config.database_path)
    db.init()
    db.execute(
        "INSERT INTO posts(tid,pid,author_id,post_at,body,discovered_at) VALUES(?,?,?,?,?,?)",
        (47288722, "456", "150058", "2026-08-27 15:00", "上一日观点", "now"),
    )
    service = StrategyService(db, config)
    first = service.generate("2026-08-28")
    second = service.generate("2026-08-29")
    assert first["status"] == "needs_configuration"
    assert second["status"] == "continued"
    assert second["items"][0]["continued_days"] == 1
    assert second["items"][0]["citations"][0]["post"]["pid"] == "456"


def test_baseline_uses_target_day_posts_instead_of_continuing(tmp_path) -> None:
    config = Settings(database_path=tmp_path / "target-day.sqlite3", scheduler_enabled=False, openai_api_key="")
    db = Database(config.database_path)
    db.init()
    db.execute(
        "INSERT INTO posts(tid,pid,author_id,post_at,body,discovered_at) VALUES(?,?,?,?,?,?)",
        (47288722, "789", "150058", "2026-08-28 09:00", "今天的新发言", "now"),
    )
    service = StrategyService(db, config)
    result = service.generate("2026-08-28")
    assert result["status"] == "needs_configuration"
    assert result["items"][0]["citations"][0]["post_pid"] == "789"


class FakeAIResponse:
    def raise_for_status(self) -> None:
        return None

    def json(self):
        return {"choices": [{"message": {"content": '{"items": []}'}}]}


class FakeAISession:
    def __init__(self):
        self.payload = None
        self.timeout = None

    def post(self, url, *, headers, json, timeout):
        self.payload = json
        self.timeout = timeout
        return FakeAIResponse()


def test_ai_request_includes_configured_reasoning_effort(tmp_path) -> None:
    config = Settings(
        database_path=tmp_path / "ai-request.sqlite3",
        scheduler_enabled=False,
        openai_api_key="test-key",
        openai_reasoning_effort="max",
        openai_request_timeout=1200,
    )
    db = Database(config.database_path)
    db.init()
    session = FakeAISession()
    service = StrategyService(db, config, session)
    service._call_ai("{}")
    assert session.payload["reasoning_effort"] == "max"
    assert session.timeout == 1200
