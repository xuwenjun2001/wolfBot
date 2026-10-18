"""Opt-in real SQL checks use a connection-local temporary table, never business rows."""

import asyncio
import os
import selectors
from urllib.parse import urlsplit

import pytest

from quantpilot_market_data.database_core import connect, database_url_from_env
from quantpilot_market_data.repositories import dashboard_sessions as archive_module
from quantpilot_market_data.services import dashboard_collector as collector_module

pytestmark = pytest.mark.skipif(
    os.getenv("QUANTPILOT_TEST_LOCAL_POSTGRES") != "1",
    reason="Set QUANTPILOT_TEST_LOCAL_POSTGRES=1 for isolated local SQL checks",
)


class CursorLease:
    def __init__(self, cursor):
        self.cursor = cursor

    async def __aenter__(self):
        await self.cursor.__aenter__()
        return self

    async def __aexit__(self, *args):
        return await self.cursor.__aexit__(*args)

    async def execute(self, sql, args=None):
        return await self.cursor.execute(
            sql.replace("quant.dashboard_index_sessions", "pg_temp.dashboard_index_sessions"), args
        )

    async def fetchone(self):
        return await self.cursor.fetchone()

    async def fetchall(self):
        return await self.cursor.fetchall()


class ConnectionLease:
    def __init__(self, connection):
        self.connection = connection

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        return False

    def cursor(self, **kwargs):
        return CursorLease(self.connection.cursor(**kwargs))


def test_sql_archive_roundtrip_merge_idempotency_and_retention(monkeypatch):
    async def run():
        assert urlsplit(database_url_from_env()).hostname in {"127.0.0.1", "localhost", "::1"}
        async with await connect() as connection:
            await connection.execute(
                "CREATE TEMP TABLE dashboard_index_sessions "
                "(LIKE quant.dashboard_index_sessions INCLUDING ALL)"
            )

            async def lease():
                return ConnectionLease(connection)

            monkeypatch.setattr(archive_module, "connect", lease)
            archive = archive_module.DashboardSessionArchive()
            dates = [
                "2026-08-28",
                "2026-08-31",
                "2026-09-01",
                "2026-09-02",
                "2026-09-03",
                "2026-09-04",
                "2026-09-07",
            ]
            session = {
                "tradeDate": dates[-1],
                "fetchedAt": "2026-09-07T07:01:00+00:00",
                "previousClose": 100,
                "tradingDates": dates,
                "days": {
                    d: {"09:30": {"time": "09:30", "minuteAmount": 10, "minuteVolume": 2}}
                    for d in dates
                },
            }
            await archive.save("sh", session, [])
            await archive.save("sh", session, [])
            cursor = await connection.execute(
                "SELECT count(*) FROM pg_temp.dashboard_index_sessions"
            )
            assert (await cursor.fetchone())[0] == 7
            current = {
                **session,
                "days": {
                    dates[-1]: {"09:31": {"time": "09:31", "minuteAmount": 20, "minuteVolume": 3}}
                },
            }
            await archive.save("sh", current, dates[-6:])
            # A new repository object reads the actual SQL archive, without process memory.
            restored = await archive_module.DashboardSessionArchive().read("sh")
            assert sorted(restored) == dates[-6:]
            assert set(restored[dates[-1]]["minutes"]) == {"09:30", "09:31"}
            assert restored[dates[-1]]["minutes"]["09:30"]["minuteAmount"] == 10
            assert restored[dates[-1]]["tradingDates"] == dates[-6:]
            await archive.save(
                "sh",
                {
                    **current,
                    "fetchedAt": "2026-09-07T06:00:00+00:00",
                    "days": {dates[-1]: {"09:31": {"time": "09:31", "minuteAmount": 1}}},
                },
                dates[-6:],
            )
            restored = await archive.read("sh")
            assert restored[dates[-1]]["minutes"]["09:31"]["minuteAmount"] == 20

    asyncio.run(run(), loop_factory=lambda: asyncio.SelectorEventLoop(selectors.SelectSelector()))


def test_collector_election_excludes_second_instance_and_releases_on_shutdown(monkeypatch):
    async def run():
        assert urlsplit(database_url_from_env()).hostname in {"127.0.0.1", "localhost", "::1"}
        # Use a test-only lock, isolated from the running application collector.
        monkeypatch.setattr(collector_module, "COLLECTOR_LOCK", 718499)
        entered = asyncio.Event()
        first = collector_module.DashboardCollector(None)

        async def hold(connection):
            entered.set()
            await asyncio.Event().wait()

        first.collect = hold
        first.task = asyncio.create_task(first.run())
        await asyncio.wait_for(entered.wait(), 5)
        async with await connect() as second:
            cursor = await second.execute("SELECT pg_try_advisory_lock(718499)")
            assert (await cursor.fetchone())[0] is False
            await first.close()
            cursor = await second.execute("SELECT pg_try_advisory_lock(718499)")
            assert (await cursor.fetchone())[0] is True

    asyncio.run(run(), loop_factory=lambda: asyncio.SelectorEventLoop(selectors.SelectSelector()))
