"""PostgreSQL boundary for public tactics and fenced, resumable runs."""

from __future__ import annotations

import time
from contextlib import contextmanager
from datetime import UTC, datetime, timedelta
from uuid import uuid4

import psycopg
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb

from quantpilot_market_data.database_core import database_url_from_env
from quantpilot_market_data.tactics import (
    TACTIC_ID,
    UNIVERSE_ID,
    display_status,
    resolve_trade_date,
    scan_date_cutoff,
)


@contextmanager
def connection():
    with psycopg.connect(database_url_from_env(), row_factory=dict_row, connect_timeout=5) as conn:
        conn.execute("SET LOCAL statement_timeout = '30s'")
        yield conn


class LeaseLost(RuntimeError):
    tactic_control_error = True


def fence(conn, run_id: str, owner: str):
    row = conn.execute(
        "SELECT id FROM quant.tactic_runs WHERE id=%s AND lease_owner=%s "
        "AND lease_until>now() AND status='running' FOR UPDATE",
        (run_id, owner),
    ).fetchone()
    if not row:
        raise LeaseLost("任务已由其他执行者接管或取消")


def get_config():
    with connection() as conn:
        row = conn.execute(
            "SELECT * FROM quant.tactic_configs WHERE id=%s", (TACTIC_ID,)
        ).fetchone()
    if not row:
        raise ValueError("战法数据表未初始化，请运行数据库迁移")
    return row


def update_config(parameters: dict, actor: str, expected_version: int):
    with connection() as conn:
        row = conn.execute(
            "UPDATE quant.tactic_configs SET "
            "parameters=%s,version=version+1,updated_by=%s,updated_at=now() "
            "WHERE id=%s AND version=%s RETURNING *",
            (Jsonb(parameters), actor, TACTIC_ID, expected_version),
        ).fetchone()
    if not row:
        raise ValueError("公共参数已被更新，请刷新后重试")
    return row


def update_guide(content: str, actor: str, expected_version: int):
    with connection() as conn:
        row = conn.execute(
            "UPDATE quant.tactic_guides SET content=%s,version=version+1,"
            "updated_by=%s,updated_at=now() WHERE tactic_id=%s AND version=%s RETURNING *",
            (content.strip(), actor, TACTIC_ID, expected_version),
        ).fetchone()
    if not row:
        raise ValueError("观察指引已被更新，请重新打开编辑后再保存")
    return row


def enqueue(requested_date, actor: str):
    with connection() as conn:
        config = conn.execute(
            "SELECT * FROM quant.tactic_configs WHERE id=%s FOR UPDATE", (TACTIC_ID,)
        ).fetchone()
        if not config:
            raise ValueError("战法数据表未初始化")
        active = conn.execute(
            "SELECT * FROM quant.tactic_runs WHERE tactic_id=%s AND status IN "
            "('queued','running','waiting')",
            (TACTIC_ID,),
        ).fetchone()
        if active:
            return active
        return conn.execute(
            "INSERT INTO "
            "quant.tactic_runs(id,tactic_id,requested_date,config_version,parameters,actor) "
            "VALUES(%s,%s,%s,%s,%s,%s) RETURNING *",
            (
                str(uuid4()),
                TACTIC_ID,
                requested_date,
                config["version"],
                Jsonb(config["parameters"]),
                actor,
            ),
        ).fetchone()


def worker_heartbeat(owner: str):
    with connection() as conn:
        conn.execute(
            "INSERT INTO quant.tactic_worker_heartbeats(id) VALUES(%s) ON CONFLICT(id) DO "
            "UPDATE SET heartbeat_at=now()",
            (owner,),
        )
        conn.execute(
            "DELETE FROM quant.tactic_worker_heartbeats WHERE heartbeat_at < now()-interval '1 day'"
        )


def claim(owner: str):
    with connection() as conn:
        return conn.execute(
            """WITH candidate AS (
          SELECT id FROM quant.tactic_runs WHERE
            (status IN ('queued','waiting') AND next_attempt_at<=now()) OR
            (status='running' AND lease_until<now())
          ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1
        ) UPDATE quant.tactic_runs r SET status='running',lease_owner=%s,
          lease_until=now()+interval '120 seconds',updated_at=now()
          FROM candidate c WHERE r.id=c.id RETURNING r.*""",
            (owner,),
        ).fetchone()


def heartbeat(run_id: str, owner: str):
    with connection() as conn:
        fence(conn, run_id, owner)
        conn.execute(
            "UPDATE quant.tactic_runs SET lease_until=now()+interval '120 "
            "seconds',updated_at=now() WHERE id=%s",
            (run_id,),
        )
    worker_heartbeat(owner)


def checkpoint(run_id: str, owner: str, *, phase: str, context: dict, trade_date=None, total=0):
    with connection() as conn:
        fence(conn, run_id, owner)
        conn.execute(
            "UPDATE quant.tactic_runs SET "
            "phase=%s,context=%s,trade_date=%s,total=%s,updated_at=now() WHERE id=%s",
            (phase, Jsonb(context), trade_date, total, run_id),
        )


def save_master(members: list[dict], run_id: str, owner: str):
    with connection() as conn:
        fence(conn, run_id, owner)
        previous = conn.execute(
            "SELECT count(*) n FROM quant.security_universe_members WHERE universe_id=%s AND "
            "role<>'inactive'",
            (UNIVERSE_ID,),
        ).fetchone()["n"]
        if previous and len(members) < previous * 0.9:
            raise ValueError("证券名单较上次减少超过10%，拒绝替换，请核验数据源")
        conn.execute(
            "INSERT INTO quant.security_universes(id,name,source,metadata) "
            "VALUES(%s,'沪深主板A股','baostock',%s) "
            "ON CONFLICT(id) DO UPDATE SET updated_at=now()",
            (UNIVERSE_ID, Jsonb({"default_adjustment": "qfq", "default_timeframe": "daily"})),
        )
        with conn.cursor() as cur:
            cur.executemany(
                "INSERT INTO "
                "quant.securities(symbol,code,name,exchange,asset_type,listed_at,provider) "
                "VALUES(%s,%s,%s,%s,'stock',%s,'baostock') ON CONFLICT(symbol) DO UPDATE SET "
                "name=EXCLUDED.name,listed_at=COALESCE(EXCLUDED.listed_at,quant.securities.listed_at),updated_at=now()",
                [
                    (m["symbol"], m["symbol"][:6], m["name"], m["symbol"][-2:], m["listed_at"])
                    for m in members
                ],
            )
            cur.executemany(
                "INSERT INTO quant.security_universe_members(universe_id,symbol,role) "
                "VALUES(%s,%s,'member') "
                "ON CONFLICT(universe_id,symbol) DO UPDATE SET role='member'",
                [(UNIVERSE_ID, m["symbol"]) for m in members],
            )
        conn.execute(
            "UPDATE quant.security_universe_members SET role='inactive' WHERE universe_id=%s "
            "AND NOT(symbol=ANY(%s))",
            (UNIVERSE_ID, [m["symbol"] for m in members]),
        )


def save_calendar(days: list[dict], run_id: str, owner: str):
    with connection() as conn:
        fence(conn, run_id, owner)
        with conn.cursor() as cur:
            cur.executemany(
                "INSERT INTO quant.trading_calendars(market,trade_date,is_open,session,source) "
                "VALUES('CN-A',%s,%s,'regular','baostock') ON "
                "CONFLICT(market,trade_date,session) DO UPDATE SET "
                "is_open=EXCLUDED.is_open,source=EXCLUDED.source",
                [(d["date"], d["is_open"]) for d in days],
            )


def cached_calendar():
    with connection() as conn:
        return [
            {"date": str(r["trade_date"]), "is_open": r["is_open"]}
            for r in conn.execute(
                "SELECT trade_date,is_open FROM quant.trading_calendars WHERE market='CN-A' "
                "AND session='regular' ORDER BY trade_date"
            ).fetchall()
        ]


def prepared_items(run_id: str):
    with connection() as conn:
        return {
            r["symbol"]: r
            for r in conn.execute(
                "SELECT * FROM quant.tactic_run_items WHERE run_id=%s", (run_id,)
            ).fetchall()
        }


def cached_window(symbol: str, target: str):
    with connection() as conn:
        row = conn.execute(
            "SELECT bars FROM quant.tactic_windows WHERE symbol=%s AND trade_date=%s AND "
            "source='baostock'",
            (symbol, target),
        ).fetchone()
        return row["bars"] if row else None


def window_for_incremental(symbol: str):
    with connection() as conn:
        return conn.execute(
            "SELECT * FROM quant.tactic_windows WHERE symbol=%s", (symbol,)
        ).fetchone()


def persist_bars(run_id: str, owner: str, symbol: str, bars: list[dict]):
    """Write one coherent provider window and refresh the existing coverage model."""
    with connection() as conn:
        fence(conn, run_id, owner)
        conn.execute(
            """INSERT INTO quant.stock_bars(
              symbol,ts,timeframe,adjustment,open,high,low,close,
              volume,amount,trade_status,is_st,provider,metadata)
            SELECT %s,b.date::timestamp AT TIME ZONE 'Asia/Shanghai','daily','qfq',
              b.open,b.high,b.low,b.close,b.volume,b.amount,b.trade_status,b.is_st,'baostock',%s
            FROM jsonb_to_recordset(%s) AS b(
              date date,open numeric,high numeric,low numeric,close numeric,
              volume bigint,amount numeric,trade_status text,is_st boolean)
            WHERE b.open IS NOT NULL AND b.high IS NOT NULL AND b.low IS NOT NULL
              AND b.close IS NOT NULL AND b.volume IS NOT NULL
            ON CONFLICT(symbol,timeframe,adjustment,ts) DO UPDATE SET
              open=EXCLUDED.open,high=EXCLUDED.high,low=EXCLUDED.low,close=EXCLUDED.close,
              volume=EXCLUDED.volume,amount=COALESCE(EXCLUDED.amount,stock_bars.amount),trade_status=EXCLUDED.trade_status,
              is_st=EXCLUDED.is_st,provider=EXCLUDED.provider,metadata=EXCLUDED.metadata""",
            (
                symbol,
                Jsonb({"source": "baostock", "tactic_snapshot": run_id, "volume_unit": "hands"}),
                Jsonb(bars),
            ),
        )
        conn.execute(
            """INSERT INTO quant.market_data_sync_state(
              symbol,timeframe,adjustment,provider,first_ts,last_ts,row_count,last_success_at)
            SELECT symbol,timeframe,adjustment,provider,min(ts),max(ts),count(*)::int,now()
            FROM quant.canonical_stock_bars
            WHERE symbol=%s AND timeframe='daily' AND adjustment='qfq' AND provider='baostock'
            GROUP BY symbol,timeframe,adjustment,provider
            ON CONFLICT(symbol,timeframe,adjustment,provider) DO UPDATE SET
              first_ts=EXCLUDED.first_ts,last_ts=EXCLUDED.last_ts,row_count=EXCLUDED.row_count,
              last_success_at=now(),last_error=NULL""",
            (symbol,),
        )


def save_item(
    run_id: str,
    owner: str,
    member: dict,
    status: str,
    reason: str,
    bars: list,
    target: str,
    acquisition=None,
):
    started = time.perf_counter()
    with connection() as conn:
        fence(conn, run_id, owner)
        if status != "gap" and bars and bars[-1]["date"] == target:
            full_date = (acquisition or {}).get("last_full_trade_date", target)
            conn.execute(
                "INSERT INTO quant.tactic_windows("
                "symbol,trade_date,bars,last_full_trade_date,acquisition_version) "
                "VALUES(%s,%s,%s,%s,'baostock:qfq:v1') ON CONFLICT(symbol) DO UPDATE SET "
                "trade_date=EXCLUDED.trade_date,bars=EXCLUDED.bars,last_full_trade_date=EXCLUDED.last_full_trade_date,"
                "acquisition_version=EXCLUDED.acquisition_version "
                "WHERE quant.tactic_windows.trade_date<=EXCLUDED.trade_date",
                (member["symbol"], target, Jsonb(bars), full_date),
            )
        metrics = dict(acquisition or {})
        conn.execute(
            "INSERT INTO quant.tactic_run_items(run_id,symbol,name,status,reason,bars,acquisition) "
            "VALUES(%s,%s,%s,%s,%s,%s,%s) ON CONFLICT(run_id,symbol) DO UPDATE SET "
            "status=EXCLUDED.status,reason=EXCLUDED.reason,bars=EXCLUDED.bars,acquisition=EXCLUDED.acquisition,updated_at=now()",
            (run_id, member["symbol"], member["name"], status, reason, Jsonb(bars), Jsonb(metrics)),
        )
        refresh_progress(conn, run_id)
        if acquisition is not None:
            # Save SQL/progress time, excluding this diagnostic write and final commit.
            elapsed = time.perf_counter() - started
            metrics["persist_seconds"] = metrics.get("persist_seconds", 0) + elapsed
            metrics["prepare_seconds"] = metrics.get("prepare_seconds", 0) + elapsed
            conn.execute(
                "UPDATE quant.tactic_run_items SET acquisition=%s WHERE run_id=%s AND symbol=%s",
                (Jsonb(metrics), run_id, member["symbol"]),
            )


def refresh_progress(conn, run_id: str):
    conn.execute(
        """UPDATE quant.tactic_runs SET
          processed=s.n,ready=s.ready,excluded=s.excluded,gaps=s.gaps,updated_at=now()
        FROM (SELECT count(*) n,count(*) FILTER(WHERE status='ready') ready,
          count(*) FILTER(WHERE status='excluded') excluded,
          count(*) FILTER(WHERE status='gap') gaps
          FROM quant.tactic_run_items WHERE run_id=%s) s WHERE id=%s""",
        (run_id, run_id),
    )


def restore_prepared_items(run_id: str, owner: str, target: str, members: list[dict]):
    """Copy validated same-date snapshots in bulk; retry gaps and newly added members."""
    with connection() as conn:
        fence(conn, run_id, owner)
        conn.execute(
            """INSERT INTO quant.tactic_run_items(run_id,symbol,name,status,reason,bars,acquisition)
            SELECT %s,p.symbol,m.name,p.status,p.reason,p.bars,
              '{"version":1,"mode":"cached","requests":0,"rows":0}'::jsonb
            FROM (
              SELECT DISTINCT ON(i.symbol) i.* FROM quant.tactic_run_items i
              JOIN quant.tactic_runs r ON r.id=i.run_id
              WHERE r.trade_date=%s AND i.run_id<>%s AND i.status IN ('ready','excluded')
              ORDER BY i.symbol,i.updated_at DESC
            ) p JOIN jsonb_to_recordset(%s) AS m(symbol text,name text) ON m.symbol=p.symbol
            ON CONFLICT(run_id,symbol) DO NOTHING""",
            (run_id, target, run_id, Jsonb(members)),
        )
        refresh_progress(conn, run_id)


def existing_events():
    with connection() as conn:
        return conn.execute(
            "SELECT * FROM quant.tactic_events WHERE tactic_id=%s", (TACTIC_ID,)
        ).fetchall()


def finish_problem(run_id: str, owner: str, message: str, wait: bool):
    with connection() as conn:
        fence(conn, run_id, owner)
        conn.execute(
            "UPDATE quant.tactic_runs SET "
            "status=%s,phase=%s,error=%s,lease_owner=NULL,lease_until=NULL, "
            "next_attempt_at=now()+interval '5 minutes',completed_at=%s,updated_at=now() "
            "WHERE id=%s",
            (
                "waiting" if wait else "failed",
                "waiting_data" if wait else "failed",
                message[:2000],
                None if wait else datetime.now(UTC),
                run_id,
            ),
        )


def cancel(run_id: str, actor: str):
    with connection() as conn:
        return conn.execute(
            "UPDATE quant.tactic_runs SET "
            "status='cancelled',phase='cancelled',lease_until=NULL,lease_owner=NULL, "
            "error=%s,completed_at=now(),updated_at=now() WHERE id=%s AND status IN "
            "('queued','waiting','running') RETURNING id",
            (f"由 {actor} 停止", run_id),
        ).fetchone()


def release(run_id: str, owner: str):
    with connection() as conn:
        fence(conn, run_id, owner)
        conn.execute(
            "UPDATE quant.tactic_runs SET status='queued',lease_owner=NULL,lease_until=NULL,"
            "next_attempt_at=now(),updated_at=now() WHERE id=%s",
            (run_id,),
        )


def publish(run_id: str, owner: str, events: list[dict], summary: dict):
    with connection() as conn:
        fence(conn, run_id, owner)
        run = conn.execute("SELECT * FROM quant.tactic_runs WHERE id=%s", (run_id,)).fetchone()
        counts = conn.execute(
            "SELECT count(*) n,count(*) FILTER(WHERE status='gap') gaps,"
            "count(*) FILTER(WHERE status='ready') ready,"
            "count(*) FILTER(WHERE status='excluded') excluded FROM "
            "quant.tactic_run_items WHERE run_id=%s",
            (run_id,),
        ).fetchone()
        if counts["n"] != run["total"]:
            raise ValueError("股票尚未全部处理，禁止发布股池")
        if counts["gaps"] and counts["gaps"] == counts["n"]:
            raise ValueError("全部股票数据获取失败，没有可发布的筛选结果")
        summary = {
            **summary,
            "partial": counts["gaps"] > 0,
            "skipped_gaps": counts["gaps"],
            "screened": counts["ready"],
            "excluded": counts["excluded"],
            "universe_total": counts["n"],
        }
        gap_symbols = {
            r["symbol"]
            for r in conn.execute(
                "SELECT symbol FROM quant.tactic_run_items WHERE run_id=%s AND status='gap'",
                (run_id,),
            ).fetchall()
        }
        if any(e["symbol"] in gap_symbols for e in events):
            raise ValueError("缺口股票不能发布新评估")
        for e in events:
            conn.execute(
                """INSERT INTO
quant.tactic_events(id,tactic_id,symbol,name,breakout_date,expires_date,config_version,
                parameters,status,signal,last_evaluated,evidence,run_id)
VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
                ON CONFLICT(id) DO UPDATE SET
status=EXCLUDED.status,signal=EXCLUDED.signal,last_evaluated=EXCLUDED.last_evaluated,
                evidence=EXCLUDED.evidence,run_id=EXCLUDED.run_id,updated_at=now()
                WHERE quant.tactic_events.last_evaluated<=EXCLUDED.last_evaluated""",
                (
                    e["id"],
                    TACTIC_ID,
                    e["symbol"],
                    e["name"],
                    e["breakout_date"],
                    e["expires_date"],
                    e["config_version"],
                    Jsonb(e["parameters"]),
                    e["status"],
                    e["signal"],
                    e["last_evaluated"],
                    Jsonb(e["evidence"]),
                    run_id,
                ),
            )
            for v in e.get("evaluations", []):
                conn.execute(
                    "INSERT INTO "
                    "quant.tactic_evaluations(run_id,event_id,trade_date,status,signal,evidence)"
                    " "
                    "VALUES(%s,%s,%s,%s,%s,%s) ON CONFLICT DO NOTHING",
                    (run_id, e["id"], v["date"], v["status"], v["signal"], Jsonb(v["evidence"])),
                )
        conn.execute(
            "UPDATE quant.tactic_runs SET "
            "status='completed',phase='completed',summary=%s,error=NULL,lease_owner=NULL,"
            "lease_until=NULL,completed_at=clock_timestamp(),updated_at=now()"
            " WHERE id=%s",
            (Jsonb(summary), run_id),
        )


def acquisition_summaries(conn, run_ids):
    if not run_ids:
        return {}
    rows = conn.execute(
        "SELECT run_id,status,acquisition FROM quant.tactic_run_items "
        "WHERE run_id=ANY(%s) AND acquisition ? 'mode'",
        (run_ids,),
    ).fetchall()
    result = {}
    for row in rows:
        d = row["acquisition"]
        summary = result.setdefault(
            row["run_id"],
            {
                "recorded": 0,
                "cached": 0,
                "incremental": 0,
                "full": 0,
                "fallback": 0,
                "fetched_stocks": 0,
                "requests": 0,
                "rows": 0,
                "gaps": 0,
                "fetch_seconds": 0.0,
                "wait_seconds": 0.0,
                "validation_seconds": 0.0,
                "cache_seconds": 0.0,
                "persist_seconds": 0.0,
                "prepare_seconds": 0.0,
                "fallback_reasons": {},
            },
        )
        summary["recorded"] += 1
        mode = d["mode"]
        summary["cached"] += mode == "cached"
        summary["incremental"] += mode == "incremental" and row["status"] != "gap"
        summary["full"] += mode in {"full", "fallback"}
        summary["fallback"] += mode == "fallback"
        summary["gaps"] += row["status"] == "gap"
        summary["fetched_stocks"] += d.get("requests", 0) > 0
        for key in (
            "requests",
            "rows",
            "fetch_seconds",
            "wait_seconds",
            "validation_seconds",
            "cache_seconds",
            "persist_seconds",
            "prepare_seconds",
        ):
            summary[key] += d.get(key, 0)
        if mode == "fallback":
            reason = d.get("fallback_reason", "原因未记录")
            summary["fallback_reasons"][reason] = summary["fallback_reasons"].get(reason, 0) + 1
    for summary in result.values():
        summary["average_fetch_seconds"] = (
            summary["fetch_seconds"] / summary["fetched_stocks"]
            if summary["fetched_stocks"]
            else None
        )
    return result


def dashboard(view: str = "active", page: int = 1, run_id: str | None = None):
    now = datetime.now(UTC)
    try:
        runnable_trade_date = resolve_trade_date(scan_date_cutoff(now), cached_calendar(), now)
    except ValueError:
        # A cold installation can enqueue; its worker fetches the real calendar first.
        runnable_trade_date = None
    with connection() as conn:
        config = conn.execute(
            "SELECT * FROM quant.tactic_configs WHERE id=%s", (TACTIC_ID,)
        ).fetchone()
        runs = conn.execute(
            "SELECT * FROM quant.tactic_runs ORDER BY created_at DESC LIMIT 20"
        ).fetchall()
        summaries = acquisition_summaries(conn, [r["id"] for r in runs])
        for r in runs:
            r["acquisition"] = summaries.get(r["id"])
            r.pop("context", None)
            r.pop("lease_owner", None)
        latest = conn.execute(
            "SELECT id,trade_date,total,ready,excluded,gaps,summary FROM quant.tactic_runs "
            "WHERE status='completed' ORDER BY "
            "trade_date DESC,completed_at DESC LIMIT 1"
        ).fetchone()
        events = conn.execute(
            "SELECT * FROM quant.tactic_events ORDER BY breakout_date DESC,symbol"
        ).fetchall()
        published_gaps = (
            conn.execute(
                "SELECT symbol,name,reason FROM quant.tactic_run_items "
                "WHERE run_id=%s AND status='gap' ORDER BY symbol",
                (latest["id"],),
            ).fetchall()
            if latest
            else []
        )
        skipped = {r["symbol"] for r in published_gaps}
        for e in events:
            e["display_status"] = display_status(e, now)
            if e["display_status"] == "observing" and e["symbol"] in skipped:
                e["display_status"] = "data_gap"
        if view == "active":
            events = [e for e in events if e["display_status"] == "observing"]
        elif view == "today":
            events = [e for e in events if latest and e["run_id"] == latest["id"]]
        total = len(events)
        events = events[(page - 1) * 50 : page * 50]
        worker = conn.execute(
            "SELECT max(heartbeat_at) heartbeat FROM quant.tactic_worker_heartbeats"
        ).fetchone()["heartbeat"]
        base = conn.execute(
            "SELECT count(*) n FROM quant.security_universe_members WHERE universe_id=%s AND "
            "role<>'inactive'",
            (UNIVERSE_ID,),
        ).fetchone()["n"]
        chosen = run_id or (runs[0]["id"] if runs else None)
        issues = (
            conn.execute(
                "SELECT symbol,name,status,reason FROM quant.tactic_run_items WHERE run_id=%s"
                " AND status<>'ready' ORDER BY (status='gap') DESC,symbol LIMIT 100",
                (chosen,),
            ).fetchall()
            if chosen
            else []
        )
        return {
            "config": config,
            "guide": conn.execute(
                "SELECT * FROM quant.tactic_guides WHERE tactic_id=%s", (TACTIC_ID,)
            ).fetchone(),
            "runs": runs,
            "events": events,
            "total": total,
            "page": page,
            "universe_count": base,
            "worker_online": bool(worker and now - worker < timedelta(seconds=120)),
            "latest_published": latest,
            "published_gaps": published_gaps[:100],
            "runnable_trade_date": runnable_trade_date,
            "issues": issues,
            "as_of": now,
        }


def event_detail(event_id: str):
    with connection() as conn:
        e = conn.execute("SELECT * FROM quant.tactic_events WHERE id=%s", (event_id,)).fetchone()
        if not e:
            return None
        row = conn.execute(
            "SELECT bars FROM quant.tactic_run_items WHERE run_id=%s AND symbol=%s",
            (e["run_id"], e["symbol"]),
        ).fetchone()
        e["bars"] = row["bars"] if row else []
        e["evaluations"] = conn.execute(
            "SELECT trade_date,status,signal,evidence FROM quant.tactic_evaluations WHERE "
            "event_id=%s AND run_id=%s ORDER BY trade_date",
            (event_id, e["run_id"]),
        ).fetchall()
        return e
