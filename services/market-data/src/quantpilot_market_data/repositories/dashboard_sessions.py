"""Durable, merge-only index sessions. No implicit DDL in request handlers."""

import copy
from datetime import UTC, datetime

from psycopg.rows import dict_row
from psycopg.types.json import Jsonb

from quantpilot_market_data.database_core import connect
from quantpilot_market_data.providers.market_layout import INDICES, MINUTES, cumulative


def merge_day(previous: dict, incoming: dict) -> dict:
    merged = copy.deepcopy(previous)
    for minute, row in incoming.items():
        if minute not in MINUTES:
            continue
        old = merged.get(minute, {})
        if old.get("fetchedAt", "") > row.get("fetchedAt", ""):
            continue
        clean = {k: v for k, v in row.items() if v is not None}
        for field in ("minuteAmount", "minuteVolume"):
            if clean.get(field, 0) < 0:
                clean.pop(field)
            elif field in clean and row.get("fetchedAt"):
                stamp_field = "amountFetchedAt" if field == "minuteAmount" else "volumeFetchedAt"
                clean[stamp_field] = row.get(stamp_field, row["fetchedAt"])
        merged[minute] = {**old, **clean}
    return merged


def session_from_archive(index: str, entries: dict) -> dict | None:
    if not entries:
        return None
    current = max(entries)
    latest = entries[current]
    rows = copy.deepcopy(list(sorted(latest["minutes"].values(), key=lambda r: r["time"])))
    preclose = latest.get("previousClose")
    for row in rows:
        for field, target in (("price", "changePct"), ("leading", "leadingPct")):
            row[target] = (
                (row[field] / preclose - 1) * 100
                if row.get(field) is not None and preclose
                else None
            )
    return {
        "days": {d: p["minutes"] for d, p in entries.items()},
        "rows": rows,
        "tradeDate": current,
        "name": INDICES[index][1],
        "previousClose": preclose,
        "fetchedAt": latest["fetchedAt"],
        "source": "东方财富",
        "archiveStale": True,
    }


class DashboardSessionArchive:
    async def read(self, index: str) -> dict:
        async with await connect() as connection, connection.cursor(row_factory=dict_row) as cursor:
            await cursor.execute(
                "SELECT trade_date, payload FROM quant.dashboard_index_sessions "
                "WHERE index_key = %s ORDER BY trade_date DESC LIMIT 6",
                (index,),
            )
            return {
                row["trade_date"].isoformat(): row["payload"] for row in await cursor.fetchall()
            }

    async def save(self, index: str, session: dict, keep_dates: list[str]) -> dict:
        stamp = session.get("fetchedAt") or datetime.now(UTC).isoformat()
        async with await connect() as connection, connection.cursor(row_factory=dict_row) as cursor:
            # Serialize read/merge/write across request and background processes.
            await cursor.execute(
                "SELECT pg_advisory_xact_lock(718421, %s)", (list(INDICES).index(index),)
            )
            for date, minutes in session["days"].items():
                if keep_dates and date not in keep_dates:
                    continue
                await cursor.execute(
                    "SELECT payload FROM quant.dashboard_index_sessions "
                    "WHERE index_key=%s AND trade_date=%s",
                    (index, date),
                )
                existing = await cursor.fetchone()
                payload = existing["payload"] if existing else {}
                incoming = {
                    t: {**r, "fetchedAt": r.get("fetchedAt", stamp)} for t, r in minutes.items()
                }
                merged = merge_day(payload.get("minutes", {}), incoming)
                fetched = max(r.get("fetchedAt", stamp) for r in merged.values())
                payload = {
                    **payload,
                    "minutes": merged,
                    "fetchedAt": fetched,
                    "source": "东方财富",
                    "amountUnit": "元",
                    "volumeUnit": "手",
                    "tradingDates": session.get("tradingDates", [])[-6:],
                    "complete": all(
                        len(cumulative(merged, f)) == len(MINUTES)
                        for f in ("minuteAmount", "minuteVolume")
                    ),
                }
                if date == session["tradeDate"] and session.get("previousClose") is not None:
                    payload["previousClose"] = session["previousClose"]
                await cursor.execute(
                    "INSERT INTO quant.dashboard_index_sessions "
                    "(index_key,trade_date,payload,fetched_at) "
                    "VALUES (%s,%s,%s,%s) ON CONFLICT (index_key,trade_date) DO UPDATE "
                    "SET payload=EXCLUDED.payload, fetched_at=EXCLUDED.fetched_at",
                    (index, date, Jsonb(payload), fetched),
                )
            if keep_dates:
                await cursor.execute(
                    "DELETE FROM quant.dashboard_index_sessions "
                    "WHERE index_key=%s AND trade_date < %s",
                    (index, min(keep_dates)),
                )
        return await self.read(index)
