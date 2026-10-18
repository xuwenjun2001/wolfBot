"""Durable tactic orchestration. Every market request is bounded and checkpointed."""

from __future__ import annotations

import logging
import time
from collections import defaultdict
from datetime import UTC, date, datetime, timedelta
from datetime import time as clock_time

from quantpilot_market_data.database_core import SHANGHAI_TZ
from quantpilot_market_data.providers.tactics_source import TacticsSource
from quantpilot_market_data.repositories import tactics as repo
from quantpilot_market_data.services import tactic_incremental as incremental
from quantpilot_market_data.tactics import (
    evaluate,
    master_members,
    resolve_trade_date,
    scan_date_cutoff,
)

log = logging.getLogger(__name__)


def submit(actor: str):
    now = datetime.now(SHANGHAI_TZ)
    # Before close (including after midnight), allow the previous completed session.
    # Freeze this cutoff now so a queued job cannot switch dates after 15:00.
    return repo.enqueue(scan_date_cutoff(now), actor)


def fetch(source: TacticsSource, run_id: str, owner: str, kind: str, *, metrics=None, **kwargs):
    for attempt in range(3):
        repo.heartbeat(run_id, owner)
        try:
            began = time.perf_counter()
            if metrics is not None:
                metrics["requests"] += 1
            try:
                result = source.request(kind, **kwargs)
                if metrics is not None:
                    metrics["rows"] += len(result)
                return result
            finally:
                if metrics is not None:
                    metrics["fetch_seconds"] += time.perf_counter() - began
        except InterruptedError:
            raise
        except Exception:
            if attempt == 2:
                raise
            source.close()
            began = time.perf_counter()
            time.sleep(2**attempt)
            if metrics is not None:
                metrics["wait_seconds"] += time.perf_counter() - began


def execute(run: dict, owner: str, source: TacticsSource):
    run_id = run["id"]
    context = run["context"]
    requested = run["requested_date"]
    try:
        if not context.get("sessions"):
            repo.checkpoint(run_id, owner, phase="calendar", context=context)
            calendar = fetch(
                source,
                run_id,
                owner,
                "calendar",
                start=(requested - timedelta(days=370)).isoformat(),
                end=(max(requested, date.today()) + timedelta(days=40)).isoformat(),
            )
            target = resolve_trade_date(requested, calendar, datetime.now(UTC)).isoformat()
            repo.save_calendar(calendar, run_id, owner)
            context.update(sessions=[d["date"] for d in calendar if d["is_open"]], target=target)
            repo.checkpoint(run_id, owner, phase="members", context=context, trade_date=target)
        target = context["target"]
        sessions = context["sessions"]
        if not context.get("members"):
            members = master_members(fetch(source, run_id, owner, "master"))
            repo.save_master(members, run_id, owner)
            context["members"] = members
            repo.checkpoint(
                run_id, owner, phase="data", context=context, trade_date=target, total=len(members)
            )
        members = context["members"]
        if not context.get("daily_states"):
            states = fetch(source, run_id, owner, "daily_members", end=target)
            if not states:
                raise ValueError("目标日证券交易状态尚未就绪")
            context["daily_states"] = {
                f"{r['code'].split('.')[1]}.{r['code'].split('.')[0].upper()}": r.get("tradeStatus")
                for r in states
                if "." in r.get("code", "")
            }
        repo.checkpoint(
            run_id, owner, phase="data", context=context, trade_date=target, total=len(members)
        )
        repo.restore_prepared_items(run_id, owner, target, members)
        prepared = repo.prepared_items(run_id)
        for member in members:
            if source.interrupted():
                raise InterruptedError("执行器停止，保留断点")
            symbol = member["symbol"]
            if prepared.get(symbol, {}).get("status") in {"ready", "excluded"}:
                continue
            repo.heartbeat(run_id, owner)
            metrics = incremental.diagnostics()
            began = time.perf_counter()
            bars = []
            try:
                read_start = time.perf_counter()
                window = repo.window_for_incremental(symbol)
                metrics["cache_seconds"] = time.perf_counter() - read_start
                bars, state, reason = incremental.prepare(
                    window,
                    member,
                    target,
                    sessions,
                    context["daily_states"].get(symbol),
                    lambda start, metrics=metrics, symbol=symbol: fetch(
                        source,
                        run_id,
                        owner,
                        "bars",
                        metrics=metrics,
                        symbol=symbol,
                        start=start,
                        end=target,
                    ),
                    metrics,
                )
                if (
                    state != "gap"
                    and metrics["mode"] != "cached"
                    and bars
                    and bars[-1]["date"] == target
                ):
                    write_start = time.perf_counter()
                    repo.persist_bars(run_id, owner, symbol, bars)
                    metrics["persist_seconds"] += time.perf_counter() - write_start
            except repo.LeaseLost, InterruptedError:
                raise
            except Exception as error:
                state, reason, bars = "gap", str(error)[:1000], []
            if metrics["requests"]:
                pause = time.perf_counter()
                time.sleep(0.3)
                metrics["wait_seconds"] += time.perf_counter() - pause
            metrics["prepare_seconds"] = time.perf_counter() - began
            previous = prepared.get(symbol, {}).get("acquisition") or {}
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
                metrics[key] += previous.get(key, 0)
            repo.save_item(run_id, owner, member, state, reason, bars, target, metrics)
        items = repo.prepared_items(run_id)
        repo.checkpoint(
            run_id, owner, phase="screening", context=context, trade_date=target, total=len(members)
        )
        existing = repo.existing_events()
        by_symbol = defaultdict(list)
        for e in existing:
            # SQL dates become explicit ISO dates before pure evaluation.
            for key in ("breakout_date", "expires_date", "last_evaluated"):
                e[key] = str(e[key])
            by_symbol[e["symbol"]].append(e)
        events = []
        for index, member in enumerate(members):
            if index % 25 == 0:
                repo.heartbeat(run_id, owner)
            item = items[member["symbol"]]
            if item["status"] == "gap":
                # Preserve prior evidence; missing data must not create or refresh a signal.
                continue
            events.extend(
                evaluate(
                    member["symbol"],
                    member["name"],
                    item["bars"],
                    sessions,
                    target,
                    run["parameters"],
                    run["config_version"],
                    by_symbol[member["symbol"]],
                    context["daily_states"].get(member["symbol"]),
                )
            )
        # A disappeared member can never remain an active tradable candidate.
        symbols = {m["symbol"] for m in members}
        for e in existing:
            if e["symbol"] not in symbols and e["expires_date"] >= target:
                e.update(status="invalidated", signal="delisted", last_evaluated=target)
                e["evaluations"] = [
                    {
                        "date": target,
                        "status": "invalidated",
                        "signal": "delisted",
                        "evidence": e["evidence"],
                    }
                ]
                events.append(e)
        repo.heartbeat(run_id, owner)
        repo.publish(
            run_id,
            owner,
            events,
            {
                "evaluated_events": len(events),
                "new_breakouts": sum(e["breakout_date"] == target for e in events),
                "pullbacks": sum(
                    e["signal"] == "pullback" and e["last_evaluated"] == target for e in events
                ),
                "expired": sum(e["status"] == "expired" for e in events),
            },
        )
    except InterruptedError:
        repo.release(run_id, owner)
    except repo.LeaseLost:
        log.info("Tactic run lease lost: %s", run_id)
    except Exception as error:
        log.exception("Tactic run failed: %s", run_id)
        now = datetime.now(SHANGHAI_TZ)
        wait = now.date() == requested and now.time() < clock_time(22)
        repo.finish_problem(run_id, owner, str(error), wait)
