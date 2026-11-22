from dataclasses import replace
from datetime import datetime, timedelta, timezone
from queue import Queue
import unittest
from unittest.mock import Mock, patch

from market_feed import (ALL_A, BAR_ENDS, CHINA, FIVE, MINUTES, IndexBar, MarketTotal, Quote,
                         closing_market_total, index_bar, live_index_bar, market_total, slot_medians, trading_session)
from market_signals import SignalTracker
from market_volume import MarketBatch, MarketFeed, MarketMonitor


DAY = datetime(2026, 11, 20, tzinfo=CHINA)
YI = 100_000_000


def at(hour, minute=0, second=0, day=DAY):
    return day.replace(hour=hour, minute=minute, second=second)


def trend_rows(day, last, amount):
    return [f'{day:%Y-%m-%d} {m//60:02}:{m%60:02},100,101,102,98,7654321,{amount},100'
            for m in MINUTES if m <= last]


def node(stamp, rows, dates=(20261119, 20261120)):
    return {'time': stamp.timestamp(), 'trends': rows, 'preClose': 99,
            'hisPrePrices': [{'date': d} for d in dates]}


def bar(end, seconds, amount, base=100 * YI, **overrides):
    value = IndexBar(end - FIVE + timedelta(seconds=seconds), end, amount, 100, 102, 98, 101, 100, base)
    return replace(value, **overrides)


class DataTests(unittest.TestCase):
    def test_second_level_snapshot_matches_bar_turnover_price_and_exact_boundary(self):
        rows = [f'{DAY:%Y-%m-%d} 09:{m:02},100,101,102,98,987654,{YI}' for m in range(35, 60, 5)]
        rows.append(f'{DAY:%Y-%m-%d} 10:00,100,101,102,98,4321,{200 * YI}')
        quote = Quote(at(9, 55, 20), 205 * YI, 101, 99)
        candle = live_index_bar(quote, rows)
        self.assertEqual((candle.end, candle.asof, candle.rolling_base, candle.amount),
                         (at(10), at(9, 55, 20), YI, 200 * YI))
        signal = SignalTracker('sh000001').observe(candle, None, candle.asof)[1]
        self.assertFalse(signal.projected)
        self.assertEqual(live_index_bar(replace(quote, timestamp=at(10)), rows).end, at(10))
        for unmatched in (replace(quote, last=100), replace(quote, amount=215 * YI)):
            with self.assertRaisesRegex(ValueError, '尚未同步'):
                live_index_bar(unmatched, rows)
        with self.assertRaisesRegex(ValueError, '未更新'):
            live_index_bar(quote, rows[1:])

    def test_half_minute_uses_source_seconds_auction_turnover_and_true_high_low(self):
        rows = trend_rows(DAY, 571, 15 * YI)
        rows[0] = rows[0].replace('100,101,102,98', '99,99,99,99')
        live = index_bar(node(at(9, 30, 40), rows))
        self.assertEqual((live.end, live.asof, live.amount, live.prev_close),
                         (at(9, 35), at(9, 30, 40), 30 * YI, 99))
        self.assertEqual((live.open, live.high, live.low, live.last), (99, 102, 98, 101))
        self.assertIsNone(live.rolling_base)

    def test_full_minute_snapshot_is_not_advanced_to_request_time(self):
        frame = index_bar(node(at(10, 5, 16), trend_rows(DAY, 605, YI)))
        self.assertEqual((frame.end, frame.asof, frame.amount), (at(10, 5), at(10, 5), 5 * YI))

    def test_trimmed_mean_excludes_current_bar_and_resets_at_lunch(self):
        rows = trend_rows(DAY, 601, YI)
        for i, row in enumerate(rows):
            # The 5 completed bars immediately before 10:00 are worth 5,10,15,20,500 yi.
            minute = MINUTES[i]
            factor = 250 if minute == 601 else (1, 2, 3, 4, 100)[min(4, max(0, (minute - 576) // 5))]
            rows[i] = row.replace(f',{YI},', f',{YI * factor},')
        morning = index_bar(node(at(10, 0, 20), rows))
        self.assertEqual((morning.rolling_base, morning.amount), (15 * YI, 250 * YI))
        with_lunch = trend_rows(DAY, 781, YI)
        with_lunch[120] = with_lunch[120].replace('100,101,102,98', '99,99,99,99')
        afternoon = index_bar(node(at(13, 0, 20), with_lunch))
        self.assertEqual((afternoon.rolling_base, afternoon.amount, afternoon.prev_close), (None, YI, 99))

    def test_bad_source_or_incomplete_bar_never_invents_prices_or_amounts(self):
        rows = trend_rows(DAY, 601, YI)
        cases = [rows[:-2] + rows[-1:], rows + rows[-1:], rows[:-1] + [rows[-1].replace(f',{YI},', ',-,')]]
        for sample in cases:
            with self.assertRaises(ValueError):
                index_bar(node(at(10, 0, 20), sample))
        rows[-1] = rows[-1].replace(',100,101,', ',0,101,')
        with self.assertRaisesRegex(ValueError, '开盘价'):
            index_bar(node(at(10, 0, 20), rows))
        lookup = Mock(return_value=100.25)
        self.assertEqual(index_bar(node(at(10, 0, 20), rows), lookup).open, 100.25)
        lookup.assert_called_once_with(at(10, 5))
        self.assertEqual(index_bar(node(at(10, 0, 20), rows), lambda end: 97.99).low, 97.99)
        with self.assertRaisesRegex(ValueError, '价格区间'):
            index_bar(node(at(10, 0, 20), rows), lambda end: 97.98)

    def test_slot_baseline_uses_only_previous_twenty_complete_trading_days(self):
        history = []
        day, value = DAY, 0
        while value <= 21:
            if day.weekday() < 5:
                for m in BAR_ENDS:
                    history.append((f'{day:%Y-%m-%d} {m//60:02}:{m%60:02}', (value if value else 1e8) + m))
                value += 1
            day -= timedelta(days=1)
        self.assertEqual(slot_medians(history, DAY.date())[575], 575 + 10.5)
        del history[len(BAR_ENDS)]
        with self.assertRaisesRegex(ValueError, '20'):
            slot_medians(history, DAY.date())

    def test_all_a_uses_last_complete_common_minute_and_previous_trading_day(self):
        monday = DAY + timedelta(days=3)
        prior = trend_rows(DAY, 900, 8 * YI)
        current = trend_rows(monday, 572, 6 * YI)
        result = market_total(node(at(9, 31, 20, monday), prior + current, (20261120, 20261123)),
                              at(9, 31, 22, monday))
        self.assertEqual((result.asof, result.amount, result.previous_day, result.previous),
                         (at(9, 31, day=monday), 12 * YI, DAY.date(), 16 * YI))
        self.assertIn('-4.00 亿元，-25.00%', result.describe())
        self.assertIn('万亿元', result.describe())

    def test_current_amount_survives_missing_comparable_minute_without_inventing_delta(self):
        prior = trend_rows(DAY - timedelta(days=1), 900, YI)
        current = trend_rows(DAY, 780 + 2, YI)
        result = market_total(node(at(13, 1, 20), prior[1:] + current), at(13, 1, 30))
        self.assertEqual((result.amount, result.previous, result.asof), (122 * YI, None, at(13, 1)))
        with self.assertRaisesRegex(ValueError, '缺口'):
            market_total(node(at(13, 1, 20), prior + current[1:]), at(13, 1, 30))

    @patch('market_feed.eastmoney')
    def test_daily_fallback_uses_only_closed_sessions(self, request):
        request.return_value = {'klines': ['2026-11-19,0,0,0,0,0,1400000000000',
                                           '2026-11-20,0,0,0,0,0,1300000000000']}
        with self.assertRaisesRegex(ValueError, '收盘'):
            closing_market_total(at(12))
        result = closing_market_total(DAY + timedelta(days=2))
        self.assertEqual((result.asof, result.previous, result.amount),
                         (at(15), 1.4e12, 1.3e12))
        self.assertIn('-1,000.00 亿元', result.describe())


class SignalTests(unittest.TestCase):
    def observe(self, tracker, candle, opening_base=None):
        return tracker.observe(candle, opening_base, candle.asof)[1]

    def test_first_minute_direct_break_both_thresholds_and_after_minute_projection(self):
        end = at(10, 5)
        for symbol, base, floor in [('sh000001', 50, 150), ('sh000688', 5, 20)]:
            with self.subTest(symbol=symbol):
                tracker = SignalTracker(symbol)
                self.assertIsNone(self.observe(tracker, bar(end, 20, (floor - 1) * YI, base * YI)))
                alert = self.observe(tracker, bar(end, 40, floor * YI, base * YI))
                self.assertEqual((alert.stage, alert.projected, alert.effective), (1, False, floor * YI))
        tracker = SignalTracker('sh000001')
        self.assertIsNone(self.observe(tracker, bar(end, 59, 36 * YI)))
        alert = self.observe(tracker, bar(end, 60, 36 * YI))
        self.assertEqual((alert.effective, alert.projected, alert.stage), (180 * YI, True, 1))

    def test_price_filter_includes_second_branch_and_rejects_selloff(self):
        for last, low, high, expected in [(99.84, 99.0, 100.1, False), (99.85, 99.0, 100.1, True),
                                          (100.2, 99.0, 103, False), (100, 100, 100, False)]:
            candle = bar(at(10, 5), 120, 600 * YI, open=100, last=last, high=high, low=low)
            self.assertEqual(bool(self.observe(SignalTracker('sh000001'), candle)), expected)

    def test_confirmation_locks_baseline_and_checks_entire_next_bar(self):
        tracker = SignalTracker('sh000001')
        self.assertEqual(self.observe(tracker, bar(at(10, 5), 120, 80 * YI)).stage, 1)
        self.assertIsNone(self.observe(tracker, bar(at(10, 5), 140, 100 * YI)))
        restored = SignalTracker('sh000001', tracker.checkpoint())
        self.assertIsNone(self.observe(restored, bar(at(10, 5), 160, 200 * YI)))
        self.assertIsNone(self.observe(restored, bar(at(10, 10), 20, 10 * YI, 500 * YI)))
        confirmed = self.observe(restored, bar(at(10, 10), 100, 50 * YI, 500 * YI))
        self.assertEqual((confirmed.stage, confirmed.baseline, confirmed.effective), (2, 100 * YI, 150 * YI))
        self.assertIsNone(self.observe(restored, bar(at(10, 10), 160, 190 * YI)))
        self.assertEqual(self.observe(restored, bar(at(10, 15), 40, 200 * YI)).stage, 1)

    def test_confirmation_expires_without_extending_across_lunch_or_overnight(self):
        for first, later in [(at(10, 5), at(10, 15)), (at(11, 30), at(13, 5)),
                             (at(15), at(9, 35, day=DAY + timedelta(days=3)))]:
            tracker = SignalTracker('sh000001')
            self.assertIsNotNone(self.observe(tracker, bar(first, 20, 200 * YI)))
            self.assertIsNone(self.observe(tracker, bar(later, 300, 150 * YI)))

    def test_out_of_order_stale_and_decreasing_turnover_cannot_emit(self):
        tracker = SignalTracker('sh000001')
        candle = bar(at(10, 5), 100, 40 * YI)
        self.assertIsNone(self.observe(tracker, candle))
        self.assertIsNone(self.observe(tracker, replace(candle, amount=200 * YI)))
        back = bar(at(10, 5), 110, 39 * YI)
        self.assertIsNone(self.observe(tracker, back))
        self.assertEqual(tracker.last, candle)
        big = bar(at(10, 5), 120, 200 * YI)
        self.assertIsNone(tracker.observe(big, None, big.asof + timedelta(minutes=5))[1])
        self.assertIsNone(self.observe(SignalTracker('sh000001'), replace(big, rolling_base=None)))


class SchedulerTests(unittest.TestCase):
    def test_exchange_hours_use_china_time(self):
        self.assertEqual(trading_session(at(13).astimezone(timezone.utc)), (DAY.date(), 1))
        for stamp in (at(9, 29), at(12), at(15, 1), at(10, day=DAY + timedelta(days=1))):
            self.assertIsNone(trading_session(stamp))

    @patch('market_volume.threading.Thread')
    def test_20_second_schedule_nonoverlap_afterhours_display_and_pause(self, thread):
        monitor = MarketMonitor(Queue())
        monitor.feed.fetch = Mock(return_value=MarketBatch())
        monitor.tick(at(10), 100, False)
        monitor.tick(at(10, 0, 20), 120, False)
        self.assertEqual(thread.call_count, 1)
        thread.call_args.kwargs['target']()
        monitor.feed.fetch.assert_called_once_with(at(10), True)
        monitor.receive(monitor.events.get_nowait()[1], at(10), False)
        monitor.tick(at(10, 0, 19), 119, False)
        self.assertEqual(thread.call_count, 1)
        monitor.tick(at(10, 0, 20), 120, False)
        self.assertEqual(thread.call_count, 2)
        pending = monitor.generation
        monitor.reset()
        total = MarketTotal(at(10), 100, None, None)
        self.assertFalse(monitor.receive((pending, MarketBatch(total=total)), at(10, 0, 21), False))
        self.assertIsNone(monitor.total)
        monitor.tick(at(12), 5000, False)
        thread.call_args.kwargs['target']()
        monitor.feed.fetch.assert_called_with(at(12), False)

    def test_unavailable_all_a_does_not_block_a_live_index_signal(self):
        monitor = MarketMonitor(Queue())
        candle = bar(at(10, 5), 20, 200 * YI)
        monitor.sync_session(candle.asof)
        result = MarketBatch(indexes={'sh000001': (candle, None)}, errors={ALL_A: '行情请求失败'})
        signals = monitor.receive((monitor.generation, result), candle.asof, False)
        self.assertEqual([s.stage for s in signals], [1])
        self.assertIn('行情请求失败', monitor.status(False))

    @patch('market_volume.historical_baselines', return_value={575: 100 * YI, 580: 120 * YI})
    @patch('market_volume.trends')
    def test_polls_use_the_cached_previous_twenty_days_even_in_next_bar(self, source, history):
        feed = MarketFeed()
        for now, end, expected in [(at(9, 30, 20), 571, 100), (at(9, 35, 20), 576, 120)]:
            source.return_value = node(now, trend_rows(DAY, end, YI))
            self.assertEqual(feed.index('sh000001', now)[1], expected * YI)
        history.assert_called_once_with('sh000001', DAY.date())


if __name__ == '__main__':
    unittest.main()
