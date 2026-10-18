"""One database-elected collector, independent of browser visibility."""

import asyncio
import logging
import os
import time
from datetime import datetime

from quantpilot_market_data.database_core import connect
from quantpilot_market_data.providers.dashboard import BACKGROUND_QUERY, SHANGHAI
from quantpilot_market_data.providers.market_layout import INDICES, MINUTES, cumulative

logger = logging.getLogger("uvicorn.error.dashboard_collector")
COLLECTOR_LOCK = 718422


def collection_due(
    now: datetime, dates: list[str], close_complete: str | None, *, probe_unknown=False
) -> bool:
    if now.date().isoformat() not in dates and not (
        probe_unknown and not dates and now.weekday() < 5
    ):
        return False
    clock = now.strftime("%H:%M")
    return (
        "09:30" <= clock <= "11:30"
        or "13:01" <= clock <= "15:00"
        or "15:05" <= clock < "18:00"
        and close_complete != now.date().isoformat()
    )


class DashboardCollector:
    def __init__(self, layout):
        self.layout = layout
        self.task = None

    def start(self):
        if os.getenv("QUANTPILOT_DASHBOARD_COLLECTOR_ENABLED", "true").lower() not in {
            "0",
            "false",
            "off",
        }:
            self.task = asyncio.create_task(self.run())

    async def close(self):
        if self.task:
            self.task.cancel()
            await asyncio.gather(self.task, return_exceptions=True)

    async def run(self):
        while True:
            try:
                async with asyncio.timeout(5):
                    connection = await connect()
                async with connection:
                    cursor = await connection.execute(
                        "SELECT pg_try_advisory_lock(%s)", (COLLECTOR_LOCK,)
                    )
                    leader = (await cursor.fetchone())[0]
                    await connection.commit()
                    if leader:
                        await self.collect(connection)
            except asyncio.CancelledError:
                raise
            except Exception as error:
                logger.warning("dashboard collector unavailable type=%s", type(error).__name__)
            await asyncio.sleep(60)

    async def collect(self, connection):
        startup, close_complete, next_attempt = True, None, 0.0
        while True:
            # Losing the database session releases the election lock. Stop collecting immediately.
            async with asyncio.timeout(5):
                await connection.execute("SELECT 1")
                await connection.commit()
            now = datetime.now(SHANGHAI)
            dates = await self.layout.trading_dates(now.date().isoformat())
            if time.monotonic() >= next_attempt and (
                startup or collection_due(now, dates, close_complete, probe_unknown=True)
            ):
                startup = False
                complete, failed = True, False
                token = BACKGROUND_QUERY.set(True)
                try:
                    for index in INDICES:
                        try:
                            async with asyncio.timeout(45):
                                data = await self.layout.session(index, force=True)
                            ready = data["tradeDate"] == now.date().isoformat() and not data.get(
                                "archiveStale"
                            )
                            ready = (
                                ready
                                and not data.get("archiveWarning")
                                and all(
                                    len(cumulative(data["days"][data["tradeDate"]], f))
                                    == len(MINUTES)
                                    for f in ("minuteAmount", "minuteVolume")
                                )
                            )
                            complete = complete and ready
                            failed = failed or bool(
                                data.get("archiveStale") or data.get("archiveWarning")
                            )
                            logger.info(
                                "dashboard collected index=%s trade_date=%s days=%s "
                                "complete=%s fetched_at=%s",
                                index,
                                data["tradeDate"],
                                len(data["days"]),
                                ready,
                                data.get("fetchedAt"),
                            )
                        except Exception as error:
                            complete, failed = False, True
                            logger.warning(
                                "dashboard collect index=%s type=%s", index, type(error).__name__
                            )
                finally:
                    BACKGROUND_QUERY.reset(token)
                after_close = now.strftime("%H:%M") >= "15:05"
                if complete and after_close:
                    close_complete = now.date().isoformat()
                # Calendar outages must not stop acquisition. These bounded probes use
                # actual response dates; they never synthesize a trading calendar.
                next_attempt = time.monotonic() + (
                    300 if failed or after_close or not dates else 60
                )
            await asyncio.sleep(10)
