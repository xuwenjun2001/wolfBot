"""Two-stage turnover alerts on consecutive five-minute index bars."""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
import math

from market_feed import BAR_ENDS, CHINA, FIVE, INDEXES, IndexBar, minute_of, trading_session


@dataclass(frozen=True)
class Thresholds:
    first: float
    second: float
    floor: float  # CNY per five-minute bar


RULES = {'sh000001': Thresholds(1.8, 1.5, 150e8),
         'sh000688': Thresholds(2.0, 1.6, 20e8)}
STAGES = {1: '一重放量信号', 2: '二重放量强确认信号'}


@dataclass(frozen=True)
class TurnoverSignal:
    symbol: str
    bar_end: datetime
    timestamp: datetime
    stage: int
    amount: float
    effective: float
    baseline: float
    projected: bool

    def describe(self):
        basis = '按进度折算' if self.projected else '实际成交额达标'
        return (f'{STAGES[self.stage]} · {INDEXES[self.symbol]}（{self.symbol[2:]}）'
                f' · {self.timestamp:%m-%d %H:%M:%S}\n'
                f'{self.bar_end - FIVE:%H:%M}–{self.bar_end:%H:%M} 已成交 {self.amount / 1e8:,.2f} 亿元'
                f' · {basis} {self.effective / 1e8:,.2f} 亿元'
                f' · 基线 {self.baseline / 1e8:,.2f} 亿元的 {self.effective / self.baseline:.2f} 倍')


class SignalTracker:
    def __init__(self, symbol, saved=None):
        self.symbol = symbol
        self.last: IndexBar | None = None
        self.signal_end = None
        self.stage = 0
        self.locked_base = 0
        if isinstance(saved, dict):
            try:
                end = datetime.fromisoformat(saved['end'])
                baseline = float(saved['baseline'])
                stage = saved['stage']
                if (end.tzinfo is not None and minute_of(end.astimezone(CHINA)) in BAR_ENDS
                        and stage in STAGES and math.isfinite(baseline) and baseline > 0):
                    self.signal_end, self.stage, self.locked_base = end, stage, baseline
            except (ValueError, TypeError, KeyError):
                pass

    def checkpoint(self):
        if self.signal_end is not None:
            return {'end': self.signal_end.isoformat(), 'stage': self.stage, 'baseline': self.locked_base}
        return None

    def observe(self, bar, opening_base, now):
        session = trading_session(bar.asof)
        if (session is None or bar.asof.date() != now.astimezone(CHINA).date()
                or not -5 <= (now - bar.asof).total_seconds() <= 40):
            return '等待最新盘中行情', None
        if self.last:
            if bar.asof <= self.last.asof:
                return '等待报价更新', None
            if bar.end == self.last.end and bar.amount < self.last.amount:
                return '本根累计成交额回拨，等待核实', None
        self.last = bar
        if self.signal_end is not None and bar.end <= self.signal_end:
            return f'本根已提醒 · {STAGES[self.stage]}', None
        confirming = (self.stage == 1 and bar.end - FIVE == self.signal_end
                      and trading_session(self.signal_end) == session)
        stage = 2 if confirming else 1
        base = self.locked_base if confirming else (
            bar.rolling_base if bar.rolling_base is not None else opening_base)
        if base is None or base <= 0:
            return '等待有效成交额基线', None
        rules = RULES[self.symbol]
        target = max(rules.floor, (rules.second if confirming else rules.first) * base)
        elapsed = (bar.asof - (bar.end - FIVE)).total_seconds()
        if not 0 <= elapsed <= 300:
            return '等待本根行情', None
        projected = bar.amount < target
        if not projected:
            effective = bar.amount
        elif elapsed >= 60:
            effective = bar.amount * 300 / elapsed
        else:
            return ('等待二重确认' if confirming else '观察中') + ' · 未满 60 秒', None
        pos = (bar.last - bar.low) / max(bar.high - bar.low, 1e-6)
        buy_dir = ((bar.last >= bar.open and pos + 1e-12 >= 0.5)
                   or (bar.last + 1e-9 >= bar.prev_close * 0.9985 and pos + 1e-12 >= 0.65))
        if effective < target or not buy_dir:
            return ('等待二重确认' if confirming else '观察中') + f' · 等效 {effective / base:.2f} 倍', None
        self.signal_end, self.stage, self.locked_base = bar.end, stage, base
        signal = TurnoverSignal(self.symbol, bar.end, bar.asof, stage, bar.amount, effective, base, projected)
        return STAGES[stage], signal
