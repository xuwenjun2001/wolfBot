"""Eastmoney intraday turnover in yuan, on the exchanges' China-time bar clock."""
from __future__ import annotations

from bisect import bisect_right
from collections import defaultdict
from dataclasses import dataclass
from datetime import date, datetime, time, timedelta, timezone
import json
import logging
import math
from statistics import median
from urllib.parse import urlencode
from urllib.request import Request, urlopen

CHINA = timezone(timedelta(hours=8))
FIVE = timedelta(minutes=5)
INDEXES = {'sh000001': '上证指数', 'sh000688': '科创50'}
ALL_A = '47.800004'  # 东方财富全A（沪深京）
MINUTES = (*range(570, 691), *range(781, 901))  # 09:30 auction, then right-labelled minutes
BAR_ENDS = (*range(575, 691, 5), *range(785, 901, 5))
LOG = logging.getLogger('nga-watcher')


def minute_of(stamp):
    return stamp.hour * 60 + stamp.minute


def trading_session(stamp):
    stamp = stamp.astimezone(CHINA)
    if stamp.weekday() < 5:
        for number, (start, end) in enumerate(((time(9, 30), time(11, 30)), (time(13), time(15)))):
            if start <= stamp.time() <= end:
                return stamp.date(), number
    return None


def number(value, *, positive=False):
    value = float(value)
    if not math.isfinite(value) or value < 0 or (positive and value == 0):
        raise ValueError('行情数值无效')
    return value


def read_json(url, params, referer='https://quote.eastmoney.com/'):
    request = Request(url + '?' + urlencode(params), headers={
        'User-Agent': 'Mozilla/5.0', 'Referer': referer, 'Cache-Control': 'no-cache'})
    with urlopen(request, timeout=5) as response:
        body = response.read(1_500_001)
    if len(body) > 1_500_000:
        raise ValueError('行情响应过大')
    return json.loads(body)


def eastmoney(endpoint, secid, **params):
    result = read_json('https://push2his.eastmoney.com/api/qt/stock/' + endpoint,
                       dict(secid=secid, **params))
    node = result.get('data')
    market, code = secid.split('.')
    if (result.get('rc') != 0 or not isinstance(node, dict)
            or node.get('code') != code or str(node.get('market')) != market):
        raise ValueError('未返回所请求的指数')
    return node


def trends(secid, days):
    return eastmoney('trends2/get', secid, ndays=days, iscr=0, iscca=0,
                     fields1='f1,f2,f3,f4,f5,f6,f7,f8,f9,f10,f11,f12,f13,f17',
                     fields2='f51,f52,f53,f54,f55,f56,f57,f58')


def five_minute_klines(symbol, day, limit):
    return eastmoney('kline/get', '1.' + symbol[2:], klt=5, fqt=0, lmt=limit,
                     end=day.strftime('%Y%m%d'), fields1='f1,f2,f3,f4,f5,f6',
                     fields2='f51,f52,f53,f54,f55,f56,f57')['klines']


@dataclass(frozen=True)
class Quote:
    timestamp: datetime
    amount: float
    last: float
    prev_close: float


def index_quotes():
    response = read_json('https://push2.eastmoney.com/api/qt/ulist.np/get',
                         dict(secids=','.join('1.' + s[2:] for s in INDEXES),
                              fields='f2,f6,f12,f13,f18,f124', fltt=2, invt=2))
    if response.get('rc') != 0:
        raise ValueError('指数快照不可用')
    quotes = {}
    for row in (response.get('data') or {}).get('diff') or []:
        symbol = 'sh' + str(row['f12'])
        if row['f13'] == 1 and symbol in INDEXES:
            try:
                quotes[symbol] = Quote(datetime.fromtimestamp(row['f124'], CHINA), number(row['f6']),
                                       number(row['f2'], positive=True), number(row['f18'], positive=True))
            except (TypeError, ValueError, KeyError, OverflowError):
                continue
    return quotes


def minutes_by_date(node):
    days = defaultdict(dict)
    for line in node['trends']:
        parts = line.split(',')
        stamp = datetime.strptime(parts[0], '%Y-%m-%d %H:%M').replace(tzinfo=CHINA)
        day = days[stamp.date()]
        slot = minute_of(stamp)
        if slot not in MINUTES or slot in day or len(parts) < 7:
            raise ValueError('分时行情时段或字段异常')
        day[slot] = parts
    if not days:
        raise ValueError('暂无分时行情')
    return days


def complete_prefix(rows, cutoff):
    needed = MINUTES[:bisect_right(MINUTES, cutoff)]
    if not needed or not all(slot in rows for slot in needed):
        raise ValueError('分钟成交额有缺口')
    return needed


@dataclass(frozen=True)
class IndexBar:
    asof: datetime
    end: datetime
    amount: float
    open: float
    high: float
    low: float
    last: float
    prev_close: float
    rolling_base: float | None


def price_range(opened, last, high, low):
    # Minute and five-minute index prices can round one tick apart.
    if low > high or min(last, opened) < low - 0.010001 or max(last, opened) > high + 0.010001:
        raise ValueError('五分钟价格区间不完整')
    return max(high, last, opened), min(low, last, opened)


def live_index_bar(quote, klines):
    stamp = quote.timestamp
    session = trading_session(stamp)
    if session is None:
        raise ValueError('报价不在盘中')
    start = stamp.replace(hour=9 if session[1] == 0 else 13, minute=30 if session[1] == 0 else 0,
                          second=0, microsecond=0)
    end = start + max(1, math.ceil((stamp - start).total_seconds() / 300)) * FIVE
    label = stamp.strftime('%Y-%m-%d')
    rows = {}
    for raw in klines:
        if raw.startswith(label + ' '):
            parts = raw.split(',')
            slot = minute_of(datetime.fromisoformat(parts[0]))
            if slot in rows or slot not in BAR_ENDS:
                raise ValueError('五分钟 K 线时段异常')
            rows[slot] = parts
    cutoff = minute_of(end)
    prefix = BAR_ENDS[:bisect_right(BAR_ENDS, cutoff)]
    if not all(m in rows for m in prefix):
        raise ValueError('五分钟 K 线未更新')
    amounts = [number(rows[m][6]) for m in prefix]
    current = quote.amount - sum(amounts[:-1])
    opened, last, high, low = (number(rows[cutoff][k], positive=True) for k in (1, 2, 3, 4))
    # The two responses can straddle a trade or a bar boundary. Trust OHLC only
    # when price and turnover describe the same snapshot (allow float32 rounding).
    if (current < 0 or not math.isclose(sum(amounts), quote.amount, rel_tol=2e-7, abs_tol=500)
            or abs(last - quote.last) > 0.010001):
        raise ValueError('快照与五分钟 K 线尚未同步')
    high, low = price_range(opened, last, high, low)
    prev_close = quote.prev_close if len(prefix) == 1 else number(rows[prefix[-2]][2], positive=True)
    base = None
    if end - start > 5 * FIVE:
        base = sum(sorted(amounts[-6:-1])[1:-1]) / 3
    return IndexBar(stamp, end, current, opened, high, low, last, prev_close, base)


def index_bar(node, open_for=None):
    stamp = datetime.fromtimestamp(node['time'], CHINA)
    days = minutes_by_date(node)
    day = max(days)
    rows = days[day]
    last_minute = max(rows)
    last_end = datetime.combine(day, time(*divmod(last_minute, 60)), CHINA)
    if stamp.date() != day or last_end - stamp >= timedelta(minutes=1):
        raise ValueError('分时与报价时间不一致')
    asof = min(stamp, last_end)
    prefix = complete_prefix(rows, last_minute)
    # A quote at 10:04:20 can carry a partial minute labelled 10:05.
    # At 10:05:00 that minute completes the bar ending at 10:05.
    end_minute = next(m for m in BAR_ENDS if m >= last_minute)
    end = datetime.combine(day, time(*divmod(end_minute, 60)), CHINA)
    first = end_minute - 4 if end_minute != 575 else 570
    current = [rows[m] for m in prefix if first <= m <= end_minute]
    # Archived minute feeds sometimes omit f52. The exchange's five-minute
    # opening price is known from the first trade, even in a forming bar.
    try:
        opened = number(current[0][1], positive=True)
    except (TypeError, ValueError):
        if open_for is None:
            raise ValueError('五分钟开盘价缺失') from None
        opened = number(open_for(end), positive=True)
    last = number(current[-1][2], positive=True)
    high = max(number(row[3], positive=True) for row in current)
    low = min(number(row[4], positive=True) for row in current)
    high, low = price_range(opened, last, high, low)
    if end_minute == 575:
        prev_close = number(node['preClose'], positive=True)
    else:
        prev_slot = 690 if end_minute == 785 else end_minute - 5
        prev_close = number(rows[prev_slot][2], positive=True)
    amounts = {m: number(rows[m][6]) for m in prefix}
    rolling_base = None
    session_first_end = 575 if end_minute <= 690 else 785
    if end_minute - session_first_end >= 25:
        previous_five = []
        for previous_end in range(end_minute - 25, end_minute, 5):
            start = 570 if previous_end == 575 else previous_end - 4
            previous_five.append(sum(amounts[m] for m in range(start, previous_end + 1)))
        rolling_base = sum(sorted(previous_five)[1:-1]) / 3
    return IndexBar(asof, end, sum(amounts[m] for m in prefix if m >= first),
                    opened, high, low, last, prev_close, rolling_base)


def exchange_bar_open(symbol, end):
    label = end.strftime('%Y-%m-%d %H:%M')
    for line in reversed(five_minute_klines(symbol, end.date(), 48)):
        parts = line.split(',')
        if parts[0] == label:
            return number(parts[1], positive=True)
    raise ValueError('五分钟开盘价缺失')


def slot_medians(history, today):
    days = defaultdict(dict)
    for timestamp, amount in history:
        stamp = datetime.fromisoformat(timestamp)
        if stamp.date() >= today:
            continue
        slot = minute_of(stamp)
        rows = days[stamp.date()]
        if slot not in BAR_ENDS or slot in rows:
            raise ValueError('历史五分钟 K 线时段异常')
        rows[slot] = number(amount)
    recent = sorted(days)[-20:]
    if len(recent) != 20 or any(len(days[day]) != len(BAR_ENDS) for day in recent):
        raise ValueError('不足此前 20 个完整交易日')
    return {slot: median(days[day][slot] for day in recent) for slot in BAR_ENDS}


def historical_baselines(symbol, today):
    # 23 sessions leave room for the partial first page and today's forming bars.
    try:
        rows = [line.split(',') for line in five_minute_klines(symbol, today, 1104)]
        return slot_medians(((r[0], r[6]) for r in rows), today)
    except (OSError, ValueError, KeyError, IndexError, TypeError) as exc:
        LOG.info('Five-minute history fallback %s: %s', symbol, type(exc).__name__)
    rows = read_json('https://quotes.sina.cn/cn/api/json_v2.php/CN_MarketDataService.getKLineData',
                     dict(symbol=symbol, scale=5, ma='no', datalen=1104), 'https://finance.sina.com.cn/')
    return slot_medians(((row['day'], row['amount']) for row in rows), today)


@dataclass(frozen=True)
class MarketTotal:
    asof: datetime
    amount: float
    previous_day: date | None
    previous: float | None

    def describe(self):
        line = f'全 A 成交额（沪深北）  {self.amount / 1e12:.4f} 万亿元  ·  {self.asof:%m-%d %H:%M}'
        if self.previous is None:
            return line + '  ·  上一交易日同刻数据缺失'
        diff = self.amount - self.previous
        pct = f'，{diff / self.previous:+.2%}' if self.previous else ''
        return (line + f'  ·  {self.previous_day:%m-%d} 同刻 {self.previous / 1e12:.4f} 万亿元'
                + f'  ·  相差 {diff / 1e8:+,.2f} 亿元{pct}')


def market_total(node, now):
    days = minutes_by_date(node)
    day = max(days)
    stamp = datetime.fromtimestamp(node['time'], CHINA)
    if stamp.date() != day or stamp > now + timedelta(seconds=5):
        raise ValueError('全 A 行情时间异常')
    rows = days[day]
    # Exclude the currently forming minute so both sides have traded for the same time.
    cutoff = min(max(rows), minute_of(stamp))
    slots = complete_prefix(rows, cutoff)
    amount = sum(number(rows[m][6]) for m in slots)
    dates = sorted({datetime.strptime(str(item['date']), '%Y%m%d').date()
                    for item in node.get('hisPrePrices', [])})
    prior = dates[-2] if len(dates) >= 2 and dates[-1] == day else None
    previous = None
    if prior in days and all(m in days[prior] for m in slots):
        try:
            previous = sum(number(days[prior][m][6]) for m in slots)
        except (ValueError, TypeError):
            pass
    return MarketTotal(datetime.combine(day, time(*divmod(slots[-1], 60)), CHINA),
                       amount, prior, previous)


def closing_market_total(now):
    node = eastmoney('kline/get', ALL_A, klt=101, fqt=0, lmt=2,
                     end=now.strftime('%Y%m%d'), fields1='f1,f2,f3,f4,f5,f6',
                     fields2='f51,f52,f53,f54,f55,f56,f57')
    previous, latest = [line.split(',') for line in node['klines'][-2:]]
    day, prior = date.fromisoformat(latest[0]), date.fromisoformat(previous[0])
    close = datetime.combine(day, time(15), CHINA)
    if prior >= day or close > now:
        raise ValueError('全 A 收盘数据尚未就绪')
    return MarketTotal(close, number(latest[6], positive=True), prior,
                       number(previous[6], positive=True))
