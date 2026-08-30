"""Browser-facing Agent run API."""

from __future__ import annotations

import asyncio
import json
from typing import Any, Literal

from fastapi import APIRouter, Header, HTTPException, Query, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, ConfigDict, Field, model_validator

from .agent_service import AgentError, AgentService


class RunCreatePayload(BaseModel):
    model_config = ConfigDict(extra="forbid")

    question: str = Field(min_length=1, max_length=32_000)
    skill_mode: Literal["auto", "manual", "none"] = "auto"
    skill_id: str | None = Field(default=None, min_length=1, max_length=128)
    # ``selected_skill`` is accepted for clients that mirror the sidecar
    # contract.  It is normalized to skill_id before persistence.
    selected_skill: str | None = Field(default=None, min_length=1, max_length=128)

    @model_validator(mode="after")
    def validate_skill_selection(self) -> "RunCreatePayload":
        if self.skill_id and self.selected_skill and self.skill_id != self.selected_skill:
            raise ValueError("skill_id and selected_skill must match")
        selected = self.skill_id or self.selected_skill
        if self.skill_mode == "manual" and not selected:
            raise ValueError("manual skill_mode requires skill_id")
        if self.skill_mode == "none" and selected == "none":
            return self
        if self.skill_mode != "manual" and selected:
            raise ValueError("skill_id is only valid with manual skill_mode")
        return self

    @property
    def selected_id(self) -> str | None:
        selected = self.skill_id or self.selected_skill
        return None if selected == "none" else selected


def _http_error(error: AgentError) -> HTTPException:
    return HTTPException(
        status_code=error.status_code,
        detail={"code": error.code, "message": str(error)},
    )


def _cursor(value: str | None, *, run_id: str | None = None) -> int:
    if not value:
        return 0
    raw = value.strip()
    if ":" in raw:
        event_run, raw = raw.rsplit(":", 1)
        # Never let an event ID from another run skip the beginning of this
        # run's audit trail.  Replaying from zero is safer than dropping
        # events when a browser restores stale local state.
        if run_id is not None and event_run != run_id:
            return 0
    try:
        parsed = int(raw)
    except ValueError:
        return 0
    return max(parsed, 0)


def create_agent_router(service: AgentService, *, prefix: str = "/api/v1/runs") -> APIRouter:
    router = APIRouter(prefix=prefix, tags=["agent"])

    @router.post("", status_code=202)
    @router.post("/", include_in_schema=False)
    async def create_run(payload: RunCreatePayload) -> dict[str, Any]:
        record: dict[str, Any] | None = None
        try:
            record = service.create_run(
                question=payload.question,
                skill_mode=payload.skill_mode,
                skill_id=payload.selected_id,
            )
            sidecar_payload = service.pop_sidecar_payload(record)
            # Reserve the active-run slot before probing.  This preserves a
            # deterministic 409 for a concurrent/existing run, while the
            # reservation is removed if the health check cannot reach the
            # sidecar and no 202 response is emitted.
            await service.preflight_sidecar()
            service.launch({"id": record["id"], "_sidecar": sidecar_payload})
        except AgentError as exc:
            if record is not None:
                service.discard_pending_run(str(record["id"]))
            raise _http_error(exc) from exc
        except asyncio.CancelledError:
            if record is not None:
                service.discard_pending_run(str(record["id"]))
            raise
        except Exception as exc:
            if record is not None:
                service.discard_pending_run(str(record["id"]))
            raise HTTPException(
                status_code=503,
                detail={"code": "SIDECAR_UNAVAILABLE", "message": "sidecar run could not be started"},
            ) from exc
        # The private payload is never returned to a browser.
        return service.get_run(str(record["id"]), include_children=False)

    @router.get("")
    async def list_runs(limit: int = Query(20, ge=1, le=100)) -> dict[str, Any]:
        items = service.list_runs(limit=limit)
        return {"items": items, "count": len(items)}

    @router.get("/{run_id}")
    async def get_run(run_id: str) -> dict[str, Any]:
        try:
            return service.get_run(run_id)
        except AgentError as exc:
            raise _http_error(exc) from exc

    @router.get("/{run_id}/events")
    async def run_events(
        request: Request,
        run_id: str,
        after: int = Query(0, ge=0),
        last_event_id: str | None = Header(default=None, alias="Last-Event-ID"),
    ) -> StreamingResponse:
        try:
            service.get_run(run_id, include_children=False)
        except AgentError as exc:
            raise _http_error(exc) from exc
        initial_cursor = max(after, _cursor(last_event_id, run_id=run_id))

        async def stream():
            cursor = initial_cursor
            while True:
                if await request.is_disconnected():
                    return
                rows = service.list_events(run_id, after=cursor, limit=100)
                for item in rows:
                    sequence = int(item["sequence"])
                    if sequence <= cursor:
                        continue
                    cursor = sequence
                    payload = {
                        "id": sequence,
                        "run_id": run_id,
                        "event_id": item["event_id"],
                        "type": item["type"],
                        "occurred_at": item["occurred_at"],
                        "payload": item["payload"],
                    }
                    yield f"id: {item['event_id']}\nevent: {item['type']}\ndata: {json.dumps(payload, ensure_ascii=False, separators=(',', ':'))}\n\n"
                    # ``run_failed`` may be an intermediate sidecar event;
                    # the sidecar normally follows it with ``run_finished``.
                    # Only close immediately on an explicit terminal marker.
                    if item["type"] in {"run_finished", "run_cancelled"}:
                        return
                record = service.get_run(run_id, include_children=False)
                if str(record["status"]) in {"completed", "insufficient_evidence", "needs_configuration", "cancelled", "timeout", "failed"}:
                    # A run can fail before its local marker is observed by a
                    # reader.  Poll once more, then close without duplicating.
                    tail = service.list_events(run_id, after=cursor, limit=1)
                    if not tail:
                        return
                await asyncio.sleep(0.1)

        return StreamingResponse(
            stream(),
            media_type="text/event-stream",
            headers={
                "Cache-Control": "no-cache, no-store",
                "Connection": "keep-alive",
                "X-Accel-Buffering": "no",
            },
        )

    @router.post("/{run_id}/cancel", status_code=202)
    @router.delete("/{run_id}/cancel", status_code=202, include_in_schema=False)
    async def cancel_run(run_id: str) -> dict[str, Any]:
        try:
            return await service.cancel_run(run_id)
        except AgentError as exc:
            raise _http_error(exc) from exc

    return router


__all__ = ["RunCreatePayload", "create_agent_router"]
