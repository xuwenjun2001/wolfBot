from datetime import date
from typing import Literal

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, ConfigDict, Field

from quantpilot_market_data.repositories import tactic_reviews as repo
from quantpilot_market_data.repositories import tactics as base
from quantpilot_market_data.services import tactic_reports, tactic_reviews

router = APIRouter(prefix="/reviews")


@router.get("")
def dashboard(
    day: date | None = None,
    start: date | None = None,
    end: date | None = None,
    origin: Literal["tracked", "retrospective", "unknown", "all"] = "tracked",
    version: int | None = Query(None, ge=1),
    search: str = Query("", max_length=200),
    report: str | None = Query(None, max_length=100),
):
    if start and end and start > end:
        raise HTTPException(422, "起始日期不能晚于结束日期")
    if report:
        result = repo.report_detail(report)
        if not result:
            raise HTTPException(404, "日报不存在")
        return {**result, "messages": tactic_reports.messages(result["input"])}
    result = repo.dashboard(
        str(day) if day else None,
        str(start) if start else None,
        str(end) if end else None,
        origin,
        version,
        search,
    )
    return {**result, "system_prompt": tactic_reports.SYSTEM_PROMPT}


class Mutation(BaseModel):
    model_config = ConfigDict(extra="forbid")
    action: Literal["run", "regenerate", "prompt", "schedule", "knowledge"]
    actor: str = Field(min_length=1, max_length=200)
    day: date | None = None
    expected_version: int | None = Field(None, ge=1)
    content: str | None = Field(None, min_length=1, max_length=20000)
    enabled: bool | None = None
    start_time: str | None = Field(None, pattern=r"^(1[5-9]|2[01]):[0-5][0-9]$")
    report_id: str | None = Field(None, max_length=100)


@router.post("", status_code=202)
def mutate(body: Mutation):
    try:
        if body.action == "run":
            job = tactic_reviews.submit(str(body.day) if body.day else None, body.actor)
            return {k: job[k] for k in ("id", "kind", "trade_date", "status")}
        if body.action == "regenerate":
            day = tactic_reviews.closed_day(str(body.day) if body.day else None)
            with base.connection() as c:
                snap = c.execute(
                    "SELECT * FROM quant.tactic_review_snapshots WHERE trade_date=%s "
                    "ORDER BY created_at DESC LIMIT 1",
                    (day,),
                ).fetchone()
            if not snap:
                raise ValueError("请先运行该日收盘复盘")
            return repo.prepare_report(snap, body.actor, force=True)
        if (
            body.action == "prompt"
            and body.content
            and body.content.strip()
            and body.expected_version
        ):
            return repo.save_prompt(body.content, body.expected_version, body.actor)
        if (
            body.action == "schedule"
            and body.enabled is not None
            and body.start_time
            and body.expected_version
        ):
            return repo.save_settings(
                body.enabled, body.start_time, body.expected_version, body.actor
            )
        if body.action == "knowledge" and body.report_id and body.enabled is not None:
            return repo.enable_knowledge(body.report_id, body.enabled, body.actor)
        raise ValueError("操作参数不完整")
    except ValueError as error:
        raise HTTPException(409, str(error)) from error
