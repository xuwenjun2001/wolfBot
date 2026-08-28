from __future__ import annotations

import json
import re
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Iterable
from urllib.parse import urlencode

import requests

from .config import Settings, settings
from .db import Database, utc_now
from .text import parse_reply, safe_html


class NGAError(RuntimeError):
    pass


def decode_nga(data: bytes | str) -> str:
    if isinstance(data, str):
        return data
    # NGA's lite endpoint is GBK in practice, although a few edge responses
    # are UTF-8.  Replacement decoding keeps the parser diagnosable.
    for encoding in ("utf-8", "gb18030", "gbk"):
        try:
            return data.decode(encoding)
        except UnicodeDecodeError:
            continue
    return data.decode("gb18030", errors="replace")


def _strip_named_string_fields(value: str, names: Iterable[str]) -> str:
    """Replace troublesome NGA string fields without parsing the whole body."""
    names_pattern = "|".join(re.escape(name) for name in names)
    pattern = re.compile(
        rf'(["\'])(?:{names_pattern})\1\s*:\s*(["\'])(?:\\.|(?!\2)[\s\S])*?\2',
        re.I,
    )
    return pattern.sub(lambda match: f'{match.group(1)}{match.group(0).split(match.group(1), 2)[1]}{match.group(1)}:""', value)


def prepare_lite_js(raw: bytes | str) -> str:
    value = decode_nga(raw).lstrip("\ufeff \r\n")
    prefix = "window.script_muti_get_var_store="
    if value.startswith(prefix):
        value = value[len(prefix):]
    value = value.replace("\t", "")
    value = _strip_named_string_fields(value, ("signature", "alterinfo"))
    return value.strip()


def _balanced_prefix(value: str) -> tuple[str, list[str]]:
    stack: list[str] = []
    in_string = False
    quote = ""
    escaped = False
    last_safe = 0
    for index, char in enumerate(value):
        if in_string:
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == quote:
                in_string = False
            continue
        if char in "\"'":
            in_string = True
            quote = char
        elif char in "[{":
            stack.append("]" if char == "[" else "}")
        elif char in "]}":
            if stack and stack[-1] == char:
                stack.pop()
            else:
                break
        if not in_string and char in "}],":
            last_safe = index + 1
    return value[:last_safe or len(value)], stack


def repair_truncated_json(value: str) -> str:
    prefix, stack = _balanced_prefix(value)
    # A response can end in an unfinished string/property.  Keep only the
    # last complete structural boundary before adding missing delimiters.
    if prefix and prefix[-1] not in "}]":
        boundary = max(prefix.rfind("}"), prefix.rfind("]"))
        if boundary >= 0:
            prefix = prefix[: boundary + 1]
    prefix = re.sub(r",\s*$", "", prefix)
    return prefix + "".join(reversed(stack))


def parse_lite_json(raw: bytes | str) -> dict[str, Any]:
    cleaned = prepare_lite_js(raw)
    candidates = [cleaned, repair_truncated_json(cleaned)]
    parsed: Any = None
    for candidate in candidates:
        if not candidate:
            continue
        try:
            parsed = json.loads(candidate)
            break
        except json.JSONDecodeError:
            try:
                import json5  # type: ignore

                parsed = json5.loads(candidate)
                break
            except Exception:
                continue
    if parsed is None or not isinstance(parsed, dict):
        raise NGAError("NGA 返回数据无法解析，可能被截断或需要登录 Cookie")
    data = parsed.get("data")
    return data if isinstance(data, dict) else parsed


def _as_int(value: Any) -> int | None:
    try:
        return int(str(value))
    except (TypeError, ValueError):
        return None


def _user_name(users: Any, author_id: str) -> str:
    if isinstance(users, dict):
        item = users.get(author_id) or users.get(str(author_id))
        if isinstance(item, dict):
            for key in ("username", "uname", "nickname", "userName", "name"):
                if item.get(key):
                    return str(item[key])
        if isinstance(item, str):
            return item
    return author_id


@dataclass(frozen=True)
class NGAPost:
    tid: int
    pid: str
    author_id: str
    author_name: str
    page: int
    post_at: str
    subject: str
    body: str
    body_html: str
    quote_text: str
    quote_pid: str
    url: str


@dataclass(frozen=True)
class NGAPage:
    requested_page: int
    actual_page: int
    rows: list[NGAPost]
    raw: dict[str, Any]


def extract_page(data: dict[str, Any], requested_page: int) -> NGAPage:
    actual = _as_int(data.get("__PAGE")) or requested_page
    tid = _as_int((data.get("__T") or {}).get("tid")) or 0
    if not tid:
        # Some responses only expose tid in the request; caller fills it in.
        tid = 0
    raw_rows = data.get("__R", {})
    if isinstance(raw_rows, list):
        rows = list(enumerate(raw_rows))
    elif isinstance(raw_rows, dict):
        rows = []
        for key, item in raw_rows.items():
            if isinstance(item, dict):
                rows.append((key, item))
    else:
        rows = []
    users = data.get("__U", {})
    posts: list[NGAPost] = []
    for _, raw in rows:
        author_id = str(raw.get("authorid", raw.get("author_id", "")))
        pid_value = raw.get("pid", raw.get("id", ""))
        if pid_value in (None, ""):
            continue
        pid = str(pid_value)
        content = str(raw.get("content", raw.get("subject", "")) or "")
        parsed = parse_reply(content)
        post_at = str(raw.get("postdate", raw.get("post_at", raw.get("date", ""))) or "")
        subject = str(raw.get("subject", "") or "")
        posts.append(
            NGAPost(
                tid=tid,
                pid=pid,
                author_id=author_id,
                author_name=_user_name(users, author_id),
                page=actual,
                post_at=post_at,
                subject=subject,
                body=parsed.body,
                body_html=safe_html(parsed.body),
                quote_text=parsed.quote,
                quote_pid=parsed.quote_pid,
                url=f"https://ngabbs.com/read.php?tid={tid}&pid={pid}",
            )
        )
    return NGAPage(requested_page, actual, posts, data)


class NGAClient:
    def __init__(self, config: Settings = settings, session: requests.Session | None = None):
        self.config = config
        self.session = session or requests.Session()
        self.session.headers.update(
            {
                "User-Agent": config.nga_user_agent,
                "Accept": "text/javascript, application/json, */*;q=0.1",
                "Referer": f"{config.nga_base_url}/",
            }
        )
        if config.nga_cookie:
            self.session.headers["Cookie"] = config.nga_cookie

    def page_url(self, tid: int, page: int) -> str:
        query = urlencode(
            {
                "lite": "js",
                "noprefix": "",
                "tid": tid,
                "authorid": self.config.nga_author_id,
                "opt": "262144",
                "page": page,
            }
        )
        return f"{self.config.nga_base_url.rstrip('/')}/read.php?{query}"

    def fetch_page(self, tid: int, page: int) -> NGAPage:
        response = self.session.get(self.page_url(tid, page), timeout=self.config.request_timeout)
        if response.status_code in (401, 403):
            raise NGAError(f"NGA 返回 HTTP {response.status_code}，请在 .env 配置有效 NGA_COOKIE")
        response.raise_for_status()
        data = parse_lite_json(response.content)
        parsed = extract_page(data, page)
        if not parsed.rows and not data.get("__PAGE"):
            raise NGAError("NGA 响应缺少 __PAGE/__R，可能是登录页或接口格式变化")
        return parsed


@dataclass(frozen=True)
class CrawlResult:
    run_id: int
    pages_scanned: int
    posts_seen: int
    new_posts: int
    status: str
    error: str = ""


def _pid_key(pid: str) -> tuple[int, str]:
    number = _as_int(pid)
    return (number if number is not None else -1, pid)


def crawl_incremental(
    db: Database,
    client: NGAClient | None = None,
    tid: int | None = None,
    author_id: int | None = None,
    initial_page: int | None = None,
    max_pages: int = 8,
) -> CrawlResult:
    cfg = client.config if client else settings
    client = client or NGAClient(cfg)
    target_tid = tid or cfg.nga_tid
    target_author = str(author_id or cfg.nga_author_id)
    cursor = db.one("SELECT * FROM crawl_cursor WHERE tid=?", (target_tid,))
    cursor_scope = str(cursor["page_scope"] or "author") if cursor else "author"
    legacy_cursor = cursor is not None and cursor_scope != "author"
    stored_page = (
        (initial_page or cfg.initial_page)
        if legacy_cursor
        else (int(cursor["last_page"]) if cursor else (initial_page or cfg.initial_page))
    )
    start_page = max(1, stored_page - 1)
    started = utc_now()
    run = db.execute(
        "INSERT INTO crawl_runs(tid,started_at,status) VALUES(?,?,?)",
        (target_tid, started, "running"),
    )
    run_id = int(run.lastrowid)
    pages_scanned = posts_seen = new_posts = 0
    last_page = stored_page
    highest_scanned_page = stored_page
    last_post_at = str(cursor["last_post_at"] if cursor else "")
    last_pid = str(cursor["last_pid"] if cursor else "")
    error = ""
    status = "ok"
    try:
        for page in range(start_page, start_page + max_pages):
            parsed = client.fetch_page(target_tid, page)
            pages_scanned += 1
            highest_scanned_page = max(highest_scanned_page, parsed.actual_page)
            rows = parsed.rows
            posts_seen += len(rows)
            with db.transaction() as conn:
                for post in rows:
                    if post.tid == 0:
                        post = NGAPost(
                            target_tid,
                            post.pid,
                            post.author_id,
                            post.author_name,
                            post.page,
                            post.post_at,
                            post.subject,
                            post.body,
                            post.body_html,
                            post.quote_text,
                            post.quote_pid,
                            post.url.replace("tid=0", f"tid={target_tid}"),
                        )
                    if post.author_id != target_author:
                        continue
                    cursor_row = conn.execute(
                        "SELECT 1 FROM posts WHERE tid=? AND pid=?", (post.tid, post.pid)
                    ).fetchone()
                    conn.execute(
                        """INSERT OR IGNORE INTO posts
                        (tid,pid,author_id,author_name,page,post_at,subject,body,body_html,quote_text,quote_pid,url,source,discovered_at)
                        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                        (
                            post.tid,
                            post.pid,
                            post.author_id,
                            post.author_name,
                            post.page,
                            post.post_at,
                            post.subject,
                            post.body,
                            post.body_html,
                            post.quote_text,
                            post.quote_pid,
                            post.url,
                            "nga",
                            started,
                        ),
                    )
                    conn.execute("DELETE FROM post_fts WHERE pid=?", (post.pid,))
                    conn.execute(
                        "INSERT INTO post_fts(rowid,pid,body,subject) SELECT rowid,pid,body,subject FROM posts WHERE tid=? AND pid=?",
                        (post.tid, post.pid),
                    )
                    if cursor_row is None:
                        new_posts += 1
                    if _pid_key(post.pid) > _pid_key(last_pid):
                        last_pid = post.pid
                        last_post_at = post.post_at
            # NGA returns the last valid page when requesting beyond it.
            if parsed.actual_page != page or not rows:
                break
    except Exception as exc:
        status = "error"
        error = str(exc)
    checked = utc_now()
    last_page = max(last_page, highest_scanned_page)
    page_scope = "thread" if legacy_cursor and status != "ok" else "author"
    db.execute(
        """INSERT INTO crawl_cursor(tid,last_page,last_pid,last_post_at,last_checked_at,last_error,page_scope)
        VALUES(?,?,?,?,?,?,?)
        ON CONFLICT(tid) DO UPDATE SET last_page=excluded.last_page,last_pid=excluded.last_pid,
        last_post_at=excluded.last_post_at,last_checked_at=excluded.last_checked_at,last_error=excluded.last_error,
        page_scope=excluded.page_scope""",
        (target_tid, last_page, last_pid, last_post_at, checked, error, page_scope),
    )
    db.execute(
        """UPDATE crawl_runs SET finished_at=?,pages_scanned=?,posts_seen=?,new_posts=?,status=?,error=? WHERE id=?""",
        (checked, pages_scanned, posts_seen, new_posts, status, error, run_id),
    )
    db.add_event("crawl", {"run_id": run_id, "new_posts": new_posts, "status": status, "error": error})
    return CrawlResult(run_id, pages_scanned, posts_seen, new_posts, status, error)
