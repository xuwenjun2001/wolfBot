"""Pure close-performance calculations; no trading or future-price inference."""

import hashlib
import json
import math
from datetime import datetime, time
from statistics import mean, median

from quantpilot_market_data.database_core import SHANGHAI_TZ
from quantpilot_market_data.tactics import (
    TacticParameters,
    indicators,
    signal,
    support_broken,
    trending,
)

RULE_TAGS = ("trend", "breakout", "contraction", "distance", "timing", "data_quality")


def digest(value):
    return hashlib.sha256(
        json.dumps(value, sort_keys=True, ensure_ascii=False, default=str).encode()
    ).hexdigest()


def valid_price(bar):
    try:
        o, h, low, c = (float(bar[k]) for k in ("open", "high", "low", "close"))
        return (
            all(math.isfinite(v) for v in (o, h, low, c))
            and 0 < low <= min(o, c) <= max(o, c) <= h
            and bar.get("trade_status") == "1"
            and float(bar.get("volume") or 0) > 0
        )
    except KeyError, TypeError, ValueError:
        return False


def performance(event, bars, sessions, as_of):
    breakout = str(event["breakout_date"])
    if breakout not in sessions or sessions.index(breakout) + 2 >= len(sessions):
        return []
    offset = sessions.index(breakout)
    days = sessions[offset + 1 : offset + 3]
    created = event.get("created_at")
    if isinstance(created, str):
        created = datetime.fromisoformat(created)
    cutoff = datetime.combine(datetime.fromisoformat(days[0]).date(), time(9, 30), SHANGHAI_TZ)
    origin = ("tracked" if created < cutoff else "retrospective") if created else "unknown"
    selected = [b for b in bars if str(b["date"]) <= as_of]
    dates = [str(b["date"]) for b in selected]
    ordered = dates == sorted(set(dates))
    rows = {str(b["date"]): b for b in selected}
    expected = {d for d in sessions if dates and min(dates) <= d <= max(dates)}
    history_valid = (
        ordered
        and expected.issubset(rows)
        and all(b.get("trade_status") == "0" or valid_price(b) for b in selected)
    )
    enriched = indicators(selected) if history_valid else {}
    base = rows.get(breakout)
    first_pullback = None
    invalidated = False
    invalid_tag = "trend_invalid"
    invalid_from = event.get("evidence", {}).get("invalidated_at")
    if not invalid_from and event.get("status") == "invalidated":
        invalid_from = event.get("last_evaluated")
    output = []
    for horizon, day in enumerate(days, 1):
        current = rows.get(day)
        r = dict(
            event_id=event["id"],
            symbol=event["symbol"],
            name=event["name"],
            breakout_date=breakout,
            trade_date=day,
            horizon=horizon,
            evaluated_as_of=as_of,
            origin=origin,
            config_version=event["config_version"],
            parameters=event["parameters"],
            status="pending",
            reason="尚未到观察日收盘",
            reference_price=None,
            original_reference_price=event["evidence"]["breakout"].get("close"),
            close=None,
            return_pct=None,
            high_pct=None,
            low_pct=None,
            signal="insufficient",
            first_pullback_date=first_pullback,
            source="baostock",
            adjustment="qfq",
            evidence={},
        )
        if day <= as_of:
            r.update(status="gap", reason="缺少同源有效行情")
            if current and current.get("trade_status") == "0":
                r.update(status="suspended", reason="观察日停牌")
            elif ordered and base and current and valid_price(base) and valid_price(current):
                price = float(base["close"])
                r.update(
                    status="ready",
                    reason="数据就绪",
                    reference_price=price,
                    close=float(current["close"]),
                    return_pct=round((float(current["close"]) / price - 1) * 100, 10),
                )
                b = enriched.get(day, {})
                if not b or not b.get("ma55"):
                    r["reason"] = "价格可评估，均线历史不完整"
                parameters = TacticParameters(**event["parameters"])
                if (
                    current.get("is_st")
                    or (b.get("ma55") and not trending(b))
                    or (invalid_from and str(invalid_from) <= day)
                ):
                    invalidated = True
                tag = (
                    invalid_tag
                    if invalidated
                    else signal(base, b, parameters)
                )
                if not invalidated and support_broken(b, parameters):
                    invalidated = True
                    tag = "support_broken"
                if current.get("is_st"):
                    tag = "is_st"
                elif invalid_from and str(invalid_from) <= day:
                    known = event.get("evidence", {}).get(
                        "invalidation_signal", event.get("signal")
                    )
                    if known in ("is_st", "delisted", "trend_invalid", "support_broken"):
                        tag = known
                if invalidated:
                    invalid_tag = tag
                if tag == "pullback" and first_pullback is None:
                    first_pullback = day
                r.update(
                    signal=tag,
                    first_pullback_date=first_pullback,
                    evidence={"current": b, "breakout": base},
                )
                window = [rows.get(d) for d in days[:horizon]]
                if all(b and valid_price(b) for b in window):
                    r.update(
                        high_pct=(max(float(b["high"]) for b in window) / price - 1) * 100,
                        low_pct=(min(float(b["low"]) for b in window) / price - 1) * 100,
                    )
        output.append(r)
    return output


def statistics(rows):
    result = []
    for horizon in (1, 2):
        selected = [r for r in rows if r["horizon"] == horizon]
        values = [r["return_pct"] for r in selected if r["status"] == "ready"]
        wins = [v for v in values if v > 0]
        losses = [v for v in values if v < 0]
        result.append(
            dict(
                horizon=horizon,
                total=len(selected),
                valid=len(values),
                wins=len(wins),
                losses=len(losses),
                flat=values.count(0),
                win_rate=100 * len(wins) / len(values) if values else None,
                mean=mean(values) if values else None,
                median=median(values) if values else None,
                mean_win=mean(wins) if wins else None,
                mean_loss=mean(losses) if losses else None,
                pending=sum(r["status"] == "pending" for r in selected),
                suspended=sum(r["status"] == "suspended" for r in selected),
                gaps=sum(r["status"] == "gap" for r in selected),
            )
        )
    return result


def post_pullback_performance(rows):
    """Evaluate only the price interval after the B+1 close signal is observable."""
    by_event = {}
    for row in rows:
        by_event.setdefault(row["event_id"], {})[row["horizon"]] = row
    result = []
    for event_id, horizons in by_event.items():
        first, second = horizons.get(1), horizons.get(2)
        if (
            first
            and second
            and first["status"] == second["status"] == "ready"
            and first["signal"] == "pullback"
        ):
            result.append(
                dict(
                    event_id=event_id,
                    config_version=first["config_version"],
                    origin=first["origin"],
                    return_pct=(
                        (1 + second["return_pct"] / 100) / (1 + first["return_pct"] / 100) - 1
                    )
                    * 100,
                )
            )
    return result


def select_knowledge(reports, chunks, current, target):
    """Deterministic retrieval with temporal cutoff and immutable citation excerpts."""
    cutoff = datetime.combine(datetime.fromisoformat(target).date(), time(15), SHANGHAI_TZ)
    latest = {}
    for report in sorted(reports, key=lambda r: r["revision"], reverse=True):
        created = report["created_at"]
        if isinstance(created, str):
            created = datetime.fromisoformat(created)
        day = str(report["trade_date"])
        if day < target and created <= cutoff:
            latest.setdefault(day, report)
    eligible = sorted(
        [r for r in latest.values() if r["knowledge_enabled"]],
        key=lambda r: str(r["trade_date"]),
        reverse=True,
    )
    recent = eligible[:5]
    refs = [
        dict(
            id=f"report:{r['id']}",
            report_id=r["id"],
            revision=r["revision"],
            trade_date=str(r["trade_date"]),
            content=r["summary"][:800],
            reason="近期摘要",
        )
        for r in recent
    ]
    older = {r["id"]: r for r in eligible[5:]}
    events = {r["event_id"] for r in current}
    symbols = {r["symbol"] for r in current}
    versions = {r["config_version"] for r in current}
    tags = {"breakout", "timing"}
    for r in current:
        tags.update(
            {
                "pullback": ["contraction", "distance"],
                "trend_invalid": ["trend"],
                "support_broken": ["distance", "timing"],
                "below_support": ["distance"],
                "outside_band": ["distance"],
                "not_contracted": ["contraction"],
                "insufficient": ["data_quality"],
            }.get(r.get("signal"), [])
        )
    ranked = []
    for chunk in chunks:
        report = older.get(chunk["report_id"])
        if not report:
            continue
        rank = (
            4
            if events.intersection(chunk["event_ids"])
            else 3
            if symbols.intersection(chunk["symbols"])
            else 2
            if versions.intersection(chunk["config_versions"])
            and tags.intersection(chunk["rule_tags"])
            else 1
            if tags.intersection(chunk["rule_tags"])
            else 0
        )
        if rank:
            ranked.append((rank, str(report["trade_date"]), chunk["id"], chunk, report))
    counts, seen = {}, set()
    for rank, day, _, chunk, report in sorted(ranked, key=lambda x: x[:3], reverse=True):
        if len(refs) - len(recent) >= 8:
            break
        content = chunk["content"][:1500]
        if content in seen or counts.get(report["id"], 0) >= 2:
            continue
        seen.add(content)
        counts[report["id"]] = counts.get(report["id"], 0) + 1
        refs.append(
            dict(
                id=f"chunk:{chunk['id']}",
                report_id=report["id"],
                revision=report["revision"],
                trade_date=day,
                content=content,
                reason={4: "同观察事件", 3: "同股票", 2: "同版本规则", 1: "相关规则"}[rank],
            )
        )
    return refs
