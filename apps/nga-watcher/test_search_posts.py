import copy
from email.message import Message
import io
import json
from pathlib import Path
import tempfile
import threading
import unittest
import urllib.request
import urllib.response
from unittest.mock import Mock, patch

from feishu import post_key
from search_posts import make_post, parse_search_html, parse_search_page, poll_search
from watcher import AUTHOR, App, AuthorMonitor, AuthorSearchClient, Client, NGAAccessError, PollCancelled, SameOriginRedirect, read_state, save_state


def api_body(records=None):
    if records is None:
        records = [{'tid': 100, 'pid': 42, 'authorid': AUTHOR, 'postdate': 1791902677, 'content': '真实回复'}]
    rows = [{'tid': post['tid'], 'authorid': 999, 'postdate': 1500000000,
             'subject': '原主题', '__P': post} for post in records]
    return json.dumps({'data': {'__T': rows, '__T__ROWS': len(rows), '__T__ROWS_PAGE': 35, '__ROWS': None}})


def html_body(author=AUTHOR, page=1):
    return f"""<html><script>var __PAGE = {{0:'/thread.php?authorid={AUTHOR}&searchpost=1&fid=0',1:-5,2:{page},3:35}};</script>
    <table id='topicrows'><!--topicliststart--><tbody><tr class='row1 topicrow'>
    <td><a class='topic' href='/read.php?tid=100'>原主题</a>
    <a href='/read.php?tid=100&pid=42'>在主题中的回复</a>
    <span id='postsubject100_42'></span><span id='postcontent100_42'>
    [quote][pid=999,777]引用[/pid]<a href='/read.php?tid=777&pid=999'>引用链接</a>[/quote]<br/>真实回复</span>
    <script>commonui.postDispMini($('postsubject100_42'),$('postcontent100_42'),0,100,42,{author},0)</script></td>
    <td><a class='author' href='/nuke.php?uid=999'>主题作者</a><span class='postdate'>1500000000</span></td>
    </tr></tbody><!--topiclistend--></table></html>"""


def post(pid, stamp, tid=100):
    return make_post({'tid': tid, 'pid': pid, 'authorid': AUTHOR, 'postdate': stamp, 'content': '新发言'}, 1, '主题')


def result(posts, number=1):
    return {'posts': posts, 'page': number, 'size': 35, 'rows': None, 'source': 'JSON'}


class FakeSearch:
    is_search = True

    def __init__(self, pages):
        self.pages, self.calls = pages, []

    def page(self, number):
        self.calls.append(number)
        value = self.pages[number]
        if isinstance(value, Exception):
            raise value
        return value


class SearchTests(unittest.TestCase):
    def state(self):
        return {'watermark': 123, 'page': 24, 'pending': [], 'recent': [], 'feishu_outbox': []}

    def active_state(self):
        return dict(self.state(), monitor='author_search', search_watermark=180, search_seen=['100:42'])

    def test_json_uses_reply_author_and_time_instead_of_topic_author_and_time(self):
        parsed = parse_search_page(json.loads(api_body())['data'], 1)
        self.assertEqual(parsed['posts'][0]['authorid'], AUTHOR)
        self.assertEqual(parsed['posts'][0]['timestamp'], 1791902677)
        self.assertEqual(parsed['posts'][0]['tid'], 100)

    def test_json_rejects_missing_fields_wrong_author_and_incomplete_counts(self):
        source = json.loads(api_body())['data']
        cases = []
        for field in ['pid', 'authorid', 'postdate', 'content']:
            changed = copy.deepcopy(source)
            del changed['__T'][0]['__P'][field]
            cases.append(changed)
        changed = copy.deepcopy(source)
        changed['__T'][0]['__P']['authorid'] = 999
        cases.append(changed)
        changed = copy.deepcopy(source)
        changed['__T__ROWS'] = 2
        cases.append(changed)
        changed = copy.deepcopy(source)
        changed['__T'][0]['tid'] = 777
        cases.append(changed)
        for changed in cases:
            with self.subTest(changed=changed), self.assertRaises(ValueError):
                parse_search_page(changed, 1)

    def test_json_rejects_duplicate_or_wrongly_ordered_posts(self):
        a = {'tid': 100, 'pid': 42, 'authorid': AUTHOR, 'postdate': 180, 'content': ''}
        b = dict(a, pid=43, postdate=240)
        for records in [[a, a], [a, b]]:
            with self.assertRaises(ValueError):
                parse_search_page(json.loads(api_body(records))['data'], 1)

    def test_html_validates_reply_metadata_and_ignores_quote_pid(self):
        parsed = parse_search_html(html_body(), 1)
        self.assertEqual([(p['tid'], p['pid'], p['authorid']) for p in parsed['posts']], [(100, 42, AUTHOR)])
        self.assertIn('真实回复', parsed['posts'][0]['content'])
        self.assertNotIn('timestamp', parsed['posts'][0])

    def test_html_rejects_truncation_wrong_author_page_and_forged_reply_link(self):
        for body, number in [(html_body()[:-7], 1), (html_body(999), 1), (html_body(), 2),
                             (html_body().replace("href='/read.php?tid=100&pid=42'", "href='/read.php?tid=100&pid=999'"), 1),
                             (html_body().replace('<!--topiclistend-->', ''), 1),
                             (html_body().replace('commonui.postDispMini', 'otherFunction'), 1)]:
            with self.subTest(number=number), self.assertRaises(ValueError):
                parse_search_html(body, number)

    def test_complete_empty_html_search_page_is_valid(self):
        body = html_body()
        begin, end = body.index('<tbody>'), body.index('</tbody>') + len('</tbody>')
        parsed = parse_search_html(body[:begin] + body[end:], 1)
        self.assertEqual(parsed['posts'], [])

    def test_search_requests_use_normal_urls_without_random_cache_busters(self):
        client = AuthorSearchClient()
        with patch.object(client, 'request', return_value=(200, api_body())) as request:
            client.page(1)
            client.page(2)
        urls = [call.args[0] for call in request.call_args_list]
        self.assertNotIn('rand=', ''.join(urls))
        self.assertIn('page=1', urls[0])
        self.assertIn('page=2', urls[1])

    def test_busy_retries_every_half_second_until_response_succeeds(self):
        client = AuthorSearchClient()
        client.on_retry = Mock()
        client.cancel_event = Mock()
        client.cancel_event.is_set.return_value = False
        client.cancel_event.wait.return_value = False
        busy = (200, json.dumps({'error': ['2048:服务器忙,请稍后重试']}))
        with patch.object(Client, 'request', side_effect=[busy, busy, (200, api_body())]) as request:
            parsed = client.page(1)
        self.assertEqual(parsed['posts'][0]['pid'], 42)
        self.assertEqual(request.call_count, 3)
        self.assertEqual([call.args for call in client.cancel_event.wait.call_args_list], [(0.5,), (0.5,)])
        self.assertEqual(client.on_retry.call_count, 2)

    def test_login_error_does_not_enter_half_second_busy_retry(self):
        client = AuthorSearchClient()
        with patch.object(Client, 'request', return_value=(200, json.dumps({'error': ['2048:你必须登录']}))) as request, patch.object(client.cancel_event, 'wait') as wait:
            with self.assertRaises(NGAAccessError) as caught:
                client.page(1)
        self.assertEqual(caught.exception.kind, 'login')
        self.assertEqual(request.call_count, 1)
        wait.assert_not_called()

    def test_empty_http_503_uses_half_second_retry_and_reports_actual_status(self):
        client = AuthorSearchClient()
        client.on_retry = Mock()
        with patch.object(Client, 'request', side_effect=[(503, ''), (200, api_body())]), patch.object(client.cancel_event, 'wait', return_value=False) as wait:
            parsed = client.page(1)
        self.assertEqual(parsed['source'], 'JSON')
        wait.assert_called_once_with(0.5)
        client.on_retry.assert_called_once_with((1, 'HTTP 503'))

    def test_http_503_with_content_is_not_an_unbounded_busy_loop(self):
        client = AuthorSearchClient()
        with patch.object(Client, 'request', return_value=(503, '<html>需要完成验证</html>')) as request, patch.object(client.cancel_event, 'wait', return_value=False):
            with self.assertRaises(ValueError):
                client.page(1)
        self.assertEqual(request.call_count, 3)

    def test_busy_retry_can_be_cancelled_without_advancing_state(self):
        state = self.active_state()
        before = copy.deepcopy(state)
        client = AuthorSearchClient()
        busy = (200, json.dumps({'error': ['2048:服务器忙,请稍后重试']}))
        with patch.object(Client, 'request', return_value=busy), patch.object(client.cancel_event, 'wait', return_value=True):
            with self.assertRaises(PollCancelled):
                poll_search(client, state)
        self.assertEqual(state, before)

    def test_truncated_json_uses_html_and_verified_detail_time(self):
        client = AuthorSearchClient()
        detail = json.dumps({'data': {'__T': {'tid': 100}, '__R__ROWS': 1,
                                     '__R': [{'pid': 42, 'authorid': AUTHOR, 'postdate': '2026-10-13 22:44', 'content': '真实回复'}]}})
        with patch.object(client, 'request', side_effect=[(200, '{'), (200, '{'), (200, html_body()), (200, detail)]), patch.object(client.cancel_event, 'wait', return_value=False):
            parsed = client.page(1)
        self.assertEqual(parsed['source'], 'HTML')
        self.assertEqual(parsed['posts'][0]['date'], '2026-10-13 22:44')
        self.assertNotEqual(parsed['posts'][0]['timestamp'], 1500000000)

    def test_html_can_reuse_verified_cached_time_without_extra_detail_requests(self):
        client = AuthorSearchClient(cached_posts=[post(42, 180)])
        with patch.object(client, 'request', return_value=(200, html_body())) as request:
            parsed = client.html_page(1)
        self.assertEqual(parsed['posts'][0]['timestamp'], 180)
        self.assertEqual(request.call_count, 1)

    def test_http_503_json_can_still_recover_through_html(self):
        client = AuthorSearchClient(cached_posts=[post(42, 180)])
        with patch.object(client, 'request', side_effect=[(503, ''), (503, ''), (200, html_body())]) as request, patch.object(client.cancel_event, 'wait', return_value=False):
            parsed = client.page(1)
        self.assertEqual(parsed['source'], 'HTML')
        self.assertEqual(request.call_count, 3)

    def test_both_sources_truncated_keep_search_progress(self):
        state = self.active_state()
        before = copy.deepcopy(state)
        client = AuthorSearchClient()
        with patch.object(client, 'request', side_effect=[(200, '{'), (200, '{'), (200, html_body()[:-7])]), patch.object(client.cancel_event, 'wait', return_value=False):
            with self.assertRaises(ValueError):
                poll_search(client, state)
        self.assertEqual(state, before)

    def test_session_cookie_is_not_forwarded_to_other_origins(self):
        request = urllib.request.Request('https://ngabbs.com/thread.php', headers={'Cookie': 'test-login-cookie'})
        for destination in ['https://other.example/thread.php', 'http://ngabbs.com/thread.php']:
            with self.assertRaises(NGAAccessError):
                SameOriginRedirect().redirect_request(request, None, 302, 'Found', {}, destination)

    def test_cookie_updates_are_used_on_same_origin_redirects(self):
        cookie_headers = []

        class Server(urllib.request.HTTPSHandler):
            def https_open(self, request):
                current = request.get_header('Cookie', '')
                cookie_headers.append(current)
                headers = Message()
                if 'session=private-new-session' in current:
                    code, body, message = 200, b'{"ok":1}', 'OK'
                else:
                    code, body, message = 302, b'', 'Found'
                    headers['Set-Cookie'] = 'session=private-new-session; Path=/; Secure; HttpOnly'
                    headers['Location'] = 'https://ngabbs.com/thread.php?redirected=1'
                response = urllib.response.addinfourl(io.BytesIO(body), headers, request.full_url, code)
                response.msg = message
                return response

        client = Client(login_cookie='session=private-old-session')
        builder = urllib.request.build_opener
        with patch('watcher.urllib.request.build_opener', side_effect=lambda *handlers: builder(*handlers, Server())), self.assertLogs('nga-watcher', level='INFO') as logs:
            status, body = client.request('https://ngabbs.com/thread.php')
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body), {'ok': 1})
        self.assertIn('session=private-old-session', cookie_headers[0])
        self.assertIn('session=private-new-session', cookie_headers[1])
        self.assertNotIn('session=private-old-session', cookie_headers[1])
        self.assertNotIn('private-', '\n'.join(logs.output))

    def test_cookie_jar_is_scoped_to_https_and_the_exact_nga_host(self):
        client = Client(login_cookie='session=private-session')
        for url in ['http://ngabbs.com/', 'https://evil.example/', 'https://sub.ngabbs.com/']:
            request = urllib.request.Request(url)
            client.cookies.add_cookie_header(request)
            self.assertIsNone(request.get_header('Cookie'))

    def test_replacing_login_cookie_removes_previous_credentials(self):
        client = Client(login_cookie='session=private-old-session; other=old')
        client.login_cookie = 'session=private-new-session'
        request = urllib.request.Request('https://ngabbs.com/')
        client.cookies.add_cookie_header(request)
        self.assertEqual(request.get_header('Cookie'), 'session=private-new-session')

    def test_switching_baseline_preserves_legacy_progress_and_queues(self):
        state = self.state()
        legacy = {'pid': 123, 'date': 'old', 'content': '旧消息'}
        state['pending'] = [legacy]
        state['feishu_outbox'] = [legacy]
        updated, fresh, baseline = poll_search(FakeSearch({1: result([post(42, 197), post(41, 120)])}), state)
        self.assertTrue(baseline)
        self.assertEqual(fresh, [])
        self.assertEqual(updated['search_watermark'], 180)
        self.assertEqual(updated['watermark'], 123)
        self.assertEqual(updated['pending'], [legacy])
        self.assertEqual(updated['feishu_outbox'], [legacy])

    def test_catch_up_crosses_short_pages_until_previous_time_boundary(self):
        client = FakeSearch({1: result([post(45, 300)]), 2: result([post(44, 240)]),
                             3: result([post(42, 190), post(41, 120)])})
        updated, fresh, _ = poll_search(client, self.active_state())
        self.assertEqual([p['pid'] for p in fresh], [44, 45])
        self.assertEqual(client.calls, [1, 2, 3])
        self.assertEqual(updated['search_watermark'], 300)

    def test_same_minute_posts_and_multiple_topic_roots_have_distinct_identities(self):
        client = FakeSearch({1: result([post(0, 199, 200), post(0, 198, 300), post(42, 190), post(41, 120)])})
        updated, fresh, _ = poll_search(client, self.active_state())
        self.assertEqual({post_key(p) for p in fresh}, {'200:0', '300:0'})
        repeated, again, _ = poll_search(client, updated)
        self.assertEqual(again, [])
        self.assertEqual(len(repeated['pending']), 2)

    def test_same_minute_boundary_continues_to_next_page(self):
        client = FakeSearch({1: result([post(43, 199), post(42, 190)]), 2: result([post(44, 185), post(41, 120)])})
        _, fresh, _ = poll_search(client, self.active_state())
        self.assertEqual({p['pid'] for p in fresh}, {43, 44})
        self.assertEqual(client.calls, [1, 2])

    def test_failed_catch_up_does_not_partially_advance_or_enqueue(self):
        state = self.active_state()
        before = copy.deepcopy(state)
        with self.assertRaises(TimeoutError):
            poll_search(FakeSearch({1: result([post(44, 240)]), 2: TimeoutError()}), state)
        self.assertEqual(state, before)

    def test_ignored_page_parameter_is_detected_and_progress_is_preserved(self):
        state = self.active_state()
        before = copy.deepcopy(state)
        with self.assertRaisesRegex(ValueError, '分页没有前进'):
            poll_search(FakeSearch({1: result([post(44, 240)]), 2: result([post(44, 240)])}), state)
        self.assertEqual(state, before)

    def test_catch_up_limit_does_not_skip_unread_pages(self):
        state = self.active_state()
        before = copy.deepcopy(state)
        with self.assertRaisesRegex(ValueError, '超过 2 页'):
            poll_search(FakeSearch({1: result([post(45, 300)]), 2: result([post(44, 240)])}), state, max_pages=2)
        self.assertEqual(state, before)

    def test_empty_or_stale_search_result_does_not_rewind_watermark(self):
        for posts in [[], [post(41, 120)]]:
            updated, fresh, _ = poll_search(FakeSearch({1: result(posts)}), self.active_state())
            self.assertEqual(fresh, [])
            self.assertEqual(updated['search_watermark'], 180)
            self.assertEqual(updated['search_seen'], ['100:42'])

    def test_restart_keeps_search_boundary_and_legacy_notifications(self):
        updated, _, _ = poll_search(FakeSearch({1: result([post(42, 197)])}), self.state())
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'state.json'
            save_state(updated, path)
            self.assertEqual(read_state(path), updated)

    def test_retry_status_keeps_poll_inflight_and_failure_count_unchanged(self):
        app = App.__new__(App)
        target = AuthorMonitor(AUTHOR, AuthorSearchClient())
        target.busy, target.failed, app.status = True, 2, Mock()
        app.targets = {str(AUTHOR): target}
        app.handle_poll_event('retry', 3)
        self.assertTrue(app.busy)
        self.assertEqual(target.failed, 2)
        self.assertIn('每 0.5 秒重试', app.status.set.call_args.args[0])


if __name__ == '__main__':
    unittest.main()
