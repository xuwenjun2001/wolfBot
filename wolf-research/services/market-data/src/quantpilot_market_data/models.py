from __future__ import annotations

from datetime import UTC, date, datetime
from decimal import Decimal
from typing import Any, Literal

from pydantic import BaseModel, Field, model_validator

MarketCode = Literal["SH", "SZ", "BJ", "UNKNOWN"]
AssetType = Literal["stock", "index", "etf", "fund", "mixed", "unknown"]
DataQualityStatus = Literal["ok", "warning", "error"]
CacheStatus = Literal["hit", "miss", "disabled", "bypass", "redis-hit", "fixture"]
KlinePeriod = Literal[
    "daily",
    "weekly",
    "monthly",
    "minute1",
    "minute5",
    "minute15",
    "minute30",
    "minute60",
]
Adjustment = Literal["none", "qfq", "hfq"]
ScreenerMode = Literal["short_term", "limit_up_relay", "trend_liquidity"]


class DataQuality(BaseModel):
    status: DataQualityStatus = "ok"
    missing_fields: list[str] = Field(default_factory=list)
    warnings: list[str] = Field(default_factory=list)


class FetchMetadata(BaseModel):
    cache_status: CacheStatus = "bypass"
    cache_key: str | None = None
    cache_ttl_seconds: int | None = None
    cached_at: datetime | None = None
    expires_at: datetime | None = None
    cache_path: str | None = None


class SymbolResolveResult(BaseModel):
    query: str
    symbol: str
    name: str | None = None
    asset_type: AssetType = "stock"
    market: MarketCode = "UNKNOWN"
    secid: str
    source: str = "eastmoney"
    confidence: float | None = None
    raw: dict[str, Any] = Field(default_factory=dict)


class SymbolResolveResponse(BaseModel):
    results: list[SymbolResolveResult]
    asset_type: AssetType = "mixed"
    source: str = "eastmoney"
    timezone: str = "Asia/Shanghai"
    as_of: datetime | str | None = None
    fetched_at: datetime = Field(default_factory=lambda: datetime.now(UTC))
    fetch: FetchMetadata = Field(default_factory=FetchMetadata)
    data_quality: DataQuality = Field(default_factory=DataQuality)

    @model_validator(mode="after")
    def fill_quality(self) -> SymbolResolveResponse:
        self.as_of = self.as_of or self.fetched_at
        if not self.results:
            self.data_quality = DataQuality(
                status="warning",
                missing_fields=["results"],
                warnings=["证券解析未返回匹配结果。"],
            )
        return self


class RealtimeQuote(BaseModel):
    symbol: str
    secid: str
    name: str | None = None
    asset_type: AssetType = "stock"
    market: MarketCode = "UNKNOWN"
    source: str = "eastmoney"
    currency: str = "CNY"
    timezone: str = "Asia/Shanghai"
    price: Decimal | None = None
    open: Decimal | None = None
    high: Decimal | None = None
    low: Decimal | None = None
    previous_close: Decimal | None = None
    change_percent: Decimal | None = None
    change_amount: Decimal | None = None
    amplitude: Decimal | None = None
    turnover: Decimal | None = None
    volume: int | None = None
    amount: Decimal | None = None
    market_cap: Decimal | None = None
    float_market_cap: Decimal | None = None
    pe_ttm: Decimal | None = None
    pb_mrq: Decimal | None = None
    industry: str | None = None
    region: str | None = None
    concepts: list[str] = Field(default_factory=list)
    quote_time: datetime | None = None
    as_of: datetime | str | None = None
    fetched_at: datetime = Field(default_factory=lambda: datetime.now(UTC))
    fetch: FetchMetadata = Field(default_factory=FetchMetadata)
    data_quality: DataQuality = Field(default_factory=DataQuality)

    @model_validator(mode="after")
    def fill_quality(self) -> RealtimeQuote:
        self.as_of = self.as_of or self.quote_time or self.fetched_at
        required = {
            "price": self.price,
            "quote_time": self.quote_time,
        }
        missing = [name for name, value in required.items() if value is None]
        if missing:
            self.data_quality = DataQuality(
                status="warning",
                missing_fields=missing,
                warnings=["实时行情返回字段不完整。"],
            )
        return self


class BatchQuoteRequest(BaseModel):
    symbols: list[str] = Field(min_length=1, max_length=100)


class BatchQuoteResponse(BaseModel):
    quotes: list[RealtimeQuote]
    asset_type: AssetType = "mixed"
    source: str = "eastmoney"
    currency: str = "CNY"
    timezone: str = "Asia/Shanghai"
    as_of: datetime | str | None = None
    fetched_at: datetime = Field(default_factory=lambda: datetime.now(UTC))
    fetch: FetchMetadata = Field(default_factory=FetchMetadata)
    data_quality: DataQuality = Field(default_factory=DataQuality)

    @model_validator(mode="after")
    def fill_quality(self) -> BatchQuoteResponse:
        self.as_of = self.as_of or (self.quotes[0].as_of if self.quotes else self.fetched_at)
        if not self.quotes:
            self.data_quality = DataQuality(
                status="warning",
                missing_fields=["quotes"],
                warnings=["批量行情未返回任何证券数据。"],
            )
        return self


class KlineBar(BaseModel):
    date: str
    open: Decimal | None = None
    close: Decimal | None = None
    high: Decimal | None = None
    low: Decimal | None = None
    previous_close: Decimal | None = None
    volume: int | None = None
    amount: Decimal | None = None
    amplitude: Decimal | None = None
    change_percent: Decimal | None = None
    change_amount: Decimal | None = None
    turnover: Decimal | None = None
    trade_status: str | None = None
    is_st: bool | None = None
    limit_up: bool | None = None
    limit_down: bool | None = None
    metadata: dict[str, Any] = Field(default_factory=dict)


class KlineResponse(BaseModel):
    symbol: str
    name: str | None = None
    secid: str
    asset_type: AssetType = "stock"
    market: MarketCode = "UNKNOWN"
    source: str = "eastmoney"
    currency: str = "CNY"
    timezone: str = "Asia/Shanghai"
    period: KlinePeriod
    adjustment: Adjustment
    bars: list[KlineBar]
    as_of: datetime | str | None = None
    fetched_at: datetime = Field(default_factory=lambda: datetime.now(UTC))
    metadata: dict[str, Any] = Field(default_factory=dict)
    fetch: FetchMetadata = Field(default_factory=FetchMetadata)
    data_quality: DataQuality = Field(default_factory=DataQuality)

    @model_validator(mode="after")
    def fill_quality(self) -> KlineResponse:
        self.as_of = self.as_of or (self.bars[-1].date if self.bars else self.fetched_at)
        if not self.bars:
            self.data_quality = DataQuality(
                status="warning",
                missing_fields=["bars"],
                warnings=["历史 K 线未返回样本。"],
            )
        return self


class TechnicalIndicatorPoint(BaseModel):
    date: str
    open: Decimal | None = None
    close: Decimal | None = None
    high: Decimal | None = None
    low: Decimal | None = None
    previous_close: Decimal | None = None
    volume: int | None = None
    amount: Decimal | None = None
    ma5: Decimal | None = None
    ma10: Decimal | None = None
    ma20: Decimal | None = None
    ma30: Decimal | None = None
    ma60: Decimal | None = None
    return_pct: Decimal | None = None
    drawdown_pct: Decimal | None = None


class TechnicalIndicatorSummary(BaseModel):
    latest_close: Decimal | None = None
    period_return_pct: Decimal | None = None
    max_drawdown_pct: Decimal | None = None
    volatility_annualized_pct: Decimal | None = None
    avg_volume20: Decimal | None = None
    ma5: Decimal | None = None
    ma10: Decimal | None = None
    ma20: Decimal | None = None
    ma30: Decimal | None = None
    ma60: Decimal | None = None


class TechnicalIndicatorsResponse(BaseModel):
    symbol: str
    name: str | None = None
    secid: str
    asset_type: AssetType = "stock"
    market: MarketCode = "UNKNOWN"
    source: str = "eastmoney"
    currency: str = "CNY"
    timezone: str = "Asia/Shanghai"
    period: KlinePeriod
    adjustment: Adjustment
    points: list[TechnicalIndicatorPoint]
    summary: TechnicalIndicatorSummary
    as_of: datetime | str | None = None
    fetched_at: datetime = Field(default_factory=lambda: datetime.now(UTC))
    metadata: dict[str, Any] = Field(default_factory=dict)
    fetch: FetchMetadata = Field(default_factory=FetchMetadata)
    data_quality: DataQuality = Field(default_factory=DataQuality)

    @model_validator(mode="after")
    def fill_quality(self) -> TechnicalIndicatorsResponse:
        self.as_of = self.as_of or (self.points[-1].date if self.points else self.fetched_at)
        if len(self.points) < 20:
            self.data_quality = DataQuality(
                status="warning",
                missing_fields=["points"] if not self.points else [],
                warnings=["技术指标样本少于 20 条，MA20 或波动率解释需谨慎。"],
            )
        return self


class FinancialReportItem(BaseModel):
    symbol: str
    name: str | None = None
    secucode: str | None = None
    report_date: datetime | None = None
    data_type: str | None = None
    basic_eps: Decimal | None = None
    revenue: Decimal | None = None
    parent_net_profit: Decimal | None = None
    weighted_roe: Decimal | None = None
    gross_margin: Decimal | None = None
    revenue_yoy: Decimal | None = None
    net_profit_yoy: Decimal | None = None
    operating_cash_flow_per_share: Decimal | None = None
    notice_date: datetime | None = None
    source: str = "eastmoney"
    raw: dict[str, Any] = Field(default_factory=dict)


class FinancialReportsResponse(BaseModel):
    symbol: str
    asset_type: AssetType = "stock"
    source: str = "eastmoney"
    currency: str = "CNY"
    timezone: str = "Asia/Shanghai"
    reports: list[FinancialReportItem]
    as_of: datetime | str | None = None
    fetched_at: datetime = Field(default_factory=lambda: datetime.now(UTC))
    fetch: FetchMetadata = Field(default_factory=FetchMetadata)
    data_quality: DataQuality = Field(default_factory=DataQuality)

    @model_validator(mode="after")
    def fill_quality(self) -> FinancialReportsResponse:
        self.as_of = self.as_of or (
            self.reports[0].report_date if self.reports else self.fetched_at
        )
        if not self.reports:
            self.data_quality = DataQuality(
                status="warning",
                missing_fields=["reports"],
                warnings=["财务摘要未返回报告期数据。"],
            )
        return self


class FundamentalIndicatorPoint(BaseModel):
    report_date: datetime | None = None
    data_type: str | None = None
    revenue: Decimal | None = None
    parent_net_profit: Decimal | None = None
    revenue_yoy: Decimal | None = None
    net_profit_yoy: Decimal | None = None
    operating_cash_flow_per_share: Decimal | None = None
    operating_cash_flow_per_share_yoy: Decimal | None = None
    gross_margin: Decimal | None = None
    weighted_roe: Decimal | None = None
    net_margin: Decimal | None = None


class FundamentalIndicatorSummary(BaseModel):
    latest_report_date: datetime | None = None
    latest_revenue: Decimal | None = None
    latest_parent_net_profit: Decimal | None = None
    latest_revenue_yoy: Decimal | None = None
    latest_net_profit_yoy: Decimal | None = None
    latest_operating_cash_flow_per_share: Decimal | None = None
    latest_operating_cash_flow_per_share_yoy: Decimal | None = None
    latest_gross_margin: Decimal | None = None
    latest_weighted_roe: Decimal | None = None
    latest_net_margin: Decimal | None = None
    avg_roe: Decimal | None = None
    avg_gross_margin: Decimal | None = None
    avg_net_margin: Decimal | None = None
    report_count: int = 0


class FundamentalIndicatorsResponse(BaseModel):
    symbol: str
    asset_type: AssetType = "stock"
    source: str = "eastmoney"
    currency: str = "CNY"
    timezone: str = "Asia/Shanghai"
    points: list[FundamentalIndicatorPoint]
    summary: FundamentalIndicatorSummary
    as_of: datetime | str | None = None
    fetched_at: datetime = Field(default_factory=lambda: datetime.now(UTC))
    fetch: FetchMetadata = Field(default_factory=FetchMetadata)
    data_quality: DataQuality = Field(default_factory=DataQuality)

    @model_validator(mode="after")
    def fill_quality(self) -> FundamentalIndicatorsResponse:
        self.as_of = self.as_of or (self.points[0].report_date if self.points else self.fetched_at)
        if len(self.points) < 4:
            self.data_quality = DataQuality(
                status="warning",
                missing_fields=["points"] if not self.points else [],
                warnings=["财务指标样本少于 4 期，趋势解释需谨慎。"],
            )
        return self


class AnnouncementItem(BaseModel):
    art_code: str
    title: str
    symbol: str | None = None
    name: str | None = None
    notice_date: datetime | None = None
    display_time: datetime | None = None
    columns: list[str] = Field(default_factory=list)
    url: str | None = None
    pdf_url: str | None = None
    source: str = "eastmoney"
    raw: dict[str, Any] = Field(default_factory=dict)


class AnnouncementResponse(BaseModel):
    symbol: str
    asset_type: AssetType = "stock"
    source: str = "eastmoney"
    timezone: str = "Asia/Shanghai"
    announcements: list[AnnouncementItem]
    as_of: datetime | str | None = None
    fetched_at: datetime = Field(default_factory=lambda: datetime.now(UTC))
    fetch: FetchMetadata = Field(default_factory=FetchMetadata)
    data_quality: DataQuality = Field(default_factory=DataQuality)

    @model_validator(mode="after")
    def fill_quality(self) -> AnnouncementResponse:
        first = self.announcements[0] if self.announcements else None
        self.as_of = self.as_of or (first.notice_date if first else self.fetched_at)
        if not self.announcements:
            self.data_quality = DataQuality(
                status="warning",
                missing_fields=["announcements"],
                warnings=["公告接口未返回近期公告。"],
            )
        return self


class BacktestEquityPoint(BaseModel):
    date: str
    close: Decimal | None = None
    fast_ma: Decimal | None = None
    slow_ma: Decimal | None = None
    position: int = 0
    daily_return_pct: Decimal | None = None
    strategy_return_pct: Decimal | None = None
    equity: Decimal
    drawdown_pct: Decimal | None = None


class BacktestTrade(BaseModel):
    entry_date: str
    entry_price: Decimal
    exit_date: str | None = None
    exit_price: Decimal | None = None
    return_pct: Decimal | None = None
    holding_days: int = 0
    status: Literal["open", "closed"] = "open"


class BacktestSummary(BaseModel):
    start_date: str | None = None
    end_date: str | None = None
    sample_count: int = 0
    initial_cash: Decimal
    final_equity: Decimal
    total_return_pct: Decimal | None = None
    benchmark_return_pct: Decimal | None = None
    excess_return_pct: Decimal | None = None
    max_drawdown_pct: Decimal | None = None
    annualized_return_pct: Decimal | None = None
    volatility_annualized_pct: Decimal | None = None
    sharpe: Decimal | None = None
    trade_count: int = 0
    win_rate_pct: Decimal | None = None
    exposure_pct: Decimal | None = None


class BacktestResponse(BaseModel):
    symbol: str
    name: str | None = None
    secid: str
    asset_type: AssetType = "stock"
    market: MarketCode = "UNKNOWN"
    source: str = "eastmoney"
    currency: str = "CNY"
    timezone: str = "Asia/Shanghai"
    strategy_id: str = "ma_crossover"
    strategy_name: str = "均线突破"
    fast_window: int
    slow_window: int
    fee_bps: Decimal
    parameters: dict[str, Any] = Field(default_factory=dict)
    period: KlinePeriod
    adjustment: Adjustment
    side: Literal["long", "flat"] = "long"
    equity_curve: list[BacktestEquityPoint]
    trades: list[BacktestTrade]
    summary: BacktestSummary
    as_of: datetime | str | None = None
    fetched_at: datetime = Field(default_factory=lambda: datetime.now(UTC))
    metadata: dict[str, Any] = Field(default_factory=dict)
    fetch: FetchMetadata = Field(default_factory=FetchMetadata)
    data_quality: DataQuality = Field(default_factory=DataQuality)

    @model_validator(mode="after")
    def fill_quality(self) -> BacktestResponse:
        self.as_of = self.as_of or (
            self.equity_curve[-1].date if self.equity_curve else self.fetched_at
        )
        if len(self.equity_curve) < self.slow_window + 5:
            self.data_quality = DataQuality(
                status="warning",
                missing_fields=["equity_curve"] if not self.equity_curve else [],
                warnings=["回测样本偏少，均线策略指标解释需谨慎。"],
            )
        return self


class ScreenerCandidate(BaseModel):
    symbol: str
    code: str
    name: str | None = None
    exchange: MarketCode = "UNKNOWN"
    sector_tags: list[str] = Field(default_factory=list)
    trade_date: date
    close: Decimal | None = None
    open: Decimal | None = None
    high: Decimal | None = None
    low: Decimal | None = None
    previous_close: Decimal | None = None
    change_percent: Decimal | None = None
    amount: Decimal | None = None
    turnover: Decimal | None = None
    ma5: Decimal | None = None
    ma10: Decimal | None = None
    ma20: Decimal | None = None
    ma30: Decimal | None = None
    ma60: Decimal | None = None
    strength_20d_pct: Decimal | None = None
    amount_ratio_20d: Decimal | None = None
    limit_up_count_4d: int = 0
    limit_up_count_10d: int = 0
    latest_limit_up_date: date | None = None
    is_limit_up: bool | None = None
    is_limit_down: bool | None = None
    is_st: bool | None = None
    trade_status: str | None = None
    sample_count: int = 0
    score: Decimal | None = None
    signals: list[str] = Field(default_factory=list)
    warnings: list[str] = Field(default_factory=list)
    missing_fields: list[str] = Field(default_factory=list)


class AnalyticsExecutionMetadata(BaseModel):
    engine: str = "postgresql"
    status: str = "disabled"
    basis: str = "postgresql.quant.canonical_stock_bars"
    target_trade_date: date | None = None
    message: str | None = None


class AShareScreenerResponse(BaseModel):
    universe_id: str
    sector_scope: str | None = None
    mode: ScreenerMode = "short_term"
    trade_date: date | None = None
    timeframe: str = "daily"
    adjustment: str = "qfq"
    scanned_symbols: int = 0
    total_symbols: int = 0
    eligible_symbols: int = 0
    excluded_symbols: int = 0
    excluded_reasons: dict[str, int] = Field(default_factory=dict)
    safety_complete_symbols: int = 0
    safety_coverage_pct: float = 0
    coverage_warning: str | None = None
    total_candidates: int = 0
    limit: int = 20
    candidates: list[ScreenerCandidate] = Field(default_factory=list)
    data_basis: str = "postgresql.quant.canonical_stock_bars"
    analytics: AnalyticsExecutionMetadata = Field(default_factory=AnalyticsExecutionMetadata)
    source: str = "wolf-research-market-api"
    notes: list[str] = Field(default_factory=list)
    cache_status: CacheStatus = "bypass"
    cache_ttl_seconds: int | None = None
    fetched_at: datetime = Field(default_factory=lambda: datetime.now(UTC))
    data_quality: DataQuality = Field(default_factory=DataQuality)

    @model_validator(mode="after")
    def fill_quality(self) -> AShareScreenerResponse:
        self.total_candidates = len(self.candidates)
        self.total_symbols = max(self.total_symbols, self.scanned_symbols)
        self.scanned_symbols = self.total_symbols
        self.excluded_symbols = max(
            self.excluded_symbols, self.total_symbols - self.eligible_symbols
        )
        if not self.candidates:
            self.data_quality = DataQuality(
                status="warning",
                missing_fields=["candidates"],
                warnings=["本地筛选接口未返回候选股票，可能是条件过严或最新交易日覆盖不足。"],
            )
        return self


class ResearchUniverseMember(BaseModel):
    symbol: str
    code: str
    name: str | None = None
    exchange: MarketCode = "UNKNOWN"
    asset_type: AssetType = "stock"
    role: str = "member"
    metadata: dict[str, Any] = Field(default_factory=dict)


class ResearchUniverseSummary(BaseModel):
    id: str
    name: str
    member_count: int = 0
    stock_count: int = 0
    ready_count: int = 0
    bar_count: int = 0
    latest_ts: datetime | None = None


class ResearchUniverseSummaryResponse(BaseModel):
    universes: list[ResearchUniverseSummary]
    fetched_at: datetime = Field(default_factory=lambda: datetime.now(UTC))
    data_quality: DataQuality = Field(default_factory=DataQuality)


class ResearchUniverseMembersResponse(BaseModel):
    universe_id: str
    page: int
    page_size: int
    total: int
    total_pages: int
    members: list[ResearchUniverseMember]
    fetched_at: datetime = Field(default_factory=lambda: datetime.now(UTC))


class LocalKlineBar(BaseModel):
    ts: datetime
    open: Decimal
    high: Decimal
    low: Decimal
    close: Decimal
    previous_close: Decimal | None = None
    volume: Decimal = Decimal("0")
    amount: Decimal | None = None
    change_percent: Decimal | None = None
    turnover: Decimal | None = None
    trade_status: str | None = None
    is_st: bool | None = None
    limit_up: bool | None = None
    limit_down: bool | None = None
    provider: str = "local"
    metadata: dict[str, Any] = Field(default_factory=dict)


class LocalKlineSummary(BaseModel):
    row_count: int = 0
    first_ts: datetime | None = None
    last_ts: datetime | None = None
    latest_close: Decimal | None = None
    previous_close: Decimal | None = None
    return_pct: Decimal | None = None
    high: Decimal | None = None
    low: Decimal | None = None
    total_volume: Decimal | None = None
    total_amount: Decimal | None = None


class LocalKlineResponse(BaseModel):
    symbol: str
    code: str | None = None
    name: str | None = None
    exchange: MarketCode = "UNKNOWN"
    asset_type: AssetType = "stock"
    secid: str | None = None
    provider: str | None = None
    timeframe: str = "daily"
    adjustment: str = "qfq"
    bars: list[LocalKlineBar]
    summary: LocalKlineSummary
    fetched_at: datetime = Field(default_factory=lambda: datetime.now(UTC))
    data_quality: DataQuality = Field(default_factory=DataQuality)


class AnalysisContextSection(BaseModel):
    status: Literal["ok", "warning", "error"]
    duration_ms: int = 0
    data: dict[str, Any] | None = None
    data_quality: DataQuality = Field(default_factory=DataQuality)
    error: dict[str, Any] | None = None


class AnalysisContextResponse(BaseModel):
    schema_version: Literal[1] = 1
    symbol: str
    status: Literal["ready", "partial", "unavailable"]
    requested_sections: list[str]
    sections: dict[str, AnalysisContextSection]
    duration_ms: int = 0
    fetched_at: datetime = Field(default_factory=lambda: datetime.now(UTC))
    data_quality: DataQuality = Field(default_factory=DataQuality)


class ProviderInfo(BaseModel):
    id: str
    name: str
    category: str
    status: Literal["available", "planned", "degraded"]
    description: str
    endpoints: list[str] = Field(default_factory=list)
    cache_ttl_seconds: int | None = None
    limitations: list[str] = Field(default_factory=list)


class RegistryResponse(BaseModel):
    providers: list[ProviderInfo]
