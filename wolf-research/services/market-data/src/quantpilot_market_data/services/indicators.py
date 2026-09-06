from __future__ import annotations

from decimal import ROUND_HALF_UP, Decimal
from math import sqrt

from quantpilot_market_data.cache import MarketDataCache
from quantpilot_market_data.config import MarketSettings
from quantpilot_market_data.models import (
    KlineResponse,
    TechnicalIndicatorPoint,
    TechnicalIndicatorsResponse,
    TechnicalIndicatorSummary,
)
from quantpilot_market_data.providers.eastmoney import EastMoneyClient
from quantpilot_market_data.services.quotes import get_history_quote


def _round(value: Decimal | None, places: int = 4) -> Decimal | None:
    return (
        value.quantize(Decimal("1").scaleb(-places), rounding=ROUND_HALF_UP)
        if value is not None
        else None
    )


def _mean(values: list[Decimal]) -> Decimal | None:
    return sum(values, Decimal("0")) / Decimal(len(values)) if values else None


def _rolling(values: list[Decimal | None], index: int, window: int) -> Decimal | None:
    if index + 1 < window:
        return None
    sample = values[index + 1 - window : index + 1]
    if any(value is None for value in sample):
        return None
    return _mean([value for value in sample if value is not None])


def build_technical_indicators(kline: KlineResponse) -> TechnicalIndicatorsResponse:
    closes = [bar.close for bar in kline.bars]
    peak: Decimal | None = None
    returns: list[Decimal] = []
    points: list[TechnicalIndicatorPoint] = []
    for index, bar in enumerate(kline.bars):
        if bar.close is not None:
            peak = bar.close if peak is None else max(peak, bar.close)
        previous = closes[index - 1] if index else None
        return_pct = (
            ((bar.close - previous) / previous * Decimal("100"))
            if bar.close is not None and previous
            else None
        )
        if return_pct is not None:
            returns.append(return_pct)
        drawdown = (
            ((bar.close - peak) / peak * Decimal("100")) if bar.close is not None and peak else None
        )
        points.append(
            TechnicalIndicatorPoint(
                date=bar.date,
                open=bar.open,
                close=bar.close,
                high=bar.high,
                low=bar.low,
                previous_close=bar.previous_close,
                volume=bar.volume,
                amount=bar.amount,
                ma5=_round(_rolling(closes, index, 5)),
                ma10=_round(_rolling(closes, index, 10)),
                ma20=_round(_rolling(closes, index, 20)),
                ma30=_round(_rolling(closes, index, 30)),
                ma60=_round(_rolling(closes, index, 60)),
                return_pct=_round(return_pct),
                drawdown_pct=_round(drawdown),
            )
        )
    valid_closes = [close for close in closes if close is not None]
    valid_returns = [value for value in returns if value is not None]
    volatility = None
    if len(valid_returns) >= 2:
        mean_return = _mean(valid_returns)
        if mean_return is not None:
            variance = sum((value - mean_return) ** 2 for value in valid_returns) / Decimal(
                len(valid_returns)
            )
            volatility = Decimal(str(sqrt(float(variance)) * sqrt(252)))
    drawdowns = [point.drawdown_pct for point in points if point.drawdown_pct is not None]
    latest = points[-1] if points else None
    summary = TechnicalIndicatorSummary(
        latest_close=valid_closes[-1] if valid_closes else None,
        period_return_pct=((valid_closes[-1] - valid_closes[0]) / valid_closes[0] * Decimal("100"))
        if len(valid_closes) > 1 and valid_closes[0]
        else None,
        max_drawdown_pct=min(drawdowns) if drawdowns else None,
        volatility_annualized_pct=_round(volatility),
        avg_volume20=_round(
            _mean([Decimal(bar.volume) for bar in kline.bars[-20:] if bar.volume is not None]), 2
        ),
        ma5=latest.ma5 if latest else None,
        ma10=latest.ma10 if latest else None,
        ma20=latest.ma20 if latest else None,
        ma30=latest.ma30 if latest else None,
        ma60=latest.ma60 if latest else None,
    )
    return TechnicalIndicatorsResponse(
        symbol=kline.symbol,
        name=kline.name,
        secid=kline.secid,
        asset_type=kline.asset_type,
        market=kline.market,
        source=kline.source,
        period=kline.period,
        adjustment=kline.adjustment,
        points=points,
        summary=summary,
        as_of=kline.as_of,
        fetched_at=kline.fetched_at,
        metadata=kline.metadata,
        fetch=kline.fetch,
    )


async def get_technical_indicators(
    client: EastMoneyClient,
    cache: MarketDataCache,
    settings: MarketSettings,
    *,
    symbol: str,
    period: str,
    adjustment: str,
    limit: int,
    end: str,
) -> TechnicalIndicatorsResponse:
    kline = await get_history_quote(
        client,
        cache,
        settings,
        symbol=symbol,
        period=period,
        adjustment=adjustment,
        limit=limit,
        end=end,
    )
    return build_technical_indicators(kline)
