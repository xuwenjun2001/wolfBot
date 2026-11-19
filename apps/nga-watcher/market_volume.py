"""Poll Tencent index snapshots and compare intraday volume rates."""
from __future__ import annotations

from collections import deque
from dataclasses import dataclass
from datetime import datetime, time as clock_time, timedelta, timezone
import logging
import re
from statistics import median
import threading
from urllib.error import HTTPError
from urllib.request import Request, urlopen

INDEXES = {'sh000001': '上证指数', 'sh000688': '科创50'}
QUOTE_URL = 'https://qt.gtimg.cn/q=' + ','.join(INDEXES)
CHINA = timezone(timedelta(hours=8))
HOURS = ((clock_time(9, 30), clock_time(11, 30)), (clock_time(13), clock_time(15)))
POLL_SECONDS = 20
BASELINE_MINUTES = 5
MIN_WINDOWS = 9
SPIKE_RATIO = 2.0
COOLDOWN_MINUTES = 5
MAX_QUOTE_AGE = 40
MIN_GAP, MAX_GAP = 10, 35
LOG = logging.getLogger('nga-watcher')


@dataclass(frozen=True)
class Quote:
    timestamp: datetime
    volume: int  # Cumulative lots for the trading day.


@dataclass(frozen=True)
class VolumeSpike:
    symbol: str
    timestamp: datetime
    volume: int
    seconds: int
    ratio: float

    def describe(self):
        return (f'{INDEXES[self.symbol]}（{self.symbol[2:]}） · {self.timestamp:%m-%d %H:%M:%S}\n'
                f'{self.seconds} 秒成交 {self.volume:,} 手，成交速度是此前水平的 {self.ratio:.1f} 倍')


def trading_session(now):
    now = now.astimezone(CHINA)
    if now.weekday() < 5:
        for number, (start, end) in enumerate(HOURS):
            if start <= now.time() < end:
                return now.date(), number
    return None


def parse_quotes(payload):
    results, seen = {}, set()
    for symbol, fields in re.findall(r'v_(sh[0-9]{6})\s*=\s*"([^"\r\n]*)"\s*;', payload):
        if symbol not in INDEXES:
            continue
        if symbol in seen:
            results.pop(symbol, None)
            continue
        seen.add(symbol)
        values = fields.split('~')
        if len(values) < 37 or values[2] != symbol[2:]:
            continue
        volume, timestamp = values[6], values[30]
        if not (re.fullmatch(r'[0-9]+', volume) and re.fullmatch(r'[0-9]{14}', timestamp)):
            continue
        try:
            results[symbol] = Quote(datetime.strptime(timestamp, '%Y%m%d%H%M%S').replace(tzinfo=CHINA),
                                    int(volume))
        except ValueError:
            continue
    return results


def fetch_quotes():
    request = Request(QUOTE_URL, headers={'User-Agent': 'Mozilla/5.0',
                                         'Referer': 'https://gu.qq.com/',
                                         'Cache-Control': 'no-cache'})
    limit = 16_384
    with urlopen(request, timeout=8) as response:
        payload = response.read(limit + 1)
    if len(payload) > limit:
        raise ValueError('行情响应超过大小限制')
    return parse_quotes(payload.decode('gb18030'))


class VolumeTracker:
    def __init__(self, symbol):
        self.symbol = symbol
        self.last_alert = None
        self.recent = deque()
        self.previous = None

    def reset(self):
        self.recent.clear()
        self.previous = None

    def observe(self, quote):
        previous = self.previous
        if previous is None:
            self.previous = quote
            return '预热中', None
        seconds = int((quote.timestamp - previous.timestamp).total_seconds())
        if seconds <= 0:
            return '等待报价刷新', None
        volume = quote.volume - previous.volume
        if (seconds > MAX_GAP or volume < 0
                or trading_session(quote.timestamp) != trading_session(previous.timestamp)):
            self.reset()
            self.previous = quote
            return '重新预热', None
        if seconds < MIN_GAP:
            return '等待下一个有效样本', None
        self.previous = quote
        cutoff = quote.timestamp - timedelta(minutes=BASELINE_MINUTES)
        while self.recent and self.recent[0][0] <= cutoff:
            self.recent.popleft()
        baseline = median(rate for _, rate in self.recent) if len(self.recent) >= MIN_WINDOWS else 0
        rate = volume / seconds
        self.recent.append((quote.timestamp, rate))
        if baseline <= 0:
            return f'预热中（{min(len(self.recent), MIN_WINDOWS)}/{MIN_WINDOWS}）', None
        ratio = rate / baseline
        status = f'最近 {seconds} 秒 {volume:,} 手 · {ratio:.2f} 倍'
        if ratio < SPIKE_RATIO:
            return status, None
        if self.last_alert and quote.timestamp - self.last_alert < timedelta(minutes=COOLDOWN_MINUTES):
            return status + ' · 提醒冷却中', None
        self.last_alert = quote.timestamp
        return status + ' · 放量', VolumeSpike(self.symbol, quote.timestamp, volume, seconds, ratio)


class MarketMonitor:
    """The UI thread owns all state. Only public quote fetching runs in the worker."""

    def __init__(self, events):
        self.events = events
        self.trackers = {symbol: VolumeTracker(symbol) for symbol in INDEXES}
        self.latest = {}
        self.notes = {}
        self.session = None
        self.next_poll = 0
        self.generation = 0
        self.busy = False

    def reset(self):
        self.generation += 1
        self.next_poll = 0
        self.notes.clear()
        for tracker in self.trackers.values():
            tracker.reset()

    def sync_session(self, now):
        session = trading_session(now)
        if session != self.session:
            self.session = session
            self.reset()

    def tick(self, now, monotonic, paused):
        self.sync_session(now)
        if paused or self.session is None or self.busy or monotonic < self.next_poll:
            return
        self.busy = True
        self.next_poll = monotonic + POLL_SECONDS
        generation = self.generation

        def work():
            error = ''
            try:
                quotes = fetch_quotes()
                missing = INDEXES.keys() - quotes.keys()
                if missing:
                    LOG.warning('Market quote missing or invalid: %s', ', '.join(sorted(missing)))
            except Exception as exc:
                LOG.warning('Market quote request failed: %s', exc)
                quotes = {}
                error = f'行情请求失败（HTTP {exc.code}）' if isinstance(exc, HTTPError) else '行情请求失败'
            self.events.put(('market', (generation, quotes, error)))

        threading.Thread(target=work, name='index-volume', daemon=True).start()

    def receive(self, result, now, paused):
        self.busy = False
        self.sync_session(now)
        generation, quotes, error = result
        if paused or self.session is None or generation != self.generation:
            return []
        alerts = []
        for symbol, tracker in self.trackers.items():
            quote = quotes.get(symbol)
            if quote is None:
                self.notes[symbol] = error or '行情缺失或格式异常'
                continue
            age = (now - quote.timestamp).total_seconds()
            if trading_session(quote.timestamp) != self.session or not -5 <= age <= MAX_QUOTE_AGE:
                self.notes[symbol] = f'无最新盘中报价（源时间 {quote.timestamp:%m-%d %H:%M:%S}）'
                continue
            previous = self.latest.get(symbol)
            if previous and quote.timestamp <= previous.timestamp:
                self.notes[symbol] = '等待报价刷新'
                continue
            self.latest[symbol] = quote
            self.notes[symbol], alert = tracker.observe(quote)
            if alert:
                LOG.info('Market volume spike symbol=%s time=%s lots=%s seconds=%s ratio=%.2f',
                         symbol, alert.timestamp, alert.volume, alert.seconds, alert.ratio)
                alerts.append(alert)
        return alerts

    def status(self, paused):
        if paused:
            heading = '指数成交量 · 已暂停'
        elif self.session is None:
            heading = '指数成交量 · 等待盘中时段（北京时间 09:30–11:30 / 13:00–15:00）'
        else:
            heading = (f'指数成交量 · 腾讯行情每 {POLL_SECONDS} 秒查询 · '
                       f'达到近 {BASELINE_MINUTES} 分钟典型成交速度的 {SPIKE_RATIO:g} 倍时提醒')
        lines = [heading]
        for symbol, name in INDEXES.items():
            quote = self.latest.get(symbol)
            displayed = (f'累计 {quote.volume / 10_000:,.2f} 万手 · {quote.timestamp:%m-%d %H:%M:%S}'
                         if quote else '暂无盘中数据')
            note = self.notes.get(symbol, '')
            lines.append(f'{name}  ·  {displayed}' + (f'  ·  {note}' if note else ''))
        return '\n'.join(lines)
