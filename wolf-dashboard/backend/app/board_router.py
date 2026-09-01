"""FastAPI router for the market-session and board research contracts.

Every route is fixed: the caller supplies only an opaque board id, an ISO date,
and enumerated sort/limit values.  No origin, path, query key, header, or
credential is ever accepted from the model.

Failures keep their classification instead of collapsing into one status.  In
particular an unreachable or malformed upstream is reported as an upstream
error and never as "this board does not exist".
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException, Query

from .board_service import MEMBER_SORT_FIELDS, BoardService, normalize_board_type
from .market_boards import BOARD_TYPES, BoardError
from .market_calendar import TradingCalendar


DATE_PATTERN = r"^[0-9]{4}-[0-9]{2}-[0-9]{2}$"


def _raise(error: BoardError) -> None:
    raise HTTPException(status_code=error.http_status, detail=error.as_detail()) from error


def create_board_router(
    *,
    service: BoardService,
    calendar: TradingCalendar | None = None,
    prefix: str = "/api/v1",
) -> APIRouter:
    """Create an unregistered router; callers choose when and where to include it."""

    router = APIRouter(prefix=prefix, tags=["boards"])
    active_calendar = calendar or service.calendar

    @router.get("/market/session")
    def market_session_endpoint(
        requested_date: str | None = Query(None, pattern=DATE_PATTERN),
    ) -> dict[str, Any]:
        return active_calendar.session(requested_date=requested_date).as_dict()

    @router.get("/boards/resolve")
    def resolve_board_endpoint(
        query: str = Query(..., min_length=1, max_length=40),
        board_type: str | None = Query(None),
    ) -> dict[str, Any]:
        try:
            normalized_type = normalize_board_type(board_type)
        except ValueError as exc:
            raise HTTPException(
                status_code=400,
                detail={
                    "code": "INVALID_BOARD_TYPE",
                    "message": str(exc),
                    "supported": list(BOARD_TYPES),
                },
            ) from exc
        try:
            return service.resolve(query, board_type=normalized_type).as_dict()
        except BoardError as exc:
            _raise(exc)

    @router.get("/boards/{board_id}/snapshot")
    def board_snapshot_endpoint(
        board_id: str,
        trade_date: str | None = Query(None, pattern=DATE_PATTERN),
    ) -> dict[str, Any]:
        try:
            return service.snapshot(board_id, trade_date=trade_date)
        except BoardError as exc:
            _raise(exc)

    @router.get("/boards/{board_id}/breadth")
    def board_breadth_endpoint(
        board_id: str,
        trade_date: str | None = Query(None, pattern=DATE_PATTERN),
    ) -> dict[str, Any]:
        try:
            return service.breadth(board_id, trade_date=trade_date)
        except BoardError as exc:
            _raise(exc)

    @router.get("/boards/{board_id}/members")
    def board_members_endpoint(
        board_id: str,
        trade_date: str | None = Query(None, pattern=DATE_PATTERN),
        sort: str = Query("change_pct"),
        direction: str = Query("desc"),
        limit: int = Query(10, ge=1, le=50),
    ) -> dict[str, Any]:
        if sort not in MEMBER_SORT_FIELDS:
            raise HTTPException(
                status_code=400,
                detail={
                    "code": "INVALID_SORT_FIELD",
                    "message": f"sort must be one of {', '.join(MEMBER_SORT_FIELDS)}",
                },
            )
        if direction not in {"asc", "desc"}:
            raise HTTPException(
                status_code=400,
                detail={"code": "INVALID_SORT_DIRECTION", "message": "direction must be asc or desc"},
            )
        try:
            return service.members(
                board_id, trade_date=trade_date, sort=sort, direction=direction, limit=limit
            )
        except BoardError as exc:
            _raise(exc)

    return router


__all__ = ["create_board_router"]
