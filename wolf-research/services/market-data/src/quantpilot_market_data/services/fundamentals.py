from __future__ import annotations

from datetime import UTC, datetime
from decimal import ROUND_HALF_UP, Decimal

from quantpilot_market_data.cache import MarketDataCache, cache_response, read_cached_response
from quantpilot_market_data.config import MarketSettings
from quantpilot_market_data.models import (
    FinancialReportsResponse,
    FundamentalIndicatorPoint,
    FundamentalIndicatorsResponse,
    FundamentalIndicatorSummary,
)
from quantpilot_market_data.providers.eastmoney import EastMoneyClient


def _round(value: Decimal | None, places: int = 4) -> Decimal | None:
    return (
        value.quantize(Decimal("1").scaleb(-places), rounding=ROUND_HALF_UP)
        if value is not None
        else None
    )


def build_fundamental_indicators(symbol: str, reports) -> FundamentalIndicatorsResponse:
    points: list[FundamentalIndicatorPoint] = []
    for index, report in enumerate(reports):
        net_margin = None
        if report.revenue not in (None, Decimal("0")) and report.parent_net_profit is not None:
            net_margin = report.parent_net_profit / report.revenue * Decimal("100")
        previous = reports[index + 1] if index + 1 < len(reports) else None
        ocf_yoy = None
        if (
            report.operating_cash_flow_per_share is not None
            and previous
            and previous.operating_cash_flow_per_share not in (None, Decimal("0"))
        ):
            ocf_yoy = (
                report.operating_cash_flow_per_share / previous.operating_cash_flow_per_share - 1
            ) * Decimal("100")
        points.append(
            FundamentalIndicatorPoint(
                report_date=report.report_date,
                data_type=report.data_type,
                revenue=report.revenue,
                parent_net_profit=report.parent_net_profit,
                revenue_yoy=report.revenue_yoy,
                net_profit_yoy=report.net_profit_yoy,
                operating_cash_flow_per_share=report.operating_cash_flow_per_share,
                operating_cash_flow_per_share_yoy=_round(ocf_yoy),
                gross_margin=report.gross_margin,
                weighted_roe=report.weighted_roe,
                net_margin=_round(net_margin),
            )
        )
    latest = points[0] if points else None
    summary = FundamentalIndicatorSummary(
        latest_report_date=latest.report_date if latest else None,
        latest_revenue=latest.revenue if latest else None,
        latest_parent_net_profit=latest.parent_net_profit if latest else None,
        latest_revenue_yoy=latest.revenue_yoy if latest else None,
        latest_net_profit_yoy=latest.net_profit_yoy if latest else None,
        latest_operating_cash_flow_per_share=latest.operating_cash_flow_per_share
        if latest
        else None,
        latest_operating_cash_flow_per_share_yoy=latest.operating_cash_flow_per_share_yoy
        if latest
        else None,
        latest_gross_margin=latest.gross_margin if latest else None,
        latest_weighted_roe=latest.weighted_roe if latest else None,
        latest_net_margin=latest.net_margin if latest else None,
        avg_roe=_round(
            _mean([point.weighted_roe for point in points if point.weighted_roe is not None])
        ),
        avg_gross_margin=_round(
            _mean([point.gross_margin for point in points if point.gross_margin is not None])
        ),
        avg_net_margin=_round(
            _mean([point.net_margin for point in points if point.net_margin is not None])
        ),
        report_count=len(points),
    )
    return FundamentalIndicatorsResponse(
        symbol=symbol,
        points=points,
        summary=summary,
        as_of=summary.latest_report_date,
        fetched_at=datetime.now(UTC),
    )


def _mean(values: list[Decimal]) -> Decimal | None:
    return sum(values, Decimal("0")) / Decimal(len(values)) if values else None


async def get_financial_reports(
    client: EastMoneyClient,
    cache: MarketDataCache,
    settings: MarketSettings,
    *,
    symbol: str,
    limit: int,
) -> FinancialReportsResponse:
    normalized = max(1, min(limit, 40))
    key = cache.build_key("fundamental-financials-v2", {"symbol": symbol, "limit": normalized})
    cached = read_cached_response(cache, key, FinancialReportsResponse)
    if cached is not None:
        return cached
    response = FinancialReportsResponse(
        symbol=symbol,
        reports=await client.get_financial_reports(symbol, normalized),
        fetched_at=datetime.now(UTC),
    )
    return cache_response(
        cache, key, settings.financial_cache_ttl_seconds, response, FinancialReportsResponse
    )


async def get_fundamental_indicators(
    client: EastMoneyClient,
    cache: MarketDataCache,
    settings: MarketSettings,
    *,
    symbol: str,
    limit: int,
) -> FundamentalIndicatorsResponse:
    normalized = max(1, min(limit, 40))
    key = cache.build_key("fundamental-indicators-v2", {"symbol": symbol, "limit": normalized})
    cached = read_cached_response(cache, key, FundamentalIndicatorsResponse)
    if cached is not None:
        return cached
    reports = await client.get_financial_reports(symbol, normalized)
    response = build_fundamental_indicators(symbol, reports)
    return cache_response(
        cache, key, settings.financial_cache_ttl_seconds, response, FundamentalIndicatorsResponse
    )
