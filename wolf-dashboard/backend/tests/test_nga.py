from __future__ import annotations

from dataclasses import replace
from urllib.parse import parse_qs, urlparse

from app.config import Settings
from app.db import Database
from app.nga import NGAClient, NGAPage, NGAPost, crawl_incremental, extract_page, parse_lite_json, repair_truncated_json


def test_lite_wrapper_and_gbk_parse() -> None:
    raw = 'window.script_muti_get_var_store={"data":{"__PAGE":30,"__R":{"0":{"pid":123,"authorid":150058,"postdate":"2026-08-28 09:00","content":"[quote][pid=9,1]Reply[/pid] old[/quote]新内容"}}}}'
    data = parse_lite_json(raw.encode("gb18030"))
    page = extract_page(data, 30)
    assert page.actual_page == 30
    assert page.rows[0].pid == "123"
    assert page.rows[0].body == "新内容"
    assert page.rows[0].quote_pid == "9"


def test_truncated_json_is_repaired() -> None:
    value = '{"data":{"__PAGE":2,"__R":{"0":{"pid":1,"authorid":150058}'
    repaired = repair_truncated_json(value)
    assert parse_lite_json(repaired)["__PAGE"] == 2


class FakeClient:
    def __init__(self, config: Settings, pages: dict[int, NGAPage]):
        self.config = config
        self.pages = pages

    def fetch_page(self, tid: int, page: int) -> NGAPage:
        return self.pages[page]


def _post(pid: str, page: int, author: str = "150058") -> NGAPost:
    return NGAPost(47288722, pid, author, "狼大", page, "2026-08-28 09:00", "", f"body-{pid}", f"body-{pid}", "", "", f"https://ngabbs.com/read.php?tid=47288722&pid={pid}")


def test_incremental_scan_overlaps_previous_page_and_deduplicates(tmp_path) -> None:
    config = Settings(database_path=tmp_path / "test.sqlite3", scheduler_enabled=False)
    db = Database(config.database_path)
    db.init()
    pages = {
        28: NGAPage(28, 28, [_post("100", 28)], {}),
        29: NGAPage(29, 29, [_post("100", 29), _post("101", 29)], {}),
        30: NGAPage(30, 30, [_post("102", 30)], {}),
        31: NGAPage(31, 30, [_post("102", 30)], {}),
    }
    result = crawl_incremental(db, FakeClient(config, pages), initial_page=29)
    assert result.status == "ok"
    assert result.new_posts == 3
    assert db.one("SELECT COUNT(*) AS n FROM posts")["n"] == 3
    assert db.one("SELECT last_page FROM crawl_cursor WHERE tid=47288722")["last_page"] == 30


def test_page_url_uses_author_filtered_pagination() -> None:
    config = Settings(nga_author_id=150058)
    query = parse_qs(urlparse(NGAClient(config).page_url(47288722, 29)).query)
    assert query["tid"] == ["47288722"]
    assert query["authorid"] == ["150058"]
    assert query["opt"] == ["262144"]
    assert query["page"] == ["29"]


def _insert_post(db: Database, pid: str) -> None:
    db.execute(
        """INSERT INTO posts(tid,pid,author_id,post_at,body,discovered_at)
        VALUES(?,?,?,?,?,?)""",
        (47288722, pid, "150058", "2026-08-28 09:00", f"body-{pid}", "now"),
    )


def test_cursor_advances_when_scanned_posts_are_already_known(tmp_path) -> None:
    config = Settings(database_path=tmp_path / "advance.sqlite3", scheduler_enabled=False)
    db = Database(config.database_path)
    db.init()
    _insert_post(db, "200")
    db.execute(
        """INSERT INTO crawl_cursor(tid,last_page,last_pid,last_post_at,last_checked_at,last_error,page_scope)
        VALUES(?,?,?,?,?,?,?)""",
        (47288722, 29, "200", "2026-08-28 09:00", "now", "", "author"),
    )
    pages = {
        page: NGAPage(page, page, [_post("200", page)], {})
        for page in (28, 29, 30)
    }
    result = crawl_incremental(db, FakeClient(config, pages), max_pages=3)
    assert result.status == "ok"
    assert result.new_posts == 0
    assert db.one("SELECT last_page FROM crawl_cursor WHERE tid=47288722")["last_page"] == 30


def test_legacy_thread_cursor_is_migrated_to_author_pages(tmp_path) -> None:
    config = Settings(database_path=tmp_path / "migration.sqlite3", scheduler_enabled=False)
    db = Database(config.database_path)
    db.init()
    db.execute(
        """INSERT INTO crawl_cursor(tid,last_page,last_pid,last_post_at,last_checked_at,last_error,page_scope)
        VALUES(?,?,?,?,?,?,?)""",
        (47288722, 40, "877189699", "2026-08-02 17:29", "now", "", "thread"),
    )
    pages = {
        28: NGAPage(28, 28, [_post("280", 28)], {}),
        29: NGAPage(29, 29, [_post("290", 29)], {}),
        30: NGAPage(30, 30, [_post("300", 30)], {}),
        31: NGAPage(31, 31, [_post("310", 31)], {}),
        32: NGAPage(32, 31, [_post("310", 31)], {}),
    }
    result = crawl_incremental(db, FakeClient(config, pages), max_pages=8)
    assert result.status == "ok"
    assert result.new_posts == 4
    cursor = db.one("SELECT last_page,page_scope FROM crawl_cursor WHERE tid=47288722")
    assert cursor["last_page"] == 31
    assert cursor["page_scope"] == "author"
    assert db.one("SELECT COUNT(*) AS n FROM posts")["n"] == 4
