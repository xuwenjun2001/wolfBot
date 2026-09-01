"""Fixed-clock coverage for Beijing-time session and trading-day resolution."""

from __future__ import annotations

from datetime import datetime

import pytest

from app.market_calendar import BJ, TradingCalendar


def _clock(value: str):
    moment = datetime.fromisoformat(value).replace(tzinfo=BJ)
    return lambda: moment


# 2026-09-01 is a Tuesday; 2026-08-31 is the Monday before it.
OBSERVED = ["2026-08-25", "2026-08-26", "2026-08-27", "2026-08-28", "2026-08-31"]


def _calendar(now: str, *, observed: list[str] | None = None, holidays: tuple[str, ...] = ()):
    values = OBSERVED if observed is None else observed
    return TradingCalendar(
        observed_trade_dates=lambda: list(values),
        holidays=holidays,
        clock=_clock(now),
    )


@pytest.mark.parametrize(
    "moment,phase",
    [
        ("2026-09-01T02:01:00", "pre_open"),
        ("2026-09-01T09:14:59", "pre_open"),
        ("2026-09-01T09:20:00", "opening_auction"),
        ("2026-09-01T10:00:00", "morning_session"),
        ("2026-09-01T12:00:00", "lunch_break"),
        ("2026-09-01T14:00:00", "afternoon_session"),
        ("2026-09-01T15:30:00", "post_close"),
    ],
)
def test_phase_boundaries(moment: str, phase: str) -> None:
    assert _calendar(moment).session().phase == phase


def test_pre_open_falls_back_to_the_latest_completed_trading_day() -> None:
    """The original failing question: asked at 02:01 before the session opens."""
    session = _calendar("2026-09-01T02:01:00").session()
    assert session.phase == "pre_open"
    assert session.calendar_date == "2026-09-01"
    assert session.requested_date == "2026-09-01"
    assert session.effective_trade_date == "2026-08-31"
    assert session.latest_completed_trade_date == "2026-08-31"
    assert session.fallback_reason == "current_session_has_no_market_data"
    assert session.intraday is False
    assert session.timezone == "Asia/Shanghai"
    assert session.observed_at.endswith("+08:00")


def test_intraday_uses_today_and_reports_that_values_still_change() -> None:
    session = _calendar("2026-09-01T10:00:00").session()
    assert session.effective_trade_date == "2026-09-01"
    assert session.fallback_reason is None
    assert session.intraday is True
    assert any("still open" in warning for warning in session.data_quality.warnings)


def test_post_close_uses_the_completed_current_session() -> None:
    session = _calendar("2026-09-01T15:30:00").session()
    assert session.effective_trade_date == "2026-09-01"
    assert session.latest_completed_trade_date == "2026-09-01"
    assert session.fallback_reason is None
    assert session.intraday is False


def test_weekend_never_reports_a_weekend_as_a_trading_day() -> None:
    # 2026-09-05 is a Saturday.
    session = _calendar("2026-09-05T11:00:00").session()
    assert session.phase == "non_trading_day"
    assert session.is_trading_day is False
    assert session.calendar_date == "2026-09-05"
    assert session.effective_trade_date == "2026-09-04"
    assert session.effective_trade_date != session.calendar_date
    assert session.fallback_reason == "current_session_has_no_market_data"


def test_injected_holiday_is_not_a_trading_day() -> None:
    session = _calendar("2026-10-01T10:00:00", holidays=("2026-10-01",)).session()
    assert session.phase == "non_trading_day"
    assert session.effective_trade_date == "2026-09-30"


def test_observed_history_marks_a_missing_weekday_as_closed() -> None:
    """A weekday absent from a populated history is a market closure."""
    calendar = _calendar(
        "2026-08-28T16:00:00",
        observed=["2026-08-24", "2026-08-25", "2026-08-28"],
    )
    session = calendar.session()
    assert session.calendar_basis == "observed_trade_dates"
    # 2026-08-27 and 2026-08-26 are weekdays inside the covered range but were
    # never observed, so the previous trading day is 2026-08-25.
    assert calendar.previous_trading_day(session_date(session)) == _date("2026-08-25")


def test_weekday_only_basis_is_reported_when_no_history_exists() -> None:
    session = TradingCalendar(clock=_clock("2026-09-01T02:01:00")).session()
    assert session.calendar_basis == "weekday_only"
    assert session.effective_trade_date == "2026-08-31"
    assert any("weekday rule" in warning for warning in session.data_quality.warnings)
    assert session.data_quality.status == "warning"


def test_explicit_historical_request_is_honoured() -> None:
    session = _calendar("2026-09-01T02:01:00").session(requested_date="2026-08-27")
    assert session.requested_date == "2026-08-27"
    assert session.effective_trade_date == "2026-08-27"
    assert session.fallback_reason is None


def test_requested_non_trading_date_falls_back_with_its_own_reason() -> None:
    session = _calendar("2026-09-01T02:01:00").session(requested_date="2026-08-30")
    assert session.fallback_reason == "requested_date_is_not_a_trading_day"
    assert session.effective_trade_date == "2026-08-28"


def test_as_dict_exposes_the_full_session_contract() -> None:
    payload = _calendar("2026-09-01T02:01:00").session().as_dict()
    for key in (
        "timezone", "observed_at", "calendar_date", "phase", "is_trading_day",
        "requested_date", "effective_trade_date", "latest_completed_trade_date",
        "next_trade_date", "fallback_reason", "intraday", "calendar_basis",
        "source", "fetched_at", "data_quality",
    ):
        assert key in payload
    assert payload["next_trade_date"] == "2026-09-01"


def test_naive_clock_is_rejected() -> None:
    calendar = TradingCalendar(clock=lambda: datetime(2026, 9, 1, 2, 1))
    with pytest.raises(ValueError):
        calendar.session()


def _date(value: str):
    from datetime import date

    return date.fromisoformat(value)


def session_date(session):
    return _date(session.calendar_date)
