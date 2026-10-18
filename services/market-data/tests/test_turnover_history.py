import asyncio
import copy
from datetime import datetime

import pytest

from quantpilot_market_data.providers.dashboard import SHANGHAI
from quantpilot_market_data.providers.market_layout import MINUTES, parse_session
from quantpilot_market_data.repositories.dashboard_sessions import merge_day, session_from_archive
from quantpilot_market_data.services.dashboard_collector import DashboardCollector, collection_due
from quantpilot_market_data.services.market_layout import MarketLayoutService
from quantpilot_market_data.services.turnover_comparison import metric_comparisons

DATES = ["2026-08-31", "2026-09-01", "2026-09-02", "2026-09-03", "2026-09-04", "2026-09-07"]


def sample():
    return parse_session(
        {
            "preClose": 100,
            "trends": [
                f"{date} {minute},100,101,102,99,{amount * 10},{amount},100.5"
                for date, amount in zip(DATES, [1, 2, 3, 4, 5, 100], strict=True)
                for minute in MINUTES[:3]
            ],
        },
        "sh",
    )


def test_ma5_uses_five_previous_sessions_at_same_time_excluding_today():
    metrics = metric_comparisons([sample()], DATES)
    amount = metrics["amount"]
    assert amount["sampleDates"] == DATES[:-1]
    assert amount["previousDate"] == "2026-09-04"  # Weekend skipped by real calendar.
    assert amount["sampleCount"] == 5
    assert amount["rows"][-1] == {
        "time": "09:32",
        "current": 300,
        "previous": 15,
        "ma5": 9,
        "previousDifference": 285,
        "previousChangePct": 1900,
        "ma5Difference": 291,
        "ma5ChangePct": pytest.approx(3233.333333),
    }
    assert metrics["volume"]["rows"][-1]["ma5"] == 90
    assert metrics["volume"]["unit"] == "手"


def test_missing_history_does_not_remove_current_or_yesterday_or_use_older_day():
    data = sample()
    data["days"]["2026-08-28"] = data["days"].pop(DATES[0])
    result = metric_comparisons([data], ["2026-08-28", *DATES])["amount"]
    assert len(result["rows"]) == 3
    assert result["rows"][-1]["previous"] == 15
    assert result["rows"][-1]["ma5"] is None
    assert result["sampleCount"] == 4
    assert "4/5" in result["ma5Status"]["reason"]


def test_volume_gap_is_independent_and_ma5_keeps_safe_prefix():
    data = sample()
    data["days"][DATES[1]]["09:31"]["minuteVolume"] = None
    result = metric_comparisons([data], DATES)
    assert result["amount"]["ma5Status"]["complete"]
    assert result["volume"]["ma5Status"]["cutoff"] == "09:30"
    assert result["volume"]["rows"][-1]["ma5"] is None
    assert result["volume"]["rows"][-1]["previous"] == 150


def test_missing_current_opening_and_zero_baseline():
    data = sample()
    data["days"][DATES[-1]]["09:30"]["minuteAmount"] = None
    for row in data["days"][DATES[-2]].values():
        row["minuteVolume"] = 0
    result = metric_comparisons([data], DATES)
    assert result["amount"]["rows"] == []
    assert result["volume"]["rows"][-1]["previousChangePct"] is None
    assert result["volume"]["rows"][-1]["previousDifference"] == 3000


def test_market_uses_common_current_cutoff_and_rejects_date_mismatch():
    a, b = sample(), sample()
    del b["days"][DATES[-1]]["09:32"]
    result = metric_comparisons([a, b], DATES)["amount"]
    assert result["currentCutoff"] == "09:31"
    assert result["rows"][-1]["current"] == 400
    assert result["rows"][-1]["ma5"] == 12
    b["tradeDate"] = DATES[-2]
    assert metric_comparisons([a, b], DATES)["amount"]["rows"] == []


def test_unknown_calendar_does_not_guess_yesterday():
    result = metric_comparisons([sample()], [])["amount"]
    assert result["rows"][-1]["current"] == 300
    assert result["previousDate"] is None
    assert result["previousStatus"]["reasonCode"] == "calendar_missing"


def test_lunch_does_not_create_a_gap():
    data = sample()
    for date in DATES:
        data["days"][date] = {t: {"time": t, "minuteAmount": 1, "minuteVolume": 2} for t in MINUTES}
    result = metric_comparisons([data], DATES)["amount"]
    assert result["rows"][-1]["current"] == 241
    assert result["ma5Status"]["cutoff"] == "15:00"


def test_merge_preserves_valid_fields_longer_sequences_and_newer_points():
    original = {
        "09:30": {
            "time": "09:30",
            "minuteAmount": 10,
            "minuteVolume": 2,
            "fetchedAt": "2026-09-07T10:00:00+00:00",
        },
        "09:31": {"time": "09:31", "minuteAmount": 20},
    }
    newer = {
        "09:30": {
            "time": "09:30",
            "minuteAmount": None,
            "minuteVolume": -1,
            "fetchedAt": "2026-09-07T10:01:00+00:00",
        }
    }
    merged = merge_day(original, newer)
    assert merged["09:30"]["minuteAmount"] == 10
    assert merged["09:30"]["minuteVolume"] == 2
    assert merged["09:31"]["minuteAmount"] == 20
    older = {"09:30": {"minuteAmount": 0, "fetchedAt": "2026-09-07T09:00:00+00:00"}}
    assert merge_day(merged, older) == merged
    assert original["09:30"]["fetchedAt"] != merged["09:30"]["fetchedAt"]


class Cache:
    def __init__(self):
        self.values = {}

    async def read(self, key):
        return copy.deepcopy(self.values.get(key))

    async def write(self, key, *, payload, ttl_seconds):
        self.values[key] = copy.deepcopy(payload)


class Archive:
    def __init__(self):
        self.values = {}

    async def read(self, index):
        return copy.deepcopy(self.values.get(index, {}))

    async def save(self, index, data, keep):
        days = self.values.setdefault(index, {})
        for date, rows in data["days"].items():
            if not keep or date in keep:
                days[date] = {
                    "minutes": merge_day(days.get(date, {}).get("minutes", {}), rows),
                    "fetchedAt": data["fetchedAt"],
                    "previousClose": 100,
                }
        if keep:
            self.values[index] = {d: p for d, p in days.items() if d >= min(keep)}
        return await self.read(index)


class Calendar:
    async def calendar(self, start, end):
        return DATES


def test_archive_survives_service_restart_and_current_only_fallback():
    async def run():
        archive = Archive()
        first = MarketLayoutService(None, Cache(), archive=archive, calendar=Calendar())

        async def full(index):
            return sample()

        first.provider.session = full
        await first.index_session("sh")
        await first.close()
        second = MarketLayoutService(None, Cache(), archive=archive, calendar=Calendar())

        async def current_only(index):
            data = sample()
            data["days"] = {DATES[-1]: data["days"][DATES[-1]]}
            data["fallback"] = True
            return data

        second.provider.session = current_only
        restored = await second.index_session("sh")
        assert restored["metrics"]["amount"]["sampleCount"] == 5
        assert restored["rows"][-1]["changePct"] == pytest.approx(1)
        stamp = restored["dataFetchedAt"]

        async def fail(index):
            raise TimeoutError()

        third = MarketLayoutService(None, Cache(), archive=archive, calendar=Calendar())
        third.provider.session = fail
        stale = await third.index_session("sh")
        assert stale["archiveStale"]
        assert stale["dataFetchedAt"] == stamp
        assert stale["metrics"]["amount"]["rows"][-1]["ma5"] == 9
        await second.close()
        await third.close()

    asyncio.run(run())


def test_database_failure_preserves_current_data_and_warns():
    class BrokenArchive:
        async def read(self, index):
            raise ConnectionError()

        async def save(self, *args):
            raise ConnectionError()

    async def run():
        service = MarketLayoutService(None, Cache(), archive=BrokenArchive(), calendar=Calendar())

        async def fetch(index):
            return sample()

        service.provider.session = fetch
        result = await service.index_session("sh")
        assert result["metrics"]["amount"]["rows"][-1]["current"] == 300
        assert "历史留存暂不可用" in result["dataWarning"]
        await service.close()

    asyncio.run(run())


@pytest.mark.parametrize(
    "clock,expected",
    [
        ("09:29", False),
        ("09:30", True),
        ("11:31", False),
        ("13:01", True),
        ("15:04", False),
        ("15:05", True),
        ("18:00", False),
    ],
)
def test_background_schedule(clock, expected):
    now = datetime.fromisoformat(f"2026-09-07T{clock}:00").replace(tzinfo=SHANGHAI)
    assert collection_due(now, DATES, None) == expected
    assert not collection_due(now, [], None)


def test_successful_close_stops_retries_and_shutdown_cancels_task():
    now = datetime(2026, 9, 7, 15, 10, tzinfo=SHANGHAI)
    assert not collection_due(now, DATES, "2026-09-07")

    async def run():
        collector = DashboardCollector(None)
        collector.task = asyncio.create_task(asyncio.Event().wait())
        await collector.close()
        assert collector.task.cancelled()

    asyncio.run(run())


def test_archive_restore_does_not_mutate_saved_payload():
    entries = {
        DATES[-1]: {
            "minutes": {"09:30": {"time": "09:30", "price": 101}},
            "previousClose": 100,
            "fetchedAt": "2026-09-07T07:00:00+00:00",
        }
    }
    original = copy.deepcopy(entries)
    assert session_from_archive("sh", entries)["rows"][0]["changePct"] == pytest.approx(1)
    assert entries == original


def test_retained_metric_field_keeps_its_original_timestamp():
    data = sample()
    old_stamp = "2026-09-07T07:00:00+00:00"
    new_stamp = "2026-09-07T07:01:00+00:00"
    old = {t: {**r, "fetchedAt": old_stamp} for t, r in data["days"][DATES[-1]].items()}
    # The newer response has prices and volume but cannot replace the valid old amounts.
    incoming = {t: {**r, "minuteAmount": None, "fetchedAt": new_stamp} for t, r in old.items()}
    data["days"][DATES[-1]] = merge_day(merge_day({}, old), incoming)
    data["fetchedAt"] = new_stamp
    metrics = metric_comparisons([data], DATES)
    assert metrics["amount"]["retained"]
    assert metrics["amount"]["fetchedAt"] == old_stamp
    assert not metrics["volume"]["retained"]
    assert metrics["volume"]["fetchedAt"] == new_stamp


def test_calendar_outage_allows_bounded_probes_without_guessing_comparison_dates():
    weekday = datetime(2026, 9, 7, 10, 0, tzinfo=SHANGHAI)
    weekend = datetime(2026, 9, 6, 10, 0, tzinfo=SHANGHAI)
    assert collection_due(weekday, [], None, probe_unknown=True)
    assert not collection_due(weekend, [], None, probe_unknown=True)
    assert not collection_due(weekday, ["2026-09-04"], None, probe_unknown=True)
    assert metric_comparisons([sample()], [])["amount"]["previousDate"] is None
