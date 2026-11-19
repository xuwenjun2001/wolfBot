from datetime import datetime, timedelta, timezone
from queue import Queue
import unittest
from unittest.mock import patch

from market_volume import CHINA, MarketMonitor, Quote, VolumeTracker, parse_quotes, trading_session


START = datetime(2026, 11, 19, 10, 0, tzinfo=CHINA)


def quote_line(symbol, timestamp='20261119100230', volume='412912755'):
    fields = [''] * 88
    for index, value in {0: '1', 1: '指数', 2: symbol[2:], 3: '3577.62',
                         6: volume, 30: timestamp, 37: '63690906'}.items():
        fields[index] = value
    return f'v_{symbol}="' + '~'.join(fields) + '";'


class MarketVolumeTests(unittest.TestCase):
    def test_parses_volume_and_timestamp_for_the_two_distinct_indexes(self):
        quotes = parse_quotes(quote_line('sh000001') + '\n' +
                              quote_line('sh000688', '20261119100233', '12272345'))
        self.assertEqual(quotes['sh000001'], Quote(START + timedelta(seconds=150), 412912755))
        self.assertEqual(quotes['sh000688'], Quote(START + timedelta(seconds=153), 12272345))

    def test_truncated_invalid_or_duplicated_symbol_does_not_reject_its_peer(self):
        a, b = quote_line('sh000001'), quote_line('sh000688')
        for invalid in (b[:-2], quote_line('sh000688', volume='-1'),
                        quote_line('sh000688', timestamp='20261199100230'),
                        b.replace('~000688~', '~000001~'), f'{b}\n{b}'):
            with self.subTest(invalid=invalid):
                self.assertEqual(set(parse_quotes(f'{a}\n{invalid}')), {'sh000001'})

    def test_hours_use_china_time_and_exclude_lunch_weekends_and_auction(self):
        for hour, minute in ((9, 29), (11, 30), (12, 59), (15, 0)):
            self.assertIsNone(trading_session(START.replace(hour=hour, minute=minute)))
        self.assertEqual(trading_session(START.replace(hour=9, minute=30)), (START.date(), 0))
        self.assertEqual(trading_session(START.replace(hour=13).astimezone(timezone.utc)), (START.date(), 1))
        self.assertIsNone(trading_session(START + timedelta(days=2)))

    def test_ratio_uses_actual_interval_and_excludes_spike_from_its_own_baseline(self):
        tracker = VolumeTracker('sh000001')
        now, volume = START, 200
        tracker.observe(Quote(now, volume))
        for seconds in (18, 22, 19, 21, 20, 20, 18, 22, 20):
            now += timedelta(seconds=seconds)
            volume += seconds * 20
            self.assertIsNone(tracker.observe(Quote(now, volume))[1])
        now += timedelta(seconds=30)
        volume += 30 * 39
        self.assertIsNone(tracker.observe(Quote(now, volume))[1])
        now += timedelta(seconds=15)
        volume += 15 * 40
        _, spike = tracker.observe(Quote(now, volume))
        self.assertEqual((spike.volume, spike.seconds, spike.ratio), (600, 15, 2.0))
        self.assertIsNone(tracker.observe(Quote(now + timedelta(seconds=20), volume + 1_600))[1])

    def test_tracker_resets_after_lunch_network_gap_or_rollback(self):
        start = START.replace(hour=11, minute=26)
        for end, delta in ((START.replace(hour=13), 1_000_000),
                           (START.replace(hour=11, minute=29, second=50), 1_000_000),
                           (START.replace(hour=11, minute=29, second=20), -500)):
            with self.subTest(end=end, delta=delta):
                tracker = VolumeTracker('sh000001')
                for number in range(10):
                    tracker.observe(Quote(start + timedelta(seconds=20 * number), 10_000 + 800 * number))
                status, spike = tracker.observe(Quote(end, 17_200 + delta))
                self.assertEqual(status, '重新预热')
                self.assertIsNone(spike)

    def test_only_a_fresh_current_session_quote_can_update_a_symbol(self):
        monitor = MarketMonitor(Queue())
        monitor.sync_session(START)
        first = Quote(START, 1_000)
        stale = Quote(START - timedelta(days=1), 999_999_999)
        self.assertFalse(monitor.receive((monitor.generation, {'sh000001': first, 'sh000688': stale}, ''), START, False))
        self.assertEqual(monitor.latest, {'sh000001': first})
        self.assertIn('无最新盘中报价', monitor.notes['sh000688'])
        duplicated = Quote(START, 999_999_999)
        second = Quote(START + timedelta(seconds=20), 4_000)
        monitor.receive((monitor.generation, {'sh000001': duplicated, 'sh000688': second}, ''), second.timestamp, False)
        self.assertEqual(monitor.latest, {'sh000001': first, 'sh000688': second})
        self.assertEqual(monitor.notes['sh000001'], '等待报价刷新')
        same_day_old = Quote(START + timedelta(seconds=1), 2_000)
        monitor.receive((monitor.generation, {'sh000001': same_day_old}, ''), START + timedelta(seconds=50), False)
        self.assertEqual(monitor.latest['sh000001'], first)

    @patch('market_volume.fetch_quotes')
    @patch('market_volume.threading.Thread')
    def test_queries_every_twenty_seconds_without_overlap_and_skips_lunch(self, thread, fetch):
        monitor = MarketMonitor(Queue())
        fetch.return_value = {'sh000001': Quote(START, 1_000), 'sh000688': Quote(START, 2_000)}
        monitor.tick(START, 100, False)
        monitor.tick(START + timedelta(seconds=19), 119, False)
        self.assertEqual(thread.call_count, 1)
        thread.call_args.kwargs['target']()
        event, payload = monitor.events.get_nowait()
        self.assertEqual(event, 'market')
        monitor.receive(payload, START, False)
        monitor.tick(START + timedelta(seconds=19), 119, False)
        self.assertEqual(thread.call_count, 1)
        monitor.tick(START + timedelta(seconds=20), 120, False)
        self.assertEqual(thread.call_count, 2)
        monitor.tick(START + timedelta(seconds=40), 140, False)
        self.assertEqual(thread.call_count, 2)
        monitor.tick(START.replace(hour=12), 10_000, False)
        self.assertEqual(thread.call_count, 2)

    def test_pause_discards_an_inflight_quote_even_after_resume(self):
        monitor = MarketMonitor(Queue())
        monitor.sync_session(START)
        pending = (monitor.generation, {'sh000001': Quote(START, 1_000)}, '')
        monitor.reset()
        self.assertFalse(monitor.receive(pending, START, False))
        self.assertFalse(monitor.latest)


if __name__ == '__main__':
    unittest.main()
