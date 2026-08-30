from __future__ import annotations

import json
import asyncio
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import httpx
from fastapi.testclient import TestClient

from app.agent_service import AgentService
from app.config import Settings
from app.db import Database
from app.main import create_app
from app.skills import create_skill_manager


def _terminal_events(run_id: str, *, terminal: bool = True) -> str:
    events = [
        {"type": "run_started", "runId": run_id, "sequence": 1, "eventId": f"{run_id}:1", "timestamp": 1},
        {
            "type": "tool_started",
            "runId": run_id,
            "sequence": 2,
            "eventId": f"{run_id}:2",
            "timestamp": 2,
            "toolCall": {"id": "quote-1", "name": "quant_api_get", "arguments": {"path": "/api/v1/quotes/realtime/sh600519"}},
        },
        {
            "type": "tool_completed",
            "runId": run_id,
            "sequence": 3,
            "eventId": f"{run_id}:3",
            "timestamp": 3,
            "toolCall": {"id": "quote-1", "name": "quant_api_get"},
            "result": {"ok": True, "data": {"symbol": "sh600519", "source": "fixture", "as_of": "2026-08-29", "content": "x" * 100_000}},
        },
    ]
    if terminal:
        events.append(
            {
                "type": "terminal_submitted",
                "runId": run_id,
                "sequence": 4,
                "eventId": f"{run_id}:4",
                "timestamp": 4,
                "submission": {
                    "status": "completed",
                    "answer": "A bounded answer containing sk-super-secret-value that must be redacted.",
                    "evidence": [{"toolCallId": "quote-1", "summary": "Fixture quote", "asOf": "2026-08-29"}],
                    "limitations": ["Fixture data only"],
                    "riskDisclaimer": "Not investment advice.",
                },
            }
        )
    sequence = 5 if terminal else 4
    events.append(
        {
            "type": "run_finished",
            "runId": run_id,
            "sequence": sequence,
            "eventId": f"{run_id}:{sequence}",
            "timestamp": sequence,
            "result": {"status": "completed", "turns": 1, "usage": {"outputTokens": 3}},
        }
    )
    return "".join(json.dumps(event) + "\n" for event in events)


def _wait_for_final(client: TestClient, run_id: str) -> dict:
    for _ in range(100):
        result = client.get(f"/api/v1/runs/{run_id}").json()
        if result["status"] not in {"pending", "running", "cancelling"}:
            return result
        time.sleep(0.01)
    raise AssertionError("run did not finish")


def _app(tmp_path, response_factory, received):
    db = Database(tmp_path / "agent.sqlite3")
    config = Settings(database_path=db.path, scheduler_enabled=False)

    async def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/healthz"):
            return httpx.Response(200, json={"status": "ok", "service": "test-sidecar"})
        if request.url.path.endswith("/cancel"):
            return httpx.Response(202, json={"status": "cancellation_requested"})
        received.append(json.loads(request.content))
        run_id = received[-1]["run_id"]
        return response_factory(run_id)

    manager = create_skill_manager(db, config)
    service = AgentService(db, config, manager, transport=httpx.MockTransport(handler))
    return create_app(db, config, skill_manager=manager, agent_service=service)


def test_agent_run_persists_public_projection_and_sse_resume(tmp_path) -> None:
    received: list[dict] = []
    app = _app(tmp_path, lambda run_id: httpx.Response(200, headers={"content-type": "application/x-ndjson"}, content=_terminal_events(run_id)), received)
    with TestClient(app) as client:
        created = client.post("/api/v1/runs", json={"question": "quote", "skill_mode": "none"})
        assert created.status_code == 202, created.text
        run_id = created.json()["id"]
        result = _wait_for_final(client, run_id)
        assert result["status"] == "completed"
        assert result["terminal_status"] == "completed"
        assert "sk-super-secret" not in json.dumps(result)
        assert received[0]["selected_skill"] == "none"
        assert all("content" not in skill for skill in received[0]["skills"])

        stream = client.get(f"/api/v1/runs/{run_id}/events")
        assert stream.status_code == 200
        assert stream.text.count("event: run_finished") == 1
        resumed = client.get(f"/api/v1/runs/{run_id}/events", headers={"Last-Event-ID": f"{run_id}:4"})
        assert resumed.text.count("event: run_finished") == 1
        assert "event: terminal_submitted" not in resumed.text
        stale = client.get(f"/api/v1/runs/{run_id}/events", headers={"Last-Event-ID": "another-run:4"})
        assert "event: run_started" in stale.text

        rows = client.get(f"/api/v1/runs/{run_id}").json()
        assert rows["evidence"]
        assert rows["artifacts"]
        stored = app.state.wolf.db.one("SELECT payload_json FROM agent_events WHERE run_id=?", (run_id,))
        assert stored is not None
        assert len(stored["payload_json"].encode()) < 64 * 1024


def test_agent_active_run_conflict_and_manual_skill_validation(tmp_path) -> None:
    received: list[dict] = []
    app = _app(tmp_path, lambda run_id: httpx.Response(200, headers={"content-type": "application/x-ndjson"}, content=_terminal_events(run_id)), received)
    with TestClient(app) as client:
        service: AgentService = app.state.wolf.agent
        held = service.create_run(question="held", skill_mode="none")
        conflict = client.post("/api/v1/runs", json={"question": "second", "skill_mode": "none"})
        assert conflict.status_code == 409
        service._fail_run(held["id"], "TEST_CLEANUP", "test cleanup")

        missing = client.post("/api/v1/runs", json={"question": "manual", "skill_mode": "manual", "skill_id": "missing"})
        assert missing.status_code in {400, 422}
        assert "SKILL" in json.dumps(missing.json()).upper()


def test_agent_stream_without_terminal_fails(tmp_path) -> None:
    received: list[dict] = []
    app = _app(tmp_path, lambda run_id: httpx.Response(200, headers={"content-type": "application/x-ndjson"}, content=_terminal_events(run_id, terminal=False)), received)
    with TestClient(app) as client:
        run_id = client.post("/api/v1/runs", json={"question": "no terminal", "skill_mode": "none"}).json()["id"]
        result = _wait_for_final(client, run_id)
        assert result["status"] == "failed"
        assert result["error"]["code"] == "SIDECAR_PROTOCOL_ERROR"


def test_agent_cancel_persists_cancelled_marker_after_stream(tmp_path) -> None:
    cancelled = asyncio.Event()
    received: list[dict] = []

    class SlowStream(httpx.AsyncByteStream):
        async def __aiter__(self):
            run_id = received[0]["run_id"]
            yield (json.dumps({"type": "run_started", "runId": run_id, "sequence": 1}) + "\n").encode()
            await cancelled.wait()
            yield (json.dumps({"type": "run_finished", "runId": run_id, "sequence": 2, "result": {"status": "cancelled"}}) + "\n").encode()

        async def aclose(self) -> None:
            return None

    db = Database(tmp_path / "cancel.sqlite3")
    config = Settings(database_path=db.path, scheduler_enabled=False)

    async def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/healthz"):
            return httpx.Response(200, json={"status": "ok", "service": "test-sidecar"})
        if request.url.path.endswith("/cancel"):
            cancelled.set()
            return httpx.Response(202, json={"status": "cancellation_requested"})
        received.append(json.loads(request.content))
        return httpx.Response(200, headers={"content-type": "application/x-ndjson"}, stream=SlowStream())

    manager = create_skill_manager(db, config)
    service = AgentService(db, config, manager, transport=httpx.MockTransport(handler))
    app = create_app(db, config, skill_manager=manager, agent_service=service)
    with TestClient(app) as client:
        run_id = client.post("/api/v1/runs", json={"question": "cancel", "skill_mode": "none"}).json()["id"]
        for _ in range(100):
            if client.get(f"/api/v1/runs/{run_id}").json()["status"] in {"running", "cancelling"}:
                break
            time.sleep(0.01)
        response = client.post(f"/api/v1/runs/{run_id}/cancel")
        assert response.status_code == 202
        result = _wait_for_final(client, run_id)
        assert result["status"] == "cancelled"
        assert [item["type"] for item in result["events"]][-1] == "run_cancelled"
        service._fail_run(run_id, "LATE_FAILURE", "late failure must not rewrite a terminal run")
        assert client.get(f"/api/v1/runs/{run_id}").json()["status"] == "cancelled"


def test_agent_needs_configuration_is_explicit_terminal_state(tmp_path) -> None:
    received: list[dict] = []

    def response(run_id: str) -> httpx.Response:
        rows = [
            {"type": "run_started", "runId": run_id, "sequence": 1},
            {"type": "run_failed", "runId": run_id, "sequence": 2, "error": {"code": "NEEDS_CONFIGURATION", "message": "provider unavailable"}},
            {"type": "run_finished", "runId": run_id, "sequence": 3, "result": {"status": "needs_configuration"}},
        ]
        return httpx.Response(200, headers={"content-type": "application/x-ndjson"}, content="".join(json.dumps(row) + "\n" for row in rows))

    app = _app(tmp_path, response, received)
    with TestClient(app) as client:
        run_id = client.post("/api/v1/runs", json={"question": "configure", "skill_mode": "none"}).json()["id"]
        result = _wait_for_final(client, run_id)
        assert result["status"] == "needs_configuration"
        assert result["error"]["code"] == "NEEDS_CONFIGURATION"


def test_sidecar_connection_refused_returns_503_without_pending_record(tmp_path) -> None:
    db = Database(tmp_path / "refused.sqlite3")
    config = Settings(database_path=db.path, scheduler_enabled=False)
    manager = create_skill_manager(db, config)

    async def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("connection refused", request=request)

    service = AgentService(db, config, manager, transport=httpx.MockTransport(handler))
    app = create_app(db, config, skill_manager=manager, agent_service=service)
    with TestClient(app) as client:
        response = client.post("/api/v1/runs", json={"question": "offline", "skill_mode": "none"})
        assert response.status_code == 503
        assert response.json()["detail"]["code"] == "SIDECAR_UNAVAILABLE"
        assert db.one("SELECT id FROM agent_runs WHERE status IN ('pending','running','cancelling')") is None
        assert db.one("SELECT COUNT(*) AS n FROM agent_runs")["n"] == 0


def test_local_sidecar_preflight_ignores_environment_proxy(tmp_path, monkeypatch) -> None:
    requests: list[str] = []

    class SidecarHandler(BaseHTTPRequestHandler):
        def do_GET(self) -> None:  # noqa: N802 - stdlib handler API
            requests.append(self.path)
            if self.path != "/healthz":
                self.send_error(404)
                return
            body = b'{"status":"ok","service":"test-sidecar"}'
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, _format: str, *_args: object) -> None:
            return None

    server = ThreadingHTTPServer(("127.0.0.1", 0), SidecarHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        proxy = "http://127.0.0.1:1"
        monkeypatch.setenv("HTTP_PROXY", proxy)
        monkeypatch.setenv("HTTPS_PROXY", proxy)
        monkeypatch.setenv("ALL_PROXY", proxy)
        monkeypatch.setenv("NO_PROXY", "")
        db = Database(tmp_path / "proxy.sqlite3")
        config = Settings(
            database_path=db.path,
            scheduler_enabled=False,
            sidecar_url=f"http://127.0.0.1:{server.server_port}",
        )
        service = AgentService(db, config)
        asyncio.run(service.preflight_sidecar())
        assert requests == ["/healthz"]
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)


def test_sidecar_health_5xx_returns_503_without_pending_record(tmp_path) -> None:
    db = Database(tmp_path / "health-5xx.sqlite3")
    config = Settings(database_path=db.path, scheduler_enabled=False)
    manager = create_skill_manager(db, config)

    async def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/healthz"):
            return httpx.Response(503, json={"status": "down"})
        raise AssertionError("run endpoint must not be called after a failed health check")

    service = AgentService(db, config, manager, transport=httpx.MockTransport(handler))
    app = create_app(db, config, skill_manager=manager, agent_service=service)
    with TestClient(app) as client:
        response = client.post("/api/v1/runs", json={"question": "offline", "skill_mode": "none"})
        assert response.status_code == 503
        assert response.json()["detail"]["code"] == "SIDECAR_UNAVAILABLE"
        assert db.one("SELECT id FROM agent_runs WHERE status IN ('pending','running','cancelling')") is None


def test_invalid_sidecar_url_is_rejected_without_pending_record(tmp_path) -> None:
    db = Database(tmp_path / "invalid-url.sqlite3")
    config = Settings(database_path=db.path, scheduler_enabled=False, sidecar_url="http://example.com")
    manager = create_skill_manager(db, config)

    async def handler(request: httpx.Request) -> httpx.Response:
        raise AssertionError("invalid local URL must be rejected before any network request")

    service = AgentService(db, config, manager, transport=httpx.MockTransport(handler))
    app = create_app(db, config, skill_manager=manager, agent_service=service)
    with TestClient(app) as client:
        response = client.post("/api/v1/runs", json={"question": "invalid URL", "skill_mode": "none"})
        assert response.status_code == 500
        assert response.json()["detail"]["code"] == "SIDECAR_URL_INVALID"
        assert db.one("SELECT id FROM agent_runs WHERE status IN ('pending','running','cancelling')") is None


def test_active_run_conflict_is_reported_before_sidecar_preflight(tmp_path) -> None:
    db = Database(tmp_path / "active-preflight.sqlite3")
    config = Settings(database_path=db.path, scheduler_enabled=False)
    manager = create_skill_manager(db, config)
    health_calls = 0

    async def handler(request: httpx.Request) -> httpx.Response:
        nonlocal health_calls
        if request.url.path.endswith("/healthz"):
            health_calls += 1
            return httpx.Response(503, json={"status": "down"})
        raise AssertionError("sidecar run endpoint must not be reached")

    service = AgentService(db, config, manager, transport=httpx.MockTransport(handler))
    app = create_app(db, config, skill_manager=manager, agent_service=service)
    with TestClient(app) as client:
        held = service.create_run(question="held", skill_mode="none")
        response = client.post("/api/v1/runs", json={"question": "second", "skill_mode": "none"})
        assert response.status_code == 409
        assert response.json()["detail"]["code"] == "RUN_ACTIVE"
        assert health_calls == 0
        service._fail_run(held["id"], "TEST_CLEANUP", "test cleanup")


def test_frontend_page_routes_use_named_entrypoints_and_explicit_fallback(tmp_path) -> None:
    dashboard_root = tmp_path / "dashboard"
    config = Settings(
        repo_root=tmp_path,
        dashboard_root=dashboard_root,
        database_path=tmp_path / "pages.sqlite3",
        scheduler_enabled=False,
    )
    app = create_app(Database(config.database_path), config)
    with TestClient(app) as client:
        for path, page in (("/", "/"), ("/skills", "/skills"), ("/monitor", "/monitor")):
            response = client.get(path)
            assert response.status_code == 200
            assert response.json()["page"] == page
            assert "fallback" in response.json()


def test_frontend_page_routes_serve_named_files_and_static_assets(tmp_path) -> None:
    frontend_root = tmp_path / "dashboard" / "frontend"
    frontend_root.mkdir(parents=True)
    (frontend_root / "agent.html").write_text("agent entry", encoding="utf-8")
    (frontend_root / "skills.html").write_text("skills entry", encoding="utf-8")
    (frontend_root / "index.html").write_text("monitor entry", encoding="utf-8")
    (frontend_root / "probe.js").write_text("window.probe = true;", encoding="utf-8")
    (frontend_root / "favicon.svg").write_text("<svg xmlns=\"http://www.w3.org/2000/svg\"></svg>", encoding="utf-8")
    config = Settings(
        repo_root=tmp_path,
        dashboard_root=tmp_path / "dashboard",
        database_path=tmp_path / "pages-with-files.sqlite3",
        scheduler_enabled=False,
    )
    app = create_app(Database(config.database_path), config)
    with TestClient(app) as client:
        assert client.get("/").text == "agent entry"
        assert client.get("/skills").text == "skills entry"
        assert client.get("/monitor").text == "monitor entry"
        assert client.get("/static/probe.js").text == "window.probe = true;"
        favicon = client.get("/favicon.ico")
        assert favicon.status_code == 200
        assert favicon.headers["content-type"].startswith("image/svg+xml")
        assert favicon.text == "<svg xmlns=\"http://www.w3.org/2000/svg\"></svg>"


def test_sidecar_stream_5xx_becomes_failed_run_and_releases_active_slot(tmp_path) -> None:
    received: list[dict] = []
    app = _app(
        tmp_path,
        lambda run_id: httpx.Response(500, json={"error": "sidecar crashed"}),
        received,
    )
    with TestClient(app) as client:
        created = client.post("/api/v1/runs", json={"question": "stream failure", "skill_mode": "none"})
        assert created.status_code == 202, created.text
        result = _wait_for_final(client, created.json()["id"])
        assert result["status"] == "failed"
        assert result["error"]["code"] == "SIDECAR_UNAVAILABLE"
        db_active = app.state.wolf.db.one(
            "SELECT id FROM agent_runs WHERE status IN ('pending','running','cancelling')"
        )
        assert db_active is None


def test_sidecar_run_failed_event_projects_error_and_releases_active_slot(tmp_path) -> None:
    received: list[dict] = []

    def response(run_id: str) -> httpx.Response:
        rows = [
            {"type": "run_started", "runId": run_id, "sequence": 1},
            {
                "type": "run_failed",
                "runId": run_id,
                "sequence": 2,
                "error": {"code": "PROVIDER_ERROR", "message": "provider failed"},
            },
            {
                "type": "run_finished",
                "runId": run_id,
                "sequence": 3,
                "result": {"status": "failed", "error": {"code": "PROVIDER_ERROR", "message": "provider failed"}},
            },
        ]
        return httpx.Response(
            200,
            headers={"content-type": "application/x-ndjson"},
            content="".join(json.dumps(row) + "\n" for row in rows),
        )

    app = _app(tmp_path, response, received)
    with TestClient(app) as client:
        created = client.post("/api/v1/runs", json={"question": "provider failure", "skill_mode": "none"})
        result = _wait_for_final(client, created.json()["id"])
        assert result["status"] == "failed"
        assert result["error"] == {"code": "PROVIDER_ERROR", "message": "provider failed"}
        assert [event["type"] for event in result["events"]][:2] == ["run_started", "run_failed"]
        stream = client.get(f"/api/v1/runs/{created.json()['id']}/events")
        assert "event: run_failed" in stream.text
        assert "event: run_finished" in stream.text


def test_successful_tool_summary_is_redacted_in_evidence_projection(tmp_path) -> None:
    received: list[dict] = []

    def response(run_id: str) -> httpx.Response:
        rows = [
            {"type": "run_started", "runId": run_id, "sequence": 1},
            {
                "type": "tool_completed",
                "runId": run_id,
                "sequence": 2,
                "toolCall": {"id": "q", "name": "quant_api_get"},
                "result": {
                    "ok": True,
                    "data": {
                        "symbol": "sh600519",
                        "summary": "token sk-summary-secret-value",
                        "source": "fixture",
                    },
                },
            },
            {
                "type": "terminal_submitted",
                "runId": run_id,
                "sequence": 3,
                "submission": {
                    "status": "completed",
                    "answer": "answer",
                    "evidence": [{"toolCallId": "q", "summary": "summary"}],
                    "limitations": ["fixture"],
                    "riskDisclaimer": "risk",
                },
            },
            {
                "type": "run_finished",
                "runId": run_id,
                "sequence": 4,
                "result": {"status": "completed"},
            },
        ]
        return httpx.Response(
            200,
            headers={"content-type": "application/x-ndjson"},
            content="".join(json.dumps(row) + "\n" for row in rows),
        )

    app = _app(tmp_path, response, received)
    with TestClient(app) as client:
        run_id = client.post("/api/v1/runs", json={"question": "redact", "skill_mode": "none"}).json()["id"]
        result = _wait_for_final(client, run_id)
        assert result["status"] == "completed"
        assert "sk-summary-secret" not in json.dumps(result)
        evidence = app.state.wolf.agent.list_evidence(run_id)
        assert evidence[0]["summary"] == "token [redacted]"
