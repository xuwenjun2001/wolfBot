import json
from contextlib import contextmanager
from datetime import datetime, timedelta
from unittest.mock import Mock

import pytest
import respx

from quantpilot_market_data.database_core import SHANGHAI_TZ
from quantpilot_market_data.services import tactic_reports as reports
from quantpilot_market_data.services import tactic_reviews as service


class Clock(datetime):
    @classmethod
    def now(cls, tz=None):
        return cls(2026, 9, 10, 19, 0, tzinfo=SHANGHAI_TZ)


def payload():
    return dict(
        snapshot={"current": [{"event_id": "e"}], "statistics": {}},
        knowledge=[],
        prompt={"content": "中文分析"},
        system_prompt="frozen-system",
    )


def content():
    return dict(
        summary="研究摘要",
        sections=[
            dict(
                title="分析", content="研究观点", event_ids=["e"], citations=[], rule_tags=["trend"]
            )
        ],
    )


def test_real_wire_contract_and_reasoning_never_persisted(monkeypatch):
    monkeypatch.setattr(reports, "credential", lambda: "test-secret")
    publish = Mock(return_value="report")
    monkeypatch.setattr(reports.repo, "publish_report", publish)
    chunks = [
        dict(
            model="deepseek-flash", choices=[{"delta": {"reasoning_content": "private-reasoning"}}]
        ),
        dict(
            choices=[
                {
                    "delta": {"content": json.dumps(content(), ensure_ascii=False)},
                    "finish_reason": "stop",
                }
            ]
        ),
        dict(usage={"total_tokens": 7}, choices=[]),
    ]
    stream = (
        "\n\n".join("data: " + json.dumps(c, ensure_ascii=False) for c in chunks)
        + "\n\ndata: [DONE]\n\n"
    )
    with respx.mock() as mock:
        route = mock.post("https://api.deepseek.com/chat/completions").respond(200, text=stream)
        assert reports.generate({"id": "job", "input": payload()}, "owner") == "report"
        sent = json.loads(route.calls[0].request.content)
        assert sent["model"] == "deepseek-flash"
        assert sent["reasoning_effort"] == "max" and sent["thinking"]["type"] == "enabled"
        assert sent["messages"][0]["content"] == "frozen-system"
        assert "tools" not in sent
        assert route.calls[0].request.headers["authorization"] == "Bearer test-secret"
    assert "private-reasoning" not in str(publish.call_args)
    assert "test-secret" not in str(publish.call_args)


def test_invalid_provider_output_does_not_publish(monkeypatch):
    monkeypatch.setattr(reports, "credential", lambda: "test-secret")
    publish = Mock()
    monkeypatch.setattr(reports.repo, "publish_report", publish)
    with respx.mock() as mock:
        mock.post("https://api.deepseek.com/chat/completions").respond(
            200, text="data: {}\n\ndata: [DONE]\n\n"
        )
        with pytest.raises(ValueError):
            reports.generate({"id": "job", "input": payload()}, "owner")
    publish.assert_not_called()


@pytest.mark.parametrize(
    ("message", "attempt", "retry"),
    [
        ("DeepSeek HTTP 429", 1, True),
        ("DeepSeek HTTP 429", 3, False),
        ("DeepSeek HTTP 401", 1, False),
        ("日报包含无效的事件、引用或规则标签", 1, False),
    ],
)
def test_generation_retry_policy_preserves_statistics(monkeypatch, message, attempt, retry):
    monkeypatch.setattr(service.tactic_reports, "generate", Mock(side_effect=ValueError(message)))
    finish = Mock()
    monkeypatch.setattr(service.repo, "finish", finish)
    save = Mock()
    monkeypatch.setattr(service.repo, "save_performances", save)
    service.execute(
        {"id": "job", "kind": "report", "trade_date": "2026-09-10", "attempts": attempt},
        "owner",
        Mock(),
    )
    assert finish.call_args.kwargs["retry"] == retry
    save.assert_not_called()


@pytest.mark.parametrize(
    ("scan", "last", "active", "want_scan", "want_review"),
    [
        (None, None, None, True, False),
        (None, None, {"id": "active"}, False, False),
        ({"completed_at": Clock.now()}, None, None, False, True),
        (
            {"completed_at": Clock.now()},
            {"status": "completed", "updated_at": Clock.now() + timedelta(seconds=1)},
            None,
            False,
            False,
        ),
        (
            {"completed_at": Clock.now()},
            {"status": "waiting", "updated_at": Clock.now() - timedelta(seconds=1)},
            None,
            False,
            False,
        ),
    ],
)
def test_schedule_chains_only_completed_scans_and_deduplicates(
    monkeypatch, scan, last, active, want_scan, want_review
):
    monkeypatch.setattr(service, "datetime", Clock)
    monkeypatch.setattr(service, "closed_day", lambda: "2026-09-10")
    monkeypatch.setattr(service.repo, "settings", lambda: dict(enabled=True, start_time="18:00"))
    connection = Mock()
    connection.execute.return_value.fetchone.side_effect = [scan, last, active, None]

    @contextmanager
    def connect():
        yield connection

    monkeypatch.setattr(service.base, "connection", connect)
    start_scan, start_review = Mock(), Mock()
    monkeypatch.setattr(service.base, "enqueue", start_scan)
    monkeypatch.setattr(service.repo, "enqueue", start_review)
    service.schedule()
    assert start_scan.called == want_scan
    assert start_review.called == want_review


def test_disabled_schedule_never_enqueues(monkeypatch):
    monkeypatch.setattr(service.repo, "settings", lambda: dict(enabled=False, start_time="18:00"))
    start_scan = Mock()
    monkeypatch.setattr(service.base, "enqueue", start_scan)
    service.schedule()
    start_scan.assert_not_called()
