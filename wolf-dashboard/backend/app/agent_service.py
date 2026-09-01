"""Durable FastAPI-side orchestration for the local Agent sidecar.

The TypeScript sidecar owns model execution.  This module owns the browser
contract, SQLite writes, validation, and the single active-run invariant.  It
intentionally stores only a bounded public projection of sidecar events.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import re
import threading
import uuid
from collections.abc import AsyncIterator, Callable, Mapping
from datetime import datetime, timezone
from typing import Any
from urllib.parse import urljoin, urlparse

import httpx

from .config import Settings
from .db import Database
from .skills import SkillError, SkillManager


ACTIVE_STATUSES = {"pending", "running", "cancelling"}
FINAL_STATUSES = {"completed", "insufficient_evidence", "needs_configuration", "cancelled", "timeout", "failed"}
VALID_SUBMISSION_STATUSES = {"completed", "insufficient_evidence"}
MAX_EVENT_BYTES = 64 * 1024
MAX_EVENT_LINE_BYTES = 1 * 1024 * 1024
MAX_ANSWER_BYTES = 256 * 1024
MAX_QUESTION_BYTES = 32 * 1024
MAX_STRING_CHARS = 2_048
MAX_COLLECTION_ITEMS = 64

# Artifact projection for successful sidecar tool calls. ``quant_api_get`` is the
# retired generic market tool: new runs never emit it, historical runs still read.
_ARTIFACT_TYPES = {
    "quant_api_get": "market_evidence",
    "resolve_symbol": "market_evidence",
    "get_realtime_quote": "market_evidence",
    "get_price_history": "market_evidence",
    "get_technical_indicators": "market_evidence",
    "get_universe_summary": "market_evidence",
    "get_universe_members": "market_evidence",
    "get_preset_candidates": "candidate_table",
    "screen_stocks": "candidate_table",
    "get_market_session_context": "market_context",
    "resolve_board": "board_evidence",
    "get_board_snapshot": "board_evidence",
    "get_board_breadth": "board_evidence",
    "get_board_members": "board_members",
}

# Keys projected out of a successful tool result into events, evidence, and
# artifacts.  Board answers are unusable without their identity, basis,
# observation point, breadth, and coverage, so those travel with the quote.
_PUBLIC_DATA_KEYS = (
    "symbol",
    "code",
    "name",
    "asset_type",
    "exchange",
    "source",
    "as_of",
    "fetched_at",
    "adjustment",
    "data_quality",
    "coverage",
    "candidate_count",
    "universe_id",
    "board_id",
    "board_type",
    "provider",
    "constituent_basis",
    "change_pct",
    "trade_date",
    "snapshot_at",
    "market_phase",
    "market_context",
    "timezone",
    "phase",
    "observed_at",
    "calendar_date",
    "requested_date",
    "effective_trade_date",
    "latest_completed_trade_date",
    "next_trade_date",
    "fallback_reason",
    "is_trading_day",
    "intraday",
    "calendar_basis",
    "breadth",
    "insufficient_coverage",
    "leaders",
    "laggards",
    "member_count",
    "membership_as_of",
    "status",
    "match_basis",
    "warnings",
    "limitations",
    "data_basis",
)

_SECRET_KEY = re.compile(
    r"(?:token|secret|password|authorization|cookie|api[_-]?key|credential|private[_-]?key|access[_-]?key)",
    re.IGNORECASE,
)
_DROP_KEY = re.compile(r"(?:reasoning|chain[_-]?of[_-]?thought|system[_-]?prompt|environment|env(?:ironment)?[_-]?vars?)", re.IGNORECASE)


class AgentError(Exception):
    """Base class for errors that can be represented in a run record."""

    code = "AGENT_ERROR"
    status_code = 500

    def __init__(self, message: str, *, code: str | None = None, status_code: int | None = None) -> None:
        super().__init__(message)
        if code is not None:
            self.code = code
        if status_code is not None:
            self.status_code = status_code


class ActiveRunError(AgentError):
    code = "RUN_ACTIVE"
    status_code = 409


class RunNotFoundError(AgentError):
    code = "RUN_NOT_FOUND"
    status_code = 404


class SkillSelectionError(AgentError):
    code = "SKILL_NOT_AVAILABLE"
    status_code = 400


class SidecarUnavailableError(AgentError):
    code = "SIDECAR_UNAVAILABLE"
    status_code = 503


class SidecarProtocolError(AgentError):
    code = "SIDECAR_PROTOCOL_ERROR"
    status_code = 502


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _json_size(value: Any) -> int:
    return len(json.dumps(value, ensure_ascii=False, separators=(",", ":"), default=str).encode("utf-8"))


def _sha256_json(value: Any) -> str:
    return hashlib.sha256(
        json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), default=str).encode("utf-8")
    ).hexdigest()


def _public_value(value: Any, *, depth: int = 0) -> Any:
    """Project arbitrary sidecar data to a small, credential-free JSON value."""

    if depth > 5:
        return "[redacted]"
    if isinstance(value, str):
        # The sidecar already redacts these values, but the FastAPI boundary
        # is a second independent defense in case another implementation is
        # used in tests or in a future sidecar.
        value = re.sub(r"Bearer\s+[A-Za-z0-9._~+/=-]+", "Bearer [redacted]", value, flags=re.IGNORECASE)
        value = re.sub(r"\bsk-[A-Za-z0-9_-]{8,}\b", "[redacted]", value)
        if len(value) > MAX_STRING_CHARS:
            return value[: MAX_STRING_CHARS - 3] + "..."
        return value
    if value is None or isinstance(value, (bool, int, float)):
        return value
    if isinstance(value, (bytes, bytearray, memoryview)):
        return "[binary redacted]"
    if isinstance(value, Mapping):
        result: dict[str, Any] = {}
        for key, item in list(value.items())[:MAX_COLLECTION_ITEMS]:
            name = str(key)
            if _SECRET_KEY.search(name) or _DROP_KEY.search(name):
                result[name] = "[redacted]"
            else:
                result[name] = _public_value(item, depth=depth + 1)
        return result
    if isinstance(value, (list, tuple, set)):
        return [_public_value(item, depth=depth + 1) for item in list(value)[:MAX_COLLECTION_ITEMS]]
    return "[redacted]"


def _bounded_public(value: Any, limit: int = MAX_EVENT_BYTES) -> dict[str, Any]:
    projected = _public_value(value)
    if not isinstance(projected, dict):
        projected = {"value": projected}
    if _json_size(projected) <= limit:
        return projected
    # Keep the event useful without retaining an unbounded tool response.
    return {"truncated": True, "sha256": _sha256_json(projected), "bytes": _json_size(projected)}


def _text(value: Any, default: str = "") -> str:
    return value if isinstance(value, str) else default


def _int(value: Any, default: int = 0) -> int:
    return value if isinstance(value, int) and not isinstance(value, bool) else default


def _redact_text(value: str) -> str:
    value = re.sub(r"Bearer\s+[A-Za-z0-9._~+/=-]+", "Bearer [redacted]", value, flags=re.IGNORECASE)
    return re.sub(r"\bsk-[A-Za-z0-9_-]{8,}\b", "[redacted]", value)


def _submission(value: Any) -> dict[str, Any]:
    """Validate and normalize the only accepted terminal submission."""

    if not isinstance(value, Mapping):
        raise SidecarProtocolError("terminal submission must be an object")
    status = value.get("status")
    if status not in VALID_SUBMISSION_STATUSES:
        raise SidecarProtocolError("terminal submission has an invalid status")
    answer = value.get("answer")
    if not isinstance(answer, str) or not answer.strip():
        raise SidecarProtocolError("terminal submission answer is required")
    if len(answer.encode("utf-8")) > MAX_ANSWER_BYTES:
        raise SidecarProtocolError("terminal submission answer exceeded the size limit")
    evidence_raw = value.get("evidence")
    if not isinstance(evidence_raw, list) or len(evidence_raw) > MAX_COLLECTION_ITEMS:
        raise SidecarProtocolError("terminal submission evidence is invalid")
    evidence: list[dict[str, Any]] = []
    for item in evidence_raw:
        if not isinstance(item, Mapping):
            raise SidecarProtocolError("terminal submission evidence item is invalid")
        call_id = item.get("toolCallId", item.get("tool_call_id"))
        summary = item.get("summary")
        if not isinstance(call_id, str) or not call_id.strip() or not isinstance(summary, str) or not summary.strip():
            raise SidecarProtocolError("terminal submission evidence item is invalid")
        entry: dict[str, Any] = {"toolCallId": call_id[:256], "summary": _redact_text(summary)[:2_000]}
        as_of = item.get("asOf", item.get("as_of"))
        source = item.get("source")
        if as_of is not None:
            if not isinstance(as_of, str) or len(as_of) > 64:
                raise SidecarProtocolError("terminal submission evidence as_of is invalid")
            entry["asOf"] = _redact_text(as_of)
        if source is not None:
            if not isinstance(source, str) or len(source) > 256:
                raise SidecarProtocolError("terminal submission evidence source is invalid")
            entry["source"] = _redact_text(source)
        evidence.append(entry)
    if status == "completed" and not evidence:
        raise SidecarProtocolError("completed terminal submissions require evidence")
    limitations = value.get("limitations")
    if not isinstance(limitations, list) or not limitations or len(limitations) > 32:
        raise SidecarProtocolError("terminal submission limitations are required")
    if any(not isinstance(item, str) or not item.strip() or len(item) > 2_000 for item in limitations):
        raise SidecarProtocolError("terminal submission limitations are invalid")
    risk = value.get("riskDisclaimer", value.get("risk_disclaimer"))
    if not isinstance(risk, str) or not risk.strip() or len(risk) > 2_000:
        raise SidecarProtocolError("terminal submission risk disclaimer is required")
    data_as_of = value.get("dataAsOf", value.get("data_as_of"))
    if data_as_of is not None and (not isinstance(data_as_of, str) or len(data_as_of) > 64):
        raise SidecarProtocolError("terminal submission data_as_of is invalid")
    return {
        "status": status,
        "answer": _redact_text(answer),
        "evidence": evidence,
        **({"dataAsOf": _redact_text(data_as_of)} if data_as_of is not None else {}),
        "limitations": [_redact_text(item)[:2_000] for item in limitations],
        "riskDisclaimer": _redact_text(risk),
    }


def _error_payload(code: str, message: str, *, http_status: int | None = None) -> dict[str, Any]:
    result: dict[str, Any] = {"code": code, "message": message[:2_000]}
    if http_status is not None:
        result["http_status"] = http_status
    return result


def _sidecar_error(value: Any, *, default_code: str = "RUN_FAILED", default_message: str = "Sidecar run failed.") -> dict[str, Any]:
    if isinstance(value, Mapping):
        code = _redact_text(_text(value.get("code"), default_code))[:128] or default_code
        message = _redact_text(_text(value.get("message"), default_message))[:2_000] or default_message
        return _error_payload(code, message)
    return _error_payload(default_code, default_message)


class AgentService:
    """Own agent run state and bridge one run to the local sidecar."""

    def __init__(
        self,
        db: Database,
        config: Settings,
        skills: SkillManager | None = None,
        *,
        client_factory: Callable[[], httpx.AsyncClient] | None = None,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        self.db = db
        self.config = config
        self.skills = skills
        self._lock = threading.RLock()
        self._tasks: dict[str, asyncio.Task[Any]] = {}
        self._client_factory = client_factory
        self._transport = transport
        self._active_run_id: str | None = None

    @property
    def sidecar_url(self) -> str:
        raw = str(getattr(self.config, "sidecar_url", "http://127.0.0.1:8790")).strip()
        try:
            parsed = urlparse(raw)
            hostname = parsed.hostname
            # Accessing ``port`` forces urlparse to validate malformed ports
            # such as ``:not-a-port``.  The value is otherwise unused.
            _ = parsed.port
        except ValueError as exc:
            raise SidecarUnavailableError(
                "sidecar_url must be a valid local HTTP URL",
                code="SIDECAR_URL_INVALID",
                status_code=500,
            ) from exc
        if (
            parsed.scheme not in {"http", "https"}
            or hostname not in {"127.0.0.1", "localhost", "::1"}
            or parsed.username is not None
            or parsed.password is not None
            or parsed.query
            or parsed.fragment
        ):
            raise SidecarUnavailableError(
                "sidecar_url must point to a local HTTP service",
                code="SIDECAR_URL_INVALID",
                status_code=500,
            )
        return raw.rstrip("/") + "/"

    def _new_client(self) -> tuple[httpx.AsyncClient, bool]:
        if self._client_factory is not None:
            client = self._client_factory()
            return client, True
        return (
            httpx.AsyncClient(
                transport=self._transport,
                trust_env=False,
                follow_redirects=False,
                headers={"Accept": "application/x-ndjson, application/json", "Content-Type": "application/json"},
            ),
            True,
        )

    def _skill_payload(self, skill_mode: str, skill_id: str | None) -> tuple[list[dict[str, Any]], str | None, str]:
        if skill_mode == "none":
            return [], "none", ""
        summaries: list[dict[str, Any]] = []
        if self.skills is not None:
            try:
                summaries = self.skills.enabled_summaries()
            except SkillError as exc:
                raise SkillSelectionError(str(exc), code="SKILL_METADATA_UNAVAILABLE") from exc
        # Explicitly construct the short descriptor instead of forwarding a
        # complete database record (which could contain local paths or data).
        descriptors = [
            {
                key: summary[key]
                for key in ("id", "name", "version", "description", "scope", "applicable_scope", "source", "content_sha256")
                if key in summary
            }
            for summary in summaries
        ]
        if skill_mode == "manual":
            assert skill_id is not None
            selected = next((item for item in descriptors if item.get("id") == skill_id), None)
            if selected is None:
                raise SkillSelectionError(
                    f"enabled skill not found: {skill_id}",
                    code="SKILL_NOT_AVAILABLE",
                    status_code=400,
                )
            return [selected], skill_id, skill_id
        return descriptors, None, ""

    def _active_from_db(self) -> dict[str, Any] | None:
        row = self.db.one(
            "SELECT * FROM agent_runs WHERE status IN ('pending','running','cancelling') ORDER BY created_at LIMIT 1"
        )
        return dict(row) if row else None

    def create_run(self, *, question: str, skill_mode: str = "auto", skill_id: str | None = None) -> dict[str, Any]:
        if not isinstance(question, str) or not question.strip() or len(question.encode("utf-8")) > MAX_QUESTION_BYTES:
            raise AgentError("question is required and bounded", code="INVALID_REQUEST", status_code=422)
        if skill_mode not in {"auto", "manual", "none"}:
            raise AgentError("skill_mode must be auto, manual, or none", code="INVALID_SKILL_MODE", status_code=422)
        if skill_mode == "manual" and (not isinstance(skill_id, str) or not skill_id.strip()):
            raise SkillSelectionError("manual skill_mode requires skill_id", code="SKILL_REQUIRED", status_code=422)
        if skill_mode != "manual" and skill_id not in {None, "", "none"}:
            raise AgentError("skill_id is only valid with manual skill_mode", code="INVALID_REQUEST", status_code=422)
        skills, selected, actual = self._skill_payload(skill_mode, skill_id.strip() if isinstance(skill_id, str) else None)
        now = utc_now()
        run_id = uuid.uuid4().hex
        with self._lock:
            # Keep the active check and insert in one SQLite write transaction
            # so two FastAPI workers cannot both pass the MVP's one-run gate.
            with self.db.transaction() as conn:
                conn.execute("BEGIN IMMEDIATE")
                active = conn.execute(
                    "SELECT id FROM agent_runs WHERE status IN ('pending','running','cancelling') ORDER BY created_at LIMIT 1"
                ).fetchone()
                if active is not None:
                    raise ActiveRunError(
                        f"run {active['id']} is already active",
                        code="RUN_ACTIVE",
                        status_code=409,
                    )
                conn.execute(
                    """INSERT INTO agent_runs(
                        id,question,skill_mode,selected_skill,model,status,budget_tokens,
                        terminal_status,answer_json,error,created_at,updated_at
                    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)""",
                    (
                        run_id,
                        _redact_text(question),
                        skill_mode,
                        actual,
                        str(getattr(self.config, "openai_model", "")),
                        "pending",
                        int(getattr(self.config, "agent_max_output_tokens", 12_000)),
                        "",
                        "{}",
                        "",
                        now,
                        now,
                    ),
                )
            self._active_run_id = run_id
        return self.get_run(run_id) | {"_sidecar": self._sidecar_payload(run_id, question, skills, selected)}

    async def preflight_sidecar(self) -> None:
        """Confirm that the local sidecar is reachable before launching a run.

        The health endpoint deliberately reports provider configuration as
        data, rather than as an HTTP failure.  A missing provider credential
        therefore remains a normal ``needs_configuration`` run outcome.
        """

        client, close = self._new_client()
        try:
            timeout_value = float(getattr(self.config, "agent_timeout_seconds", 300.0))
            timeout = httpx.Timeout(max(0.1, min(timeout_value, 10.0)))
            try:
                response = await client.get(urljoin(self.sidecar_url, "healthz"), timeout=timeout)
            except (httpx.HTTPError, OSError) as exc:
                raise SidecarUnavailableError(
                    "sidecar health check failed",
                    code="SIDECAR_UNAVAILABLE",
                    status_code=503,
                ) from exc
            if 500 <= response.status_code < 600:
                raise SidecarUnavailableError(
                    f"sidecar health check returned HTTP {response.status_code}",
                    code="SIDECAR_UNAVAILABLE",
                    status_code=503,
                )
            if response.status_code != 200:
                raise SidecarProtocolError(
                    f"sidecar health check returned HTTP {response.status_code}",
                    code="SIDECAR_HEALTH_HTTP_ERROR",
                    status_code=502,
                )
            try:
                health = response.json()
            except (TypeError, ValueError) as exc:
                raise SidecarProtocolError(
                    "sidecar health check returned invalid JSON",
                    code="SIDECAR_HEALTH_INVALID",
                    status_code=502,
                ) from exc
            if not isinstance(health, Mapping) or health.get("status") != "ok":
                raise SidecarProtocolError(
                    "sidecar health check returned an invalid status",
                    code="SIDECAR_HEALTH_INVALID",
                    status_code=502,
                )
        finally:
            if close:
                await client.aclose()

    def discard_pending_run(self, run_id: str) -> bool:
        """Remove a reservation that failed before sidecar execution began."""

        removed = False
        with self._lock:
            with self.db.transaction() as conn:
                cursor = conn.execute(
                    "DELETE FROM agent_runs WHERE id=? AND status='pending'",
                    (run_id,),
                )
                removed = cursor.rowcount == 1
            if removed and self._active_run_id == run_id:
                self._active_run_id = None
        return removed

    def _sidecar_payload(
        self,
        run_id: str,
        question: str,
        skills: list[dict[str, Any]],
        selected: str | None,
    ) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "run_id": run_id,
            "question": question,
            "skills": skills,
            "max_turns": int(getattr(self.config, "agent_max_turns", 8)),
            "max_total_tool_calls": int(getattr(self.config, "agent_max_total_tool_calls", 20)),
            "max_market_requests": int(getattr(self.config, "agent_max_market_requests", 16)),
            "max_output_tokens": int(getattr(self.config, "agent_max_output_tokens", 12_000)),
            "timeout_ms": int(float(getattr(self.config, "agent_timeout_seconds", 300.0)) * 1000),
        }
        if selected is not None:
            payload["selected_skill"] = selected
        return payload

    def pop_sidecar_payload(self, record: dict[str, Any]) -> dict[str, Any]:
        return dict(record.pop("_sidecar", {}))

    def get_run(self, run_id: str, *, include_children: bool = True) -> dict[str, Any]:
        row = self.db.one("SELECT * FROM agent_runs WHERE id=?", (run_id,))
        if row is None:
            raise RunNotFoundError(f"run not found: {run_id}")
        result = dict(row)
        try:
            result["answer"] = json.loads(result.pop("answer_json") or "{}")
        except (TypeError, json.JSONDecodeError):
            result["answer"] = {}
            result.pop("answer_json", None)
        try:
            result["error"] = json.loads(result.get("error") or "{}")
        except (TypeError, json.JSONDecodeError):
            result["error"] = {}
        result["run_id"] = result["id"]
        if include_children:
            result["events"] = self.list_events(run_id)
            result["evidence"] = self.list_evidence(run_id)
            result["artifacts"] = self.list_artifacts(run_id)
        return result

    def list_runs(self, *, limit: int = 20) -> list[dict[str, Any]]:
        rows = self.db.query(
            "SELECT * FROM agent_runs ORDER BY created_at DESC LIMIT ?",
            (min(max(int(limit), 1), 100),),
        )
        result: list[dict[str, Any]] = []
        for row in rows:
            item = dict(row)
            try:
                item["answer"] = json.loads(item.pop("answer_json") or "{}")
            except (TypeError, json.JSONDecodeError):
                item["answer"] = {}
                item.pop("answer_json", None)
            try:
                item["error"] = json.loads(item.get("error") or "{}")
            except (TypeError, json.JSONDecodeError):
                item["error"] = {}
            item["run_id"] = item["id"]
            result.append(item)
        return result

    def list_events(self, run_id: str, *, after: int = 0, limit: int = 500) -> list[dict[str, Any]]:
        rows = self.db.query(
            "SELECT id,run_id,sequence,event_type,payload_json,occurred_at,duration_ms FROM agent_events WHERE run_id=? AND sequence>? ORDER BY sequence LIMIT ?",
            (run_id, max(after, 0), min(max(limit, 1), 1_000)),
        )
        result: list[dict[str, Any]] = []
        for row in rows:
            item = dict(row)
            try:
                payload = json.loads(item.pop("payload_json") or "{}")
            except (TypeError, json.JSONDecodeError):
                payload = {}
                item.pop("payload_json", None)
            item["type"] = item.pop("event_type")
            item["payload"] = payload
            item["event_id"] = f"{run_id}:{item['sequence']}"
            result.append(item)
        return result

    def list_evidence(self, run_id: str) -> list[dict[str, Any]]:
        rows = self.db.query("SELECT * FROM agent_evidence WHERE run_id=? ORDER BY id", (run_id,))
        result = []
        for row in rows:
            item = dict(row)
            try:
                item["payload"] = json.loads(item.pop("payload_json") or "{}")
            except (TypeError, json.JSONDecodeError):
                item["payload"] = {}
                item.pop("payload_json", None)
            result.append(item)
        return result

    def list_artifacts(self, run_id: str) -> list[dict[str, Any]]:
        rows = self.db.query("SELECT * FROM agent_artifacts WHERE run_id=? ORDER BY id", (run_id,))
        result = []
        for row in rows:
            item = dict(row)
            try:
                item["metadata"] = json.loads(item.pop("metadata_json") or "{}")
            except (TypeError, json.JSONDecodeError):
                item["metadata"] = {}
                item.pop("metadata_json", None)
            result.append(item)
        return result

    def _set_running(self, run_id: str) -> None:
        self.db.execute(
            "UPDATE agent_runs SET status=CASE WHEN status='pending' THEN 'running' ELSE status END,"
            "started_at=COALESCE(started_at,?),updated_at=? "
            "WHERE id=? AND status IN ('pending','running','cancelling')",
            (utc_now(), utc_now(), run_id),
        )

    def _set_status(
        self,
        run_id: str,
        status: str,
        *,
        error: dict[str, Any] | None = None,
        terminal_status: str = "",
        answer: dict[str, Any] | None = None,
    ) -> None:
        if status not in FINAL_STATUSES and status not in ACTIVE_STATUSES:
            status = "failed"
        now = utc_now()
        # Every terminal state is immutable.  This also prevents a late
        # cancellation request or a duplicate sidecar event from rewriting a
        # result that has already been observed by an SSE client.
        final_guard = " AND status NOT IN ('completed','insufficient_evidence','needs_configuration','cancelled','timeout','failed')"
        self.db.execute(
            """UPDATE agent_runs SET status=?,terminal_status=?,answer_json=?,error=?,finished_at=?,updated_at=? WHERE id=?"""
            + final_guard,
            (
                status,
                terminal_status,
                json.dumps(answer or {}, ensure_ascii=False, separators=(",", ":")),
                json.dumps(error or {}, ensure_ascii=False, separators=(",", ":")),
                now if status in FINAL_STATUSES else None,
                now,
                run_id,
            ),
        )

    def _append_event(self, run_id: str, sequence: int, event_type: str, payload: Any, *, duration_ms: int | None = None) -> None:
        projected = _bounded_public(payload)
        if _json_size(projected) > MAX_EVENT_BYTES:
            projected = {"truncated": True}
        try:
            self.db.execute(
                "INSERT INTO agent_events(run_id,sequence,event_type,payload_json,occurred_at,duration_ms) VALUES(?,?,?,?,?,?)",
                (run_id, sequence, event_type[:128], json.dumps(projected, ensure_ascii=False, separators=(",", ":")), utc_now(), duration_ms),
            )
        except Exception as exc:
            # A duplicate/rewound sequence is a protocol failure.  Let the
            # caller convert it into a failed run rather than silently
            # overwriting an event that an SSE client may already have seen.
            raise SidecarProtocolError("sidecar event sequence is not strictly increasing") from exc

    def _project_event(self, event_type: str, event: Mapping[str, Any]) -> dict[str, Any]:
        # Model-generated prose is not persisted as a trace: it can contain
        # hidden reasoning.  Keep only lengths and tool metadata for those
        # event kinds.  Terminal answer text is handled separately below.
        if event_type == "text_delta":
            return {"turn": _int(event.get("turn")), "chars": len(_text(event.get("delta")))}
        if event_type == "assistant_message":
            message = event.get("message")
            calls: list[Any] = []
            if isinstance(message, Mapping) and isinstance(message.get("toolCalls"), list):
                calls = [
                    {
                        "id": _text(item.get("id"))[:256],
                        "name": _text(item.get("name"))[:128],
                    }
                    for item in message["toolCalls"]
                    if isinstance(item, Mapping)
                ][:MAX_COLLECTION_ITEMS]
            return {"turn": _int(event.get("turn")), "tool_calls": calls, "finish_reason": _text(event.get("finishReason"))[:64]}
        if event_type == "tool_started":
            call = event.get("toolCall")
            if isinstance(call, Mapping):
                return {
                    "turn": _int(event.get("turn")),
                    "operation_id": _text(event.get("operationId"))[:256],
                    "tool_call": {"id": _text(call.get("id"))[:256], "name": _text(call.get("name"))[:128], "arguments": _bounded_public(call.get("arguments"))},
                }
        if event_type in {"tool_completed", "tool_failed"}:
            call = event.get("toolCall")
            result = event.get("result")
            projected: dict[str, Any] = {"turn": _int(event.get("turn")), "operation_id": _text(event.get("operationId"))[:256]}
            if isinstance(call, Mapping):
                projected["tool_call"] = {"id": _text(call.get("id"))[:256], "name": _text(call.get("name"))[:128]}
            if isinstance(result, Mapping):
                projected["ok"] = bool(result.get("ok"))
                if not result.get("ok"):
                    projected["error"] = _public_value(result.get("error"))
                else:
                    data = result.get("data")
                    if isinstance(data, Mapping):
                        projected["data"] = {
                            key: _public_value(data[key])
                            for key in _PUBLIC_DATA_KEYS
                            if key in data
                        }
                    else:
                        projected["data"] = _public_value(data)
            return projected
        if event_type == "terminal_submitted":
            submission = event.get("submission")
            try:
                normalized = _submission(submission)
            except SidecarProtocolError:
                return {"invalid": True}
            # Keep answer bounded in the event while the validated result is
            # stored in agent_runs.answer_json for the run detail endpoint.
            return {
                "turn": _int(event.get("turn")),
                "status": normalized["status"],
                "answer": normalized["answer"][:16_000],
                "evidence": normalized["evidence"],
                "limitations": normalized["limitations"],
                "dataAsOf": normalized.get("dataAsOf"),
            }
        if event_type == "run_finished":
            result = event.get("result")
            if isinstance(result, Mapping):
                return {"status": _text(result.get("status"))[:64], "turns": _int(result.get("turns")), "usage": _public_value(result.get("usage")), "error": _public_value(result.get("error")) if result.get("error") else None}
        if event_type == "skill_selected":
            skill = event.get("skill")
            if isinstance(skill, Mapping):
                return {
                    "skill": {
                        key: _text(skill.get(key))[:256]
                        for key in ("skill_id", "id", "name", "version", "source")
                        if key in skill
                    },
                    "skill_id": _text(event.get("skillId"), _text(skill.get("skill_id"), _text(skill.get("id"))))[:128],
                }
            return {"skill_id": _text(event.get("skillId"))[:128] or None}
        return _bounded_public({key: value for key, value in event.items() if key not in {"runId", "run_id", "sequence", "eventId", "timestamp"}})

    def _persist_evidence(self, run_id: str, event_type: str, event: Mapping[str, Any], payload: Mapping[str, Any]) -> None:
        if event_type not in {"tool_completed", "tool_failed"}:
            return
        call = event.get("toolCall")
        result = event.get("result")
        if not isinstance(call, Mapping) or not isinstance(result, Mapping) or not result.get("ok"):
            return
        tool = _text(call.get("name"))[:128]
        data = result.get("data")
        data_map = data if isinstance(data, Mapping) else {}
        summary = _redact_text(_text(data_map.get("summary"), f"{tool} completed"))[:2_000]
        endpoint = _redact_text(_text(data_map.get("path"), data_map.get("endpoint", "")))[:512]
        symbol = _redact_text(_text(data_map.get("symbol"), data_map.get("code", data_map.get("board_id", ""))))[:128]
        as_of = _text(data_map.get("as_of"), data_map.get("asOf", data_map.get("effective_trade_date", "")))[:64]
        digest = _sha256_json(_public_value(data))
        safe_payload: dict[str, Any] = {
            key: _public_value(data_map[key]) for key in _PUBLIC_DATA_KEYS if key in data_map
        }
        self.db.execute(
            "INSERT INTO agent_evidence(run_id,tool,endpoint,symbol,as_of,summary,content_sha256,payload_json,created_at) VALUES(?,?,?,?,?,?,?,?,?)",
            (run_id, tool, endpoint, symbol, as_of, summary, digest, json.dumps(safe_payload, ensure_ascii=False, separators=(",", ":")), utc_now()),
        )
        artifact_type = _ARTIFACT_TYPES.get(tool)
        if artifact_type is not None:
            self.db.execute(
                "INSERT INTO agent_artifacts(run_id,artifact_type,reference,content_sha256,metadata_json,created_at) VALUES(?,?,?,?,?,?)",
                (run_id, artifact_type, f"agent_events:{run_id}:{_int(event.get('sequence'))}", digest, json.dumps(safe_payload, ensure_ascii=False, separators=(",", ":")), utc_now()),
            )

    def _persist_submission_evidence(self, run_id: str, submission: Mapping[str, Any]) -> None:
        for item in submission.get("evidence", []):
            self.db.execute(
                "INSERT INTO agent_evidence(run_id,tool,endpoint,symbol,as_of,summary,content_sha256,payload_json,created_at) VALUES(?,?,?,?,?,?,?,?,?)",
                (
                    run_id,
                    "submit_analysis",
                    "",
                    "",
                    _text(item.get("asOf")),
                    _redact_text(_text(item.get("summary")))[:2_000],
                    _sha256_json(item),
                    json.dumps(_public_value(item), ensure_ascii=False, separators=(",", ":")),
                    utc_now(),
                ),
            )

    async def _iter_sidecar_events(self, payload: Mapping[str, Any]) -> AsyncIterator[dict[str, Any]]:
        client, close = self._new_client()
        try:
            timeout = float(getattr(self.config, "agent_timeout_seconds", 300.0))
            async with client.stream(
                "POST",
                urljoin(self.sidecar_url, "internal/v1/runs"),
                json=dict(payload),
                timeout=httpx.Timeout(timeout),
            ) as response:
                if response.status_code == 409:
                    raise ActiveRunError("sidecar already has an active run", code="SIDECAR_RUN_ACTIVE", status_code=409)
                if 500 <= response.status_code < 600:
                    raise SidecarUnavailableError(f"sidecar returned HTTP {response.status_code}", code="SIDECAR_UNAVAILABLE", status_code=503)
                if response.status_code < 200 or response.status_code >= 300:
                    raise SidecarProtocolError(f"sidecar returned HTTP {response.status_code}", code="SIDECAR_HTTP_ERROR", status_code=502)
                async for line in response.aiter_lines():
                    if not line.strip():
                        continue
                    if len(line.encode("utf-8")) > MAX_EVENT_LINE_BYTES:
                        raise SidecarProtocolError("sidecar event exceeded the size limit")
                    try:
                        value = json.loads(line)
                    except json.JSONDecodeError as exc:
                        raise SidecarProtocolError("sidecar returned malformed event JSON") from exc
                    if not isinstance(value, dict):
                        raise SidecarProtocolError("sidecar event must be a JSON object")
                    yield value
        except (httpx.HTTPError, OSError) as exc:
            raise SidecarUnavailableError("sidecar request failed", code="SIDECAR_UNAVAILABLE", status_code=503) from exc
        finally:
            if close:
                await client.aclose()

    async def execute_run(self, run_id: str, payload: Mapping[str, Any]) -> None:
        last_sequence = 0
        saw_finished = False
        terminal: dict[str, Any] | None = None
        sidecar_failure: dict[str, Any] | None = None
        started_monotonic = asyncio.get_running_loop().time()
        self._set_running(run_id)
        try:
            async for event in self._iter_sidecar_events(payload):
                event_type = event.get("type")
                sequence = event.get("sequence")
                allow_initial_failure = event_type == "run_failed" and last_sequence == 0 and sequence == 0
                if (
                    not isinstance(event_type, str)
                    or not event_type
                    or not isinstance(sequence, int)
                    or isinstance(sequence, bool)
                    or (not allow_initial_failure and sequence <= last_sequence)
                ):
                    raise SidecarProtocolError("sidecar event type or sequence is invalid")
                if event.get("runId", event.get("run_id", run_id)) != run_id:
                    raise SidecarProtocolError("sidecar event belongs to another run")
                if saw_finished:
                    raise SidecarProtocolError("sidecar emitted an event after run_finished")
                last_sequence = sequence
                if event_type == "terminal_submitted":
                    candidate = _submission(event.get("submission"))
                    if terminal is not None:
                        raise SidecarProtocolError("sidecar submitted more than one terminal result")
                    terminal = candidate
                elif event_type == "run_failed":
                    sidecar_failure = _sidecar_error(event.get("error"))
                elif event_type == "skill_selected":
                    selected_value = event.get("skillId")
                    skill_value = event.get("skill")
                    if not isinstance(selected_value, str) and isinstance(skill_value, Mapping):
                        selected_value = skill_value.get("skill_id", skill_value.get("id"))
                    if selected_value is not None and (not isinstance(selected_value, str) or len(selected_value) > 128):
                        raise SidecarProtocolError("sidecar selected an invalid skill")
                    if isinstance(selected_value, str):
                        self.db.execute(
                            "UPDATE agent_runs SET selected_skill=?,updated_at=? WHERE id=?",
                            (selected_value, utc_now(), run_id),
                        )
                projected = self._project_event(event_type, event)
                self._append_event(run_id, sequence, event_type, projected, duration_ms=int((asyncio.get_running_loop().time() - started_monotonic) * 1000))
                self._persist_evidence(run_id, event_type, event, projected)
                if event_type == "run_finished":
                    if saw_finished:
                        raise SidecarProtocolError("sidecar emitted more than one run_finished event")
                    saw_finished = True
                    result = event.get("result")
                    result_status = result.get("status") if isinstance(result, Mapping) else None
                    if result_status == "needs_configuration":
                        self._set_status(run_id, "needs_configuration", error=_error_payload("NEEDS_CONFIGURATION", "Provider is not configured."))
                    elif result_status in {"cancelled", "timeout"}:
                        status = str(result_status)
                        self._set_status(run_id, status, error=_error_payload(status.upper(), f"Run {status}."))
                    elif result_status == "failed" or sidecar_failure is not None:
                        self._set_status(
                            run_id,
                            "failed",
                            error=sidecar_failure
                            or _sidecar_error(result.get("error") if isinstance(result, Mapping) else None),
                        )
                    elif terminal is not None and result_status in {"completed", "insufficient_evidence"}:
                        self._set_status(run_id, terminal["status"], terminal_status=terminal["status"], answer=terminal)
                        self._persist_submission_evidence(run_id, terminal)
                    else:
                        raise SidecarProtocolError("sidecar finished without a valid terminal submission")
            if not saw_finished:
                if sidecar_failure is not None:
                    self._set_status(run_id, "failed", error=sidecar_failure)
                    self._append_local_event(run_id, "run_failed", {"error": sidecar_failure})
                else:
                    raise SidecarProtocolError("sidecar stream ended without run_finished")
            # A malformed implementation could mark the record above and then
            # continue sending events; this final guard keeps the invariant.
            current = self.db.one("SELECT status FROM agent_runs WHERE id=?", (run_id,))
            if current is None or str(current["status"]) not in FINAL_STATUSES:
                raise SidecarProtocolError("run did not reach a terminal state")
            if current["status"] == "cancelled":
                # Append local lifecycle markers only after the sidecar stream
                # is fully consumed; inserting one while it is still emitting
                # would collide with the sidecar's sequence namespace.
                self._append_local_event(run_id, "run_cancelled", {"reason": "cancelled"})
        except asyncio.CancelledError:
            self._set_status(run_id, "cancelled", error=_error_payload("CANCELLED", "Run was cancelled."))
            self._append_local_event(run_id, "run_cancelled", {"reason": "cancelled"})
        except AgentError as exc:
            self._fail_run(run_id, exc.code, str(exc), http_status=exc.status_code)
        except Exception:
            self._fail_run(run_id, "RUN_FAILED", "Agent run failed.")
        finally:
            with self._lock:
                self._tasks.pop(run_id, None)
                if self._active_run_id == run_id:
                    self._active_run_id = None

    def _append_local_event(self, run_id: str, event_type: str, payload: Mapping[str, Any]) -> None:
        row = self.db.one("SELECT COALESCE(MAX(sequence),0) AS sequence FROM agent_events WHERE run_id=?", (run_id,))
        sequence = int(row["sequence"] if row else 0) + 1
        try:
            self._append_event(run_id, sequence, event_type, payload)
        except SidecarProtocolError:
            # This can only happen if another writer races us; preserving the
            # run failure is more important than creating a duplicate marker.
            return

    def _fail_run(self, run_id: str, code: str, message: str, *, http_status: int | None = None) -> None:
        row = self.db.one("SELECT status FROM agent_runs WHERE id=?", (run_id,))
        if row is None:
            return
        current = str(row["status"])
        if current in FINAL_STATUSES:
            return
        error = _error_payload(code, message, http_status=http_status)
        self._set_status(run_id, "failed", error=error)
        self._append_local_event(run_id, "run_failed", {"error": error})

    def launch(self, record: Mapping[str, Any]) -> asyncio.Task[Any]:
        run_id = str(record["id"])
        payload = dict(record.get("_sidecar", {}))
        task = asyncio.create_task(self.execute_run(run_id, payload), name=f"wolfbot-agent-{run_id}")
        with self._lock:
            self._tasks[run_id] = task
        return task

    async def cancel_run(self, run_id: str) -> dict[str, Any]:
        row = self.db.one("SELECT status FROM agent_runs WHERE id=?", (run_id,))
        if row is None:
            raise RunNotFoundError(f"run not found: {run_id}")
        status = str(row["status"])
        if status not in ACTIVE_STATUSES:
            return {"run_id": run_id, "status": status, "already_finished": True}
        self._set_status(run_id, "cancelling")
        latest = self.db.one("SELECT status FROM agent_runs WHERE id=?", (run_id,))
        if latest and str(latest["status"]) in FINAL_STATUSES:
            return {"run_id": run_id, "status": str(latest["status"]), "already_finished": True}
        client, close = self._new_client()
        try:
            timeout = min(float(getattr(self.config, "agent_timeout_seconds", 300.0)), 15.0)
            response = await client.post(
                urljoin(self.sidecar_url, f"internal/v1/runs/{run_id}/cancel"),
                timeout=httpx.Timeout(timeout),
            )
            if response.status_code == 404:
                # The stream may have finished between the DB read and the
                # cancel request.  Leave its terminal result untouched.
                latest = self.db.one("SELECT status FROM agent_runs WHERE id=?", (run_id,))
                if latest and str(latest["status"]) in FINAL_STATUSES:
                    return {"run_id": run_id, "status": str(latest["status"]), "already_finished": True}
                self._fail_run(run_id, "SIDECAR_CANCEL_NOT_FOUND", "Sidecar has no active run.", http_status=503)
                return {"run_id": run_id, "status": "failed"}
            if response.status_code >= 400:
                self._fail_run(run_id, "SIDECAR_CANCEL_FAILED", f"Sidecar cancellation returned HTTP {response.status_code}.", http_status=503)
                return {"run_id": run_id, "status": "failed"}
        except (httpx.HTTPError, OSError, AgentError) as exc:
            self._fail_run(run_id, "SIDECAR_CANCEL_FAILED", "Sidecar cancellation failed.", http_status=503)
            if isinstance(exc, AgentError):
                return {"run_id": run_id, "status": "failed"}
        finally:
            if close:
                await client.aclose()
        return {"run_id": run_id, "status": "cancellation_requested"}

    async def shutdown(self) -> None:
        tasks = list(self._tasks.values())
        for task in tasks:
            task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)


__all__ = [
    "ACTIVE_STATUSES",
    "AgentError",
    "AgentService",
    "ActiveRunError",
    "RunNotFoundError",
    "SidecarProtocolError",
    "SidecarUnavailableError",
    "SkillSelectionError",
]
