import copy
import json
from pathlib import Path
import queue
import tempfile
import unittest
from unittest.mock import Mock, patch

from feishu import post_key
from monitor_state import AUTHORS, merge_author_result, prepare_monitors, search_url
from search_posts import parse_search_html, parse_search_page, poll_search
from test_search_posts import api_body, html_body, FakeSearch, result
from watcher import App, AuthorMonitor, AuthorSearchClient, poll_thread, read_state, save_state


FIRST, SECOND = AUTHORS


def post(author, pid, stamp):
    return {'authorid': author, 'tid': 100, 'pid': pid, 'timestamp': stamp,
            'date': '2026-10-14 02:00:00', 'content': '新发言', 'subject': '主题', 'page': 1}


def legacy_state():
    return {'watermark': 123, 'page': 1, 'monitor': 'author_search',
            'search_watermark': 180, 'search_seen': ['100:42'],
            'recent': [post(FIRST, 42, 190), post(FIRST, 41, 120)],
            'last_success': 197, 'source': 'JSON', 'rows': 2,
            'pending': [post(FIRST, 40, 100)], 'feishu_outbox': [post(FIRST, 40, 100)]}


class MonitorTests(unittest.TestCase):
    def mock_app(self):
        app = App.__new__(App)
        app.state = prepare_monitors(legacy_state())
        app.targets = {str(uid): AuthorMonitor(uid, AuthorSearchClient(author=uid)) for uid in AUTHORS}
        app.status, app.details, app.feishu_status = Mock(), Mock(), Mock()
        app.feishu_config = {'enabled': True}
        app.render_posts, app.show_alert = Mock(), Mock()
        app.paused, app.smoke = False, False
        app.events = queue.Queue()
        return app

    @patch.dict('monitor_state.THREADS', {SECOND: 47288722}, clear=True)
    def test_legacy_search_migration_preserves_existing_progress_and_notification_queues(self):
        original = legacy_state()
        before = copy.deepcopy(original)
        state = prepare_monitors(original)
        self.assertEqual(original, before)
        for key in ('search_watermark', 'search_seen', 'last_success', 'recent', 'watermark'):
            self.assertEqual(state['authors'][str(FIRST)][key], original[key])
        self.assertNotIn('search_watermark', state['authors'][str(SECOND)])
        self.assertEqual(state['pending'], original['pending'])
        self.assertEqual(state['feishu_outbox'], original['feishu_outbox'])

    def test_restart_does_not_reset_either_author(self):
        state = prepare_monitors(legacy_state())
        client = Mock(tid=47288722)
        client.page.return_value = dict(result([dict(post(SECOND, 52, 500), tid=47288722)]), pages=1, rows=1)
        progress, fresh, _ = poll_thread(client, state['authors'][str(SECOND)])
        state = merge_author_result(state, SECOND, progress, fresh, True)
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'state.json'
            save_state(state, path)
            self.assertEqual(prepare_monitors(read_state(path)), state)

    @patch.dict('monitor_state.THREADS', {}, clear=True)
    def test_search_mode_new_author_baselines_while_existing_author_catches_up(self):
        state = prepare_monitors(legacy_state())
        first = poll_search(FakeSearch({1: result([post(FIRST, 43, 250), post(FIRST, 42, 190), post(FIRST, 41, 120)])}), state['authors'][str(FIRST)])
        second = poll_search(FakeSearch({1: result([post(SECOND, 52, 500)])}), state['authors'][str(SECOND)])
        self.assertFalse(first[2])
        self.assertEqual([p['pid'] for p in first[1]], [43])
        self.assertTrue(second[2])
        self.assertEqual(second[1], [])
        for author, polled in ((SECOND, second), (FIRST, first)):
            state = merge_author_result(state, author, polled[0], polled[1], True)
        self.assertEqual(state['authors'][str(FIRST)]['search_watermark'], 240)
        self.assertEqual(state['authors'][str(SECOND)]['search_watermark'], 480)
        self.assertEqual({post_key(p) for p in state['feishu_outbox']}, {'100:40', '100:43'})
        self.assertEqual({p['authorid'] for p in state['recent']}, set(AUTHORS))

    def test_concurrent_completions_preserve_both_queues_and_progress(self):
        state = prepare_monitors(legacy_state())
        for order in ((FIRST, SECOND), (SECOND, FIRST)):
            current = copy.deepcopy(state)
            for author in order:
                new = post(author, author, 500)
                progress = dict(state['authors'][str(author)], search_watermark=480, recent=[new])
                current = merge_author_result(current, author, progress, [new], True)
            self.assertEqual({p['authorid'] for p in current['pending']}, set(AUTHORS))
            self.assertEqual(len(current['feishu_outbox']), 3)
            for author in AUTHORS:
                self.assertEqual(current['authors'][str(author)]['search_watermark'], 480)

    def test_stale_result_cannot_restore_acknowledged_or_delivered_messages(self):
        state = prepare_monitors(legacy_state())
        stale = dict(copy.deepcopy(state['authors'][str(SECOND)]), pending=state['pending'], feishu_outbox=state['feishu_outbox'])
        state['pending'], state['feishu_outbox'] = [], []
        updated = merge_author_result(state, SECOND, stale, [], True)
        self.assertEqual(updated['pending'], [])
        self.assertEqual(updated['feishu_outbox'], [])
        self.assertNotIn('pending', updated['authors'][str(SECOND)])

    def test_second_author_failure_does_not_reset_other_progress_or_inflight_check(self):
        app = self.mock_app()
        before = copy.deepcopy(app.state)
        app.targets[str(FIRST)].busy = app.targets[str(SECOND)].busy = True
        app.handle_poll_event('error', '网络超时', SECOND)
        self.assertEqual(app.state, before)
        self.assertTrue(app.targets[str(FIRST)].busy)
        self.assertEqual(app.targets[str(FIRST)].failed, 0)
        self.assertFalse(app.targets[str(SECOND)].busy)
        self.assertEqual(app.targets[str(SECOND)].failed, 1)

    def test_busy_author_does_not_block_second_author_and_checks_never_overlap(self):
        app = self.mock_app()
        app.targets[str(FIRST)].busy = True
        polled = ({'recent': [], 'rows': 0, 'page': 1}, [], True)
        with patch('watcher.poll', return_value=polled) as poll, patch('watcher.threading.Thread') as thread:
            app.check()
            app.check()
            self.assertEqual(thread.call_count, 1)
            thread.call_args.kwargs['target']()
        poll.assert_called_once_with(app.targets[str(SECOND)].client, app.state['authors'][str(SECOND)])
        kind, (author, event, _) = app.events.get_nowait()
        self.assertEqual((kind, author, event), ('poll', SECOND, 'ok'))

    def test_success_of_one_author_does_not_postpone_other_schedule(self):
        app = self.mock_app()
        before = app.targets[str(FIRST)].next_check
        progress = dict(app.state['authors'][str(SECOND)], rows=0)
        with patch('watcher.save_state'), patch('watcher.time.monotonic', return_value=100):
            app.handle_poll_event('ok', (progress, [], True), SECOND)
        self.assertEqual(app.targets[str(SECOND)].next_check, 160)
        self.assertEqual(app.targets[str(FIRST)].next_check, before)

    def test_tick_starts_due_author_while_other_is_retrying(self):
        app = self.mock_app()
        app.targets[str(FIRST)].busy = True
        app.targets[str(SECOND)].next_check = 0
        app.root, app.dispatch_feishu, app.check = Mock(), Mock(), Mock()
        app.tick()
        app.check.assert_called_once_with(str(SECOND))

    def test_pause_cancels_both_author_workers(self):
        app = self.mock_app()
        app.pause_button = Mock()
        app.toggle()
        self.assertTrue(app.paused)
        self.assertTrue(all(target.client.cancel_event.is_set() for target in app.targets.values()))

    def test_new_author_json_and_html_reject_mixed_authors(self):
        record = {'tid': 100, 'pid': 42, 'authorid': SECOND, 'postdate': 197, 'content': '真实回复'}
        data = json.loads(api_body([record]))['data']
        self.assertEqual(parse_search_page(data, 1, SECOND)['posts'][0]['authorid'], SECOND)
        with self.assertRaises(ValueError):
            parse_search_page(data, 1, FIRST)
        body = html_body(SECOND).replace(f'authorid={FIRST}&', f'authorid={SECOND}&')
        self.assertEqual(parse_search_html(body, 1, SECOND)['posts'][0]['authorid'], SECOND)
        with self.assertRaises(ValueError):
            parse_search_html(body, 1, FIRST)
        with self.assertRaises(ValueError):
            parse_search_html(body.replace(f',42,{SECOND},0)', f',42,{FIRST},0)'), 1, SECOND)

    def test_new_author_html_fallback_resolves_its_own_post_time(self):
        client = AuthorSearchClient(author=SECOND)
        body = html_body(SECOND).replace(f'authorid={FIRST}&', f'authorid={SECOND}&')
        detail = json.dumps({'data': {'__T': {'tid': 100}, '__R__ROWS': 1,
                                     '__R': [{'pid': 42, 'authorid': SECOND, 'postdate': 197, 'content': '真实回复'}]}})
        with patch.object(client, 'request', side_effect=[(200, '{'), (200, '{'), (200, body), (200, detail)]), patch.object(client.cancel_event, 'wait', return_value=False):
            parsed = client.page(1)
        self.assertEqual(parsed['source'], 'HTML')
        self.assertEqual(parsed['posts'][0]['authorid'], SECOND)
        self.assertEqual(parsed['posts'][0]['timestamp'], 197)
        self.assertEqual(client.url, search_url(SECOND))


if __name__ == '__main__':
    unittest.main()
