from __future__ import annotations

from datetime import date
from decimal import Decimal

from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from quantpilot_market_data.cache import MarketDataCache
from quantpilot_market_data.config import MarketSettings, get_settings
from quantpilot_market_data.database import ping
from quantpilot_market_data.errors import MarketDataError
from quantpilot_market_data.models import (
    Adjustment,
    AnalysisContextResponse,
    AnnouncementResponse,
    AShareScreenerResponse,
    BacktestResponse,
    BatchQuoteRequest,
    BatchQuoteResponse,
    FinancialReportsResponse,
    FundamentalIndicatorsResponse,
    KlinePeriod,
    KlineResponse,
    LocalKlineResponse,
    RealtimeQuote,
    RegistryResponse,
    ResearchUniverseMembersResponse,
    ResearchUniverseSummaryResponse,
    SymbolResolveResponse,
    TechnicalIndicatorsResponse,
)
from quantpilot_market_data.providers.eastmoney import EastMoneyClient
from quantpilot_market_data.services.backtests import get_ma_crossover_backtest
from quantpilot_market_data.services.context import DEFAULT_SECTIONS, get_analysis_context
from quantpilot_market_data.services.events import get_announcements
from quantpilot_market_data.services.fundamentals import (
    get_financial_reports,
    get_fundamental_indicators,
)
from quantpilot_market_data.services.indicators import get_technical_indicators
from quantpilot_market_data.services.quotes import (
    get_history_quote,
    get_realtime_quote,
    get_realtime_quotes,
    resolve_symbol,
)
from quantpilot_market_data.services.registry import build_registry
from quantpilot_market_data.services.research import (
    get_local_bars,
    get_universe_members,
    get_universe_summary,
    screen_short_term_candidates,
)


def create_app(settings: MarketSettings | None = None) -> FastAPI:
    active_settings = settings or get_settings()
    client = EastMoneyClient(active_settings)
    cache = MarketDataCache(active_settings)
    app = FastAPI(
        title="Wolf Research Market Data API",
        description="Market data boundary for Wolf Research",
        version="0.1.0",
    )

    app.add_middleware(
        CORSMiddleware,
        allow_origin_regex=r"^https?://(localhost|127\\.0\\.0\\.1):\\d+$",
        allow_credentials=False,
        allow_methods=["GET", "POST", "OPTIONS"],
        allow_headers=["*"],
    )

    @app.exception_handler(MarketDataError)
    async def market_data_error_handler(_: Request, error: MarketDataError) -> JSONResponse:
        return JSONResponse(
            status_code=error.status_code,
            content={
                "detail": str(error),
                "error": {
                    "code": error.code,
                    "message": str(error),
                    "retryable": error.retryable,
                },
            },
            headers={"Cache-Control": "no-store"},
        )

    @app.get("/health")
    async def health() -> dict[str, str]:
        return {"status": "ok", "service": "wolf-research-market-data"}

    @app.get("/ready")
    async def ready() -> dict[str, object]:
        try:
            await ping(active_settings)
        except MarketDataError as error:
            body = {
                "ok": False,
                "service": "wolf-research-market-data",
                "code": error.code,
                "message": str(error),
                "retryable": error.retryable,
            }
            return JSONResponse(
                status_code=200, content=body, headers={"Cache-Control": "no-store"}
            )
        return {"ok": True, "service": "wolf-research-market-data", "database": "ready"}

    @app.get("/api/v1/symbols/resolve", response_model=SymbolResolveResponse)
    async def resolve_symbol_endpoint(
        query: str, count: int = Query(default=5, ge=1, le=20)
    ) -> SymbolResolveResponse:
        try:
            return await resolve_symbol(client, cache, active_settings, query=query, count=count)
        except ValueError as error:
            raise HTTPException(status_code=400, detail=str(error)) from error

    @app.get("/api/v1/quotes/realtime/{symbol}", response_model=RealtimeQuote)
    async def realtime_quote_endpoint(symbol: str) -> RealtimeQuote:
        try:
            return await get_realtime_quote(client, cache, active_settings, symbol=symbol)
        except ValueError as error:
            raise HTTPException(status_code=400, detail=str(error)) from error

    @app.post("/api/v1/quotes/realtime", response_model=BatchQuoteResponse)
    async def realtime_quotes_endpoint(request: BatchQuoteRequest) -> BatchQuoteResponse:
        try:
            return await get_realtime_quotes(
                client, cache, active_settings, symbols=request.symbols
            )
        except ValueError as error:
            raise HTTPException(status_code=400, detail=str(error)) from error

    @app.get("/api/v1/quotes/history/{symbol}", response_model=KlineResponse)
    async def history_endpoint(
        symbol: str,
        period: KlinePeriod = "daily",
        adjustment: Adjustment = "qfq",
        limit: int = Query(default=120, ge=1, le=2_000),
        end: str = "20500101",
        refresh: bool = False,
    ) -> KlineResponse:
        try:
            return await get_history_quote(
                client,
                cache,
                active_settings,
                symbol=symbol,
                period=period,
                adjustment=adjustment,
                limit=limit,
                end=end,
                refresh=refresh,
            )
        except ValueError as error:
            raise HTTPException(status_code=400, detail=str(error)) from error

    @app.get("/api/v1/indicators/technical/{symbol}", response_model=TechnicalIndicatorsResponse)
    async def technical_endpoint(
        symbol: str,
        period: KlinePeriod = "daily",
        adjustment: Adjustment = "qfq",
        limit: int = Query(default=120, ge=1, le=2_000),
        end: str = "20500101",
    ) -> TechnicalIndicatorsResponse:
        try:
            return await get_technical_indicators(
                client,
                cache,
                active_settings,
                symbol=symbol,
                period=period,
                adjustment=adjustment,
                limit=limit,
                end=end,
            )
        except ValueError as error:
            raise HTTPException(status_code=400, detail=str(error)) from error

    @app.get("/api/v1/fundamentals/financials/{symbol}", response_model=FinancialReportsResponse)
    async def financials_endpoint(
        symbol: str, limit: int = Query(default=8, ge=1, le=40)
    ) -> FinancialReportsResponse:
        try:
            return await get_financial_reports(
                client, cache, active_settings, symbol=symbol, limit=limit
            )
        except ValueError as error:
            raise HTTPException(status_code=400, detail=str(error)) from error

    @app.get(
        "/api/v1/indicators/fundamental/{symbol}", response_model=FundamentalIndicatorsResponse
    )
    async def fundamental_endpoint(
        symbol: str, limit: int = Query(default=8, ge=1, le=40)
    ) -> FundamentalIndicatorsResponse:
        try:
            return await get_fundamental_indicators(
                client, cache, active_settings, symbol=symbol, limit=limit
            )
        except ValueError as error:
            raise HTTPException(status_code=400, detail=str(error)) from error

    @app.get("/api/v1/events/announcements/{symbol}", response_model=AnnouncementResponse)
    async def announcements_endpoint(
        symbol: str, limit: int = Query(default=20, ge=1, le=100)
    ) -> AnnouncementResponse:
        try:
            return await get_announcements(
                client, cache, active_settings, symbol=symbol, limit=limit
            )
        except ValueError as error:
            raise HTTPException(status_code=400, detail=str(error)) from error

    @app.get("/api/v1/backtests/ma-crossover/{symbol}", response_model=BacktestResponse)
    async def backtest_endpoint(
        symbol: str,
        fast_window: int = Query(default=20, ge=2, le=120),
        slow_window: int = Query(default=60, ge=3, le=250),
        period: KlinePeriod = "daily",
        adjustment: Adjustment = "qfq",
        limit: int = Query(default=250, ge=1, le=2_000),
        end: str = "20500101",
        initial_cash: Decimal = Decimal("1"),
        fee_bps: Decimal = Decimal("5"),
    ) -> BacktestResponse:
        try:
            if initial_cash <= 0 or fee_bps < 0:
                raise ValueError("initial_cash 必须大于 0，fee_bps 不能为负数。")
            return await get_ma_crossover_backtest(
                client,
                cache,
                active_settings,
                symbol=symbol,
                fast_window=fast_window,
                slow_window=slow_window,
                period=period,
                adjustment=adjustment,
                limit=limit,
                end=end,
                initial_cash=initial_cash,
                fee_bps=fee_bps,
            )
        except ValueError as error:
            raise HTTPException(status_code=400, detail=str(error)) from error

    @app.get(
        "/api/v1/research/screeners/a-share/short-term-candidates",
        response_model=AShareScreenerResponse,
    )
    async def screener_endpoint(
        universe_id: str = "a-share-sample-research-pool",
        trade_date: date | None = None,
        mode: str = "short_term",
        limit: int = Query(default=20, ge=1, le=100),
        sector: str | None = None,
    ) -> AShareScreenerResponse:
        return await screen_short_term_candidates(
            active_settings,
            universe_id=universe_id,
            trade_date=trade_date,
            limit=limit,
            sector=sector,
            mode=mode,
        )

    @app.get("/api/v1/analysis/context/{symbol}", response_model=AnalysisContextResponse)
    async def context_endpoint(
        symbol: str,
        include: str | None = None,
        period: KlinePeriod = "daily",
        adjustment: Adjustment = "qfq",
        limit: int = Query(default=120, ge=1, le=2_000),
        end: str = "20500101",
        financial_limit: int = Query(default=8, ge=1, le=40),
        announcement_limit: int = Query(default=20, ge=1, le=100),
    ) -> AnalysisContextResponse:
        requested = list(
            dict.fromkeys(
                part.strip()
                for part in (include or ",".join(DEFAULT_SECTIONS)).split(",")
                if part.strip()
            )
        )
        invalid = [part for part in requested if part not in DEFAULT_SECTIONS]
        if not requested or invalid:
            raise HTTPException(
                status_code=400,
                detail=f"未知或空 include 数据区块：{', '.join(invalid or requested)}",
            )
        return await get_analysis_context(
            client,
            cache,
            active_settings,
            symbol=symbol,
            sections=requested,
            period=period,
            adjustment=adjustment,
            limit=limit,
            end=end,
            financial_limit=financial_limit,
            announcement_limit=announcement_limit,
        )

    @app.get("/api/v1/research/universes/summary", response_model=ResearchUniverseSummaryResponse)
    async def universe_summary_endpoint() -> ResearchUniverseSummaryResponse:
        return await get_universe_summary(active_settings)

    @app.get(
        "/api/v1/research/universes/{universe_id}/members",
        response_model=ResearchUniverseMembersResponse,
    )
    async def universe_members_endpoint(
        universe_id: str,
        page: int = Query(default=1, ge=1),
        page_size: int = Query(default=100, ge=1, le=500),
        keyword: str | None = None,
    ) -> ResearchUniverseMembersResponse:
        return await get_universe_members(
            active_settings,
            universe_id=universe_id,
            page=page,
            page_size=page_size,
            keyword=keyword,
        )

    @app.get("/api/v1/research/bars/{symbol}", response_model=LocalKlineResponse)
    async def local_bars_endpoint(
        symbol: str, limit: int = Query(default=120, ge=1, le=2_000), provider: str | None = None
    ) -> LocalKlineResponse:
        return await get_local_bars(active_settings, symbol=symbol, limit=limit, provider=provider)

    @app.get("/api/v1/registry", response_model=RegistryResponse)
    async def registry_endpoint() -> RegistryResponse:
        return build_registry(active_settings)

    return app


app = create_app()
