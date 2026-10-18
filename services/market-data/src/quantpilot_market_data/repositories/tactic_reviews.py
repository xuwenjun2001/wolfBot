"""Persisted review jobs, immutable reports and locally scoped knowledge."""

import json
from datetime import datetime
from uuid import uuid4

from psycopg.types.json import Jsonb

from quantpilot_market_data.database_core import SHANGHAI_TZ
from quantpilot_market_data.repositories import tactics as base
from quantpilot_market_data.tactic_reviews import (
    digest,
    post_pullback_performance,
    select_knowledge,
    statistics,
)
from quantpilot_market_data.tactics import TACTIC_ID


def plain(value):
    return json.loads(json.dumps(value, default=str))


def settings():
    with base.connection() as c:
        return c.execute(
            "SELECT * FROM quant.tactic_review_settings WHERE tactic_id=%s", (TACTIC_ID,)
        ).fetchone()


def prompt_history():
    with base.connection() as c:
        return c.execute(
            "SELECT * FROM quant.tactic_report_prompts WHERE tactic_id=%s ORDER BY version DESC",
            (TACTIC_ID,),
        ).fetchall()


def save_prompt(content, expected_version, actor):
    with base.connection() as c:
        c.execute("SELECT id FROM quant.tactic_configs WHERE id=%s FOR UPDATE", (TACTIC_ID,))
        latest = c.execute(
            "SELECT max(version) v FROM quant.tactic_report_prompts WHERE tactic_id=%s",
            (TACTIC_ID,),
        ).fetchone()["v"]
        if latest != expected_version:
            raise ValueError("提示词已被更新，请刷新版本后重试；草稿未保存")
        return c.execute(
            "INSERT INTO quant.tactic_report_prompts(tactic_id,version,content,actor) "
            "VALUES(%s,%s,%s,%s) RETURNING *",
            (TACTIC_ID, latest + 1, content.strip(), actor),
        ).fetchone()


def save_settings(enabled, start_time, expected_version, actor):
    with base.connection() as c:
        row = c.execute(
            "UPDATE quant.tactic_review_settings SET enabled=%s,start_time=%s,"
            "version=version+1,updated_by=%s,updated_at=now() "
            "WHERE tactic_id=%s AND version=%s RETURNING *",
            (enabled, start_time, actor, TACTIC_ID, expected_version),
        ).fetchone()
        if not row:
            raise ValueError("日程已被更新，请刷新后重试")
        return row


def enqueue(kind, day, actor, payload=None):
    with base.connection() as c:
        c.execute("SELECT id FROM quant.tactic_configs WHERE id=%s FOR UPDATE", (TACTIC_ID,))
        active = c.execute(
            "SELECT * FROM quant.tactic_review_jobs WHERE kind=%s AND trade_date=%s "
            "AND status IN ('queued','running','waiting')",
            (kind, day),
        ).fetchone()
        if active:
            return active
        return c.execute(
            "INSERT INTO quant.tactic_review_jobs(id,kind,trade_date,actor,input) "
            "VALUES(%s,%s,%s,%s,%s) RETURNING *",
            (str(uuid4()), kind, day, actor, Jsonb(plain(payload or {}))),
        ).fetchone()


def claim(owner, job_id=None):
    with base.connection() as c:
        return c.execute(
            """WITH candidate AS (
          SELECT id FROM quant.tactic_review_jobs WHERE
          ((status IN ('queued','waiting') AND next_attempt_at<=now()) OR
          (status='running' AND lease_until<now())) AND (%s::text IS NULL OR id=%s)
          ORDER BY CASE kind WHEN 'review' THEN 0 ELSE 1 END,created_at
          FOR UPDATE SKIP LOCKED LIMIT 1)
          UPDATE quant.tactic_review_jobs j SET status='running',lease_owner=%s,
          lease_until=now()+interval '120 seconds',updated_at=now(),attempts=attempts+1
          FROM candidate WHERE j.id=candidate.id RETURNING j.*""",
            (job_id, job_id, owner),
        ).fetchone()


def fence(c, job_id, owner):
    row = c.execute(
        "SELECT id FROM quant.tactic_review_jobs WHERE id=%s AND lease_owner=%s "
        "AND status='running' AND lease_until>now() FOR UPDATE",
        (job_id, owner),
    ).fetchone()
    if not row:
        raise base.LeaseLost("复盘任务租约已失效")


def heartbeat(job_id, owner):
    with base.connection() as c:
        fence(c, job_id, owner)
        c.execute(
            "UPDATE quant.tactic_review_jobs SET lease_until=now()+interval '120 seconds',"
            "updated_at=now() WHERE id=%s",
            (job_id,),
        )
    base.worker_heartbeat(owner)


def finish(job_id, owner, result=None, error=None, retry=False):
    with base.connection() as c:
        fence(c, job_id, owner)
        c.execute(
            "UPDATE quant.tactic_review_jobs SET status=%s,result=%s,error=%s,"
            "next_attempt_at=now()+interval '5 minutes',lease_owner=NULL,lease_until=NULL,"
            "updated_at=now() WHERE id=%s",
            (
                "waiting" if retry else "failed" if error else "completed",
                Jsonb(plain(result or {})),
                error,
                job_id,
            ),
        )


def event_inputs():
    with base.connection() as c:
        return c.execute(
            "SELECT e.*,w.bars cached_bars FROM quant.tactic_events e "
            "LEFT JOIN quant.tactic_windows w ON w.symbol=e.symbol "
            "WHERE e.tactic_id=%s ORDER BY e.breakout_date,e.symbol",
            (TACTIC_ID,),
        ).fetchall()


def save_performances(job_id, owner, rows):
    with base.connection() as c:
        fence(c, job_id, owner)
        for r in rows:
            c.execute(
                "INSERT INTO quant.tactic_performances(event_id,trade_date,horizon,data) "
                "VALUES(%s,%s,%s,%s) ON CONFLICT(event_id,trade_date) DO UPDATE "
                "SET data=EXCLUDED.data,updated_at=now() "
                "WHERE coalesce(quant.tactic_performances.data->>'evaluated_as_of','') "
                "<=EXCLUDED.data->>'evaluated_as_of'",
                (r["event_id"], r["trade_date"], r["horizon"], Jsonb(plain(r))),
            )


def all_performances():
    with base.connection() as c:
        return [
            r["data"]
            for r in c.execute(
                "SELECT data FROM quant.tactic_performances ORDER BY trade_date,event_id"
            ).fetchall()
        ]


def snapshot(job_id, owner, day, coverage):
    rows = all_performances()
    calendar = [d["date"] for d in base.cached_calendar() if d["is_open"] and d["date"] <= day]
    start = calendar[-60] if len(calendar) >= 60 else calendar[0] if calendar else day
    history = [r for r in rows if start <= r["breakout_date"] <= day and r["trade_date"] <= day]
    groups = {}
    for r in history:
        groups.setdefault(f"v{r['config_version']}:{r['origin']}", []).append(r)
    data = dict(
        trade_date=day,
        current=[r for r in rows if r["trade_date"] == day],
        historical=history,
        post_pullback_performance=post_pullback_performance(history),
        statistics={k: statistics(v) for k, v in groups.items()},
        coverage=coverage,
    )
    with base.connection() as c:
        fence(c, job_id, owner)
        return c.execute(
            "INSERT INTO quant.tactic_review_snapshots(id,trade_date,digest,data) "
            "VALUES(%s,%s,%s,%s) ON CONFLICT(trade_date,digest) DO UPDATE "
            "SET digest=EXCLUDED.digest RETURNING *",
            (str(uuid4()), day, digest(data), Jsonb(plain(data))),
        ).fetchone()


def prepare_report(snapshot_row, actor, force=False):
    from quantpilot_market_data.services.tactic_reports import SYSTEM_PROMPT

    day = str(snapshot_row["trade_date"])
    with base.connection() as c:
        c.execute("SELECT id FROM quant.tactic_configs WHERE id=%s FOR UPDATE", (TACTIC_ID,))
        existing = c.execute(
            "SELECT id FROM quant.tactic_reports WHERE snapshot_id=%s LIMIT 1",
            (snapshot_row["id"],),
        ).fetchone()
        if existing and not force:
            return existing
        reports = c.execute(
            "SELECT id,trade_date,revision,summary,created_at,knowledge_enabled "
            "FROM quant.tactic_reports WHERE trade_date<%s",
            (day,),
        ).fetchall()
        chunks = c.execute(
            "SELECT ch.* FROM quant.tactic_report_chunks ch JOIN quant.tactic_reports "
            "r ON r.id=ch.report_id WHERE r.trade_date<%s",
            (day,),
        ).fetchall()
        prompt = c.execute(
            "SELECT * FROM quant.tactic_report_prompts WHERE tactic_id=%s "
            "ORDER BY version DESC LIMIT 1",
            (TACTIC_ID,),
        ).fetchone()
        knowledge = select_knowledge(reports, chunks, snapshot_row["data"]["current"], day)
        # enqueue under the same transaction to make auto-generation idempotent.
        active = c.execute(
            "SELECT id FROM quant.tactic_review_jobs WHERE kind='report' "
            "AND trade_date=%s AND status IN ('queued','running','waiting')",
            (day,),
        ).fetchone()
        if active:
            return active
        return c.execute(
            "INSERT INTO quant.tactic_review_jobs(id,kind,trade_date,actor,input) "
            "VALUES(%s,'report',%s,%s,%s) RETURNING id",
            (
                str(uuid4()),
                day,
                actor,
                Jsonb(
                    plain(
                        dict(
                            snapshot_id=snapshot_row["id"],
                            system_prompt=SYSTEM_PROMPT,
                            snapshot=snapshot_row["data"],
                            prompt=prompt,
                            knowledge=knowledge,
                        )
                    )
                ),
            ),
        ).fetchone()


def report_detail(report_id):
    with base.connection() as c:
        return c.execute("SELECT * FROM quant.tactic_reports WHERE id=%s", (report_id,)).fetchone()


def enable_knowledge(report_id, enabled, actor):
    with base.connection() as c:
        row = c.execute(
            "UPDATE quant.tactic_reports SET knowledge_enabled=%s,knowledge_updated_by=%s,"
            "knowledge_updated_at=now() WHERE id=%s RETURNING id,knowledge_enabled",
            (enabled, actor, report_id),
        ).fetchone()
        if not row:
            raise ValueError("日报不存在")
        return row


def publish_report(job, owner, content, model, usage, duration):
    data = job["input"]
    with base.connection() as c:
        fence(c, job["id"], owner)
        c.execute("SELECT id FROM quant.tactic_configs WHERE id=%s FOR UPDATE", (TACTIC_ID,))
        revision = c.execute(
            "SELECT coalesce(max(revision),0)+1 v FROM quant.tactic_reports WHERE trade_date=%s",
            (job["trade_date"],),
        ).fetchone()["v"]
        report_id = str(uuid4())
        c.execute(
            "INSERT INTO quant.tactic_reports(id,trade_date,revision,job_id,snapshot_id,"
            "prompt_version,model,response_model,effort,summary,content,input,usage,"
            "duration_seconds) "
            "VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)",
            (
                report_id,
                job["trade_date"],
                revision,
                job["id"],
                data["snapshot_id"],
                data["prompt"]["version"],
                "program" if model == "program" else "deepseek-flash",
                model,
                "none" if model == "program" else "max",
                content["summary"],
                Jsonb(content),
                Jsonb(data),
                Jsonb(usage),
                duration,
            ),
        )
        events = {r["event_id"]: r for r in data["snapshot"]["current"]}
        for section in content["sections"]:
            referenced = [events[e] for e in section["event_ids"] if e in events]
            c.execute(
                "INSERT INTO quant.tactic_report_chunks "
                "(id,report_id,title,content,event_ids,symbols,rule_tags,config_versions) "
                "VALUES(%s,%s,%s,%s,%s,%s,%s,%s)",
                (
                    str(uuid4()),
                    report_id,
                    section["title"],
                    section["content"],
                    Jsonb(section["event_ids"]),
                    Jsonb(sorted({r["symbol"] for r in referenced})),
                    Jsonb(section["rule_tags"]),
                    Jsonb(sorted({r["config_version"] for r in referenced})),
                ),
            )
        c.execute(
            "UPDATE quant.tactic_review_jobs SET status='completed',result=%s,"
            "lease_owner=NULL,lease_until=NULL,updated_at=now() WHERE id=%s",
            (Jsonb({"report_id": report_id}), job["id"]),
        )
        return report_id


def dashboard(day=None, start=None, end=None, origin="tracked", version=None, search=""):
    rows = all_performances()
    today = datetime.now(SHANGHAI_TZ).date().isoformat()
    calendar = [d["date"] for d in base.cached_calendar() if d["is_open"] and d["date"] <= today]
    day = day or max(
        (
            r.get("evaluated_as_of", r["trade_date"])
            for r in rows
            if r.get("evaluated_as_of", r["trade_date"]) <= today
        ),
        default=today,
    )
    start = start or (calendar[-60] if len(calendar) >= 60 else calendar[0] if calendar else day)
    end = end or day
    selected = [
        r
        for r in rows
        if start <= r["breakout_date"] <= end
        and (origin == "all" or r["origin"] == origin)
        and (version is None or r["config_version"] == version)
    ]
    with base.connection() as c:
        reports = c.execute(
            "SELECT id,trade_date,revision,summary,model,effort,prompt_version,"
            "knowledge_enabled,created_at FROM quant.tactic_reports "
            "WHERE summary ILIKE %s OR content::text ILIKE %s OR trade_date::text ILIKE %s "
            "ORDER BY trade_date DESC,revision DESC LIMIT 200",
            (f"%{search}%", f"%{search}%", f"%{search}%"),
        ).fetchall()
        jobs = c.execute(
            "SELECT id,kind,trade_date,status,result,error,attempts,created_at "
            "FROM quant.tactic_review_jobs ORDER BY created_at DESC LIMIT 20"
        ).fetchall()
    return dict(
        trade_date=day,
        start=start,
        end=end,
        rows=[r for r in rows if r["trade_date"] == day],
        statistics=statistics(selected),
        sample_count=len({r["event_id"] for r in selected}),
        versions=sorted({r["config_version"] for r in rows}, reverse=True),
        reports=reports,
        jobs=jobs,
        settings=settings(),
        prompts=prompt_history(),
    )
