"""Schedule index signals and the Shanghai/Shenzhen/Beijing turnover display."""
from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from datetime import timedelta
import logging
import threading
import time

from market_feed import (ALL_A, INDEXES, MarketTotal, closing_market_total, exchange_bar_open,
                         five_minute_klines, historical_baselines, index_bar, index_quotes,
                         live_index_bar, market_total, minute_of, trading_session, trends)
from market_signals import SignalTracker

POLL_SECONDS = 20
LOG = logging.getLogger('nga-watcher')


def poll_session(now):
    # Receive the last exchange-stamped snapshot even if it arrives just after the bell.
    return trading_session(now) or trading_session(now - timedelta(seconds=40))


@dataclass
class MarketBatch:
    indexes: dict = field(default_factory=dict)
    total: MarketTotal | None = None
    errors: dict = field(default_factory=dict)


class MarketFeed:
    def __init__(self):
        self.history = {}
        self.retry_after = {}
        self.opens = {}

    def bar_open(self, symbol, end):
        entry = self.opens.get(symbol)
        if not entry or entry[0] != end:
            entry = self.opens[symbol] = (end, exchange_bar_open(symbol, end))
        return entry[1]

    def snapshot(self, symbol, now, quotes):
        if quotes is not None:
            try:
                quote = quotes.result().get(symbol)
                if quote and -5 <= (now - quote.timestamp).total_seconds() <= 40:
                    bars = five_minute_klines(symbol, now.date(), 48)
                    return live_index_bar(quote, bars)
            except Exception as exc:
                LOG.debug('Using stamped minute data for %s: %s', symbol, exc)
        return index_bar(trends('1.' + symbol[2:], 1), lambda end: self.bar_open(symbol, end))

    def index(self, symbol, now, quotes=None):
        bar = self.snapshot(symbol, now, quotes)
        opening_base = None
        if bar.rolling_base is None and bar.asof.date() == now.date():
            day = bar.asof.date()
            entry = self.history.get(symbol)
            if (entry is None or entry[0] != day) and time.monotonic() >= self.retry_after.get(symbol, 0):
                try:
                    entry = (day, historical_baselines(symbol, day))
                    self.history[symbol] = entry
                except Exception as exc:
                    self.retry_after[symbol] = time.monotonic() + 60
                    LOG.warning('Index opening baseline unavailable %s: %s', symbol, exc)
            if entry and entry[0] == day:
                opening_base = entry[1].get(minute_of(bar.end))
        return bar, opening_base

    @staticmethod
    def total(now, live):
        try:
            return market_total(trends(ALL_A, 2), now)
        except Exception:
            if live:
                raise
            return closing_market_total(now)

    def fetch(self, now, live):
        batch = MarketBatch()
        with ThreadPoolExecutor(max_workers=4) as pool:
            tasks = {ALL_A: pool.submit(self.total, now, live)}
            if live:
                quotes = pool.submit(index_quotes)
                tasks.update({symbol: pool.submit(self.index, symbol, now, quotes) for symbol in INDEXES})
            for symbol, task in tasks.items():
                try:
                    value = task.result()
                    if symbol == ALL_A:
                        batch.total = value
                    else:
                        batch.indexes[symbol] = value
                except Exception as exc:
                    batch.errors[symbol] = str(exc) if isinstance(exc, ValueError) else '行情请求失败'
                    LOG.warning('Market data unavailable %s: %s', symbol, exc)
        return batch


class MarketMonitor:
    def __init__(self, events, saved=None):
        self.events = events
        self.feed = MarketFeed()
        saved = saved if isinstance(saved, dict) else {}
        self.trackers = {s: SignalTracker(s, saved.get(s)) for s in INDEXES}
        self.notes = {}
        self.total = None
        self.total_note = ''
        self.phase = None
        self.next_poll = 0
        self.generation = 0
        self.busy = False

    def checkpoint(self):
        return {s: t.checkpoint() for s, t in self.trackers.items() if t.signal_end}

    def reset(self):
        self.generation += 1
        self.next_poll = 0
        self.notes.clear()

    def sync_session(self, now):
        phase = now.date(), poll_session(now)
        if self.phase != phase:
            self.phase = phase
            self.reset()

    def tick(self, now, monotonic, paused):
        self.sync_session(now)
        if paused or self.busy or monotonic < self.next_poll:
            return
        self.busy = True
        live = self.phase[1] is not None
        self.next_poll = monotonic + (POLL_SECONDS if live else 1800)
        generation = self.generation

        def work():
            try:
                batch = self.feed.fetch(now, live)
            except Exception as exc:
                LOG.warning('Market poll failed: %s', exc)
                batch = MarketBatch(errors={s: '行情请求失败' for s in (*INDEXES, ALL_A)})
            self.events.put(('market', (generation, batch)))

        threading.Thread(target=work, name='market-turnover', daemon=True).start()

    def receive(self, result, now, paused):
        self.busy = False
        self.sync_session(now)
        generation, batch = result
        if paused or generation != self.generation:
            return []
        self.total_note = batch.errors.get(ALL_A, '')
        if batch.total and (self.total is None or batch.total.asof >= self.total.asof):
            self.total = batch.total
            LOG.debug('All-A turnover asof=%s amount=%.0f previous=%s',
                      self.total.asof, self.total.amount, self.total.previous)
        if self.phase[1] is None:
            if self.total_note:
                self.next_poll = min(self.next_poll, time.monotonic() + 60)
            return []
        if self.total and not self.total_note and (
                self.total.asof.date() != now.date() or (now - self.total.asof).total_seconds() > 120):
            self.total_note = '等待最新完整分钟'
        alerts = []
        for symbol, tracker in self.trackers.items():
            if symbol not in batch.indexes:
                self.notes[symbol] = batch.errors.get(symbol, '行情缺失')
                continue
            bar, opening_base = batch.indexes[symbol]
            if trading_session(bar.asof) != self.phase[1]:
                self.notes[symbol] = '等待当前交易时段的报价'
                continue
            self.notes[symbol], alert = tracker.observe(bar, opening_base, now)
            if alert:
                alerts.append(alert)
                LOG.info('Index turnover signal symbol=%s stage=%d end=%s actual=%.0f effective=%.0f base=%.0f',
                         symbol, alert.stage, alert.bar_end, alert.amount, alert.effective, alert.baseline)
        return alerts

    def status(self, paused):
        total = self.total.describe() if self.total else '全 A 成交额（沪深北） · 等待行情'
        if self.total_note:
            total += '  ·  ' + self.total_note
        if paused:
            activity = '已暂停'
        elif not self.phase or self.phase[1] is None:
            activity = '等待盘中时段（北京时间 09:30–11:30 / 13:00–15:00）'
        else:
            activity = '每 20 秒检查'
        lines = [total, '五分钟成交额  ·  ' + activity]
        for symbol, tracker in self.trackers.items():
            bar = tracker.last
            value = (f'{bar.asof:%H:%M:%S} · 本根 {bar.amount / 1e8:,.2f} 亿元'
                     if bar and self.phase and self.phase[1] == trading_session(bar.asof) else '')
            note = self.notes.get(symbol, '')
            lines.append('  ·  '.join(p for p in [INDEXES[symbol], value, note] if p))
        return '\n'.join(lines)
