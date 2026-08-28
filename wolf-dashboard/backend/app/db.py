from __future__ import annotations

import json
import sqlite3
import threading
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterator


SCHEMA = """
PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;

CREATE TABLE IF NOT EXISTS posts (
    tid INTEGER NOT NULL,
    pid TEXT NOT NULL,
    author_id TEXT NOT NULL,
    author_name TEXT NOT NULL DEFAULT '',
    page INTEGER,
    post_at TEXT NOT NULL DEFAULT '',
    subject TEXT NOT NULL DEFAULT '',
    body TEXT NOT NULL DEFAULT '',
    body_html TEXT NOT NULL DEFAULT '',
    quote_text TEXT NOT NULL DEFAULT '',
    quote_pid TEXT NOT NULL DEFAULT '',
    url TEXT NOT NULL DEFAULT '',
    source TEXT NOT NULL DEFAULT 'nga',
    discovered_at TEXT NOT NULL,
    PRIMARY KEY (tid, pid)
);
CREATE INDEX IF NOT EXISTS idx_posts_post_at ON posts(post_at DESC);
CREATE INDEX IF NOT EXISTS idx_posts_author ON posts(author_id, post_at DESC);

CREATE TABLE IF NOT EXISTS crawl_cursor (
    tid INTEGER PRIMARY KEY,
    last_page INTEGER NOT NULL DEFAULT 1,
    last_pid TEXT NOT NULL DEFAULT '',
    last_post_at TEXT NOT NULL DEFAULT '',
    last_checked_at TEXT NOT NULL DEFAULT '',
    last_error TEXT NOT NULL DEFAULT '',
    page_scope TEXT NOT NULL DEFAULT 'author'
);

CREATE TABLE IF NOT EXISTS crawl_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tid INTEGER NOT NULL,
    started_at TEXT NOT NULL,
    finished_at TEXT NOT NULL DEFAULT '',
    pages_scanned INTEGER NOT NULL DEFAULT 0,
    posts_seen INTEGER NOT NULL DEFAULT 0,
    new_posts INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'running',
    error TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS rules (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL DEFAULT '',
    summary TEXT NOT NULL DEFAULT '',
    evidence_ref TEXT NOT NULL DEFAULT '',
    source_file TEXT NOT NULL DEFAULT '',
    source_line INTEGER,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS strategy_versions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    strategy_date TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'baseline',
    generated_at TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'ready',
    source_post_count INTEGER NOT NULL DEFAULT 0,
    market_asof TEXT NOT NULL DEFAULT '',
    model TEXT NOT NULL DEFAULT '',
    raw_json TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_strategy_date ON strategy_versions(strategy_date, generated_at DESC);

CREATE TABLE IF NOT EXISTS strategy_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    version_id INTEGER NOT NULL REFERENCES strategy_versions(id) ON DELETE CASCADE,
    rank INTEGER NOT NULL DEFAULT 0,
    title TEXT NOT NULL,
    stance TEXT NOT NULL DEFAULT 'observe',
    details TEXT NOT NULL DEFAULT '',
    triggers TEXT NOT NULL DEFAULT '',
    invalidation TEXT NOT NULL DEFAULT '',
    confidence REAL NOT NULL DEFAULT 0,
    continued_days INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS strategy_citations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    item_id INTEGER NOT NULL REFERENCES strategy_items(id) ON DELETE CASCADE,
    post_pid TEXT NOT NULL DEFAULT '',
    rule_id TEXT NOT NULL DEFAULT '',
    quote TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS watchlist (
    code TEXT PRIMARY KEY,
    name TEXT NOT NULL DEFAULT '',
    asset_type TEXT NOT NULL DEFAULT 'stock',
    enabled INTEGER NOT NULL DEFAULT 1,
    notes TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS aliases (
    alias TEXT PRIMARY KEY,
    code TEXT NOT NULL,
    confidence REAL NOT NULL DEFAULT 0,
    source TEXT NOT NULL DEFAULT 'ai',
    corrected_at TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS market_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT NOT NULL,
    snapshot_at TEXT NOT NULL,
    source TEXT NOT NULL,
    price REAL,
    change_pct REAL,
    extra_json TEXT NOT NULL DEFAULT '{}',
    status TEXT NOT NULL DEFAULT 'ok',
    error TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_market_code_time ON market_snapshots(code, snapshot_at DESC);

CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_type TEXT NOT NULL,
    payload_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_created ON events(id DESC);

CREATE VIRTUAL TABLE IF NOT EXISTS post_fts USING fts5(pid, body, subject, content='');
CREATE VIRTUAL TABLE IF NOT EXISTS rule_fts USING fts5(id, title, summary, content='');
"""


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


class Database:
    def __init__(self, path: str | Path):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._local = threading.local()
        self._lock = threading.RLock()

    def connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.path, check_same_thread=False, timeout=30)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys=ON")
        connection.execute("PRAGMA busy_timeout=30000")
        return connection

    @property
    def connection(self) -> sqlite3.Connection:
        connection = getattr(self._local, "connection", None)
        if connection is None:
            connection = self.connect()
            self._local.connection = connection
        return connection

    def init(self) -> None:
        with self._lock:
            self.connection.executescript(SCHEMA)
            columns = {
                str(row["name"])
                for row in self.connection.execute("PRAGMA table_info(crawl_cursor)").fetchall()
            }
            if "page_scope" not in columns:
                # Cursors written before author-filtered pagination used whole-thread pages.
                self.connection.execute(
                    "ALTER TABLE crawl_cursor ADD COLUMN page_scope TEXT NOT NULL DEFAULT 'thread'"
                )
            self.connection.commit()

    @contextmanager
    def transaction(self) -> Iterator[sqlite3.Connection]:
        with self._lock:
            conn = self.connection
            try:
                yield conn
                conn.commit()
            except Exception:
                conn.rollback()
                raise

    def execute(self, sql: str, params: tuple[Any, ...] = ()) -> sqlite3.Cursor:
        with self._lock:
            cursor = self.connection.execute(sql, params)
            self.connection.commit()
            return cursor

    def query(self, sql: str, params: tuple[Any, ...] = ()) -> list[sqlite3.Row]:
        with self._lock:
            return list(self.connection.execute(sql, params).fetchall())

    def one(self, sql: str, params: tuple[Any, ...] = ()) -> sqlite3.Row | None:
        with self._lock:
            return self.connection.execute(sql, params).fetchone()

    def add_event(self, event_type: str, payload: dict[str, Any]) -> None:
        self.execute(
            "INSERT INTO events(event_type,payload_json,created_at) VALUES(?,?,?)",
            (event_type, json.dumps(payload, ensure_ascii=False), utc_now()),
        )

    def close(self) -> None:
        connection = getattr(self._local, "connection", None)
        if connection is not None:
            connection.close()
            self._local.connection = None
