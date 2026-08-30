"""FastAPI router factory for the MVP's read-only market and screener APIs."""

from __future__ import annotations

from dataclasses import asdict
from typing import Any, Iterable

from fastapi import APIRouter, HTTPException, Query

from .market_data import (
    DailyBar,
    MarketDataError,
    Security,
    SymbolResolutionError,
    TencentProvider,
    compute_features,
    default_catalog,
    resolve_symbol,
    utc_now,
)
from .market_store import DEFAULT_UNIVERSE_ID, MarketStore
from .screener import MODES, Screener, ScreenerValidationError, screen_stocks


def _catalog(store: MarketStore | None, values: Iterable[Security] | None) -> list[Security]:
    if values is not None:
        return list(values)
    if store is not None:
        stored = store.list_symbols(enabled_only=False)
        if stored:
            return stored
    return default_catalog()


def _resolve(
    query: str,
    *,
    store: MarketStore | None,
    catalog: Iterable[Security] | None,
) -> Any:
    return resolve_symbol(query, catalog=_catalog(store, catalog))


def _security_or_400(
    query: str,
    *,
    store: MarketStore | None,
    catalog: Iterable[Security] | None,
) -> Security:
    try:
        result = _resolve(query, store=store, catalog=catalog)
    except SymbolResolutionError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    if result.status != "resolved" or len(result.candidates) != 1:
        raise HTTPException(status_code=409, detail=result.as_dict())
    return result.candidates[0]


def _bar_dict(bar: DailyBar) -> dict[str, Any]:
    return bar.as_dict()


def _history_response(security: Security, bars: list[DailyBar], adjustment: str) -> dict[str, Any]:
    quality = {
        "status": "ok" if bars else "warning",
        "missing_fields": [] if bars else ["bars"],
        "warnings": [] if bars else ["history returned no bars"],
    }
    return {
        "source": bars[0].source if bars else "tencent",
        "symbol": security.symbol,
        "code": security.code,
        "name": security.name,
        "asset_type": security.asset_type,
        "exchange": security.exchange,
        "board": security.board,
        "secid": security.secid,
        "as_of": bars[-1].trade_date if bars else None,
        "fetched_at": bars[-1].fetched_at if bars else utc_now(),
        "adjustment": adjustment,
        "period": "daily",
        "bars": [_bar_dict(bar) for bar in bars],
        "data_basis": "tencent.daily.qfq" if adjustment == "qfq" else f"tencent.daily.{adjustment}",
        "data_quality": quality,
    }


def _indicator_points(bars: list[DailyBar]) -> list[dict[str, Any]]:
    closes = [bar.close for bar in bars]
    points: list[dict[str, Any]] = []
    for index, bar in enumerate(bars):
        def mean(window: int) -> float | None:
            if index + 1 < window:
                return None
            values = closes[index + 1 - window : index + 1]
            if any(value is None for value in values):
                return None
            return round(sum(value for value in values if value is not None) / window, 6)

        return_pct = None
        if index > 0 and bar.close is not None and closes[index - 1] not in (None, 0):
            return_pct = round((bar.close / closes[index - 1] - 1.0) * 100.0, 6)
        points.append(
            {
                "date": bar.trade_date,
                "close": bar.close,
                "volume": bar.volume,
                "ma5": mean(5),
                "ma10": mean(10),
                "ma20": mean(20),
                "ma30": mean(30),
                "ma60": mean(60),
                "return_pct": return_pct,
            }
        )
    return points


def create_market_router(
    *,
    store: MarketStore | None = None,
    provider: Any | None = None,
    catalog: Iterable[Security] | None = None,
    screener: Screener | None = None,
    prefix: str = "/api/v1",
) -> APIRouter:
    """Create an unregistered router; callers choose when and where to include it."""
    router = APIRouter(prefix=prefix, tags=["market"])
    active_provider = provider or TencentProvider()
    active_screener = screener or Screener(store)

    @router.get("/symbols/resolve")
    def resolve_endpoint(query: str = Query(..., min_length=1, max_length=80)) -> dict[str, Any]:
        try:
            return _resolve(query, store=store, catalog=catalog).as_dict()
        except SymbolResolutionError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    @router.get("/quotes/realtime/{symbol}")
    def realtime_endpoint(symbol: str) -> dict[str, Any]:
        security = _security_or_400(symbol, store=store, catalog=catalog)
        try:
            quote = active_provider.realtime(security.symbol)
        except (MarketDataError, ValueError) as exc:
            raise HTTPException(status_code=502, detail=str(exc)) from exc
        return quote.as_dict() if hasattr(quote, "as_dict") else dict(quote)

    @router.get("/quotes/history/{symbol}")
    def history_endpoint(
        symbol: str,
        period: str = Query("daily"),
        adjustment: str = Query("qfq"),
        limit: int = Query(240, ge=1, le=800),
    ) -> dict[str, Any]:
        if period != "daily":
            raise HTTPException(status_code=400, detail="only daily period is supported in MVP")
        if adjustment not in {"none", "qfq", "hfq"}:
            raise HTTPException(status_code=400, detail="adjustment must be none, qfq, or hfq")
        security = _security_or_400(symbol, store=store, catalog=catalog)
        try:
            bars = list(active_provider.history(security.symbol, adjustment=adjustment, limit=limit))
        except (MarketDataError, ValueError) as exc:
            raise HTTPException(status_code=502, detail=str(exc)) from exc
        return _history_response(security, bars[-limit:], adjustment)

    @router.get("/indicators/technical/{symbol}")
    def indicators_endpoint(
        symbol: str,
        period: str = Query("daily"),
        adjustment: str = Query("qfq"),
        limit: int = Query(240, ge=1, le=800),
    ) -> dict[str, Any]:
        if period != "daily":
            raise HTTPException(status_code=400, detail="only daily period is supported in MVP")
        security = _security_or_400(symbol, store=store, catalog=catalog)
        try:
            bars = list(active_provider.history(security.symbol, adjustment=adjustment, limit=limit))
            features = compute_features(bars, symbol=security.symbol, adjustment=adjustment)
        except (MarketDataError, ValueError) as exc:
            raise HTTPException(status_code=502, detail=str(exc)) from exc
        points = _indicator_points(bars)
        summary = features.as_dict()
        amount_values = [bar.amount for bar in bars[-20:] if bar.amount is not None]
        volume_values = [bar.volume for bar in bars[-20:] if bar.volume is not None]
        summary.update(
            {
                "latest_close": features.close,
                "period_return_pct": features.return_60d_pct,
                "max_drawdown_pct": features.max_drawdown_60d_pct,
                "volatility_annualized_pct": features.volatility_20d_pct,
                "avg_amount_20d": (sum(amount_values) / len(amount_values)) if amount_values else None,
                "avg_volume20": (sum(volume_values) / len(volume_values)) if volume_values else None,
            }
        )
        return {
            "source": "tencent",
            "symbol": security.symbol,
            "code": security.code,
            "name": security.name,
            "asset_type": security.asset_type,
            "exchange": security.exchange,
            "secid": security.secid,
            "period": period,
            "adjustment": adjustment,
            "as_of": features.trade_date or None,
            "fetched_at": features.fetched_at,
            "points": points,
            "summary": summary,
            "features": summary,
            "data_basis": "tencent.daily." + adjustment,
            "data_quality": {
                "status": "ok" if len(bars) >= 20 else "warning",
                "missing_fields": [],
                "warnings": [] if len(bars) >= 20 else ["less than 20 daily bars; long-window indicators are incomplete"],
            },
        }

    @router.get("/research/universes/summary")
    def universe_summary_endpoint(universe_id: str = DEFAULT_UNIVERSE_ID) -> dict[str, Any]:
        if store is None:
            return {
                "universes": [],
                "source": "sqlite",
                "data_basis": "sqlite.market_daily_bars",
                "data_quality": {"status": "warning", "missing_fields": ["universes"], "warnings": ["market store is not configured"]},
                "fetched_at": utc_now(),
            }
        return {"universes": [store.universe_summary(universe_id)], "fetched_at": utc_now()}

    @router.get("/research/universes/{universe_id}/members")
    def universe_members_endpoint(
        universe_id: str,
        page: int = Query(1, ge=1),
        page_size: int = Query(50, ge=1, le=200),
    ) -> dict[str, Any]:
        if store is None:
            raise HTTPException(status_code=503, detail="market store is not configured")
        return store.universe_members(universe_id, page=page, page_size=page_size)

    @router.get("/research/screeners/a-share/short-term-candidates")
    def fixed_screener_endpoint(
        universe_id: str = DEFAULT_UNIVERSE_ID,
        as_of: str | None = None,
        trade_date: str | None = None,
        mode: str = Query("short_term"),
        limit: int = Query(10, ge=1, le=20),
    ) -> dict[str, Any]:
        if mode not in MODES:
            raise HTTPException(status_code=400, detail=f"unsupported screener mode: {mode}")
        try:
            result = active_screener.screen_fixed(
                mode,
                universe_id=universe_id,
                as_of=as_of or trade_date,
                limit=limit,
            )
        except ScreenerValidationError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        return result.as_dict()

    @router.post("/research/screeners/a-share/query")
    def custom_screener_endpoint(payload: dict[str, Any]) -> dict[str, Any]:
        try:
            result = active_screener.screen(payload)
        except ScreenerValidationError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        return result.as_dict()

    return router


# Alias used by integrations that mirror QuantPilot's router naming.
create_research_router = create_market_router


__all__ = ["create_market_router", "create_research_router"]
