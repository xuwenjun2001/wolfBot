"""NGA author-post watcher. Python standard library only."""
from __future__ import annotations

import ctypes
import html
from html.parser import HTMLParser
from http.client import HTTPException
from http.cookiejar import Cookie, CookieJar, DefaultCookiePolicy
import json
import logging
from logging.handlers import RotatingFileHandler
import math
import os
from pathlib import Path
import queue
import re
import sys
import threading
import time
import tkinter as tk
from tkinter import ttk, messagebox
import urllib.error
import urllib.parse
import urllib.request
import webbrowser

from feishu import DEFAULT_CONFIG, FeishuClient, post_key, post_url, read_config, validate_config
from monitor_state import AUTHORS, THREADS, merge_author_result, monitor_url, prepare_monitors, search_url
from nga_auth import SEARCH_URL, load_cookie, open_settings as open_nga_settings, validate_cookie
from search_posts import make_post, parse_search_html, parse_search_page, poll_search, validate_order

URL = 'https://ngabbs.com/read.php?tid=47559481&authorid=60916468&opt=262144'
AUTHOR = 60916468
INTERVAL = 60
DATA = Path(os.environ.get('LOCALAPPDATA', str(Path.home()))) / 'NGAWatcher'
STATE_FILE = DATA / 'state.json'
FEISHU_CONFIG_FILE = DATA / 'feishu.json'
LOG = logging.getLogger('nga-watcher')


def read_response(response, limit=8_000_000):
    """A sized HTTP read may be short; keep reading until EOF."""
    chunks = []
    total = 0
    while True:
        chunk = response.read(min(65536, limit + 1 - total))
        if not chunk:
            return b''.join(chunks)
        chunks.append(chunk)
        total += len(chunk)
        if total > limit:
            raise ValueError('服务器响应超过大小限制')


def plain(text):
    text = re.sub(r'<br\s*/?>|\[/?(?:quote|collapse)[^\]]*\]', '\n', str(text), flags=re.I)
    return html.unescape(re.sub(r'<[^>]*>|\[[^\]]*\]', '', text)).strip()


def save_state(state, path=STATE_FILE):
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix('.tmp')
    temp.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding='utf-8')
    temp.replace(path)


def read_state(path=STATE_FILE):
    if not path.exists():
        return {'watermark': None, 'page': 1, 'pending': [], 'recent': []}
    state = json.loads(path.read_text(encoding='utf-8'))
    if not isinstance(state.get('pending'), list) or not isinstance(state.get('page'), int):
        raise ValueError('监控记录格式异常，请保留 state.json 后检查，避免重置进度漏报。')
    return state


class NGAAccessError(RuntimeError):
    def __init__(self, kind, message):
        super().__init__(message)
        self.kind = kind


class NGAHTTPError(ValueError):
    pass


def check_access(status, body):
    """An NGA HTTP 200 or ERROR:2048 alone does not mean success or busy."""
    message, code = '', None
    try:
        payload = json.loads(body)
    except ValueError:
        payload = None
    if isinstance(payload, dict):
        errors = payload.get('error')
        if isinstance(errors, list):
            message = ' '.join(value for value in errors if isinstance(value, str))
        match = re.search(r'(?:^|\s)(\d+):', message)
        if match:
            code = int(match[1])
    else:
        stripped = re.sub(r'<(?:script|style)\b.*?</(?:script|style)>', '', body, flags=re.S | re.I)
        message = plain(stripped)
        is_post_page = '<!--topicliststart-->' in body or bool(re.search(r"id=['\"]postcontainer\d+['\"]", body))
        match = None if is_post_page else re.search(r'\(ERROR:\s*(\d+)\)', message, re.I)
        if match:
            code = int(match[1])
        else:
            # Do not classify words inside ordinary post content as errors.
            message = ''
    if any(value in message for value in ('必须登录', '请先登录', '需要登录')):
        raise NGAAccessError('login', f'NGA 要求登录（ERROR:{code or 2048}）；请在“NGA 登录态”中配置或更新 Cookie，原进度已保留')
    if any(value in message for value in ('服务器忙', '访问过于频繁', '操作过于频繁')):
        raise NGAAccessError('busy', f'NGA 服务器忙（ERROR:{code or 2048}）；60 秒后重试，原进度已保留')
    if '帖子审核未通过' in message:
        raise NGAAccessError('restricted', 'NGA 帖子审核未通过，暂时无法读取，原进度已保留')
    if 'guestJs=' in body and (status in (403, 503) or '访客不能直接访问' in message):
        return 'guest'
    if code is not None:
        raise NGAAccessError('restricted', f'NGA 访问受限（' + (f'ERROR:{code}，' if code is not None else '') + f'HTTP {status}），原进度已保留')
    if status != 200:
        raise NGAHTTPError(f'NGA 请求失败（HTTP {status}），原进度已保留')
    return None


class SameOriginRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        before, after = urllib.parse.urlsplit(req.full_url), urllib.parse.urlsplit(newurl)
        if (before.scheme, before.netloc) != (after.scheme, after.netloc):
            raise NGAAccessError('redirect', 'NGA 请求跳转到了其他网站，已停止发送登录态，原进度已保留')
        return super().redirect_request(req, fp, code, msg, headers, newurl)


class Client:
    def __init__(self, url=URL, login_cookie=''):
        self.url = url
        self.login_cookie = login_cookie
        self._guest = ''

    def set_cookie(self, name, value):
        if not re.fullmatch(r"[!#$%&'*+.^_`|~0-9A-Za-z-]+", name):
            raise ValueError('NGA Cookie 字段格式异常，请重新复制请求头中的 Cookie 值')
        self.cookies.set_cookie(Cookie(
            version=0, name=name, value=value, port=None, port_specified=False,
            domain='ngabbs.com', domain_specified=False, domain_initial_dot=False,
            path='/', path_specified=True, secure=True, expires=None, discard=True,
            comment=None, comment_url=None, rest={'HttpOnly': None}, rfc2109=False))

    @property
    def login_cookie(self):
        return self._login_cookie

    @login_cookie.setter
    def login_cookie(self, value):
        self._login_cookie = validate_cookie(value)
        self.cookies = CookieJar(policy=DefaultCookiePolicy(strict_ns_domain=DefaultCookiePolicy.DomainStrict))
        for item in self._login_cookie.split(';'):
            if not item.strip():
                continue
            name, separator, content = item.strip().partition('=')
            if not separator:
                raise ValueError('NGA Cookie 字段格式异常')
            self.set_cookie(name, content)

    @property
    def guest(self):
        return self._guest

    @guest.setter
    def guest(self, value):
        self._guest = value
        for cookie in list(self.cookies):
            if cookie.name == 'guestJs':
                self.cookies.clear(cookie.domain, cookie.path, cookie.name)
        if value:
            name, separator, content = value.partition('=')
            if separator:
                self.set_cookie(name, content)

    def request(self, url):
        started = time.monotonic()
        req = urllib.request.Request(url, headers={
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
            'Referer': f'https://ngabbs.com/nuke.php?func=ucp&uid={self.author}' if getattr(self, 'is_search', False) else self.url,
            'Cache-Control': 'max-age=0',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
            'Accept-Language': 'zh-CN,zh;q=0.9',
            'Sec-Fetch-Dest': 'document', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Site': 'same-origin',
            'Upgrade-Insecure-Requests': '1',
        })
        try:
            response = urllib.request.build_opener(SameOriginRedirect(), urllib.request.HTTPCookieProcessor(self.cookies)).open(req, timeout=20)
        except urllib.error.HTTPError as exc:
            response = exc
        with response:
            raw = read_response(response)
            status = response.status
            charset = response.headers.get_content_charset()
        try:
            text = raw.decode(charset or 'utf-8')
        except (UnicodeDecodeError, LookupError):
            text = raw.decode('gb18030')
        LOG.info("Request uid=%s source=%s status=%s bytes=%s seconds=%.2f",
                 getattr(self, 'author', AUTHOR), "JSON" if "__output" in url else "HTML", status, len(raw), time.monotonic() - started)
        return status, text

    def page(self, number):
        errors = []
        for attempt in range(2):
            try:
                status, body = self.request(f'{self.url}&page={number}&__output=11&rand={time.time_ns()}')
                if check_access(status, body) == 'guest':
                    self.refresh_guest(number)
                    raise ValueError('访客会话已刷新')
                payload = json.loads(body)
                if status != 200 or not isinstance(payload, dict) or payload.get('error'):
                    raise ValueError(f'接口访问受限（HTTP {status}）')
                result = parse_page(payload['data'], number)
                result['source'] = 'JSON'
                return result
            except NGAAccessError:
                # Login and busy responses affect both views. Do not add
                # immediate retries or HTML traffic to an already busy site.
                raise
            except (ValueError, KeyError, OSError, HTTPException) as exc:
                errors.append(type(exc).__name__ + ': ' + str(exc))
                LOG.warning('JSON page=%s attempt=%s failed=%s', number, attempt + 1, errors[-1])
                if attempt == 0:
                    time.sleep(1)
        LOG.info('HTML fallback page=%s', number)
        try:
            return self.html_page(number)
        except (ValueError, OSError, HTTPException) as exc:
            raise RuntimeError(f'第 {number} 页 JSON 与网页均读取失败：{exc}。已保留进度。') from exc

    def html_page(self, number):
        for attempt in range(2):
            status, body = self.request(f'{self.url}&page={number}&rand={time.time_ns()}')
            if check_access(status, body) == 'guest' and attempt == 0:
                self.refresh_guest(number)
                continue
            if status != 200:
                raise ValueError(f'网页访问失败 HTTP {status}')
            result = parse_html_page(body, number)
            LOG.info('HTML fallback OK page=%s posts=%s', number, len(result['posts']))
            return result
        raise ValueError('网页访客会话建立失败')

    def refresh_guest(self, number):
        # Establish the session through the ordinary HTML landing page, just
        # like the browser; a token from the JSON error can yield partial data.
        self.guest = ''
        _, landing = self.request(f'{self.url}&page={number}&rand={time.time_ns()}')
        match = re.search(r"guestJs=([^;'\s]+)", landing)
        if match:
            self.guest = 'guestJs=' + match.group(1)
            return True
        return False


class PostHTMLParser(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=False)
        self.posts = {}
        self.stack = []
        self.capture = None
        self.parts = []
        self.closed = False
        self.ended = False

    def handle_comment(self, data):
        if data.strip() == 'postlistend':
            self.ended = True

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        identity = attrs.get('id', '')
        if self.capture:
            self.parts.append(self.get_starttag_text())
        if tag not in ('br', 'img', 'meta', 'link', 'hr', 'input', 'wbr'):
            self.stack.append((tag, identity))
        match = re.fullmatch(r'post(author|date|content|container)(\d+)', identity)
        if match:
            kind, index = match.groups()
            record = self.posts.setdefault(index, {})
            if kind == 'author':
                record['authorid'] = int(urllib.parse.parse_qs(urllib.parse.urlsplit(attrs.get('href', '')).query).get('uid', ['0'])[0])
            elif kind in ('date', 'content'):
                self.capture = (index, kind, len(self.stack))
                self.parts = []
        pid = re.fullmatch(r'pid(\d+)Anchor', identity)
        if pid and not self.capture:
            for _, parent in reversed(self.stack):
                container = re.fullmatch(r'postcontainer(\d+)', parent)
                if container:
                    self.posts.setdefault(container[1], {})['pid'] = int(pid[1])
                    break

    def handle_startendtag(self, tag, attrs):
        self.handle_starttag(tag, attrs)
        if tag not in ('br', 'img', 'meta', 'link', 'hr', 'input', 'wbr'):
            self.handle_endtag(tag)

    def handle_endtag(self, tag):
        if self.capture:
            index, kind, depth = self.capture
            if len(self.stack) == depth and self.stack[-1][0] == tag:
                self.posts[index][kind] = plain(''.join(self.parts))
                self.capture = None
            else:
                self.parts.append(f'</{tag}>')
        for i in range(len(self.stack) - 1, -1, -1):
            if self.stack[i][0] == tag:
                del self.stack[i:]
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


def parse_html_page(body, requested, author=AUTHOR, tid=47559481):
    pager = re.search(r"var\s+__PAGE\s*=\s*\{0:'([^']+)',1:(\d+),2:(\d+),3:(\d+)\}", body)
    if not pager:
        raise ValueError('网页缺少分页信息，可能是登录页或响应不完整')
    query = urllib.parse.parse_qs(urllib.parse.urlsplit(html.unescape(pager[1])).query)
    pages, current, size = map(int, pager.groups()[1:])
    if query.get('tid') != [str(tid)] or query.get('authorid') != [str(author)] or current != requested or not 1 <= current <= pages or size <= 0:
        raise ValueError('网页帖子、作者或分页不匹配')
    parser = PostHTMLParser()
    parser.feed(body)
    parser.close()
    records = parser.posts
    if not parser.closed or not parser.ended or parser.capture or not records:
        raise ValueError('网页响应不完整')
    expected = list(range((current - 1) * size, (current - 1) * size + len(records)))
    if sorted(map(int, records)) != expected or len(records) > size or (current < pages and len(records) != size):
        raise ValueError('网页发言数量或楼层不完整')
    posts = []
    for index in expected:
        record = records[str(index)]
        if not all(key in record for key in ('pid', 'authorid', 'content', 'date')) or record['authorid'] != author or record['pid'] < 0 or not re.fullmatch(r'\d{4}-\d{2}-\d{2} \d{2}:\d{2}', record['date']):
            raise ValueError('网页发言字段缺失或作者不匹配')
        post = make_post(dict(record, tid=tid, postdate=record['date']), current, author=author)
        # PostHTMLParser already converted the content to plain text. Decoding
        # it again changes quoted entities and can remove literal angle brackets.
        post['content'] = record['content']
        posts.append(post)
    if len({p['pid'] for p in posts}) != len(posts):
        raise ValueError('网页出现重复 PID')
    return {'posts': posts, 'page': current, 'pages': pages,
            'rows': (current - 1) * size + len(posts) if current == pages else None, 'source': 'HTML'}


def parse_page(data, requested):
    required = ('__R', '__ROWS', '__R__ROWS_PAGE', '__PAGE')
    if any(key not in data for key in required):
        raise ValueError('NGA 返回结构变化，已停止本次检查，保留原进度')
    rows, size, page = int(data['__ROWS']), int(data['__R__ROWS_PAGE']), int(data['__PAGE'])
    if rows < 0 or size <= 0 or page != requested:
        raise ValueError('分页数据异常，保留原进度')
    raw_posts = data['__R']
    if isinstance(raw_posts, dict):
        raw_posts = list(raw_posts.values())
    if not isinstance(raw_posts, list):
        raise ValueError('发言列表格式异常')
    posts = []
    for post in raw_posts:
        if int(post.get('authorid', 0)) != AUTHOR:
            continue
        pid = int(post.get('pid', 0))
        if pid <= 0:
            continue
        posts.append({'pid': pid, 'date': str(post.get('postdate', '')),
                      'content': plain(post.get('content', '')), 'page': page})
    if '__R__ROWS' in data and (len(raw_posts) != int(data['__R__ROWS']) or len(posts) != len(raw_posts)):
        raise ValueError('JSON 发言数量或作者不匹配，保留原进度')
    if rows and not posts:
        raise ValueError('页面有记录但未找到目标用户发言，保留原进度')
    return {'posts': posts, 'pages': max(1, math.ceil(rows / size)), 'rows': rows, 'page': page}


def parse_thread_page(data, requested, author, tid):
    required = ('__T', '__R', '__ROWS', '__R__ROWS_PAGE', '__R__ROWS', '__PAGE')
    if not isinstance(data, dict) or any(key not in data for key in required):
        raise ValueError('帖子接口结构不完整，原进度已保留')
    if not isinstance(data['__T'], dict) or int(data['__T'].get('tid', 0)) != tid:
        raise ValueError('帖子接口的主题不匹配，原进度已保留')
    rows, size, current = int(data['__ROWS']), int(data['__R__ROWS_PAGE']), int(data['__PAGE'])
    pages = max(1, math.ceil(rows / size)) if size > 0 else 0
    if rows < 0 or not 1 <= size <= 100 or current != requested or not 1 <= current <= pages:
        raise ValueError('帖子分页数据异常，原进度已保留')
    records = data['__R']
    records = list(records.values()) if isinstance(records, dict) else records
    expected = min(size, max(0, rows - (current - 1) * size))
    if not isinstance(records, list) or len(records) != expected or int(data['__R__ROWS']) != expected:
        raise ValueError('帖子发言数量不完整，原进度已保留')
    posts = []
    for record in records:
        if not isinstance(record, dict) or int(record.get('tid', 0)) != tid:
            raise ValueError('帖子发言主题不匹配，原进度已保留')
        posts.append(make_post(record, current, data['__T'].get('subject', ''), author))
    ids = [post['pid'] for post in posts]
    if ids != sorted(set(ids)):
        raise ValueError('帖子发言重复或顺序异常，原进度已保留')
    return {'posts': posts, 'page': current, 'pages': pages, 'rows': rows, 'source': 'JSON'}


class PollCancelled(RuntimeError):
    pass


class PollingClient(Client):
    def __init__(self, url, login_cookie, author):
        self.author = int(author)
        super().__init__(url, login_cookie)
        self.cancel_event = threading.Event()
        self.on_retry = None

    def request(self, url):
        attempt = 0
        while True:
            if self.cancel_event.is_set():
                raise PollCancelled()
            status, body = super().request(url)
            reason = None
            try:
                check_access(status, body)
            except NGAAccessError as exc:
                if exc.kind != 'busy':
                    raise
                reason = 'ERROR:2048'
            except NGAHTTPError:
                if status != 503 or body.strip():
                    raise
                reason = 'HTTP 503'
            if reason:
                attempt += 1
                LOG.info('NGA busy uid=%s retry=%s delay=1 source=%s reason=%s', self.author, attempt, 'JSON' if '__output' in url else 'HTML', reason)
                if self.on_retry:
                    self.on_retry((attempt, reason))
                if self.cancel_event.wait(1):
                    raise PollCancelled()
                continue
            return status, body

    def page_url(self, number):
        # Explicit page=1 worked when the URL without a page returned an empty
        # HTTP 503. Keep ordinary, stable page URLs rather than random values.
        return f'{self.url}&page={number}'


class AuthorSearchClient(PollingClient):
    is_search = True

    def __init__(self, login_cookie='', cached_posts=(), author=AUTHOR):
        super().__init__(search_url(author), login_cookie, author)
        self.cache = {post_key(post): dict(post) for post in cached_posts
                      if 'tid' in post and 'timestamp' in post and post.get('authorid') == self.author}

    def page(self, number):
        for attempt in range(2):
            try:
                status, body = self.request(self.page_url(number) + '&__output=11')
                if check_access(status, body) == 'guest':
                    raise NGAAccessError('login', '用户发言搜索页需要登录，请更新“NGA 登录态”')
                result = parse_search_page(json.loads(body)['data'], number, self.author)
                self.cache.update({post_key(post): dict(post) for post in result['posts']})
                LOG.info('Search JSON OK uid=%s page=%s posts=%s', self.author, number, len(result['posts']))
                return result
            except (NGAAccessError, PollCancelled):
                raise
            except (ValueError, KeyError, TypeError, OSError, HTTPException) as exc:
                LOG.warning('Search JSON uid=%s page=%s attempt=%s failed=%s', self.author, number, attempt + 1, type(exc).__name__)
                if attempt == 0 and self.cancel_event.wait(1):
                    raise PollCancelled()
        LOG.info('Search HTML fallback uid=%s page=%s', self.author, number)
        if self.cancel_event.wait(1):
            raise PollCancelled()
        result = self.html_page(number)
        LOG.info('Search HTML fallback OK uid=%s page=%s posts=%s', self.author, number, len(result['posts']))
        return result

    def html_page(self, number):
        status, body = self.request(self.page_url(number))
        check_access(status, body)
        result = parse_search_html(body, number, self.author)
        posts = []
        for ref in result['posts']:
            if self.cancel_event.is_set():
                raise PollCancelled()
            key = post_key(ref)
            post = self.cache.get(key)
            if post is None:
                post = self.detail_post(ref)
                self.cache[key] = dict(post)
            # The list HTML only has the TOPIC creation date. Never use that
            # as this reply's time; use a verified full-post time or the cache.
            posts.append(dict(post, page=number, content=ref['content'], subject=ref['subject']))
        validate_order(posts)
        return dict(result, posts=posts)

    def detail_post(self, ref):
        url = post_url(ref)
        for attempt in range(2):
            try:
                status, body = self.request(url + '&__output=11')
                check_access(status, body)
                data = json.loads(body)['data']
                if not isinstance(data.get('__T'), dict) or int(data['__T'].get('tid', 0)) != ref['tid']:
                    raise ValueError('发言详情主题不匹配')
                records = data['__R']
                records = list(records.values()) if isinstance(records, dict) else records
                if not isinstance(records, list) or len(records) != int(data['__R__ROWS']):
                    raise ValueError('发言详情响应不完整')
                matches = [record for record in records if int(record.get('pid', -1)) == ref['pid']]
                if len(matches) != 1:
                    raise ValueError('发言详情 PID 不匹配')
                return make_post(dict(matches[0], tid=ref['tid']), ref['page'], ref['subject'], self.author)
            except (NGAAccessError, PollCancelled):
                raise
            except (ValueError, KeyError, TypeError, OSError, HTTPException):
                LOG.warning('Search detail JSON failed tid=%s pid=%s attempt=%s', ref['tid'], ref['pid'], attempt + 1)
                if attempt == 0 and self.cancel_event.wait(1):
                    raise PollCancelled()
        if self.cancel_event.wait(1):
            raise PollCancelled()
        status, body = self.request(url)
        check_access(status, body)
        pager = re.search(r"var\s+__PAGE\s*=\s*\{0:'([^']+)'", body)
        if not pager or urllib.parse.parse_qs(urllib.parse.urlsplit(html.unescape(pager[1])).query).get('tid') != [str(ref['tid'])]:
            raise ValueError('发言详情网页主题不匹配')
        parser = PostHTMLParser()
        parser.feed(body)
        parser.close()
        if not parser.closed or not parser.ended or parser.capture:
            raise ValueError('发言详情网页不完整')
        matches = [record for record in parser.posts.values() if record.get('pid') == ref['pid']]
        if len(matches) != 1:
            raise ValueError('发言详情网页 PID 不匹配')
        record = matches[0]
        if 'date' not in record or not re.fullmatch(r'\d{4}-\d{2}-\d{2} \d{2}:\d{2}', record['date']):
            raise ValueError('发言详情网页缺少真实时间')
        return make_post(dict(record, tid=ref['tid'], postdate=record['date']), ref['page'], ref['subject'], self.author)


class AuthorThreadClient(PollingClient):
    is_thread = True

    def __init__(self, login_cookie='', author=150058, tid=47288722):
        self.tid = int(tid)
        super().__init__(f'https://ngabbs.com/read.php?tid={self.tid}&authorid={int(author)}', login_cookie, author)

    def refresh_guest(self, number):
        self.guest = ''
        _, landing = self.request(self.page_url(number))
        match = re.search(r"guestJs=([^;'\s]+)", landing)
        if match:
            self.guest = 'guestJs=' + match[1]

    def page(self, number):
        for attempt in range(2):
            try:
                status, body = self.request(self.page_url(number) + '&__output=11')
                if check_access(status, body) == 'guest':
                    self.refresh_guest(number)
                    raise ValueError('访客会话已刷新')
                result = parse_thread_page(json.loads(body)['data'], number, self.author, self.tid)
                LOG.info('Thread JSON OK uid=%s tid=%s page=%s posts=%s', self.author, self.tid, number, len(result['posts']))
                return result
            except (NGAAccessError, PollCancelled):
                raise
            except (ValueError, KeyError, TypeError, OSError, HTTPException) as exc:
                LOG.warning('Thread JSON uid=%s tid=%s page=%s attempt=%s failed=%s', self.author, self.tid, number, attempt + 1, type(exc).__name__)
                if attempt == 0 and self.cancel_event.wait(1):
                    raise PollCancelled()
        LOG.info('Thread HTML fallback uid=%s tid=%s page=%s', self.author, self.tid, number)
        if self.cancel_event.wait(1):
            raise PollCancelled()
        return self.html_page(number)

    def html_page(self, number):
        for attempt in range(2):
            status, body = self.request(self.page_url(number))
            if check_access(status, body) == 'guest':
                if attempt == 0:
                    self.refresh_guest(number)
                    continue
                raise ValueError('帖子网页访客会话建立失败，原进度已保留')
            result = parse_html_page(body, number, self.author, self.tid)
            LOG.info('Thread HTML OK uid=%s tid=%s page=%s posts=%s', self.author, self.tid, number, len(result['posts']))
            return result


def poll_thread(client, state, max_pages=200):
    baseline = state.get('watermark') is None
    old = state.get('watermark') or 0
    first = client.page(1)
    pages, number = first['pages'], first['pages']
    collected, sources, visited = {}, {first['source']}, set()
    rows = first['rows']
    for _ in range(max_pages):
        result = first if number == 1 else client.page(number)
        sources.add(result['source'])
        posts = result['posts']
        if result['page'] != number:
            raise ValueError('帖子补查页码不匹配，原进度已保留')
        keys = {post_key(post) for post in posts}
        if number not in visited and keys and keys <= collected.keys():
            raise ValueError('帖子补查分页没有前进，原进度已保留')
        visited.add(number)
        collected.update({post_key(post): post for post in posts})
        if result['rows'] is not None:
            rows = result['rows']
        if result['pages'] > pages:
            # A newly appended page must also be verified before committing.
            pages = number = result['pages']
            continue
        if baseline or number == 1 or not posts or min(post['pid'] for post in posts) <= old:
            break
        number -= 1
    else:
        raise ValueError(f'帖子补查超过 {max_pages} 页，原进度已保留')
    posts = sorted(collected.values(), key=lambda post: post['pid'])
    fresh = [] if baseline else [post for post in posts if post['pid'] > old]
    pending = {post_key(post): post for post in state.get('pending', [])}
    pending.update({post_key(post): post for post in fresh})
    recent = {post_key(post): post for post in state.get('recent', [])}
    recent.update(collected)
    updated = dict(state, monitor='author_thread', thread_id=client.tid,
                   watermark=max([old] + [post['pid'] for post in posts]), page=pages,
                   pending=list(pending.values()), recent=sorted(recent.values(), key=lambda post: post['pid'])[-35:],
                   rows=rows, source=' + '.join(sorted(sources)), last_success=time.time())
    return updated, fresh, baseline


def poll(client, state):
    if getattr(client, 'is_thread', False):
        return poll_thread(client, state)
    if getattr(client, 'is_search', False):
        return poll_search(client, state)
    baseline = state['watermark'] is None
    # Revisit one earlier page to tolerate deletions shifting page boundaries.
    start = 1 if baseline else max(1, state['page'] - 1)
    first = client.page(start)
    sources = {first.get('source', 'JSON')}
    pages = first['pages']
    posts = list(first['posts'])
    if baseline:
        if pages != start:
            last = client.page(pages)
            sources.add(last.get('source', 'JSON'))
            posts.extend(last['posts'])
            pages = last['pages']
            # Include any pages appended during baseline acquisition.
            for number in range(last['page'] + 1, pages + 1):
                posts.extend(client.page(number)['posts'])
    else:
        number = start + 1
        while number <= pages:
            result = client.page(number)
            sources.add(result.get('source', 'JSON'))
            posts.extend(result['posts'])
            pages = max(pages, result['pages'])
            number += 1
    posts = sorted({p['pid']: p for p in posts}.values(), key=lambda p: p['pid'])
    old = state['watermark'] or 0
    fresh = [] if baseline else [p for p in posts if p['pid'] > old]
    pending = {p['pid']: p for p in state.get('pending', [])}
    pending.update({p['pid']: p for p in fresh})
    result = dict(state, watermark=max([old] + [p['pid'] for p in posts]), page=pages,
                  pending=list(pending.values()), recent=posts[-20:], last_success=time.time(),
                  rows=first['rows'], source=' + '.join(sorted(sources)))
    return result, fresh, baseline


class AuthorMonitor:
    def __init__(self, author, client):
        self.author, self.client = author, client
        self.busy = False
        self.failed = 0
        self.next_check = time.monotonic()
        self.message = '等待检查…'


class App:
    def __init__(self, root, smoke=False):
        self.root, self.smoke = root, smoke
        saved_state = read_state() if not smoke else {'watermark': None, 'page': 1, 'pending': [], 'recent': []}
        self.state = prepare_monitors(saved_state)
        if not smoke and self.state != saved_state:
            save_state(self.state)
        try:
            cookie = '' if smoke else load_cookie()
        except (ValueError, OSError):
            cookie = ''
            LOG.warning('NGA login configuration could not be loaded')
        self.events = queue.Queue()
        self.targets = {str(author): AuthorMonitor(author, self.make_client(author, cookie)) for author in AUTHORS}
        self.paused = False
        self.alert = None
        self.silent = False
        self.feishu_busy = False
        self.feishu_test_busy = False
        self.feishu_next = 0
        self.feishu_storage_error = False
        self.feishu_settings = None
        self.nga_settings = None
        self.feishu_status = tk.StringVar(value='飞书：未配置（点击“飞书设置”）')
        self.feishu_config = dict(DEFAULT_CONFIG)
        if not smoke:
            try:
                self.feishu_config = read_config(FEISHU_CONFIG_FILE)
                if self.feishu_config['enabled']:
                    self.feishu_status.set('飞书：已启用，等待新发言')
                elif self.feishu_config['app_id']:
                    self.feishu_status.set('飞书：已暂停')
            except (ValueError, OSError):
                self.feishu_status.set('飞书：配置读取失败，请打开“飞书设置”重新保存')
                LOG.warning('Feishu configuration could not be loaded')
        self.feishu_client = FeishuClient(self.feishu_config)
        root.title('NGA 发言雷达 · UID 60916468 / 150058')
        root.geometry('1100x780')
        root.minsize(1040, 660)
        root.configure(bg='#0b1220')
        style = ttk.Style()
        style.theme_use('clam')
        style.configure('TButton', font=('Microsoft YaHei UI', 11), padding=9)
        tk.Label(root, text='NGA 发言雷达', bg='#0b1220', fg='#f8fafc', font=('Microsoft YaHei UI', 26, 'bold')).pack(anchor='w', padx=28, pady=(24, 5))
        tk.Label(root, text='UID 60916468：跨帖搜索  /  UID 150058：帖子 47288722  /  各自每 60 秒检查，忙时每秒重试', bg='#0b1220', fg='#94a3b8', font=('Microsoft YaHei UI', 11)).pack(anchor='w', padx=30)
        self.status = tk.StringVar()
        self.details = tk.StringVar()
        self.refresh_status()
        tk.Label(root, textvariable=self.status, bg='#132538', fg='#5eead4', font=('Microsoft YaHei UI', 13, 'bold'), anchor='w', justify='left', padx=18, pady=18, wraplength=980).pack(fill='x', padx=28, pady=(22, 5))
        tk.Label(root, textvariable=self.details, bg='#0b1220', fg='#94a3b8', justify='left', font=('Microsoft YaHei UI', 10)).pack(anchor='w', padx=30, pady=5)
        tk.Label(root, textvariable=self.feishu_status, bg='#0b1220', fg='#fbbf24', font=('Microsoft YaHei UI', 10), anchor='w', wraplength=810).pack(fill='x', padx=30)
        bar = tk.Frame(root, bg='#0b1220')
        bar.pack(fill='x', padx=28, pady=12)
        for label, action in [('立即检查', self.check), *[(f'打开 {author}', lambda uid=author: webbrowser.open(monitor_url(uid))) for author in AUTHORS], ('测试强提醒', self.test_alert)]:
            ttk.Button(bar, text=label, command=action).pack(side='left', padx=(0, 8))
        self.pause_button = ttk.Button(bar, text='暂停监控', command=self.toggle)
        self.pause_button.pack(side='left')
        ttk.Button(bar, text='飞书设置', command=self.open_feishu_settings).pack(side='left', padx=(8, 0))
        ttk.Button(bar, text='NGA 登录态', command=self.open_nga_settings).pack(side='left', padx=(8, 0))
        self.content = tk.Text(root, bg='#111c2e', fg='#e2e8f0', insertbackground='white', relief='flat', wrap='word', font=('Microsoft YaHei UI', 11), padx=18, pady=16)
        self.content.pack(fill='both', expand=True, padx=28, pady=(0, 14))
        tk.Label(root, text='新发言：置顶大窗口 + 循环提示音 + 任务栏闪烁，确认后停止。\n最小化可继续运行；退出、关机或电脑睡眠期间无法实时检查。', bg='#0b1220', fg='#94a3b8', justify='left', font=('Microsoft YaHei UI', 10)).pack(anchor='w', padx=30, pady=(0, 20))
        root.protocol('WM_DELETE_WINDOW', self.close)
        self.render_posts()
        if smoke:
            self.test_alert()
            root.after(800, root.destroy)
        else:
            if self.state['pending']:
                root.after(500, self.show_alert)
            self.tick()

    @property
    def busy(self):
        return any(target.busy for target in self.targets.values())

    def make_client(self, author, cookie):
        if author in THREADS:
            client = AuthorThreadClient(cookie, author, THREADS[author])
        else:
            client = AuthorSearchClient(cookie, self.state['authors'][str(author)].get('recent', []), author)
        client.on_retry = lambda attempt: self.events.put(('poll', (author, 'retry', attempt)))
        return client

    def refresh_status(self):
        self.status.set('\n'.join(f'UID {target.author} · {target.message}' for target in self.targets.values()))

    def render_posts(self):
        self.content.config(state='normal')
        self.content.delete('1.0', 'end')
        posts = self.state.get('recent', [])
        self.content.insert('end', '\n\n'.join(f"UID {p.get('authorid', AUTHOR)}  ·  {p['date']}  ·  #{p['pid']}\n" + (f"{p['subject']}\n" if p.get('subject') else '') + p['content'] for p in reversed(posts)) or '首次加入的用户建立基线，仅对之后的新发言提醒；已有用户继续补查。')
        self.content.config(state='disabled')

    def check(self, author=None):
        if self.paused or self.smoke:
            return
        if author is None:
            for uid in self.targets:
                self.check(uid)
            return
        target = self.targets[str(author)]
        if target.busy:
            return
        target.busy = True
        client = target.client
        client.cancel_event = threading.Event()
        target.message = '正在检查新发言…'
        self.refresh_status()
        snapshot = dict(self.state['authors'][str(author)])
        def work():
            try:
                result = poll(client, snapshot)
                if client.cancel_event.is_set():
                    raise PollCancelled()
                LOG.info('Poll OK uid=%s rows=%s page=%s new=%s baseline=%s', target.author, result[0]['rows'], result[0]['page'], len(result[1]), result[2])
                self.events.put(('poll', (target.author, 'ok', result)))
            except PollCancelled:
                self.events.put(('poll', (target.author, 'cancelled', None)))
            except Exception as exc:
                if client.cancel_event.is_set():
                    self.events.put(('poll', (target.author, 'cancelled', None)))
                    return
                LOG.exception('Poll failed uid=%s', target.author)
                self.events.put(('poll', (target.author, 'error', str(exc))))
        threading.Thread(target=work, daemon=True).start()

    def handle_poll_event(self, kind, value, author=AUTHOR):
        target = self.targets[str(author)]
        if kind == 'retry':
            attempt, reason = value if isinstance(value, tuple) else (value, 'ERROR:2048')
            target.message = f'NGA 服务器忙（{reason}）· 每秒重试中（第 {attempt} 次）· 原进度已保留'
            self.refresh_status()
            return
        target.busy = False
        if kind == 'cancelled':
            target.message = '已暂停监控' if self.paused else '正在准备重新检查…'
            target.next_check = time.monotonic()
            self.refresh_status()
            return
        target.next_check = time.monotonic() + INTERVAL
        if kind == 'ok':
            result, fresh, baseline = value
            self.state = merge_author_result(self.state, author, result, fresh, self.feishu_config['enabled'])
            try:
                save_state(self.state)
            except OSError as exc:
                target.message = f'进度保存失败：{exc}'
                self.paused = True
                for item in self.targets.values():
                    item.client.cancel_event.set()
                self.pause_button.config(text='继续监控')
                self.feishu_storage_error = True
                self.feishu_status.set('飞书：进度无法保存，已暂停发送，请检查磁盘后重启')
            else:
                scope = f'帖子 {THREADS[int(author)]}' if int(author) in THREADS else '搜索页'
                target.message = f'已建立{scope}基线 · {result["rows"]} 条已有发言' if baseline else (f'发现 {len(fresh)} 条新发言！' if fresh else f'监控中 · {scope}本次没有新发言')
            target.failed = 0
            self.refresh_status()
            self.render_posts()
            if fresh:
                self.show_alert()
        else:
            target.failed += 1
            target.message = f'检查失败（连续 {target.failed} 次）· {value}'
            self.refresh_status()
            if target.failed == 3:
                self.show_alert(error=True)

    def tick(self):
        for _ in range(50):
            try:
                kind, value = self.events.get_nowait()
            except queue.Empty:
                break
            if kind.startswith('feishu_'):
                self.handle_feishu_event(kind, value)
            elif kind == 'poll':
                author, event, result = value
                self.handle_poll_event(event, result, author)
        lines = []
        for uid, target in self.targets.items():
            remaining = max(0, math.ceil(target.next_check - time.monotonic()))
            progress = self.state['authors'][uid]
            last = progress.get('last_success')
            stamp = time.strftime('%m-%d %H:%M:%S', time.localtime(last)) if last else '尚未成功'
            activity = '已暂停' if self.paused else ('检查进行中' if target.busy else f'下次检查：{remaining} 秒')
            lines.append(f'UID {uid}  |  上次成功：{stamp}  |  {activity}  |  来源：{progress.get("source", "尚未检查")}')
            if not self.paused and not target.busy and remaining == 0:
                self.check(uid)
        self.details.set('\n'.join(lines) + f'\n待确认：{len(self.state["pending"])} 条')
        self.dispatch_feishu()
        self.root.after(250, self.tick)

    def dispatch_feishu(self):
        queued = self.state.get('feishu_outbox', [])
        if (self.smoke or not self.feishu_config['enabled'] or self.feishu_busy
                or self.feishu_storage_error or not queued or time.monotonic() < self.feishu_next):
            return
        self.feishu_busy = True
        post = dict(queued[0])
        client = self.feishu_client
        self.feishu_status.set(f'飞书：正在推送 #{post["pid"]}，待发送 {len(queued)} 条')
        def work():
            try:
                client.send(post)
                self.events.put(('feishu_ok', post_key(post)))
            except Exception as exc:
                detail = str(exc) if isinstance(exc, RuntimeError) else f'飞书发送失败（{type(exc).__name__}）'
                self.events.put(('feishu_error', detail))
        threading.Thread(target=work, daemon=True).start()

    def handle_feishu_event(self, kind, value):
        if kind == 'feishu_test':
            self.feishu_test_busy = False
            win, status, button, error = value
            if win.winfo_exists():
                status.set(error or '测试消息发送成功，请查看机器人单聊。点击“保存设置”后启用自动通知。')
                button.config(state='normal')
            return
        self.feishu_busy = False
        if kind == 'feishu_ok':
            self.state['feishu_outbox'] = [p for p in self.state.get('feishu_outbox', []) if (post_key(p) if isinstance(value, str) else p['pid']) != value]
            try:
                save_state(self.state)
            except OSError:
                self.feishu_storage_error = True
                self.feishu_status.set('飞书：发送成功，但进度保存失败；已暂停发送，请检查磁盘后重启')
                LOG.warning('Feishu delivery state could not be saved pid=%s', value)
                return
            self.feishu_next = time.monotonic() + 2
            count = len(self.state['feishu_outbox'])
            self.feishu_status.set(f'飞书：已推送 #{value}，待发送 {count} 条')
            LOG.info('Feishu delivered pid=%s remaining=%s', value, count)
        else:
            self.feishu_next = time.monotonic() + INTERVAL
            self.feishu_status.set(f'飞书：{value}；60 秒后重试，待发送 {len(self.state.get("feishu_outbox", []))} 条')
            LOG.warning('Feishu delivery failed: %s', value)

    def open_nga_settings(self):
        if self.nga_settings and self.nga_settings.winfo_exists():
            self.nga_settings.lift()
            return

        def saved(cookie):
            for uid, target in self.targets.items():
                target.client.cancel_event.set()
                target.client = self.make_client(int(uid), cookie)
                target.next_check = time.monotonic()

        self.nga_settings = open_nga_settings(self.root, saved)

    def open_feishu_settings(self):
        if self.feishu_settings and self.feishu_settings.winfo_exists():
            self.feishu_settings.lift()
            return
        win = self.feishu_settings = tk.Toplevel(self.root)
        win.title('飞书机器人单聊设置')
        win.geometry('710x570')
        win.minsize(680, 550)
        win.transient(self.root)
        frame = ttk.Frame(win, padding=22)
        frame.pack(fill='both', expand=True)
        frame.columnconfigure(0, weight=1)
        enabled = tk.BooleanVar(value=self.feishu_config['enabled'])
        app_id = tk.StringVar(value=self.feishu_config['app_id'])
        secret = tk.StringVar(value=self.feishu_config['app_secret'])
        receive_id = tk.StringVar(value=self.feishu_config['receive_id'])
        type_labels = {'飞书邮箱': 'email', 'Open ID': 'open_id', 'User ID': 'user_id'}
        receive_type = tk.StringVar(value=next(k for k, v in type_labels.items() if v == self.feishu_config['receive_id_type']))
        status = tk.StringVar(value='新发言将由企业自建应用机器人单聊发送给你。')
        ttk.Checkbutton(frame, text='启用飞书单聊通知', variable=enabled).grid(row=0, column=0, sticky='w', pady=(0, 12))
        ttk.Label(frame, text='App ID（cli_ 开头）').grid(row=1, column=0, sticky='w')
        ttk.Entry(frame, textvariable=app_id).grid(row=2, column=0, sticky='ew', pady=(4, 12))
        ttk.Label(frame, text='App Secret').grid(row=3, column=0, sticky='w')
        secret_entry = ttk.Entry(frame, textvariable=secret, show='*')
        secret_entry.grid(row=4, column=0, sticky='ew', pady=(4, 8))
        visible = tk.BooleanVar(value=False)
        def toggle_visible():
            secret_entry.config(show='' if visible.get() else '*')
        ttk.Checkbutton(frame, text='显示密钥', variable=visible, command=toggle_visible).grid(row=5, column=0, sticky='w')
        ttk.Label(frame, text='接收人类型').grid(row=6, column=0, sticky='w', pady=(10, 4))
        ttk.Combobox(frame, textvariable=receive_type, values=list(type_labels), state='readonly', width=18).grid(row=7, column=0, sticky='w')
        ttk.Label(frame, text='你的飞书账号邮箱或对应用户 ID').grid(row=8, column=0, sticky='w', pady=(10, 4))
        ttk.Entry(frame, textvariable=receive_id).grid(row=9, column=0, sticky='ew')
        ttk.Label(frame, text='应用需启用机器人、发布版本，并将你设为可用用户。\n需开通 im:message:send_as_bot；使用 User ID 还需\ncontact:user.employee_id:readonly。凭证仅保存在本机。', wraplength=650, justify='left').grid(row=10, column=0, sticky='w', pady=12)
        ttk.Label(frame, textvariable=status, wraplength=650).grid(row=11, column=0, sticky='w', pady=(0, 12))
        actions = ttk.Frame(frame)
        actions.grid(row=12, column=0, sticky='w')
        def config_value(for_test=False):
            return validate_config({'enabled': True if for_test else enabled.get(),
                                    'app_id': app_id.get(), 'app_secret': secret.get(),
                                    'receive_id_type': type_labels[receive_type.get()], 'receive_id': receive_id.get()})
        def save():
            try:
                config = config_value()
                save_state(config, FEISHU_CONFIG_FILE)
            except (ValueError, OSError) as exc:
                messagebox.showerror('无法保存飞书设置', str(exc), parent=win)
                return
            self.feishu_config = config
            self.feishu_client = FeishuClient(config)
            self.feishu_next = 0
            self.feishu_status.set('飞书：已启用，等待新发言' if config['enabled'] else '飞书：已关闭')
            win.destroy()
        def test():
            if self.feishu_test_busy or self.smoke:
                return
            try:
                config = config_value(for_test=True)
            except ValueError as exc:
                status.set(str(exc))
                return
            self.feishu_test_busy = True
            test_button.config(state='disabled')
            status.set('正在发送一条机器人单聊测试消息…')
            def work():
                error = None
                try:
                    FeishuClient(config).send()
                except Exception as exc:
                    error = str(exc) if isinstance(exc, RuntimeError) else f'发送失败（{type(exc).__name__}）'
                self.events.put(('feishu_test', (win, status, test_button, error)))
            threading.Thread(target=work, daemon=True).start()
        test_button = ttk.Button(actions, text='发送单聊测试', command=test)
        test_button.pack(side='left', padx=(0, 10))
        ttk.Button(actions, text='保存设置', command=save).pack(side='left', padx=(0, 10))
        ttk.Button(actions, text='取消', command=win.destroy).pack(side='left')

    def toggle(self):
        self.paused = not self.paused
        self.pause_button.config(text='继续监控' if self.paused else '暂停监控')
        for target in self.targets.values():
            if self.paused:
                target.client.cancel_event.set()
                target.message = '正在取消检查…' if target.busy else '已暂停监控'
            else:
                target.next_check = time.monotonic()
                target.message = '正在准备重新检查…'
        self.refresh_status()

    def test_alert(self):
        self.show_alert(test=True)

    def show_alert(self, test=False, error=False):
        if self.alert and self.alert.winfo_exists():
            self.alert.destroy()
        self.silent = False
        win = self.alert = tk.Toplevel(self.root)
        win.title('NGA · 需要你关注')
        win.configure(bg='#9f1239')
        win.attributes('-topmost', True)
        w, h = int(win.winfo_screenwidth() * .90), int(win.winfo_screenheight() * .85)
        win.geometry(f'{w}x{h}+{(win.winfo_screenwidth()-w)//2}+{(win.winfo_screenheight()-h)//2}')
        title = '提醒测试 · 这是演示' if test else ('监控连续失败，请检查网络或 NGA 登录态' if error else f'目标用户有新发言！共 {len(self.state["pending"])} 条待确认')
        tk.Label(win, text=title, bg='#9f1239', fg='white', font=('Microsoft YaHei UI', 30, 'bold'), wraplength=w-80).pack(pady=(35, 20))
        text = tk.Text(win, bg='#fff1f2', fg='#4c0519', font=('Microsoft YaHei UI', 16), wrap='word', padx=24, pady=20)
        text.pack(fill='both', expand=True, padx=36, pady=12)
        posts = self.state['pending']
        message = '真实新发言出现时，会像这样置顶显示并循环播放提示音。点击“我知道了”即可关闭。' if test else (self.status.get() if error else '\n\n'.join(f"UID {p.get('authorid', AUTHOR)}  ·  {p['date']}\n" + (f"{p['subject']}\n" if p.get('subject') else '') + p['content'] for p in posts))
        text.insert('end', message)
        text.config(state='disabled')
        actions = tk.Frame(win, bg='#9f1239')
        actions.pack(pady=24)
        def ack():
            if not test and not error:
                self.state['pending'] = []
                try:
                    save_state(self.state)
                except OSError as exc:
                    messagebox.showerror('保存失败', str(exc), parent=win)
            win.destroy()
            self.alert = None
            if os.name == 'nt':
                ctypes.windll.user32.FlashWindow(self.root.winfo_id(), False)
        ttk.Button(actions, text='打开对应发言', command=lambda: webbrowser.open(post_url(posts[-1]) if posts and not test and not error else SEARCH_URL)).pack(side='left', padx=8)
        ttk.Button(actions, text='静音（保留提醒）', command=lambda: setattr(self, 'silent', True)).pack(side='left', padx=8)
        ttk.Button(actions, text='我知道了 · 关闭提醒', command=ack).pack(side='left', padx=8)
        win.protocol('WM_DELETE_WINDOW', ack)
        win.lift()
        win.focus_force()
        def ring():
            if not win.winfo_exists():
                return
            if not self.silent and not self.smoke:
                if os.name == 'nt':
                    import winsound
                    winsound.PlaySound('SystemExclamation', winsound.SND_ALIAS | winsound.SND_ASYNC)
                    ctypes.windll.user32.FlashWindow(self.root.winfo_id(), True)
                else:
                    win.bell()
            win.after(2000, ring)
        ring()

    def close(self):
        if messagebox.askyesno('退出监控', '退出后将停止检查。是否退出？\n若要继续监控，请选择“否”，然后最小化窗口。', parent=self.root):
            for target in self.targets.values():
                target.client.cancel_event.set()
            self.root.destroy()


def main():
    smoke = '--smoke-test' in sys.argv
    if not smoke:
        DATA.mkdir(parents=True, exist_ok=True)
        handler = RotatingFileHandler(DATA / 'watcher.log', maxBytes=500_000, backupCount=2, encoding='utf-8')
        handler.setFormatter(logging.Formatter('%(asctime)s %(levelname)s %(message)s'))
        LOG.addHandler(handler)
        LOG.setLevel(logging.INFO)
    mutex = None
    if os.name == 'nt' and not smoke:
        kernel = ctypes.WinDLL('kernel32', use_last_error=True)
        kernel.CreateMutexW.restype = ctypes.c_void_p
        kernel.CreateMutexW.argtypes = [ctypes.c_void_p, ctypes.c_bool, ctypes.c_wchar_p]
        mutex = kernel.CreateMutexW(None, False, 'Local\\NGAWatcher_47559481_60916468')
        if ctypes.get_last_error() == 183:
            messagebox.showinfo('NGA 发言雷达', '监控程序已经在运行，请查看任务栏。')
            return
    root = tk.Tk()
    try:
        app = App(root, smoke=smoke)
        if '--feishu-settings' in sys.argv:
            root.after(300, app.open_feishu_settings)
        if '--nga-settings' in sys.argv:
            root.after(300, app.open_nga_settings)
        root.mainloop()
    except Exception as exc:
        messagebox.showerror('NGA 发言雷达启动失败', str(exc), parent=root)
        raise


if __name__ == '__main__':
    main()
