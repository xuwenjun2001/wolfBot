"""Opt-in real PostgreSQL contracts, isolated in a per-test transaction/schema."""

import json
import os
from contextlib import contextmanager
from datetime import UTC, date, datetime
from pathlib import Path
from uuid import uuid4

import psycopg
import pytest
from psycopg.rows import dict_row

from quantpilot_market_data.database_core import database_url_from_env
from quantpilot_market_data.repositories import tactics as repo
from quantpilot_market_data.tactics import TACTIC_ID, TacticParameters

pytestmark = pytest.mark.skipif(
    os.getenv("TACTICS_TEST_POSTGRES") != "1", reason="opt-in local PostgreSQL integration"
)


@pytest.fixture
def db(monkeypatch):
    schema = "tactic_test_" + uuid4().hex
    c = psycopg.connect(database_url_from_env(), row_factory=dict_row)
    c.execute(f'CREATE SCHEMA "{schema}"')
    sql = (Path(__file__).parents[3] / "sqls/011-tactics-platform.sql").read_text(encoding="utf-8")
    c.execute(sql.replace("quant.", f'"{schema}".'))
    guide_sql = (Path(__file__).parents[3] / "sqls/012-tactic-observation-guide.sql").read_text(
        encoding="utf-8"
    )
    c.execute(guide_sql.replace("quant.", f'"{schema}".'))
    chart_sql = (Path(__file__).parents[3] / "sqls/013-tactic-chart-cache.sql").read_text(
        encoding="utf-8"
    )
    c.execute(chart_sql.replace("quant.", f'"{schema}".'))
    incremental_sql = (Path(__file__).parents[3] / "sqls/014-tactic-incremental.sql").read_text(
        encoding="utf-8"
    )
    c.execute(incremental_sql.replace("quant.", f'"{schema}".'))
    for table in (
        "securities",
        "security_universes",
        "security_universe_members",
        "trading_calendars",
        "stock_bars",
        "market_data_sync_state",
    ):
        c.execute(f'CREATE TABLE "{schema}".{table} (LIKE quant.{table} INCLUDING ALL)')
    c.execute(f'CREATE VIEW "{schema}".canonical_stock_bars AS SELECT * FROM "{schema}".stock_bars')

    class Cursor:
        def __enter__(self):
            self.cur = c.cursor()
            return self

        def __exit__(self, *args):
            self.cur.close()

        def executemany(self, sql, params):
            return self.cur.executemany(sql.replace("quant.", f'"{schema}".'), params)

    class Isolated:
        def cursor(self):
            return Cursor()

        def execute(self, sql, params=None):
            return c.execute(sql.replace("quant.", f'"{schema}".'), params)

    @contextmanager
    def connection():
        # Nested repository calls see their own writes but never commit the fixture.
        with c.transaction():
            yield Isolated()

    monkeypatch.setattr(repo, "connection", connection)
    try:
        yield Isolated()
    finally:
        c.rollback()
        c.close()


def test_shared_guide_persists_without_changing_parameters_and_rejects_stale_edits(db):
    config = repo.get_config()
    assert "人工看盘" in repo.dashboard()["guide"]["content"]
    result = repo.update_guide("  次日先观察趋势\n再观察回踩  ", "manager", 1)
    assert result["version"] == 2
    assert repo.dashboard()["guide"]["content"] == "次日先观察趋势\n再观察回踩"
    assert repo.get_config() == config
    with pytest.raises(ValueError, match="已被更新"):
        repo.update_guide("旧页面草稿", "other", 1)
    assert repo.dashboard()["guide"]["updated_by"] == "manager"


def test_shared_enqueue_and_expired_lease_fencing(db):
    first = repo.enqueue(date(2026, 9, 8), "user-a")
    assert repo.enqueue(date(2026, 9, 8), "user-b")["id"] == first["id"]
    claimed = repo.claim("worker-a")
    assert claimed["id"] == first["id"]
    assert repo.claim("worker-b") is None
    db.execute("UPDATE quant.tactic_runs SET lease_until=now()-interval '1 second'")
    resumed = repo.claim("worker-b")
    assert resumed["id"] == first["id"]
    with pytest.raises(repo.LeaseLost):
        repo.save_item(
            first["id"],
            "worker-a",
            {"symbol": "000001.SZ", "name": "平安"},
            "ready",
            "",
            [],
            "2026-09-08",
        )
    repo.save_item(
        first["id"],
        "worker-b",
        {"symbol": "000001.SZ", "name": "平安"},
        "ready",
        "",
        [],
        "2026-09-08",
    )
    assert repo.prepared_items(first["id"])["000001.SZ"]["status"] == "ready"


def test_publish_requires_all_items_processed_and_rejects_all_gaps(db):
    run = repo.enqueue(date(2026, 9, 8), "user")
    repo.claim("w")
    repo.checkpoint(
        run["id"],
        "w",
        phase="data",
        context={"target": "2026-09-08"},
        trade_date="2026-09-08",
        total=1,
    )
    member = {"symbol": "000001.SZ", "name": "平安"}
    with pytest.raises(ValueError, match="尚未全部处理"):
        repo.publish(run["id"], "w", [], {})
    repo.save_item(run["id"], "w", member, "gap", "缺今日数据", [], "2026-09-08")
    with pytest.raises(ValueError, match="全部股票数据获取失败"):
        repo.publish(run["id"], "w", [], {})
    assert db.execute("SELECT status FROM quant.tactic_runs").fetchone()["status"] == "running"
    repo.save_item(run["id"], "w", member, "ready", "", [], "2026-09-08")
    repo.publish(run["id"], "w", [], {"new_breakouts": 0})
    assert db.execute("SELECT status FROM quant.tactic_runs").fetchone()["status"] == "completed"


def test_public_parameter_concurrency_and_cancel_fence(db):
    p = TacticParameters().model_dump()
    new = repo.update_config({**p, "body_pct": 4}, "manager", 1)
    assert new["version"] == 2
    with pytest.raises(ValueError, match="刷新"):
        repo.update_config(p, "other", 1)
    run = repo.enqueue(date(2026, 9, 8), "user")
    assert run["parameters"]["body_pct"] == 4
    repo.claim("w")
    repo.cancel(run["id"], "manager")
    with pytest.raises(repo.LeaseLost):
        repo.publish(run["id"], "w", [], {})


def test_publish_event_and_evidence_do_not_extend_expiry(db):
    p = TacticParameters().model_dump()
    e = {
        "id": "event-1",
        "symbol": "002837.SZ",
        "name": "英维克",
        "breakout_date": "2026-08-27",
        "expires_date": "2026-08-31",
        "config_version": 1,
        "parameters": p,
        "status": "observing",
        "signal": "breakout",
        "last_evaluated": "2026-08-27",
        "evidence": {"breakout": {}},
        "evaluations": [
            {"date": "2026-08-27", "status": "observing", "signal": "breakout", "evidence": {}}
        ],
    }
    run = repo.enqueue(date(2026, 8, 27), "user")
    repo.claim("w")
    repo.publish(run["id"], "w", [e], {})
    next_run = repo.enqueue(date(2026, 8, 28), "user")
    repo.claim("w")
    repo.publish(
        next_run["id"],
        "w",
        [{**e, "expires_date": "2026-09-02", "last_evaluated": "2026-08-28", "signal": "pullback"}],
        {},
    )
    row = db.execute(
        "SELECT * FROM quant.tactic_events WHERE tactic_id=%s", (TACTIC_ID,)
    ).fetchone()
    assert str(row["expires_date"]) == "2026-08-31"
    assert row["signal"] == "pullback"
    assert db.execute("SELECT count(*) n FROM quant.tactic_evaluations").fetchone()["n"] == 2


@pytest.fixture
def source(monkeypatch):
    from quantpilot_market_data.services import tactics as service

    bars = json.loads((Path(__file__).parent / "fixtures/ma55/002837.json").read_text())["bars"]
    monkeypatch.setattr(service.time, "sleep", lambda _: None)

    class Source:
        stopped = False
        missing = False
        missing_symbols = set()
        codes = ["sz.002837"]
        calls = []
        bar_symbols = []

        def interrupted(self):
            return self.stopped

        def request(self, kind, **kwargs):
            self.calls.append(kind)
            if kind == "calendar":
                return [{"date": b["date"], "is_open": True} for b in bars]
            if kind == "master":
                return [
                    {
                        "code": code,
                        "code_name": "英维克",
                        "type": "1",
                        "status": "1",
                        "ipoDate": "2016-12-29",
                    }
                    for code in self.codes
                ]
            if kind == "daily_members":
                return [{"code": "sz.002837", "tradeStatus": "1"}]
            self.bar_symbols.append(kwargs["symbol"])
            return (
                []
                if self.missing or kwargs["symbol"] in self.missing_symbols
                else [b for b in bars if kwargs["start"] <= b["date"] <= kwargs["end"]]
            )

    return Source()


def run_on(day, source):
    from quantpilot_market_data.services.tactics import execute

    row = repo.enqueue(date.fromisoformat(day), "test")
    execute(repo.claim("w"), "w", source)
    return row["id"]


def test_cold_workflow_cached_rerun_and_next_session(db, source):
    first = run_on("2026-08-27", source)
    assert (
        db.execute("SELECT status FROM quant.tactic_runs WHERE id=%s", (first,)).fetchone()[
            "status"
        ]
        == "completed"
    )
    e = repo.existing_events()[0]
    assert e["signal"] == "breakout"
    assert str(e["expires_date"]) == "2026-08-31"
    bars_count = db.execute("SELECT count(*) n FROM quant.stock_bars").fetchone()["n"]
    assert bars_count >= 60
    assert (
        db.execute("SELECT row_count FROM quant.market_data_sync_state").fetchone()["row_count"]
        == bars_count
    )
    assert (
        str(
            db.execute(
                "SELECT (max(ts) AT TIME ZONE 'Asia/Shanghai')::date d FROM quant.stock_bars"
            ).fetchone()["d"]
        )
        == "2026-08-27"
    )
    source.calls.clear()
    run_on("2026-08-27", source)
    assert "bars" not in source.calls
    assert len(repo.existing_events()) == 1
    assert db.execute("SELECT count(*) n FROM quant.stock_bars").fetchone()["n"] == bars_count
    run_on("2026-08-28", source)
    e = repo.existing_events()[0]
    assert e["signal"] == "pullback"
    assert str(e["expires_date"]) == "2026-08-31"
    assert db.execute("SELECT count(*) n FROM quant.stock_bars").fetchone()["n"] == bars_count + 1
    run_on("2026-08-31", source)
    assert repo.existing_events()[0]["status"] == "expired"


def test_workflow_all_gaps_keeps_published_events(db, source):
    first = run_on("2026-08-27", source)
    source.missing = True
    failed = run_on("2026-08-28", source)
    row = db.execute("SELECT status,gaps FROM quant.tactic_runs WHERE id=%s", (failed,)).fetchone()
    assert row == {"status": "failed", "gaps": 1}
    assert repo.existing_events()[0]["run_id"] == first


def test_partial_publication_skips_gaps_reuses_ready_and_recovers(db, source):
    source.codes = ["sz.002837", "sz.000688"]
    source.missing_symbols = {"000688.SZ"}
    first = run_on("2026-08-27", source)
    row = db.execute("SELECT * FROM quant.tactic_runs WHERE id=%s", (first,)).fetchone()
    assert (row["status"], row["ready"], row["gaps"], row["processed"]) == ("completed", 1, 1, 2)
    assert row["summary"]["partial"] is True
    assert row["summary"]["screened"] == 1
    assert [e["symbol"] for e in repo.existing_events()] == ["002837.SZ"]
    d = repo.dashboard()
    assert d["latest_published"]["id"] == first
    assert d["published_gaps"][0]["symbol"] == "000688.SZ"
    assert d["published_gaps"][0]["reason"] == "目标交易日日K未就绪"
    source.bar_symbols.clear()
    second = run_on("2026-08-27", source)
    assert source.bar_symbols == ["000688.SZ"]
    assert (
        db.execute("SELECT gaps FROM quant.tactic_runs WHERE id=%s", (second,)).fetchone()["gaps"]
        == 1
    )
    source.missing_symbols.clear()
    third = run_on("2026-08-27", source)
    row = db.execute("SELECT * FROM quant.tactic_runs WHERE id=%s", (third,)).fetchone()
    assert row["summary"]["partial"] is False
    assert row["ready"] == 2
    assert len(repo.existing_events()) == 2
    assert repo.dashboard()["published_gaps"] == []


def test_gap_existing_event_is_not_refreshed_or_shown_as_current(db, source, monkeypatch):
    source.codes = ["sz.002837", "sz.000688"]
    first = run_on("2026-08-27", source)
    source.missing_symbols = {"000688.SZ"}
    second = run_on("2026-08-28", source)
    events = {e["symbol"]: e for e in repo.existing_events()}
    assert events["000688.SZ"]["run_id"] == first
    assert events["002837.SZ"]["run_id"] == second
    assert str(events["000688.SZ"]["expires_date"]) == "2026-08-31"

    class Clock(datetime):
        @classmethod
        def now(cls, tz=None):
            return datetime(2026, 8, 28, 8, tzinfo=UTC).astimezone(tz)

    monkeypatch.setattr(repo, "datetime", Clock)
    assert [e["symbol"] for e in repo.dashboard()["events"]] == ["002837.SZ"]
    history = {e["symbol"]: e for e in repo.dashboard("history")["events"]}
    assert history["000688.SZ"]["display_status"] == "data_gap"


def test_workflow_interruption_releases_and_resumes(db, source):
    from quantpilot_market_data.services.tactics import execute

    source.stopped = True
    run_id = run_on("2026-08-27", source)
    assert (
        db.execute("SELECT status FROM quant.tactic_runs WHERE id=%s", (run_id,)).fetchone()[
            "status"
        ]
        == "queued"
    )
    source.stopped = False
    source.calls.clear()
    execute(repo.claim("w2"), "w2", source)
    assert "master" not in source.calls
    assert "calendar" not in source.calls
    assert (
        db.execute("SELECT status FROM quant.tactic_runs WHERE id=%s", (run_id,)).fetchone()[
            "status"
        ]
        == "completed"
    )


def test_chart_cache_is_independent_persistent_and_does_not_change_event(db, source):
    from quantpilot_market_data.services import tactic_charts as charts

    run_on("2026-08-27", source)
    e = repo.existing_events()[0]
    detail = charts.event(e["id"])
    fallback = charts.cached_chart(detail, "daily")
    assert fallback["cacheKind"] == "snapshot"
    assert len(fallback["bars"]) >= 60
    assert charts.cached_chart(detail, "session")["session"] is None
    payload = {"bars": [{"date": "2026-08-28", "close": 99}], "fetchedAt": "2026-08-28T08:00:00Z"}
    charts.persist_chart(e["symbol"], "daily", payload)
    assert charts.cached_chart(charts.event(e["id"]), "daily")["bars"] == payload["bars"]
    charts.persist_chart(e["symbol"], "daily", {"bars": [], "fetchedAt": "2026-08-27T08:00:00Z"})
    assert charts.cached_chart(detail, "daily")["bars"] == payload["bars"]
    assert repo.existing_events()[0] == e
    assert repo.event_detail(e["id"])["bars"] == detail["bars"]


def test_bulk_bars_write_suspension_and_repeat(db, source):
    run_id = run_on("2026-08-27", source)
    row = repo.enqueue(date(2026, 8, 28), "test")
    repo.claim("w")
    bars = repo.prepared_items(run_id)["002837.SZ"]["bars"]
    suspended = {**bars[-1], "date": "2026-08-28", "trade_status": "0", "volume": 0}
    for _ in range(2):
        repo.persist_bars(row["id"], "w", "002837.SZ", [*bars, suspended])
    assert db.execute("SELECT count(*) n FROM quant.stock_bars").fetchone()["n"] == len(bars) + 1
    assert (
        db.execute("SELECT volume FROM quant.stock_bars ORDER BY ts DESC LIMIT 1").fetchone()[
            "volume"
        ]
        == 0
    )


def test_incremental_window_metadata_and_diagnostics_reuse(db, source):
    run_id = run_on("2026-08-27", source)
    e = repo.existing_events()[0]
    window = repo.window_for_incremental(e["symbol"])
    assert str(window["last_full_trade_date"]) == "2026-08-27"
    assert window["acquisition_version"] == "baostock:qfq:v1"
    summary = repo.acquisition_summaries(db, [run_id])[run_id]
    assert summary["full"] == 1 and summary["requests"] >= 1
    assert summary["fetch_seconds"] >= 0 and summary["prepare_seconds"] >= summary["fetch_seconds"]
    # A same-day rerun copies validated evidence but not prior network timing.
    second = run_on("2026-08-27", source)
    reused = repo.acquisition_summaries(db, [second])[second]
    assert reused["cached"] == 1 and reused["requests"] == reused["fetch_seconds"] == 0
    assert repo.acquisition_summaries(db, [second])[second] == reused
    assert repo.existing_events()[0]["expires_date"] == e["expires_date"]


def test_gap_and_older_write_preserve_incremental_baseline(db, source):
    run_on("2026-08-27", source)
    before = repo.window_for_incremental("002837.SZ")
    next_run = repo.enqueue(date(2026, 8, 28), "test")
    repo.claim("w")
    member = {"symbol": "002837.SZ", "name": "test"}
    repo.save_item(
        next_run["id"],
        "w",
        member,
        "gap",
        "full retry failed",
        [],
        "2026-08-28",
        {
            "version": 1,
            "mode": "fallback",
            "requests": 4,
            "fetch_seconds": 2,
            "fallback_reason": "price changed",
        },
    )
    assert repo.window_for_incremental("002837.SZ") == before
    repo.save_item(
        next_run["id"],
        "w",
        member,
        "ready",
        "",
        before["bars"][:-1],
        "2026-08-26",
        {"mode": "full", "last_full_trade_date": "2026-08-26"},
    )
    assert repo.window_for_incremental("002837.SZ") == before


def test_incremental_migration_backfill_is_idempotent(db):
    db.execute(
        "INSERT INTO quant.tactic_windows(symbol,trade_date,bars) "
        "VALUES('000001.SZ','2026-08-27','[]')"
    )
    sql = (Path(__file__).parents[3] / "sqls/014-tactic-incremental.sql").read_text(
        encoding="utf-8"
    )
    db.execute(sql)
    first = repo.window_for_incremental("000001.SZ")
    assert str(first["last_full_trade_date"]) == "2026-08-27"
    db.execute("UPDATE quant.tactic_windows SET trade_date='2026-08-28'")
    db.execute(sql)
    assert (
        repo.window_for_incremental("000001.SZ")["last_full_trade_date"]
        == first["last_full_trade_date"]
    )


def test_next_day_real_orchestration_uses_increment_and_keeps_full_baseline(db, source):
    run_on("2026-08-27", source)
    before = repo.window_for_incremental("002837.SZ")
    second = run_on("2026-08-28", source)
    item = repo.prepared_items(second)["002837.SZ"]
    assert item["acquisition"]["mode"] == "incremental"
    assert item["acquisition"]["rows"] == 5
    after = repo.window_for_incremental("002837.SZ")
    assert after["last_full_trade_date"] == before["last_full_trade_date"]
    assert str(after["trade_date"]) == "2026-08-28"
    assert repo.existing_events()[0]["signal"] == "pullback"


def test_legacy_missing_amount_does_not_erase_known_canonical_amount(db, source):
    first = run_on("2026-08-27", source)
    bars = repo.prepared_items(first)["002837.SZ"]["bars"]
    next_run = repo.enqueue(date(2026, 8, 28), "test")
    repo.claim("w")
    latest = {**bars[-1], "amount": 123456}
    repo.persist_bars(next_run["id"], "w", "002837.SZ", [latest])
    repo.persist_bars(next_run["id"], "w", "002837.SZ", [{**latest, "amount": None}])
    assert (
        db.execute("SELECT amount FROM quant.stock_bars ORDER BY ts DESC LIMIT 1").fetchone()[
            "amount"
        ]
        == 123456
    )
