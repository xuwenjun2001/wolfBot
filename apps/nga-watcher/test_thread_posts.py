import copy
import json
import unittest
from unittest.mock import Mock, patch

from monitor_state import monitor_url, prepare_monitors
from test_monitor_state import legacy_state
import test_watcher
from watcher import (App, AuthorSearchClient, AuthorThreadClient, Client, NGAAccessError,
                     PollCancelled, parse_html_page, parse_thread_page, poll)


AUTHOR = 150058
TID = 47288722


def record(pid, author=AUTHOR, tid=TID):
    return {'pid': pid, 'tid': tid, 'authorid': author,
            'postdate': '2026-10-14 09:00', 'content': '[quote][pid=999]引用[/pid][/quote]实际发言'}


def data(pids=(41, 42), number=1, rows=2, size=20):
    return {'__T': {'tid': TID, 'subject': '主题'}, '__R': [record(pid) for pid in pids],
            '__R__ROWS': len(pids), '__ROWS': rows, '__R__ROWS_PAGE': size, '__PAGE': number}


def body(pids=(41, 42), number=1, rows=2, size=20):
    return json.dumps({'data': data(pids, number, rows, size)})


def html_body():
    return test_watcher.WatcherTests().html_body(AUTHOR).replace('tid=47559481&authorid=60916468', f'tid={TID}&authorid={AUTHOR}')


class ThreadTests(unittest.TestCase):
    def client(self, pages):
        client = AuthorThreadClient()
        def page(number):
            value = pages[number]
            if isinstance(value, Exception):
                raise value
            return parse_thread_page(value, number, AUTHOR, TID)
        client.page = Mock(side_effect=page)
        return client

    def test_scope_switch_carries_verified_pid_and_preserves_other_user_and_queues(self):
        state = prepare_monitors(legacy_state())
        known = dict(record(42), timestamp=197, date='2026-10-14 09:00', page=1)
        prior = {'monitor': 'author_search', 'search_watermark': 180,
                 'search_seen': [f'{TID}:42'], 'recent': [known, dict(known, tid=100, pid=999)], 'page': 1}
        state['authors'][str(AUTHOR)] = prior
        before = copy.deepcopy(state)
        updated = prepare_monitors(state)
        progress = updated['authors'][str(AUTHOR)]
        self.assertEqual(progress['monitor'], 'author_thread')
        self.assertEqual(progress['thread_id'], TID)
        self.assertEqual(progress['watermark'], 42)
        self.assertEqual(progress['recent'], [known])
        self.assertEqual(updated['previous_monitors'][f'{AUTHOR}:author_search'], prior)
        self.assertEqual(updated['authors']['60916468'], before['authors']['60916468'])
        self.assertEqual(updated['pending'], before['pending'])
        self.assertEqual(updated['feishu_outbox'], before['feishu_outbox'])
        self.assertEqual(state, before)
        self.assertEqual(prepare_monitors(updated), updated)

    def test_client_factory_and_open_link_use_the_requested_thread(self):
        app = App.__new__(App)
        app.state = prepare_monitors(legacy_state())
        app.events = Mock()
        self.assertIsInstance(app.make_client(AUTHOR, ''), AuthorThreadClient)
        self.assertIsInstance(app.make_client(60916468, ''), AuthorSearchClient)
        self.assertEqual(monitor_url(AUTHOR), f'https://ngabbs.com/read.php?tid={TID}&authorid={AUTHOR}')

    def test_json_validates_author_topic_and_all_fields_including_pid_zero(self):
        parsed = parse_thread_page(data((0, 42)), 1, AUTHOR, TID)
        self.assertEqual([p['pid'] for p in parsed['posts']], [0, 42])
        self.assertTrue(all(p['authorid'] == AUTHOR and p['tid'] == TID for p in parsed['posts']))
        cases = []
        for key in ('postdate', 'authorid', 'pid', 'content', 'tid'):
            changed = data()
            del changed['__R'][0][key]
            cases.append(changed)
        changed = data()
        changed['__T']['tid'] = 999
        cases.append(changed)
        changed = data()
        changed['__R'][0]['authorid'] = 60916468
        cases.append(changed)
        cases.extend([data(rows=3), data((42, 42)), data((42, 41)), data(number=2)])
        for changed in cases:
            with self.subTest(changed=changed), self.assertRaises((ValueError, KeyError)):
                parse_thread_page(changed, 1, AUTHOR, TID)

    def test_html_checks_uid_tid_and_ignores_quote_pid(self):
        parsed = parse_html_page(html_body(), 1, AUTHOR, TID)
        self.assertEqual((parsed['posts'][0]['tid'], parsed['posts'][0]['pid'], parsed['posts'][0]['authorid']), (TID, 42, AUTHOR))
        for author, tid in ((60916468, TID), (AUTHOR, 999)):
            with self.assertRaises(ValueError):
                parse_html_page(html_body(), 1, author, tid)

    def test_thread_json_truncation_recovers_through_html(self):
        client = AuthorThreadClient()
        with patch.object(client, 'request', side_effect=[(200, '{'), (200, '{'), (200, html_body())]) as request, patch.object(client.cancel_event, 'wait', return_value=False):
            parsed = client.page(1)
        self.assertEqual(parsed['source'], 'HTML')
        self.assertEqual(parsed['posts'][0]['tid'], TID)
        self.assertEqual(request.call_count, 3)
        self.assertTrue(all('rand=' not in call.args[0] for call in request.call_args_list))

    def test_html_does_not_decode_entities_twice_or_remove_literal_text(self):
        original = '[quote][pid=999]wrong[/pid][/quote]<br/>new <b>post</b>'
        content = '[quote][pid=999]wrong[/pid][/quote]<br/>new &amp;#160;post &lt;value&gt;'
        page = html_body().replace(original, content)
        source = data((42,), rows=1)
        source['__R'][0]['content'] = content
        expected = parse_thread_page(source, 1, AUTHOR, TID)['posts'][0]['content']
        actual = parse_html_page(page, 1, AUTHOR, TID)['posts'][0]['content']
        self.assertEqual(actual, expected)
        self.assertIn('<value>', actual)

    def test_both_sources_truncated_leave_thread_progress_unchanged(self):
        client = AuthorThreadClient()
        state = {'watermark': 40, 'page': 1, 'recent': [], 'pending': []}
        before = copy.deepcopy(state)
        with patch.object(client, 'request', side_effect=[(200, '{'), (200, '{'), (200, html_body()[:-7])]), patch.object(client.cancel_event, 'wait', return_value=False):
            with self.assertRaises(ValueError):
                poll(client, state)
        self.assertEqual(state, before)

    def test_thread_busy_retries_every_half_second_but_login_does_not(self):
        for text, expected in (('服务器忙,请稍后重试', 2), ('你必须登录', 1)):
            client = AuthorThreadClient()
            error = (200, json.dumps({'error': ['2048:' + text]}))
            with patch.object(Client, 'request', side_effect=[error, (200, body())]) as request, patch.object(client.cancel_event, 'wait', return_value=False) as wait:
                if expected == 1:
                    with self.assertRaises(NGAAccessError):
                        client.page(1)
                    wait.assert_not_called()
                else:
                    client.page(1)
                    wait.assert_called_once_with(0.5)
                self.assertEqual(request.call_count, expected)

    def test_thread_busy_retry_can_be_cancelled(self):
        client = AuthorThreadClient()
        error = (503, '')
        with patch.object(Client, 'request', return_value=error), patch.object(client.cancel_event, 'wait', return_value=True):
            with self.assertRaises(PollCancelled):
                client.page(1)

    def test_baseline_reads_latest_page_without_alerting_history(self):
        client = self.client({1: data((0, 1), rows=6, size=2), 3: data((4, 5), number=3, rows=6, size=2)})
        updated, fresh, baseline = poll(client, {'watermark': None})
        self.assertTrue(baseline)
        self.assertEqual(fresh, [])
        self.assertEqual(updated['watermark'], 5)
        self.assertEqual(updated['page'], 3)
        self.assertEqual([call.args[0] for call in client.page.call_args_list], [1, 3])

    def test_catchup_walks_back_across_pages_then_deduplicates(self):
        client = self.client({1: data((1, 2), rows=6, size=2), 2: data((3, 4), number=2, rows=6, size=2), 3: data((5, 6), number=3, rows=6, size=2)})
        updated, fresh, _ = poll(client, {'watermark': 3, 'recent': []})
        self.assertEqual([p['pid'] for p in fresh], [4, 5, 6])
        self.assertEqual([call.args[0] for call in client.page.call_args_list], [1, 3, 2])
        repeated, fresh, _ = poll(client, updated)
        self.assertEqual(fresh, [])
        self.assertEqual(len(repeated['pending']), 3)

    def test_catchup_failure_never_advances_watermark_or_enqueues_partial_posts(self):
        client = self.client({1: data((1, 2), rows=6, size=2), 2: TimeoutError(), 3: data((5, 6), number=3, rows=6, size=2)})
        state = {'watermark': 3, 'page': 2, 'recent': [], 'pending': []}
        before = copy.deepcopy(state)
        with self.assertRaises(TimeoutError):
            poll(client, state)
        self.assertEqual(state, before)

    def test_appended_page_during_catchup_is_also_checked(self):
        client = self.client({1: data((1, 2), rows=4, size=2), 2: data((3, 4), number=2, rows=6, size=2), 3: data((5, 6), number=3, rows=6, size=2)})
        updated, fresh, _ = poll(client, {'watermark': 3})
        self.assertEqual([p['pid'] for p in fresh], [4, 5, 6])
        self.assertEqual(updated['watermark'], 6)
        self.assertEqual(updated['page'], 3)


if __name__ == '__main__':
    unittest.main()
