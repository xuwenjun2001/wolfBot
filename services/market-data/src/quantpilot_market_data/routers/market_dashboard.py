from __future__ import annotations

import re
from datetime import date, datetime

from fastapi import APIRouter, Depends, HTTPException, Request

from quantpilot_market_data.providers.dashboard import SHANGHAI
from quantpilot_market_data.security import require_market_admin
from quantpilot_market_data.services.market_dashboard import MarketDashboardService

RESOURCE_PARAMS = {
    "index-session": {"index"},
    "index-breadth": {"index"},
    "market-turnover": set(),
    "overview": set(),
    "etfs": set(),
    "watch": set(),
    "institutions": set(),
    "strong": set(),
    "sectors": {"kind", "page"},
    "themes": {"page"},
    "theme-stocks": {"code", "page"},
    "sector-history": {"code", "period"},
    "limits": {"pool", "date"},
    "dragon-tiger": {"date"},
    "seats": {"date", "code"},
    "minute": {"code"},
    "kline": {"code"},
}


def validate_params(resource: str, pairs: list[tuple[str, str]]) -> dict:
    if resource not in RESOURCE_PARAMS:
        raise HTTPException(404, "Unknown dashboard resource")
    params = dict(pairs)
    if len(params) != len(pairs) or set(params) - RESOURCE_PARAMS[resource]:
        raise HTTPException(400, "Unsupported or duplicate query parameter")
    if "index" in RESOURCE_PARAMS[resource] and params.get("index") not in (
        "sh",
        "sz",
        "cy",
        "kc",
    ):
        raise HTTPException(400, "Invalid market index")
    if "page" in RESOURCE_PARAMS[resource]:
        page = params.get("page", "1")
        if not re.fullmatch(r"[1-9]|10", page):
            raise HTTPException(400, "page must be between 1 and 10")
        params["page"] = int(page)
    if resource == "sectors":
        params.setdefault("kind", "industry")
        if params["kind"] not in ("industry", "concept"):
            raise HTTPException(400, "Invalid sector kind")
    if resource == "sector-history":
        params.setdefault("period", "intraday")
        if params["period"] not in ("intraday", "3d"):
            raise HTTPException(400, "Invalid history period")
    if "code" in RESOURCE_PARAMS[resource]:
        pattern = r"BK\d{4,6}" if resource in ("sector-history", "theme-stocks") else r"\d{6}"
        if not re.fullmatch(pattern, params.get("code", "")):
            raise HTTPException(400, "Invalid security code")
        if re.match(r"^(43|83|87)", params["code"]):
            raise HTTPException(400, "北交所旧代码可能返回停更数据，请使用迁移后的920代码。")
    if "date" in RESOURCE_PARAMS[resource]:
        value = params.get("date", "")
        try:
            if (
                not re.fullmatch(r"\d{4}-\d{2}-\d{2}", value)
                or date.fromisoformat(value) > datetime.now(SHANGHAI).date()
            ):
                raise ValueError
        except ValueError as error:
            raise HTTPException(400, "Invalid trade date") from error
    if resource == "limits":
        params.setdefault("pool", "up")
        if params["pool"] not in ("up", "down", "blow", "yesterday"):
            raise HTTPException(400, "Invalid limit pool")
    return params


def create_market_dashboard_router(service: MarketDashboardService) -> APIRouter:
    router = APIRouter(
        prefix="/api/v1/market-dashboard",
        tags=["market-dashboard"],
        dependencies=[Depends(require_market_admin)],
    )

    @router.get("/{resource}")
    async def get_dashboard(resource: str, request: Request) -> dict:
        params = validate_params(resource, list(request.query_params.multi_items()))
        return await service.get(resource, params)

    return router
