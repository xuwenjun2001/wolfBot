"""After-close scheduling and performance catch-up, independent from eligibility."""

import logging
from datetime import datetime, time, timedelta

import httpx

from quantpilot_market_data.database_core import SHANGHAI_TZ
from quantpilot_market_data.repositories import tactic_reviews as repo
from quantpilot_market_data.repositories import tactics as base
from quantpilot_market_data.services import tactic_reports
from quantpilot_market_data.tactic_reviews import performance
from quantpilot_market_data.tactics import resolve_trade_date, scan_date_cutoff

log = logging.getLogger(__name__)


def closed_day(day=None):
    now = datetime.now(SHANGHAI_TZ)
    target = datetime.fromisoformat(day).date() if day else scan_date_cutoff(now)
    return resolve_trade_date(target, base.cached_calendar(), now).isoformat()


def submit(day, actor):
    return repo.enqueue("review", closed_day(day), actor)


def schedule():
    config = repo.settings()
    if not config or not config["enabled"]:
        return
    now = datetime.now(SHANGHAI_TZ)
    if now.time() < time.fromisoformat(config["start_time"]):
        return
    try:
        day = closed_day()
    except ValueError:
        # The ordinary scanner is also responsible for cold calendar initialization.
        base.enqueue(scan_date_cutoff(now), "scheduled-review")
        return
    with base.connection() as c:
        scan = c.execute(
            "SELECT * FROM quant.tactic_runs WHERE status='completed' AND trade_date=%s "
            "ORDER BY completed_at DESC LIMIT 1",
            (day,),
        ).fetchone()
        last = c.execute(
            "SELECT * FROM quant.tactic_review_jobs WHERE kind='review' AND trade_date=%s "
            "ORDER BY created_at DESC LIMIT 1",
            (day,),
        ).fetchone()
        active_scan = c.execute(
            "SELECT id FROM quant.tactic_runs WHERE status IN "
            "('queued','running','waiting') LIMIT 1"
        ).fetchone()
        failed_scan = c.execute(
            "SELECT id FROM quant.tactic_runs WHERE requested_date=%s AND status='failed' LIMIT 1",
            (day,),
        ).fetchone()
    if not scan:
        if not active_scan and not failed_scan:
            base.enqueue(datetime.fromisoformat(day).date(), "scheduled-review")
        return
    if not last or (
        last["status"] in ("completed", "failed") and scan["completed_at"] > last["updated_at"]
    ):
        repo.enqueue("review", day, "scheduled-review")


def execute(job, owner, source):
    day = str(job["trade_date"])
    now = datetime.now(SHANGHAI_TZ)
    can_retry = now.date().isoformat() == day and now.time() < time(22)
    try:
        if job["kind"] == "report":
            tactic_reports.generate(job, owner, source.interrupted)
            return
        sessions = [r["date"] for r in base.cached_calendar() if r["is_open"]]
        inputs = repo.event_inputs()
        previous = {}
        for row in repo.all_performances():
            previous.setdefault(row["event_id"], []).append(row)
        gathered, rows, problems = {}, [], []
        for event in inputs:
            if source.interrupted():
                raise InterruptedError("执行器停止")
            repo.heartbeat(job["id"], owner)
            breakout = str(event["breakout_date"])
            if breakout > day:
                continue
            settled = previous.get(event["id"], [])
            if (
                str(event["expires_date"]) < day
                and len(settled) == 2
                and all(r["status"] in ("ready", "suspended") for r in settled)
            ):
                rows.extend(settled)
                continue
            target = min(day, str(event["expires_date"]))
            cache_key = (event["symbol"], target)
            bars = event.get("cached_bars") or []
            dates = {str(b["date"]) for b in bars}
            required = {d for d in sessions if breakout <= d <= target}
            if not required.issubset(dates):
                if cache_key not in gathered:
                    try:
                        gathered[cache_key] = source.request(
                            "bars",
                            symbol=event["symbol"],
                            end=target,
                            start=(
                                datetime.fromisoformat(breakout).date() - timedelta(days=370)
                            ).isoformat(),
                        )
                    except Exception:
                        gathered[cache_key] = []
                        problems.append(event["symbol"])
                bars = gathered[cache_key]
            # Use a whole source window; never splice separately adjusted prices.
            evaluated = performance(event, bars, sessions, day)
            if not evaluated:
                raise ValueError("交易日历未覆盖观察事件的完整窗口")
            rows.extend(evaluated)
            repo.save_performances(job["id"], owner, evaluated)
        gaps = sum(r["status"] == "gap" and r["trade_date"] <= day for r in rows)
        with base.connection() as c:
            scan = c.execute(
                "SELECT id,ready,gaps,total,excluded FROM quant.tactic_runs "
                "WHERE status='completed' AND trade_date=%s "
                "ORDER BY completed_at DESC LIMIT 1",
                (day,),
            ).fetchone()
        snap = repo.snapshot(
            job["id"], owner, day, dict(scan=repo.plain(scan), gaps=gaps, fetch_failures=problems)
        )
        if gaps and can_retry:
            repo.finish(
                job["id"], owner, {"snapshot_id": snap["id"]}, "部分行情缺失，等待补齐", True
            )
        else:
            repo.prepare_report(snap, job["actor"])
            repo.finish(job["id"], owner, {"snapshot_id": snap["id"], "gaps": gaps})
    except base.LeaseLost:
        log.info("Review job lease lost: %s", job["id"])
    except Exception as error:
        # Do not expose provider response bodies, URLs with credentials or source exceptions.
        status_error = (
            str(error)
            if isinstance(error, ValueError)
            and str(error).startswith(("DeepSeek HTTP", "日报", "未配置", "交易日历"))
            else type(error).__name__
        )
        retryable = isinstance(error, (httpx.TransportError, TimeoutError, InterruptedError)) or (
            status_error.startswith("DeepSeek HTTP")
            and status_error.split()[-1] in ("408", "429", "500", "502", "503", "504")
        )
        retry = (job["attempts"] < 3 and retryable) if job["kind"] == "report" else can_retry
        repo.finish(job["id"], owner, error=status_error, retry=retry)
