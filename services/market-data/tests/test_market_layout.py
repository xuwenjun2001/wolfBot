import asyncio
import copy
from datetime import UTC, datetime, timedelta

import httpx
import pytest
from fastapi import HTTPException

from quantpilot_market_data.providers.dashboard import DashboardUpstreamError
from quantpilot_market_data.providers.market_layout import (
    INDICES,
    MINUTES,
    MarketLayoutProvider,
    compare_amounts,
    parse_session,
)
from quantpilot_market_data.routers.market_dashboard import validate_params
from quantpilot_market_data.services.market_layout import MarketLayoutService, envelope


def session(current=20, previous=10, days=("2026-09-03", "2026-09-04")):
    return parse_session(
        {
            "preClose": 100,
            "trends": [
                f"{date} {minute},100,101,102,99,10,{amount},100.5"
                for date, amount in zip(days, (previous, current), strict=True)
                for minute in MINUTES[:4]
            ],
        },
        "sh",
    )


def test_turnover_cumulative_alignment_and_units():
    comparison = compare_amounts([session(), session(30, 10)])
    assert comparison["complete"]
    assert comparison["rows"][-1] == {
        "time": "09:33",
        "current": 200,
        "previous": 80,
        "difference": 120,
        "changePct": 150,
    }
    assert comparison["previousDate"] == "2026-09-03"


@pytest.mark.parametrize("missing", ["09:30", "09:32"])
def test_missing_minute_never_becomes_zero(missing):
    data = session()
    del data["days"]["2026-09-04"][missing]
    comparison = compare_amounts([data])
    assert not comparison["complete"]
    assert all(row["time"] < missing for row in comparison["rows"])


def test_zero_denominator_and_missing_day():
    assert compare_amounts([session(previous=0)])["rows"][0]["changePct"] is None
    data = session()
    del data["days"]["2026-09-03"]
    assert compare_amounts([data])["rows"] == []
    assert compare_amounts([data])["currentTotal"] == 80
    assert len(data["rows"]) == 4


def test_market_dates_must_match():
    assert not compare_amounts([session(), session(days=("2026-09-02", "2026-09-03"))])["complete"]


def test_source_leading_and_previous_close_are_not_invented():
    data = parse_session({"preClose": 0, "trends": ["2026-09-04 09:30,1,101,1,1,1,20,-"]}, "sh")
    assert data["rows"][0]["leading"] is None
    assert data["rows"][0]["changePct"] is None
    assert session()["rows"][0]["leading"] == 100.5


def test_star_market_index_uses_kechuang50_and_board_scope():
    assert INDICES["kc"][:2] == ("1.000688", "科创50")
    assert INDICES["kc"][2:] == ("m:1+t:23", "科创板全体")
    assert validate_params("index-session", [("index", "kc")]) == {"index": "kc"}


class MemoryCache:
    def __init__(self):
        self.values = {}

    async def read(self, key):
        return copy.deepcopy(self.values.get(key))

    async def write(self, key, *, payload, ttl_seconds):
        self.values[key] = copy.deepcopy(payload)


def test_shared_session_prevents_duplicate_fetch_and_excludes_chinext():
    class Calendar:
        async def calendar(self, start, end):
            return ["2026-09-03", "2026-09-04"]

    async def run():
        service = MarketLayoutService(None, MemoryCache(), calendar=Calendar())
        calls = []

        async def fetch(index):
            calls.append(index)
            await asyncio.sleep(0.01)
            return session()

        service.provider.session = fetch
        index, total = await asyncio.gather(service.index_session("sh"), service.turnover())
        assert sorted(calls) == ["sh", "sz"]
        assert total["rows"][-1]["current"] == 160
        assert index["comparison"]["complete"]
        await service.close()

    asyncio.run(run())


def test_breadth_returns_pending_coalesces_and_cleans_up():
    async def run():
        service = MarketLayoutService(None, MemoryCache())
        gate = asyncio.Event()
        calls = []

        async def fetch(index):
            calls.append(index)
            await gate.wait()
            return {
                "rows": [{"up": 1}],
                "source": "fixture",
                "tradeDate": "2026-09-04",
                "note": "",
                "complete": True,
                "refreshing": False,
            }

        service.provider.breadth = fetch
        responses = await asyncio.gather(*(service.breadth("sh") for _ in range(8)))
        assert all(r["status"] == "pending" and r["rows"] == [] for r in responses)
        await asyncio.sleep(0)
        assert calls == ["sh"]
        gate.set()
        await service._tasks["sh"]
        assert (await service.breadth("sh"))["complete"]
        gate.clear()
        await service.breadth("sz")
        await asyncio.sleep(0)
        await service.close()
        assert all(task.done() for task in service._tasks.values())

    asyncio.run(run())


def test_breadth_failure_preserves_original_timestamp_and_backs_off():
    async def run():
        service = MarketLayoutService(None, MemoryCache())
        old = envelope(
            {
                "rows": [{"up": 1}],
                "source": "fixture",
                "tradeDate": "2026-09-04",
                "note": "",
                "complete": True,
            }
        )
        old["fetchedAt"] = (datetime.now(UTC) - timedelta(seconds=400)).isoformat()
        service._breadth["sh"] = old
        calls = 0

        async def fail(index):
            nonlocal calls
            calls += 1
            raise TimeoutError()

        service.provider.breadth = fail
        assert (await service.breadth("sh"))["refreshing"]
        await service._tasks["sh"]
        response = await service.breadth("sh")
        assert response["status"] == "stale"
        assert response["fetchedAt"] == old["fetchedAt"]
        assert calls == 1
        await service.close()

    asyncio.run(run())


class Pages:
    def __init__(self, pages):
        self.pages = iter(pages)

    async def _json(self, *args):
        return {"data": next(self.pages)}


def quote(code, pct, stamp=1788508800):
    return {"f12": code, "f3": pct, "f124": stamp}


def test_breadth_deduplicates_and_classifies_missing():
    async def run():
        a = quote("600001", 1)
        provider = MarketLayoutProvider(
            Pages(
                [
                    {"total": 4, "diff": [a, quote("600002", -1)]},
                    {"total": 4, "diff": [a, quote("600003", 0), quote("600004", "-")]},
                ]
            )
        )
        data = await provider.breadth("sh")
        assert data["rows"][0] == {
            "up": 1,
            "down": 1,
            "flat": 1,
            "missing": 1,
            "total": 4,
            "name": "沪市A股",
        }

    asyncio.run(run())


@pytest.mark.parametrize(
    "pages",
    [
        [{"total": 2, "diff": [quote("600001", 1)]}, {"total": 2, "diff": []}],
        [{"total": 2, "diff": [quote("600001", 1), quote("600002", -1, 1788422400)]}],
        [{"total": 2, "diff": [quote("600001", 1)]}, {"total": 3, "diff": [quote("600002", -1)]}],
    ],
)
def test_breadth_rejects_incomplete_or_mixed_date_snapshots(pages):
    async def run():
        with pytest.raises(DashboardUpstreamError):
            await MarketLayoutProvider(Pages(pages)).breadth("sh")

    asyncio.run(run())


@pytest.mark.parametrize(
    "resource,params",
    [
        ("index-session", []),
        ("index-breadth", [("index", "000001")]),
        ("index-session", [("index", "sh"), ("index", "sz")]),
        ("market-turnover", [("url", "http://localhost")]),
    ],
)
def test_layout_rejects_unknown_parameters(resource, params):
    with pytest.raises(HTTPException):
        validate_params(resource, params)


def test_current_day_fallback_keeps_index_without_faking_previous_day():
    class Fallback:
        async def _json(self, url, params):
            if "push2his" in url:
                raise httpx.RemoteProtocolError("closed")
            assert "push2delay.eastmoney.com" in url
            return {
                "data": {"preClose": 100, "trends": ["2026-09-04 09:30,100,101,102,99,1,20,100.5"]}
            }

    async def run():
        data = await MarketLayoutProvider(Fallback()).session("sh")
        assert data["fallback"] and data["rows"][0]["price"] == 101
        assert not compare_amounts([data])["complete"]
        assert compare_amounts([data])["previousDate"] is None

    asyncio.run(run())


def test_breadth_serializes_scans_across_scopes():
    async def run():
        service = MarketLayoutService(None, MemoryCache())
        gate = asyncio.Event()
        calls = []

        async def fetch(index):
            calls.append(index)
            await gate.wait()
            raise TimeoutError()

        service.provider.breadth = fetch
        await asyncio.gather(
            service.breadth("sh"),
            service.breadth("sz"),
            service.breadth("cy"),
            service.breadth("kc"),
        )
        await asyncio.sleep(0)
        assert calls == ["sh"]
        gate.set()
        await asyncio.gather(*service._tasks.values())
        assert calls == ["sh", "sz", "cy", "kc"]
        assert all(
            entry["status"] == "unavailable" and not entry["rows"]
            for entry in service._breadth.values()
        )
        await service.close()

    asyncio.run(run())


def test_breadth_deadline_cancels_scan_without_partial_publication(monkeypatch):
    monkeypatch.setattr(
        "quantpilot_market_data.services.market_layout.BREADTH_TIMEOUT_SECONDS", 0.02
    )

    async def run():
        service = MarketLayoutService(None, MemoryCache())
        cancelled = asyncio.Event()

        async def fetch(index):
            try:
                await asyncio.Event().wait()
            finally:
                cancelled.set()

        service.provider.breadth = fetch
        await service.breadth("sh")
        await service._tasks["sh"]
        assert cancelled.is_set()
        response = await service.breadth("sh")
        assert response["status"] == "unavailable" and response["rows"] == []
        await service.close()

    asyncio.run(run())
