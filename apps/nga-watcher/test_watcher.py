import copy
import tempfile
import unittest
import json
from unittest.mock import patch
from pathlib import Path
from watcher import AUTHOR, Client, NGAAccessError, check_access, parse_page, poll, read_state, save_state, read_response, parse_html_page


def page(number, pages, ids):
    return {'page': number, 'pages': pages, 'rows': pages * 20,
            'posts': [{'pid': pid, 'date': 'now', 'content': '新发言', 'page': number} for pid in ids]}


class FakeClient:
    def __init__(self, pages):
        self.pages = pages
    def page(self, number):
        value = self.pages[number]
        if isinstance(value, Exception):
            raise value
        return value


class WatcherTests(unittest.TestCase):
    def test_error_2048_distinguishes_login_and_server_busy(self):
        for text, expected in [('你必须登录', 'login'), ('服务器忙,请稍后重试', 'busy')]:
            for body in [json.dumps({'error': ['2048:' + text]}),
                         '<html><body>(ERROR:<b>2048</b>) &gt; ' + text + '</body></html>']:
                with self.subTest(text=text, body=body), self.assertRaises(NGAAccessError) as caught:
                    check_access(200, body)
                self.assertEqual(caught.exception.kind, expected)

    def test_busy_or_login_does_not_retry_immediately_or_refresh_session(self):
        for text in ['你必须登录', '服务器忙,请稍后重试']:
            client = Client()
            with patch.object(client, 'request', return_value=(200, json.dumps({'error': ['2048:' + text]}))) as request, patch.object(client, 'refresh_guest') as refresh:
                with self.assertRaises(NGAAccessError):
                    client.page(1)
                self.assertEqual(request.call_count, 1)
                refresh.assert_not_called()

    def test_post_content_mentioning_login_or_busy_is_not_an_error(self):
        self.assertIsNone(check_access(200, '<html><span>你必须登录，服务器忙</span></html>'))
        self.assertIsNone(check_access(200, json.dumps({'data': {'content': '服务器忙'}})))
        self.assertIsNone(check_access(200, "<html><!--topicliststart--><span>(ERROR:2048) &gt; 服务器忙</span></html>"))

    def test_login_failure_keeps_original_progress(self):
        state = self.state(40)
        before = copy.deepcopy(state)
        with patch.object(Client, 'request', return_value=(200, json.dumps({'error': ['2048:你必须登录']}))):
            with self.assertRaises(NGAAccessError):
                poll(Client(), state)
        self.assertEqual(state, before)

    def test_short_http_reads_are_joined_until_eof(self):
        class Response:
            chunks = iter([b'{"data":', b'{"value":1}', b'}', b''])
            def read(self, size):
                return next(self.chunks)
        self.assertEqual(json.loads(read_response(Response())), {'data': {'value': 1}})

    def test_response_size_limit(self):
        class Response:
            def read(self, size):
                return b'x' * size
        with self.assertRaises(ValueError):
            read_response(Response(), limit=100)

    def api_body(self):
        return json.dumps({'data': {'__R': [{'pid': 42, 'authorid': AUTHOR, 'content': 'test'}],
                                   '__ROWS': 1, '__R__ROWS_PAGE': 20, '__PAGE': 1}})

    def test_truncated_json_is_retried(self):
        client = Client()
        with patch.object(client, 'refresh_guest'), patch.object(client, 'request', side_effect=[(200, '{"data":'), (200, self.api_body())]) as request, patch('watcher.time.sleep'):
            self.assertEqual(client.page(1)['posts'][0]['pid'], 42)
            self.assertEqual(request.call_count, 2)

    def test_repeated_truncation_is_reported_without_login_hint(self):
        with patch.object(Client, 'refresh_guest'), patch.object(Client, 'request', return_value=(200, '{"data":')) as request, patch('watcher.time.sleep'):
            with self.assertRaisesRegex(RuntimeError, '均读取失败'):
                Client().page(1)
            self.assertEqual(request.call_count, 3)

    def html_body(self, author=AUTHOR):
        return f"""<html><script>var __PAGE = {{0:'/read.php?tid=47559481&authorid=60916468&opt=262144',1:1,2:1,3:20}};</script>
        <a id='postauthor0' href='nuke.php?uid={author}'></a>
        <td id='postcontainer0'><a id='pid42Anchor'></a>
        <span id='postdate0'>2026-09-23 12:00</span>
        <span id='postcontent0'>[quote][pid=999]wrong[/pid][/quote]<br/>new <b>post</b></span></td>
        <!--postlistend--></html>"""

    def test_json_failure_uses_html(self):
        with patch.object(Client, 'request', side_effect=[(200, '{'), (200, '{'), (200, self.html_body())]), patch('watcher.time.sleep'):
            result = Client().page(1)
            self.assertEqual(result['source'], 'HTML')
            self.assertEqual(result['posts'][0]['pid'], 42)

    def test_html_rejects_truncation_wrong_author_and_page(self):
        for body, page_number in [(self.html_body()[:-7], 1), (self.html_body(123), 1), (self.html_body(), 2)]:
            with self.subTest(page=page_number, body=body[-30:]):
                with self.assertRaises(ValueError):
                    parse_html_page(body, page_number)

    def test_quote_pid_and_markup(self):
        result = parse_html_page(self.html_body(), 1)
        self.assertEqual(result['posts'][0]['pid'], 42)
        self.assertIn('new post', result['posts'][0]['content'])

    def test_html_missing_anchor_or_content_is_rejected(self):
        for body in [self.html_body().replace("id='pid42Anchor'", "id='missing'"),
                     self.html_body().replace("id='postcontent0'", "id='missing'")]:
            with self.assertRaises(ValueError):
                parse_html_page(body, 1)

    def test_both_sources_fail_without_advancing_state(self):
        state = self.state(40)
        before = copy.deepcopy(state)
        with patch.object(Client, 'request', side_effect=[(200, '{'), (200, '{'), (200, self.html_body()[:-7])]), patch('watcher.time.sleep'):
            with self.assertRaises(RuntimeError):
                poll(Client(), state)
        self.assertEqual(state, before)

    def test_transport_incomplete_read_uses_html(self):
        from http.client import IncompleteRead
        with patch.object(Client, 'request', side_effect=[IncompleteRead(b'partial'), IncompleteRead(b'partial'), (200, self.html_body())]), patch('watcher.time.sleep'):
            self.assertEqual(Client().page(1)['source'], 'HTML')

    def test_truncation_does_not_refresh_guest(self):
        with patch.object(Client, 'refresh_guest') as refresh, patch.object(Client, 'request', side_effect=[(200, '{'), (200, '{'), (200, self.html_body())]), patch('watcher.time.sleep'):
            Client().page(1)
            refresh.assert_not_called()

    def test_expired_guest_cookie_refresh(self):
        client = Client()
        client.guest = 'guestJs=expired'
        gate = json.dumps({'error': ['15:访客不能直接访问', "document.cookie = 'guestJs=renewed;path=/'"], 'data': {}})
        with patch.object(client, 'request', side_effect=[(403, gate), (403, "document.cookie = 'guestJs=renewed;path=/'"), (200, self.api_body())]):
            self.assertEqual(client.page(1)['posts'][0]['pid'], 42)
            self.assertEqual(client.guest, 'guestJs=renewed')

    def state(self, watermark=None, page=1):
        return {'watermark': watermark, 'page': page, 'pending': [], 'recent': []}

    def test_baseline_does_not_alert_old_posts(self):
        state, fresh, baseline = poll(FakeClient({1: page(1, 7, [1, 2]), 7: page(7, 7, [120, 130])}), self.state())
        self.assertTrue(baseline)
        self.assertEqual(fresh, [])
        self.assertEqual(state['watermark'], 130)
        self.assertEqual(state['page'], 7)

    def test_cross_pages_and_ignore_other_authors(self):
        data = {'__R': [{'pid': 5, 'authorid': AUTHOR, 'content': 'a'}, {'pid': 6, 'authorid': 99}], '__ROWS': 21, '__R__ROWS_PAGE': 20, '__PAGE': 2}
        result = parse_page(data, 2)
        self.assertEqual([p['pid'] for p in result['posts']], [5])
        self.assertEqual(result['pages'], 2)

    def test_catch_up_multiple_pages(self):
        client = FakeClient({6: page(6, 9, [110]), 7: page(7, 9, [130, 131]), 8: page(8, 9, [132]), 9: page(9, 9, [133])})
        state, fresh, _ = poll(client, self.state(130, 7))
        self.assertEqual([p['pid'] for p in fresh], [131, 132, 133])
        self.assertEqual(state['page'], 9)

    def test_repeat_poll_does_not_repeat_alert(self):
        client = FakeClient({1: page(1, 1, [10, 11])})
        state, _, _ = poll(client, self.state(10))
        state, fresh, _ = poll(client, state)
        self.assertEqual(fresh, [])
        self.assertEqual(len(state['pending']), 1)

    def test_partial_failure_keeps_original_state(self):
        state = self.state(10)
        before = copy.deepcopy(state)
        with self.assertRaises(TimeoutError):
            poll(FakeClient({1: page(1, 2, [10, 11]), 2: TimeoutError()}), state)
        self.assertEqual(state, before)

    def test_deleted_posts_shift_boundary(self):
        state, fresh, _ = poll(FakeClient({6: page(6, 6, [131])}), self.state(130, 7))
        self.assertEqual(fresh[0]['pid'], 131)
        self.assertEqual(state['page'], 6)

    def test_unknown_response_rejected(self):
        with self.assertRaises(ValueError):
            parse_page({'__R': []}, 1)

    def test_restart_preserves_pending_and_watermark(self):
        state = self.state(12)
        state['pending'] = [{'pid': 12, 'content': '测试'}]
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'state.json'
            save_state(state, path)
            self.assertEqual(read_state(path), state)


if __name__ == '__main__':
    unittest.main()
