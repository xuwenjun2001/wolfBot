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

-- WolfBot Agent MVP durable runtime and local market data.  These tables are
-- additive so existing dashboard databases remain readable and writable.
CREATE TABLE IF NOT EXISTS skills (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    version TEXT NOT NULL DEFAULT '0.1.0',
    description TEXT NOT NULL DEFAULT '',
    scope TEXT NOT NULL DEFAULT '',
    applicable_scope TEXT NOT NULL DEFAULT '',
    source TEXT NOT NULL DEFAULT 'builtin',
    archive_sha256 TEXT NOT NULL DEFAULT '',
    content_sha256 TEXT NOT NULL DEFAULT '',
    enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
    builtin INTEGER NOT NULL DEFAULT 0 CHECK (builtin IN (0, 1)),
    installed_at TEXT NOT NULL DEFAULT '',
    install_path TEXT NOT NULL DEFAULT '',
    archive_name TEXT NOT NULL DEFAULT '',
    archive_size INTEGER NOT NULL DEFAULT 0,
    file_count INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL DEFAULT '',
    metadata_json TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_skills_enabled ON skills(enabled, name);

CREATE TABLE IF NOT EXISTS agent_runs (
    id TEXT PRIMARY KEY,
    question TEXT NOT NULL DEFAULT '',
    skill_mode TEXT NOT NULL DEFAULT 'auto',
    selected_skill TEXT NOT NULL DEFAULT '',
    model TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'pending',
    budget_tokens INTEGER NOT NULL DEFAULT 0,
    terminal_status TEXT NOT NULL DEFAULT '',
    answer_json TEXT NOT NULL DEFAULT '{}',
    error TEXT NOT NULL DEFAULT '',
    started_at TEXT,
    finished_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_agent_runs_status_created ON agent_runs(status, created_at DESC);

CREATE TABLE IF NOT EXISTS agent_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
    sequence INTEGER NOT NULL,
    event_type TEXT NOT NULL,
    payload_json TEXT NOT NULL DEFAULT '{}',
    occurred_at TEXT NOT NULL,
    duration_ms INTEGER,
    UNIQUE(run_id, sequence)
);
CREATE INDEX IF NOT EXISTS idx_agent_events_run_sequence ON agent_events(run_id, sequence);

CREATE TABLE IF NOT EXISTS agent_evidence (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
    tool TEXT NOT NULL DEFAULT '',
    endpoint TEXT NOT NULL DEFAULT '',
    symbol TEXT NOT NULL DEFAULT '',
    as_of TEXT NOT NULL DEFAULT '',
    summary TEXT NOT NULL DEFAULT '',
    content_sha256 TEXT NOT NULL DEFAULT '',
    payload_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_agent_evidence_run_created ON agent_evidence(run_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_evidence_symbol_asof ON agent_evidence(symbol, as_of DESC);

CREATE TABLE IF NOT EXISTS agent_artifacts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
    artifact_type TEXT NOT NULL,
    reference TEXT NOT NULL,
    content_sha256 TEXT NOT NULL DEFAULT '',
    metadata_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_agent_artifacts_run_type ON agent_artifacts(run_id, artifact_type, created_at DESC);

CREATE TABLE IF NOT EXISTS market_symbols (
    symbol TEXT PRIMARY KEY,
    code TEXT NOT NULL,
    name TEXT NOT NULL DEFAULT '',
    exchange TEXT NOT NULL,
    asset_type TEXT NOT NULL,
    board TEXT NOT NULL DEFAULT '',
    universe_id TEXT NOT NULL DEFAULT 'a-share',
    is_st INTEGER,
    enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
    status TEXT NOT NULL DEFAULT 'active',
    source TEXT NOT NULL DEFAULT 'fixture',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    metadata_json TEXT NOT NULL DEFAULT '{}',
    UNIQUE(exchange, code)
);
CREATE INDEX IF NOT EXISTS idx_market_symbols_universe ON market_symbols(universe_id, enabled, symbol);
CREATE INDEX IF NOT EXISTS idx_market_symbols_type_exchange ON market_symbols(asset_type, exchange, enabled);

CREATE TABLE IF NOT EXISTS market_daily_bars (
    symbol TEXT NOT NULL REFERENCES market_symbols(symbol) ON DELETE CASCADE,
    trade_date TEXT NOT NULL,
    timeframe TEXT NOT NULL DEFAULT 'daily',
    adjustment TEXT NOT NULL DEFAULT 'qfq',
    open REAL,
    high REAL,
    low REAL,
    close REAL,
    previous_close REAL,
    volume REAL,
    amount REAL,
    turnover REAL,
    change_pct REAL,
    trade_status TEXT,
    is_st INTEGER,
    limit_up INTEGER,
    limit_down INTEGER,
    source TEXT NOT NULL DEFAULT 'tencent',
    fetched_at TEXT NOT NULL,
    metadata_json TEXT NOT NULL DEFAULT '{}',
    PRIMARY KEY(symbol, trade_date, timeframe, adjustment)
);
CREATE INDEX IF NOT EXISTS idx_market_bars_date ON market_daily_bars(trade_date DESC, symbol);
CREATE INDEX IF NOT EXISTS idx_market_bars_symbol_date ON market_daily_bars(symbol, timeframe, adjustment, trade_date DESC);

CREATE TABLE IF NOT EXISTS market_daily_features (
    symbol TEXT NOT NULL REFERENCES market_symbols(symbol) ON DELETE CASCADE,
    trade_date TEXT NOT NULL,
    timeframe TEXT NOT NULL DEFAULT 'daily',
    adjustment TEXT NOT NULL DEFAULT 'qfq',
    ma5 REAL,
    ma10 REAL,
    ma20 REAL,
    ma30 REAL,
    ma60 REAL,
    return_5d_pct REAL,
    return_10d_pct REAL,
    return_20d_pct REAL,
    return_60d_pct REAL,
    amount_ratio_20d REAL,
    volatility_20d_pct REAL,
    max_drawdown_20d_pct REAL,
    max_drawdown_60d_pct REAL,
    limit_up_count_4d INTEGER,
    limit_up_count_10d INTEGER,
    close REAL,
    amount REAL,
    turnover REAL,
    change_pct REAL,
    is_st INTEGER,
    is_limit_up INTEGER,
    is_limit_down INTEGER,
    trade_status TEXT,
    sample_count INTEGER NOT NULL DEFAULT 0,
    source TEXT NOT NULL DEFAULT 'local',
    fetched_at TEXT NOT NULL,
    metadata_json TEXT NOT NULL DEFAULT '{}',
    PRIMARY KEY(symbol, trade_date, timeframe, adjustment)
);
CREATE INDEX IF NOT EXISTS idx_market_features_date ON market_daily_features(trade_date DESC, symbol);
CREATE INDEX IF NOT EXISTS idx_market_features_symbol_date ON market_daily_features(symbol, timeframe, adjustment, trade_date DESC);

-- Board (industry/concept/theme/region) identity, membership, and snapshots.
-- ``id`` is an opaque internal identifier derived from provider + provider code
-- so the model never receives or supplies a provider-specific board code.
CREATE TABLE IF NOT EXISTS market_boards (
    id TEXT PRIMARY KEY,
    provider TEXT NOT NULL,
    provider_board_code TEXT NOT NULL,
    name TEXT NOT NULL,
    normalized_name TEXT NOT NULL DEFAULT '',
    aliases_json TEXT NOT NULL DEFAULT '[]',
    board_type TEXT NOT NULL DEFAULT 'concept',
    definition TEXT NOT NULL DEFAULT '',
    constituent_basis TEXT NOT NULL DEFAULT 'provider-defined',
    source_ref TEXT NOT NULL DEFAULT '',
    active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
    fetched_at TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    metadata_json TEXT NOT NULL DEFAULT '{}',
    UNIQUE(provider, provider_board_code)
);
CREATE INDEX IF NOT EXISTS idx_market_boards_name ON market_boards(normalized_name, board_type);
CREATE INDEX IF NOT EXISTS idx_market_boards_type_active ON market_boards(board_type, active, name);

CREATE TABLE IF NOT EXISTS market_board_memberships (
    board_id TEXT NOT NULL REFERENCES market_boards(id) ON DELETE CASCADE,
    symbol TEXT NOT NULL,
    code TEXT NOT NULL DEFAULT '',
    name TEXT NOT NULL DEFAULT '',
    valid_from TEXT NOT NULL,
    valid_to TEXT NOT NULL DEFAULT '',
    source TEXT NOT NULL DEFAULT '',
    as_of TEXT NOT NULL DEFAULT '',
    fetched_at TEXT NOT NULL,
    metadata_json TEXT NOT NULL DEFAULT '{}',
    PRIMARY KEY(board_id, symbol, valid_from)
);
CREATE INDEX IF NOT EXISTS idx_board_memberships_board_valid
    ON market_board_memberships(board_id, valid_from DESC, valid_to);

CREATE TABLE IF NOT EXISTS market_board_snapshots (
    board_id TEXT NOT NULL REFERENCES market_boards(id) ON DELETE CASCADE,
    trade_date TEXT NOT NULL,
    snapshot_at TEXT NOT NULL,
    market_phase TEXT NOT NULL DEFAULT '',
    open REAL,
    high REAL,
    low REAL,
    last REAL,
    previous_close REAL,
    change_pct REAL,
    amount REAL,
    volume REAL,
    turnover REAL,
    advancers INTEGER,
    decliners INTEGER,
    unchanged INTEGER,
    limit_up_count INTEGER,
    limit_down_count INTEGER,
    covered_members INTEGER,
    total_members INTEGER,
    coverage_pct REAL,
    breadth_basis TEXT NOT NULL DEFAULT '',
    algorithm_version TEXT NOT NULL DEFAULT '',
    source TEXT NOT NULL DEFAULT '',
    data_quality TEXT NOT NULL DEFAULT 'ok',
    fetched_at TEXT NOT NULL,
    metadata_json TEXT NOT NULL DEFAULT '{}',
    PRIMARY KEY(board_id, trade_date, snapshot_at)
);
CREATE INDEX IF NOT EXISTS idx_board_snapshots_board_date
    ON market_board_snapshots(board_id, trade_date DESC, snapshot_at DESC);

CREATE TABLE IF NOT EXISTS market_sync_runs (
    id TEXT PRIMARY KEY,
    universe_id TEXT NOT NULL DEFAULT 'a-share',
    operation TEXT NOT NULL DEFAULT 'manual',
    source TEXT NOT NULL DEFAULT 'fixture',
    status TEXT NOT NULL DEFAULT 'running',
    total_symbols INTEGER NOT NULL DEFAULT 0,
    succeeded_symbols INTEGER NOT NULL DEFAULT 0,
    failed_symbols INTEGER NOT NULL DEFAULT 0,
    rows_written INTEGER NOT NULL DEFAULT 0,
    coverage_pct REAL NOT NULL DEFAULT 0,
    first_trade_date TEXT,
    last_trade_date TEXT,
    error_json TEXT NOT NULL DEFAULT '{}',
    started_at TEXT NOT NULL,
    finished_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_market_sync_runs_universe_started ON market_sync_runs(universe_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_market_sync_runs_status ON market_sync_runs(status, started_at DESC);

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


def _additive_columns(connection: sqlite3.Connection, table: str, definitions: dict[str, str]) -> None:
    """Apply only additive migrations for tables introduced by the MVP."""
    columns = {
        str(row["name"])
        for row in connection.execute(f"PRAGMA table_info({table})").fetchall()
    }
    for name, definition in definitions.items():
        if name not in columns:
            connection.execute(f"ALTER TABLE {table} ADD COLUMN {name} {definition}")


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
            # A prior MVP build may have created a subset of the additive
            # tables.  Keep init idempotent without rewriting existing rows.
            _additive_columns(
                self.connection,
                "skills",
                {
                    "description": "TEXT NOT NULL DEFAULT ''",
                    "scope": "TEXT NOT NULL DEFAULT ''",
                    "applicable_scope": "TEXT NOT NULL DEFAULT ''",
                    "install_path": "TEXT NOT NULL DEFAULT ''",
                    "archive_name": "TEXT NOT NULL DEFAULT ''",
                    "archive_size": "INTEGER NOT NULL DEFAULT 0",
                    "file_count": "INTEGER NOT NULL DEFAULT 0",
                },
            )
            _additive_columns(
                self.connection,
                "market_daily_features",
                {"sample_count": "INTEGER NOT NULL DEFAULT 0"},
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
