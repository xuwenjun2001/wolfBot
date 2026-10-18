import asyncio
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel, ConfigDict, Field

from quantpilot_market_data.repositories import tactics as repo
from quantpilot_market_data.routers.tactic_reviews import router as reviews_router
from quantpilot_market_data.security import require_market_admin
from quantpilot_market_data.services import tactic_charts
from quantpilot_market_data.services.tactics import submit
from quantpilot_market_data.tactics import TacticParameters, indicators

router = APIRouter(
    prefix="/api/v1/tactics", tags=["tactics"], dependencies=[Depends(require_market_admin)]
)
router.include_router(reviews_router)


class RunRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    actor: str = Field(min_length=1, max_length=200)


class ConfigRequest(RunRequest):
    parameters: TacticParameters
    expected_version: int = Field(ge=1)


class GuideRequest(RunRequest):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    content: str = Field(min_length=1, max_length=20000)
    expected_version: int = Field(ge=1)


@router.post("/guide")
def update_guide(request: GuideRequest):
    try:
        return repo.update_guide(request.content, request.actor, request.expected_version)
    except ValueError as error:
        raise HTTPException(409, str(error)) from error


@router.get("")
def dashboard(
    view: Literal["active", "today", "history"] = "active",
    page: int = Query(1, ge=1),
    run_id: str | None = None,
):
    return repo.dashboard(view, page, run_id)


@router.post("/runs", status_code=202)
def start_run(request: RunRequest):
    try:
        row = submit(request.actor)
        row.pop("context", None)
        return row
    except ValueError as error:
        raise HTTPException(409, str(error)) from error


@router.post("/config")
def update_config(request: ConfigRequest):
    try:
        return repo.update_config(
            request.parameters.model_dump(), request.actor, request.expected_version
        )
    except ValueError as error:
        raise HTTPException(409, str(error)) from error


@router.post("/runs/{run_id}/cancel")
def cancel(run_id: str, request: RunRequest):
    return {"cancelled": bool(repo.cancel(run_id, request.actor))}


@router.get("/events/{event_id}")
def detail(event_id: str):
    result = repo.event_detail(event_id)
    if result is None:
        raise HTTPException(404, "观察事件不存在")
    enriched = indicators(result["bars"])
    result["bars"] = [enriched.get(b["date"], b) for b in result["bars"]]
    return result


@router.get("/events/{event_id}/chart")
def chart_cache(event_id: str, mode: Literal["daily", "session"] = "daily"):
    try:
        return tactic_charts.cached_chart(tactic_charts.event(event_id), mode)
    except ValueError as error:
        raise HTTPException(404, str(error)) from error


class ChartRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    mode: Literal["daily", "session"]


@router.post("/events/{event_id}/chart")
async def chart_refresh(event_id: str, body: ChartRequest, request: Request):
    try:
        e = await asyncio.to_thread(tactic_charts.event, event_id)
    except ValueError as error:
        raise HTTPException(404, str(error)) from error
    try:
        return await request.app.state.tactic_charts.refresh(e["symbol"], body.mode)
    except (ValueError, TimeoutError) as error:
        raise HTTPException(502, str(error) or "行情刷新超时，保留原缓存") from error
