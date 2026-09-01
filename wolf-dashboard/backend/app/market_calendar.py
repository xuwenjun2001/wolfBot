"""Beijing-time market session and trading-day resolution.

"Today" is not the server date.  A board or quote question asked before the
open, during the lunch break, after the close, or on a non-trading day needs a
different effective trade date, and the answer has to say which one it used.
This module owns that decision so the router, the board service, and the agent
all read one explanation instead of each inventing a rule.

The clock is injectable so every phase can be covered by a fixed-clock test.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date, datetime, time, timedelta, timezone
from time import monotonic
from typing import Any, Callable, Iterable

from .market_data import DataQuality, utc_now


BJ = timezone(timedelta(hours=8), name="Asia/Shanghai")
TIMEZONE_NAME = "Asia/Shanghai"

PRE_OPEN = "pre_open"
OPENING_AUCTION = "opening_auction"
MORNING_SESSION = "morning_session"
LUNCH_BREAK = "lunch_break"
AFTERNOON_SESSION = "afternoon_session"
POST_CLOSE = "post_close"
NON_TRADING_DAY = "non_trading_day"

PHASES = (
    PRE_OPEN,
    OPENING_AUCTION,
    MORNING_SESSION,
    LUNCH_BREAK,
    AFTERNOON_SESSION,
    POST_CLOSE,
    NON_TRADING_DAY,
)

#: Phases in which the current calendar date has no usable market data yet.
_NO_SESSION_DATA_PHASES = frozenset({PRE_OPEN, OPENING_AUCTION, NON_TRADING_DAY})
#: Phases in which the current session is still producing changing values.
_INTRADAY_PHASES = frozenset({MORNING_SESSION, LUNCH_BREAK, AFTERNOON_SESSION})

OPENING_AUCTION_START = time(9, 15)
MORNING_OPEN = time(9, 30)
MORNING_CLOSE = time(11, 30)
AFTERNOON_OPEN = time(13, 0)
AFTERNOON_CLOSE = time(15, 0)

#: How far back the weekday fallback will walk when looking for a trading day.
_MAX_LOOKBACK_DAYS = 30

FALLBACK_NO_SESSION_DATA = "current_session_has_no_market_data"


def _as_date(value: Any) -> date | None:
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value
    text = str(value or "").strip()
    if not text:
        return None
    try:
        return date.fromisoformat(text[:10])
    except ValueError:
        return None


@dataclass(frozen=True)
class MarketSession:
    """One resolved market observation point and its effective trade date."""

    observed_at: str
    calendar_date: str
    phase: str
    is_trading_day: bool
    requested_date: str
    effective_trade_date: str | None
    latest_completed_trade_date: str | None
    next_trade_date: str | None
    fallback_reason: str | None
    intraday: bool
    calendar_basis: str
    timezone: str = TIMEZONE_NAME
    source: str = "local-calendar"
    fetched_at: str = ""
    data_quality: DataQuality = field(default_factory=DataQuality)

    def as_dict(self) -> dict[str, Any]:
        return {
            "timezone": self.timezone,
            "observed_at": self.observed_at,
            "calendar_date": self.calendar_date,
            "phase": self.phase,
            "is_trading_day": self.is_trading_day,
            "requested_date": self.requested_date,
            "effective_trade_date": self.effective_trade_date,
            "latest_completed_trade_date": self.latest_completed_trade_date,
            "next_trade_date": self.next_trade_date,
            "fallback_reason": self.fallback_reason,
            "intraday": self.intraday,
            "calendar_basis": self.calendar_basis,
            "session_windows": {
                "opening_auction": "09:15-09:30",
                "morning_session": "09:30-11:30",
                "lunch_break": "11:30-13:00",
                "afternoon_session": "13:00-15:00",
            },
            "source": self.source,
            "fetched_at": self.fetched_at,
            "data_quality": self.data_quality.as_dict(),
        }


class TradingCalendar:
    """Resolve Beijing-time trading days and intraday session phases.

    Trading days are decided by three inputs, in order of authority:

    1. ``observed_trade_dates`` -- dates the local database has actually seen.
       These are facts, so a date present here is a trading day and a weekday
       missing from a populated history is treated as a market holiday.
    2. ``holidays`` -- an explicitly supplied closure set.
    3. The weekday rule.

    When no observed dates are available the result is still returned, but
    ``calendar_basis`` reports ``weekday_only`` and a warning is attached.  The
    module never claims to hold an official exchange holiday calendar.
    """

    def __init__(
        self,
        *,
        observed_trade_dates: Callable[[], Iterable[str]] | None = None,
        holidays: Iterable[Any] = (),
        clock: Callable[[], datetime] | None = None,
        observed_cache_seconds: float = 5.0,
    ) -> None:
        self._observed_trade_dates = observed_trade_dates
        self._holidays = frozenset(
            parsed for parsed in (_as_date(item) for item in holidays) if parsed is not None
        )
        self._clock = clock or (lambda: datetime.now(BJ))
        self._observed_cache_seconds = max(0.0, float(observed_cache_seconds))
        self._observed_cache: tuple[frozenset[date], date | None] | None = None
        self._observed_cached_at: float = 0.0

    def now(self) -> datetime:
        value = self._clock()
        if value.tzinfo is None:
            raise ValueError("market clock must return an aware datetime")
        return value.astimezone(BJ)

    def _observed(self) -> tuple[frozenset[date], date | None]:
        # ``previous_trading_day`` walks up to a month backwards, so the
        # observed set is cached briefly instead of re-queried per step.
        if (
            self._observed_cache is not None
            and (monotonic() - self._observed_cached_at) <= self._observed_cache_seconds
        ):
            return self._observed_cache
        result: tuple[frozenset[date], date | None] = (frozenset(), None)
        if self._observed_trade_dates is not None:
            try:
                raw = list(self._observed_trade_dates())
            except Exception:
                # A degraded local database must not make the session
                # unreadable; the weekday fallback is reported through
                # ``calendar_basis``.
                raw = []
            parsed = {value for value in (_as_date(item) for item in raw) if value is not None}
            if parsed:
                result = (frozenset(parsed), max(parsed))
        self._observed_cache = result
        self._observed_cached_at = monotonic()
        return result

    def is_trading_day(self, day: date) -> bool:
        observed, latest = self._observed()
        if day in observed:
            return True
        if day in self._holidays:
            return False
        if day.weekday() >= 5:
            return False
        if latest is not None and day <= latest:
            # History covers this day and it is absent: a market closure.
            return False
        return True

    def previous_trading_day(self, day: date) -> date | None:
        cursor = day - timedelta(days=1)
        for _ in range(_MAX_LOOKBACK_DAYS):
            if self.is_trading_day(cursor):
                return cursor
            cursor -= timedelta(days=1)
        return None

    def next_trading_day(self, day: date) -> date | None:
        cursor = day + timedelta(days=1)
        for _ in range(_MAX_LOOKBACK_DAYS):
            if self.is_trading_day(cursor):
                return cursor
            cursor += timedelta(days=1)
        return None

    def next_open_trading_day(self, day: date, phase: str) -> date | None:
        """The next trading session that has not finished yet.

        Before the close on a trading day that session is still ahead, so the
        answer is ``day`` itself.  This is what "the next trading day" means to
        someone asking at 02:00, and it keeps the field from pointing past a
        session that has not happened.
        """

        if phase != NON_TRADING_DAY and phase != POST_CLOSE:
            return day
        return self.next_trading_day(day)

    def phase(self, moment: datetime) -> str:
        local = moment.astimezone(BJ)
        if not self.is_trading_day(local.date()):
            return NON_TRADING_DAY
        clock = local.time()
        if clock < OPENING_AUCTION_START:
            return PRE_OPEN
        if clock < MORNING_OPEN:
            return OPENING_AUCTION
        if clock < MORNING_CLOSE:
            return MORNING_SESSION
        if clock < AFTERNOON_OPEN:
            return LUNCH_BREAK
        if clock < AFTERNOON_CLOSE:
            return AFTERNOON_SESSION
        return POST_CLOSE

    def session(self, *, requested_date: str | None = None) -> MarketSession:
        moment = self.now()
        today = moment.date()
        phase = self.phase(moment)
        trading_today = phase != NON_TRADING_DAY
        observed, latest_observed = self._observed()
        basis = "observed_trade_dates" if observed else "weekday_only"

        # The last day whose session is finished and therefore fully readable.
        if trading_today and phase == POST_CLOSE:
            latest_completed = today
        else:
            latest_completed = self.previous_trading_day(today)

        requested = _as_date(requested_date) or today
        warnings: list[str] = []
        fallback_reason: str | None = None
        intraday = False

        if requested != today:
            # An explicit historical request is honoured as long as it is a
            # trading day; the caller is not asking about "today" at all.
            if self.is_trading_day(requested):
                effective: date | None = requested
            else:
                effective = self.previous_trading_day(requested)
                fallback_reason = "requested_date_is_not_a_trading_day"
                warnings.append("requested date is not a trading day")
        elif phase in _NO_SESSION_DATA_PHASES:
            effective = latest_completed
            fallback_reason = FALLBACK_NO_SESSION_DATA
            warnings.append(
                "the requested calendar date has no usable market data yet; "
                "the latest completed trading day is used instead"
            )
        elif phase in _INTRADAY_PHASES:
            effective = today
            intraday = True
            warnings.append("the current session is still open; values continue to change")
        else:
            effective = today

        if effective is None:
            warnings.append("no completed trading day could be resolved")
        if basis == "weekday_only":
            warnings.append(
                "trading days are derived from the weekday rule only; "
                "exchange holidays are not verified"
            )

        session_date = effective
        next_trade_date = self.next_open_trading_day(today, phase)
        return MarketSession(
            observed_at=moment.isoformat(timespec="seconds"),
            calendar_date=today.isoformat(),
            phase=phase,
            is_trading_day=trading_today,
            requested_date=requested.isoformat(),
            effective_trade_date=session_date.isoformat() if session_date else None,
            latest_completed_trade_date=latest_completed.isoformat() if latest_completed else None,
            next_trade_date=next_trade_date.isoformat() if next_trade_date else None,
            fallback_reason=fallback_reason,
            intraday=intraday,
            calendar_basis=basis,
            fetched_at=utc_now(),
            data_quality=DataQuality(
                status="warning" if warnings else "ok",
                missing_fields=() if session_date else ("effective_trade_date",),
                warnings=tuple(dict.fromkeys(warnings)),
            ),
        )


def calendar_from_store(store: Any, *, clock: Callable[[], datetime] | None = None) -> TradingCalendar:
    """Build a calendar whose trading days come from locally observed data."""

    def observed() -> list[str]:
        db = getattr(store, "db", None)
        if db is None:
            return []
        rows = db.query(
            """
            SELECT trade_date FROM (
              SELECT DISTINCT trade_date FROM market_daily_bars
              UNION
              SELECT DISTINCT trade_date FROM market_board_snapshots
            ) ORDER BY trade_date DESC LIMIT 800
            """
        )
        return [str(row["trade_date"]) for row in rows]

    return TradingCalendar(observed_trade_dates=observed, clock=clock)


__all__ = [
    "BJ",
    "FALLBACK_NO_SESSION_DATA",
    "PHASES",
    "TIMEZONE_NAME",
    "MarketSession",
    "TradingCalendar",
    "calendar_from_store",
]
