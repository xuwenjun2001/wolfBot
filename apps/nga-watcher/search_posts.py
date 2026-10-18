"""Strict parsing and newest-first catch-up for NGA author search results."""
from __future__ import annotations

import html
from html.parser import HTMLParser
import re
import time
import urllib.parse

from feishu import post_key

AUTHOR = 60916468


def plain(text):
    text = re.sub(r'<br\s*/?>|\[/?(?:quote|collapse)[^\]]*\]', '\n', str(text), flags=re.I)
    return html.unescape(re.sub(r'<[^>]*>|\[[^\]]*\]', '', text)).strip()


def make_post(record, page, subject='', author=AUTHOR):
    required = ('tid', 'pid', 'authorid', 'postdate', 'content')
    if not isinstance(record, dict) or any(key not in record for key in required):
        raise ValueError('用户发言字段缺失，原进度已保留')
    try:
        tid, pid, actual_author = (int(record[key]) for key in required[:3])
    except (ValueError, TypeError):
        raise ValueError('用户发言标识或时间格式异常') from None
    date = record['postdate']
    if isinstance(date, str) and re.fullmatch(r'\d{4}-\d{2}-\d{2} \d{2}:\d{2}(?::\d{2})?', date):
        stamp = int(time.mktime(time.strptime(date, '%Y-%m-%d %H:%M:%S' if len(date) == 19 else '%Y-%m-%d %H:%M')))
    else:
        try:
            stamp = int(date)
        except (ValueError, TypeError):
            raise ValueError('用户发言时间格式异常') from None
        date = time.strftime('%Y-%m-%d %H:%M:%S', time.localtime(stamp))
    if tid <= 0 or pid < 0 or actual_author != author or stamp <= 0 or not isinstance(record['content'], str):
        raise ValueError('用户发言作者、标识或时间不匹配')
    return {'tid': tid, 'pid': pid, 'authorid': actual_author, 'timestamp': stamp,
            'date': date,
            'content': plain(record['content']), 'subject': plain(subject), 'page': page}


def parse_search_page(data, requested, author=AUTHOR):
    required = ('__T', '__T__ROWS', '__T__ROWS_PAGE')
    if not isinstance(data, dict) or any(key not in data for key in required):
        raise ValueError('用户发言搜索接口结构变化，原进度已保留')
    records = data['__T']
    if isinstance(records, dict):
        records = list(records.values())
    if not isinstance(records, list):
        raise ValueError('用户发言搜索列表格式异常')
    count, size = int(data['__T__ROWS']), int(data['__T__ROWS_PAGE'])
    if count != len(records) or not 1 <= size <= 100 or count > size or requested < 1:
        raise ValueError('用户发言搜索条数不完整')
    if '__PAGE' in data and int(data['__PAGE']) != requested:
        raise ValueError('用户发言搜索页码不匹配')
    posts = []
    for record in records:
        # The outer author/date belong to the THREAD, not to this user's reply.
        if not isinstance(record, dict) or not isinstance(record.get('__P'), dict):
            raise ValueError('搜索结果缺少回复信息，原进度已保留')
        post = make_post(record['__P'], requested, record.get('subject', ''), author)
        if int(record.get('tid', 0)) != post['tid']:
            raise ValueError('搜索结果的主题与回复不匹配')
        posts.append(post)
    validate_order(posts)
    return {'posts': posts, 'page': requested, 'size': size, 'rows': data.get('__ROWS'), 'source': 'JSON'}


def validate_order(posts):
    if len({post_key(post) for post in posts}) != len(posts):
        raise ValueError('用户发言搜索出现重复记录')
    # Full-post pages expose minute precision; search JSON exposes seconds.
    # Compare actual known minutes and keep all identities at that boundary.
    stamps = [post['timestamp'] // 60 for post in posts]
    if stamps != sorted(stamps, reverse=True):
        raise ValueError('用户发言搜索顺序异常，原进度已保留')


class SearchHTMLParser(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=False)
        self.stack = []
        self.table_depth = None
        self.table_closed = False
        self.started = self.ended = self.closed = False
        self.row = None
        self.row_depth = None
        self.records = []
        self.capture = None
        self.parts = []

    def handle_comment(self, data):
        if self.table_depth and not self.capture:
            if data.strip() == 'topicliststart':
                self.started = True
            elif data.strip() == 'topiclistend':
                self.ended = True

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        identity = attrs.get('id', '')
        if self.capture:
            self.parts.append(self.get_starttag_text())
        if tag not in ('br', 'img', 'meta', 'link', 'hr', 'input', 'wbr'):
            self.stack.append(tag)
        if self.capture:
            return
        if tag == 'table' and identity == 'topicrows':
            if self.table_depth:
                raise ValueError('重复的搜索结果表格')
            self.table_depth = len(self.stack)
        if tag == 'tr' and 'topicrow' in attrs.get('class', '').split() and self.table_depth:
            if self.row is not None:
                raise ValueError('搜索结果行不完整')
            self.row, self.row_depth = {'links': [], 'scripts': []}, len(self.stack)
        if self.row is None:
            return
        content = re.fullmatch(r'postcontent(\d+)_(\d+)', identity)
        if content:
            if 'pid' in self.row:
                raise ValueError('搜索结果行包含多个发言')
            self.row.update(tid=int(content[1]), pid=int(content[2]))
            self.capture, self.parts = ('content', len(self.stack)), []
        elif tag == 'a':
            link = urllib.parse.urlsplit(html.unescape(attrs.get('href', '')))
            query = urllib.parse.parse_qs(link.query)
            if link.path == '/read.php' and 'tid' in query and 'pid' in query:
                self.row['links'].append((int(query['tid'][0]), int(query['pid'][0])))
            if 'topic' in attrs.get('class', '').split():
                self.row['topic_tid'] = int(query.get('tid', ['0'])[0])
                self.capture, self.parts = ('subject', len(self.stack)), []
        elif tag == 'script':
            self.capture, self.parts = ('script', len(self.stack)), []

    def handle_startendtag(self, tag, attrs):
        self.handle_starttag(tag, attrs)
        if tag not in ('br', 'img', 'meta', 'link', 'hr', 'input', 'wbr'):
            self.handle_endtag(tag)

    def handle_endtag(self, tag):
        if self.capture:
            kind, depth = self.capture
            if len(self.stack) == depth and self.stack[-1] == tag:
                value = ''.join(self.parts)
                if kind == 'script':
                    self.row['scripts'].append(value)
                else:
                    self.row[kind] = plain(value)
                self.capture = None
            else:
                self.parts.append(f'</{tag}>')
        if self.row is not None and tag == 'tr' and len(self.stack) == self.row_depth:
            self.records.append(self.row)
            self.row = self.row_depth = None
        if tag == 'table' and self.table_depth == len(self.stack):
            self.table_closed = True
            self.table_depth = None
        for index in range(len(self.stack) - 1, -1, -1):
            if self.stack[index] == tag:
                del self.stack[index:]
                break
        if tag == 'html':
            self.closed = True

    def handle_data(self, data):
        if self.capture:
            self.parts.append(data)

    def handle_entityref(self, name):
        self.handle_data(f'&{name};')

    def handle_charref(self, name):
        self.handle_data(f'&#{name};')


def parse_search_html(body, requested, author=AUTHOR):
    pager = re.search(r"var\s+__PAGE\s*=\s*\{0:'([^']+)',1:(-?\d+),2:(\d+),3:(\d+)\}", body)
    if not pager:
        raise ValueError('用户发言网页缺少分页信息')
    query = urllib.parse.parse_qs(urllib.parse.urlsplit(html.unescape(pager[1])).query)
    current, size = int(pager[3]), int(pager[4])
    if query.get('authorid') != [str(author)] or query.get('searchpost') != ['1'] or current != requested or not 1 <= size <= 100:
        raise ValueError('用户发言网页的作者或分页不匹配')
    parser = SearchHTMLParser()
    parser.feed(body)
    parser.close()
    if not all((parser.started, parser.ended, parser.table_closed, parser.closed)) or parser.row is not None or parser.capture:
        raise ValueError('用户发言网页响应不完整')
    if len(parser.records) > size:
        raise ValueError('用户发言网页条数异常')
    refs = []
    metadata_pattern = re.compile(
        r"commonui\.postDispMini\(\s*\$\(['\"]postsubject(\d+)_(\d+)['\"]\)\s*,"
        r"\s*\$\(['\"]postcontent(\d+)_(\d+)['\"]\)\s*,\s*\d+\s*,"
        r"\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*\d+\s*\)")
    for record in parser.records:
        if any(key not in record for key in ('tid', 'pid', 'content', 'subject', 'topic_tid')):
            raise ValueError('用户发言网页字段缺失')
        identity = (record['tid'], record['pid'])
        matches = metadata_pattern.findall('\n'.join(record['scripts']))
        if len(matches) != 1:
            raise ValueError('用户发言网页缺少可靠的作者标识')
        a, b, c, d, e, f, actual_author = map(int, matches[0])
        if (a, b) != identity or (c, d) != identity or (e, f) != identity or actual_author != author:
            raise ValueError('用户发言网页的作者或 PID 不匹配')
        if identity not in record['links'] or record['topic_tid'] != record['tid']:
            raise ValueError('用户发言网页缺少真实发言链接')
        refs.append({key: record[key] for key in ('tid', 'pid', 'content', 'subject')} | {'authorid': actual_author, 'page': current})
    if len({post_key(post) for post in refs}) != len(refs):
        raise ValueError('用户发言网页出现重复记录')
    return {'posts': refs, 'page': current, 'size': size, 'rows': None, 'source': 'HTML'}


def poll_search(client, state, max_pages=20):
    baseline = state.get('monitor') != 'author_search' or state.get('search_watermark') is None
    old = 0 if baseline else int(state['search_watermark'])
    seen = set(state.get('search_seen', [])) if not baseline else set()
    collected, sources, previous = {}, set(), set()
    first_count = 0
    for number in range(1, max_pages + 1):
        result = client.page(number)
        posts = result['posts']
        if number == 1:
            first_count = len(posts)
        sources.add(result['source'])
        keys = {post_key(post) for post in posts}
        if number > 1 and keys and (keys == previous or keys <= collected.keys()):
            raise ValueError('补查分页没有前进，原进度已保留')
        collected.update({post_key(post): post for post in posts})
        previous = keys
        # A short search page need not be the last page. Only stop after the
        # prior time boundary or a fully validated empty page has been reached.
        if baseline or not posts or min(post['timestamp'] for post in posts) < old:
            break
    else:
        raise ValueError(f'补查超过 {max_pages} 页仍未到达原进度，保留进度等待下次重试')
    posts = sorted(collected.values(), key=lambda post: (post['timestamp'], post['tid'], post['pid']))
    fresh = [] if baseline else [post for post in posts if post['timestamp'] >= old and post_key(post) not in seen]
    watermark = max([old] + [post['timestamp'] // 60 * 60 for post in posts])
    boundary_seen = seen if watermark == old else set()
    boundary_seen |= {post_key(post) for post in posts if post['timestamp'] // 60 * 60 == watermark}
    pending = {post_key(post): post for post in state.get('pending', [])}
    pending.update({post_key(post): post for post in fresh})
    recent = {} if baseline else {post_key(post): post for post in state.get('recent', [])}
    recent.update(collected)
    recent = sorted(recent.values(), key=lambda post: (post['timestamp'], post['tid'], post['pid']))[-35:]
    result = dict(state, monitor='author_search', search_watermark=watermark,
                  search_seen=sorted(boundary_seen), page=1, pending=list(pending.values()), recent=recent,
                  last_success=time.time(), rows=first_count, source=' + '.join(sorted(sources)))
    return result, fresh, baseline
