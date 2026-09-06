from __future__ import annotations

from datetime import UTC, datetime
from decimal import ROUND_HALF_UP, Decimal
from math import sqrt

from quantpilot_market_data.cache import MarketDataCache
from quantpilot_market_data.config import MarketSettings
from quantpilot_market_data.models import (
    Adjustment,
    BacktestEquityPoint,
    BacktestResponse,
    BacktestSummary,
    BacktestTrade,
    KlinePeriod,
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


def _ma(closes: list[Decimal | None], index: int, window: int) -> Decimal | None:
    if index + 1 < window:
        return None
    values = closes[index + 1 - window : index + 1]
    return (
        _mean([value for value in values if value is not None])
        if all(value is not None for value in values)
        else None
    )


def _return(current: Decimal | None, previous: Decimal | None) -> Decimal | None:
    if current is None or previous in (None, Decimal("0")):
        return None
    return (current - previous) / previous * Decimal("100")


def build_ma_crossover_backtest(
    *,
    kline,
    fast_window: int,
    slow_window: int,
    initial_cash: Decimal,
    fee_bps: Decimal,
) -> BacktestResponse:
    if fast_window < 2 or slow_window < 3 or fast_window >= slow_window:
        raise ValueError("fast_window 必须小于 slow_window，且分别不小于 2 和 3。")
    if initial_cash <= 0:
        raise ValueError("initial_cash 必须大于 0。")
    if fee_bps < 0:
        raise ValueError("fee_bps 不能为负数。")

    closes = [bar.close for bar in kline.bars]
    equity = initial_cash
    peak_equity = equity
    position = 0
    entry_index: int | None = None
    current_trade: BacktestTrade | None = None
    trades: list[BacktestTrade] = []
    equity_curve: list[BacktestEquityPoint] = []
    strategy_returns: list[Decimal] = []
    fee_rate = fee_bps / Decimal("10000")

    for index, bar in enumerate(kline.bars):
        previous = closes[index - 1] if index else None
        daily_return = _return(bar.close, previous)
        strategy_return = Decimal("0")
        if position and daily_return is not None:
            strategy_return = daily_return / Decimal("100")
            equity *= Decimal("1") + strategy_return
            strategy_returns.append(daily_return)

        fast = _ma(closes, index, fast_window)
        slow = _ma(closes, index, slow_window)
        previous_fast = _ma(closes, index - 1, fast_window) if index else None
        previous_slow = _ma(closes, index - 1, slow_window) if index else None
        enter = (
            not position
            and fast is not None
            and slow is not None
            and previous_fast is not None
            and previous_slow is not None
            and previous_fast <= previous_slow
            and fast > slow
        )
        exit = (
            bool(position)
            and fast is not None
            and slow is not None
            and previous_fast is not None
            and previous_slow is not None
            and previous_fast >= previous_slow
            and fast < slow
        )
        if enter and bar.close is not None:
            equity *= Decimal("1") - fee_rate
            position = 1
            entry_index = index
            current_trade = BacktestTrade(entry_date=bar.date, entry_price=bar.close, status="open")
        elif (
            exit and current_trade is not None and bar.close is not None and entry_index is not None
        ):
            equity *= Decimal("1") - fee_rate
            result = _return(bar.close, current_trade.entry_price)
            trades.append(
                current_trade.model_copy(
                    update={
                        "exit_date": bar.date,
                        "exit_price": bar.close,
                        "return_pct": _round(result),
                        "holding_days": max(0, index - entry_index),
                        "status": "closed",
                    }
                )
            )
            current_trade = None
            entry_index = None
            position = 0
        peak_equity = max(peak_equity, equity)
        drawdown = (equity - peak_equity) / peak_equity * Decimal("100") if peak_equity else None
        equity_curve.append(
            BacktestEquityPoint(
                date=bar.date,
                close=bar.close,
                fast_ma=_round(fast),
                slow_ma=_round(slow),
                position=position,
                daily_return_pct=_round(daily_return),
                strategy_return_pct=_round(strategy_return * Decimal("100")),
                equity=_round(equity, 6) or Decimal("0"),
                drawdown_pct=_round(drawdown),
            )
        )

    if current_trade is not None and entry_index is not None and equity_curve:
        last = equity_curve[-1]
        result = _return(last.close, current_trade.entry_price)
        trades.append(
            current_trade.model_copy(
                update={
                    "return_pct": _round(result),
                    "holding_days": max(0, len(equity_curve) - 1 - entry_index),
                }
            )
        )
    benchmark = _return(closes[-1], closes[0]) if len(closes) > 1 else None
    total = _return(equity, initial_cash)
    mean_return = _mean(strategy_returns)
    volatility = None
    if len(strategy_returns) > 1 and mean_return is not None:
        variance = sum((value - mean_return) ** 2 for value in strategy_returns) / Decimal(
            len(strategy_returns)
        )
        volatility = Decimal(str(sqrt(float(variance)) * sqrt(252)))
    sharpe = (
        (mean_return / (volatility / Decimal(str(sqrt(252)))) * Decimal(str(sqrt(252))))
        if mean_return and volatility
        else None
    )
    closed = [
        trade for trade in trades if trade.status == "closed" and trade.return_pct is not None
    ]
    summary = BacktestSummary(
        start_date=equity_curve[0].date if equity_curve else None,
        end_date=equity_curve[-1].date if equity_curve else None,
        sample_count=len(equity_curve),
        initial_cash=initial_cash,
        final_equity=equity,
        total_return_pct=_round(total),
        benchmark_return_pct=_round(benchmark),
        excess_return_pct=_round(total - benchmark)
        if total is not None and benchmark is not None
        else None,
        max_drawdown_pct=min(
            (point.drawdown_pct for point in equity_curve if point.drawdown_pct is not None),
            default=None,
        ),
        annualized_return_pct=_round(
            Decimal(
                str(
                    (float(equity / initial_cash) ** (252 / max(1, len(equity_curve) - 1)) - 1)
                    * 100
                )
            )
        )
        if equity > 0 and equity_curve
        else None,
        volatility_annualized_pct=_round(volatility),
        sharpe=_round(sharpe),
        trade_count=len(trades),
        win_rate_pct=_round(
            Decimal(len([trade for trade in closed if trade.return_pct and trade.return_pct > 0]))
            / Decimal(len(closed))
            * 100,
            2,
        )
        if closed
        else None,
        exposure_pct=_round(
            Decimal(sum(point.position for point in equity_curve))
            / Decimal(len(equity_curve))
            * 100,
            2,
        )
        if equity_curve
        else None,
    )
    return BacktestResponse(
        symbol=kline.symbol,
        name=kline.name,
        secid=kline.secid,
        asset_type=kline.asset_type,
        market=kline.market,
        source=kline.source,
        strategy_id="ma_crossover",
        strategy_name="均线交叉趋势",
        fast_window=fast_window,
        slow_window=slow_window,
        fee_bps=fee_bps,
        parameters={
            "fast_window": fast_window,
            "slow_window": slow_window,
            "fee_bps": str(fee_bps),
        },
        period=kline.period,
        adjustment=kline.adjustment,
        side="long" if position else "flat",
        equity_curve=equity_curve,
        trades=trades,
        summary=summary,
        as_of=kline.as_of,
        fetched_at=datetime.now(UTC),
        metadata={"data_basis": "local_ma_crossover"},
        fetch=kline.fetch,
    )


async def get_ma_crossover_backtest(
    client: EastMoneyClient,
    cache: MarketDataCache,
    settings: MarketSettings,
    *,
    symbol: str,
    fast_window: int,
    slow_window: int,
    period: KlinePeriod,
    adjustment: Adjustment,
    limit: int,
    end: str,
    initial_cash: Decimal,
    fee_bps: Decimal,
) -> BacktestResponse:
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
    return build_ma_crossover_backtest(
        kline=kline,
        fast_window=fast_window,
        slow_window=slow_window,
        initial_cash=initial_cash,
        fee_bps=fee_bps,
    )
