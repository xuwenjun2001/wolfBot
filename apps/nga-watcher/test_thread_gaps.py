import copy
import json
import math
import unittest
from unittest.mock import patch
from urllib.parse import parse_qs, urlsplit

from test_thread_posts import AUTHOR, TID, record
from watcher import AuthorThreadClient, parse_html_page, parse_thread_page, poll


def page_data(floors=(0, 2), page=1, rows=6, size=3):
    return {'__T': {'tid': TID}, '__PAGE': page, '__ROWS': rows,
            '__R__ROWS_PAGE': size, '__R__ROWS': len(floors),
            '__R': [dict(record(10 + floor), lou=floor) for floor in floors]}


def page_html(data):
    pages = max(1, math.ceil(data['__ROWS'] / data['__R__ROWS_PAGE']))
    parts = [f"<html><script>var __PAGE = {{0:'/read.php?tid={TID}&authorid={AUTHOR}',"
             f"1:{pages},2:{data['__PAGE']},3:{data['__R__ROWS_PAGE']}}};</script>"]
    for post in data['__R']:
        floor = post['lou']
        parts.append(f"<td id='postcontainer{floor}'><a id='pid{post['pid']}Anchor'></a>"
                     f"<a id='postauthor{floor}' href='nuke.php?uid={post['authorid']}'></a>"
                     f"<span id='postdate{floor}'>{post['postdate'][:16]}</span>"
                     f"<span id='postcontent{floor}'>{post['content']}</span></td>")
    return ''.join(parts) + '<!--postlistend--></html>'


class ThreadGapTests(unittest.TestCase):
    def test_complete_page_still_uses_one_json_request(self):
        client = AuthorThreadClient()
        with patch.object(client, 'request', return_value=(200, json.dumps({'data': page_data((0, 1, 2))}))) as request:
            result = client.page(1)
        self.assertEqual(result['source'], 'JSON')
        request.assert_called_once()

    def test_missing_floor_requires_both_complete_sources_and_ignores_quote_pid(self):
        source = page_data()
        client = AuthorThreadClient()
        with patch.object(client, 'request', side_effect=[(200, json.dumps({'data': source})), (200, page_html(source))]) as request:
            result = client.page(1)
        self.assertEqual(result['source'], 'JSON + HTML')
        self.assertEqual(result['missing_floors'], [1])
        self.assertEqual([post['pid'] for post in result['posts']], [10, 12])
        self.assertEqual(request.call_count, 2)
        self.assertNotIn('__output', request.call_args.args[0])
        with self.assertRaises(ValueError):
            parse_thread_page(source, 1, AUTHOR, TID)
        with self.assertRaises(ValueError):
            parse_html_page(page_html(source), 1, AUTHOR, TID)

    def test_gap_json_rejects_bad_counts_floors_scope_and_missing_fields(self):
        cases = []
        source = page_data()
        source['__R__ROWS'] = 3
        cases.append(source)
        for key, value in (('lou', 0), ('lou', 3), ('authorid', 60916468), ('tid', 100)):
            source = page_data()
            source['__R'][1][key] = value
            cases.append(source)
        for key in ('lou', 'pid', 'postdate', 'content'):
            source = page_data()
            del source['__R'][0][key]
            cases.append(source)
        source = page_data()
        for post in source['__R']:
            del post['lou']
        cases.append(source)
        source = page_data()
        source['__R'][0]['lou'], source['__R'][1]['lou'] = 2, 0
        cases.append(source)
        source = page_data()
        source['__PAGE'] = 2
        cases.append(source)
        for source in cases:
            with self.subTest(source=source), self.assertRaises((ValueError, KeyError)):
                parse_thread_page(source, 1, AUTHOR, TID, allow_gaps=True)

    def test_gap_html_rejects_truncation_bad_scope_duplicate_container_and_missing_fields(self):
        body = page_html(page_data())
        cases = [body[:-7], body.replace('<!--postlistend-->', ''),
                 body.replace('tid=' + str(TID), 'tid=100'),
                 body.replace('uid=' + str(AUTHOR), 'uid=60916468', 1),
                 body.replace("id='postcontent0'", "id='missing'"),
                 body.replace("id='postcontainer2'", "id='postcontainer3'"),
                 body.replace('<!--postlistend-->', "<td id='postcontainer0'></td><!--postlistend-->")]
        for changed in cases:
            with self.subTest(body=changed), self.assertRaises(ValueError):
                parse_html_page(changed, 1, AUTHOR, TID, allow_gaps=True)

    def test_disagreeing_sources_never_advance_progress_or_enqueue_partial_results(self):
        source = page_data()
        body = page_html(source)
        wrong_floors = body
        for kind in ('container', 'author', 'date', 'content'):
            wrong_floors = wrong_floors.replace(f'post{kind}2', f'post{kind}1')
        cases = [body.replace('pid12Anchor', 'pid99Anchor'),
                 body.replace('实际发言', '不同发言', 1),
                 body.replace('09:00', '09:01', 1),
                 body.replace('1:2,2:1', '1:3,2:1'), wrong_floors, body[:-7]]
        for changed in cases:
            with self.subTest(body=changed):
                state = {'watermark': 11, 'page': 1, 'pending': [], 'recent': []}
                before = copy.deepcopy(state)
                client = AuthorThreadClient()
                responses = [(200, json.dumps({'data': source})), (200, changed)] * 2
                with patch.object(client, 'request', side_effect=responses), patch.object(client.cancel_event, 'wait', return_value=False):
                    with self.assertRaisesRegex(ValueError, '一致性验证'):
                        poll(client, state)
                self.assertEqual(state, before)

    def test_html_alone_cannot_confirm_a_gap_after_json_truncation(self):
        client = AuthorThreadClient()
        state = {'watermark': 11, 'page': 1, 'pending': [], 'recent': []}
        before = copy.deepcopy(state)
        with patch.object(client, 'request', side_effect=[(200, '{'), (200, '{'), (200, page_html(page_data()))]), patch.object(client.cancel_event, 'wait', return_value=False):
            with self.assertRaises(ValueError):
                poll(client, state)
        self.assertEqual(state, before)

    def test_confirmation_compares_real_times_at_available_minute_precision(self):
        source = page_data()
        source['__R'][0]['postdate'] = '2026-10-14 09:00:37'
        client = AuthorThreadClient()
        with patch.object(client, 'request', side_effect=[(200, json.dumps({'data': source})), (200, page_html(source))]):
            result = client.page(1)
        self.assertEqual(result['source'], 'JSON + HTML')
        self.assertEqual(result['posts'][0]['date'], '2026-10-14 09:00:37')

    def test_last_page_gap_keeps_server_slot_count(self):
        source = page_data((6,), page=3, rows=8)
        client = AuthorThreadClient()
        with patch.object(client, 'request', side_effect=[(200, json.dumps({'data': source})), (200, page_html(source))]):
            result = client.page(3)
        self.assertEqual((result['rows'], result['pages']), (8, 3))
        self.assertEqual(result['missing_floors'], [7])

    def test_catchup_crosses_gap_and_empty_pages_without_skipping_unread_posts(self):
        for middle in ((3, 5), ()):
            with self.subTest(middle=middle):
                sources = {1: page_data((0, 1, 2), rows=9),
                           2: page_data(middle, page=2, rows=9),
                           3: page_data((6, 7, 8), page=3, rows=9)}
                calls = []
                def request(url):
                    query = parse_qs(urlsplit(url).query)
                    page = int(query['page'][0])
                    is_json = '__output' in query
                    calls.append((page, is_json))
                    return 200, json.dumps({'data': sources[page]}) if is_json else page_html(sources[page])
                client = AuthorThreadClient()
                state = {'watermark': 11, 'page': 1, 'pending': [], 'recent': []}
                with patch.object(client, 'request', side_effect=request):
                    updated, fresh, baseline = poll(client, state)
                    repeated, again, _ = poll(client, updated)
                expected = [12] + [10 + floor for floor in middle] + [16, 17, 18]
                self.assertFalse(baseline)
                self.assertEqual([post['pid'] for post in fresh], expected)
                self.assertEqual((updated['page'], updated['watermark']), (3, 18))
                self.assertEqual(updated['source'], 'HTML + JSON')
                self.assertEqual(again, [])
                self.assertEqual(repeated['pending'], updated['pending'])
                self.assertEqual(calls, [(1, True), (3, True), (2, True), (2, False), (3, True)])


if __name__ == '__main__':
    unittest.main()
