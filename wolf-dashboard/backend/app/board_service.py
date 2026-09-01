"""Board research orchestration: routing, caching, breadth, and coverage.

This layer sits between the fixed FastAPI routes and the upstream provider.  It
owns four decisions the router and the agent must not each re-invent:

* which trade date a board question is actually about (delegated to
  :mod:`.market_calendar`),
* when a cached catalog, membership, or snapshot is still fresh enough,
* how market breadth is derived when the provider does not publish it, and
* what counts as insufficient constituent coverage.

Every returned payload carries ``source``, ``as_of``/``snapshot_at``,
``fetched_at``, ``data_quality``, ``coverage`` and ``warnings`` so an answer can
never quote a number without its basis.
"""

from __future__ import annotations

import time
from dataclasses import dataclass, replace
from typing import Any, Callable, Iterable

from .board_store import BoardStore
from .market_boards import (
    BOARD_TYPES,
    Board,
    BoardAmbiguityError,
    BoardBreadth,
    BoardMember,
    BoardNoSessionDataError,
    BoardNotFoundError,
    BoardRateLimitedError,
    BoardResolution,
    BoardSnapshot,
    BoardUpstreamUnavailableError,
    compute_breadth,
    normalize_board_name,
)
from .market_calendar import MarketSession, TradingCalendar
from .market_data import DataQuality, utc_now


#: Board kinds that have their own upstream catalog.  "theme" is a user-facing
#: synonym for a concept board and is deliberately not stored separately.
CATALOG_TYPES = ("industry", "concept", "region")

DEFAULT_CATALOG_TTL_SECONDS = 24 * 3600
DEFAULT_MEMBERSHIP_TTL_SECONDS = 12 * 3600
DEFAULT_INTRADAY_SNAPSHOT_TTL_SECONDS = 60
#: Below this share of constituents the breadth numbers stop describing the
#: board, and the agent is told to treat the evidence as insufficient.
MIN_COVERAGE_PCT = 60.0

MEMBER_SORT_FIELDS = ("change_pct", "amount", "turnover", "close")


def normalize_board_type(value: str | None) -> str | None:
    if value is None:
        return None
    text = str(value).strip().lower()
    if text == "theme":
        return "concept"
    if text in CATALOG_TYPES:
        return text
    if text in BOARD_TYPES:
        return text
    raise ValueError(f"unsupported board_type: {value}")


@dataclass
class _MemberCacheEntry:
    members: tuple[BoardMember, ...]
    trade_date: str
    fetched_monotonic: float


class BoardService:
    """Resolve boards and read their quotes, breadth, and constituents."""

    def __init__(
        self,
        store: BoardStore,
        provider: Any,
        calendar: TradingCalendar,
        *,
        catalog_ttl_seconds: float = DEFAULT_CATALOG_TTL_SECONDS,
        membership_ttl_seconds: float = DEFAULT_MEMBERSHIP_TTL_SECONDS,
        intraday_snapshot_ttl_seconds: float = DEFAULT_INTRADAY_SNAPSHOT_TTL_SECONDS,
        min_coverage_pct: float = MIN_COVERAGE_PCT,
        monotonic: Callable[[], float] | None = None,
    ) -> None:
        self.store = store
        self.provider = provider
        self.calendar = calendar
        self.catalog_ttl_seconds = float(catalog_ttl_seconds)
        self.membership_ttl_seconds = float(membership_ttl_seconds)
        self.intraday_snapshot_ttl_seconds = float(intraday_snapshot_ttl_seconds)
        self.min_coverage_pct = float(min_coverage_pct)
        self._monotonic = monotonic or time.monotonic
        self._catalog_refreshed_at: dict[str, float] = {}
        self._members: dict[str, _MemberCacheEntry] = {}

    # -- session ----------------------------------------------------------

    def session(self, *, requested_date: str | None = None) -> MarketSession:
        return self.calendar.session(requested_date=requested_date)

    def _effective_trade_date(self, requested: str | None) -> tuple[str, MarketSession]:
        session = self.session(requested_date=requested)
        if not session.effective_trade_date:
            raise BoardNoSessionDataError(
                "no completed trading day is available for the requested date",
                details={"market_context": session.as_dict()},
            )
        return session.effective_trade_date, session

    # -- catalog ----------------------------------------------------------

    def _catalog_is_stale(self, board_type: str) -> bool:
        if self.store.catalog_size(board_type=board_type) == 0:
            return True
        refreshed = self._catalog_refreshed_at.get(board_type)
        if refreshed is None:
            return True
        return (self._monotonic() - refreshed) > self.catalog_ttl_seconds

    def refresh_catalog(self, *, board_type: str | None = None) -> int:
        """Import board identities for one kind, or for every kind."""

        targets = (board_type,) if board_type else CATALOG_TYPES
        written = 0
        for target in targets:
            boards = list(self.provider.list_boards(board_type=target))
            written += self.store.upsert_boards(boards)
            self._catalog_refreshed_at[target] = self._monotonic()
        return written

    # -- resolution -------------------------------------------------------

    def resolve(self, query: str, *, board_type: str | None = None) -> BoardResolution:
        wanted = normalize_board_type(board_type)
        normalized = normalize_board_name(query)
        if not normalized:
            raise BoardNotFoundError(
                "board query is empty after normalization",
                details={"query": query},
            )
        candidates = self.store.search_boards(query, board_type=wanted)
        if not candidates:
            # Only refresh once, and only when the local catalog cannot answer.
            for target in ((wanted,) if wanted else CATALOG_TYPES):
                if self._catalog_is_stale(target):
                    self.refresh_catalog(board_type=target)
            candidates = self.store.search_boards(query, board_type=wanted)
        fetched_at = utc_now()
        if not candidates:
            raise BoardNotFoundError(
                f"no supported board matches: {query}",
                details={"query": query, "normalized_query": normalized, "board_type": wanted},
            )
        if len(candidates) > 1:
            raise BoardAmbiguityError(query, candidates)
        board = candidates[0]
        exact = board.normalized_name == normalized
        return BoardResolution(
            query=query,
            status="resolved",
            candidates=(board,),
            match_basis="exact_normalized_name" if exact else "normalized_name_contains",
            confidence=1.0 if exact else 0.75,
            message="" if exact else "matched by partial name; confirm the constituent basis",
            fetched_at=fetched_at,
            data_quality=DataQuality(
                status="ok" if exact else "warning",
                warnings=() if exact else ("board name matched partially",),
            ),
        )

    def require_board(self, board_id: str) -> Board:
        board = self.store.get_board(board_id)
        if board is None:
            raise BoardNotFoundError(
                "board_id is not a known board; call resolve_board first",
                details={"board_id": str(board_id)[:64]},
            )
        return board

    # -- constituents -----------------------------------------------------

    def _load_members(self, board: Board, trade_date: str) -> tuple[BoardMember, ...]:
        cached = self._members.get(board.id)
        fresh = (
            cached is not None
            and cached.trade_date == trade_date
            and (self._monotonic() - cached.fetched_monotonic) <= self.membership_ttl_seconds
        )
        if fresh and cached is not None:
            return cached.members
        members = tuple(self.provider.members(board, as_of=trade_date))
        self._members[board.id] = _MemberCacheEntry(
            members=members, trade_date=trade_date, fetched_monotonic=self._monotonic()
        )
        self.store.replace_memberships(
            board.id,
            members,
            valid_from=trade_date,
            source=board.provider,
            as_of=trade_date,
        )
        return members

    # -- snapshot ---------------------------------------------------------

    def _fetch_snapshot(self, board: Board, session: MarketSession, trade_date: str) -> tuple[BoardSnapshot, list[str]]:
        """Read the board quote, preferring a completed session's stored copy.

        When the upstream is unreachable or rate limited, a stored snapshot for
        the same trade date is served with an explicit staleness warning rather
        than failing the whole question.  If no such copy exists the upstream
        error propagates -- an empty or invented quote is never returned.
        """

        cached = self.store.latest_snapshot(board.id, trade_date=trade_date)
        if cached is not None and not session.intraday:
            # A completed session's snapshot never changes again.
            return cached, []
        try:
            return self.provider.quote(board, trade_date=trade_date, market_phase=session.phase), []
        except (BoardUpstreamUnavailableError, BoardRateLimitedError):
            if cached is None:
                raise
            return cached, [
                "the upstream board quote was unavailable; a stored snapshot for "
                f"{trade_date} taken at {cached.snapshot_at} is used instead"
            ]

    def snapshot(self, board_id: str, *, trade_date: str | None = None) -> dict[str, Any]:
        board = self.require_board(board_id)
        effective, session = self._effective_trade_date(trade_date)
        snapshot, warnings = self._fetch_snapshot(board, session, effective)
        breadth, breadth_warnings = self._resolve_breadth(board, snapshot, effective)
        snapshot = replace(snapshot, breadth=breadth)
        self.store.upsert_snapshot(snapshot)
        return self._snapshot_payload(board, snapshot, session, breadth, [*warnings, *breadth_warnings])

    def breadth(self, board_id: str, *, trade_date: str | None = None) -> dict[str, Any]:
        """Breadth view of the same observation the snapshot tool reads.

        Sharing one code path keeps the two tools from ever disagreeing about
        coverage, the trade date, or the observation point.
        """

        return {**self.snapshot(board_id, trade_date=trade_date), "view": "breadth"}

    def _resolve_breadth(
        self, board: Board, snapshot: BoardSnapshot, trade_date: str
    ) -> tuple[BoardBreadth, list[str]]:
        warnings: list[str] = []
        provider_breadth = snapshot.breadth
        if provider_breadth.basis == "provider" and provider_breadth.covered_members > 0:
            return provider_breadth, warnings
        members = self._load_members(board, trade_date)
        computed = compute_breadth(members)
        warnings.append(
            "advance/decline counts were computed from the provider's constituent "
            "quotes at the same observation point, not published by the provider"
        )
        return computed, warnings

    def _snapshot_payload(
        self,
        board: Board,
        snapshot: BoardSnapshot,
        session: MarketSession,
        breadth: Any,
        warnings: Iterable[str],
    ) -> dict[str, Any]:
        collected = list(warnings)
        insufficient = breadth.coverage_pct < self.min_coverage_pct
        if insufficient:
            collected.append(
                f"constituent coverage {breadth.coverage_pct}% is below the "
                f"{self.min_coverage_pct}% threshold; breadth is not representative"
            )
        if session.intraday:
            collected.append("the session is still open; these values continue to change")
        if session.fallback_reason:
            collected.append(
                f"the requested date had no usable data; {snapshot.trade_date} is used instead"
            )
        quality = DataQuality(
            status="warning" if collected else "ok",
            missing_fields=() if snapshot.change_pct is not None else ("change_pct",),
            warnings=tuple(dict.fromkeys(collected)),
        )
        return {
            "board": board.as_dict(),
            "board_id": board.id,
            "board_type": board.board_type,
            "provider": board.provider,
            "constituent_basis": board.constituent_basis,
            "name": board.name,
            "market_context": session.as_dict(),
            "snapshot": snapshot.as_dict(),
            "breadth": breadth.as_dict(),
            "coverage": {
                "covered_members": breadth.covered_members,
                "total_members": breadth.total_members,
                "coverage_pct": breadth.coverage_pct,
                "minimum_pct": self.min_coverage_pct,
                "sufficient": not insufficient,
            },
            "insufficient_coverage": insufficient,
            "change_pct": snapshot.change_pct,
            "trade_date": snapshot.trade_date,
            "snapshot_at": snapshot.snapshot_at,
            "market_phase": snapshot.market_phase,
            "effective_trade_date": session.effective_trade_date,
            "source": snapshot.source,
            "as_of": snapshot.snapshot_at,
            "fetched_at": snapshot.fetched_at or utc_now(),
            "data_basis": f"{board.provider}.board.{board.board_type}",
            "data_quality": quality.as_dict(),
            "warnings": list(quality.warnings),
            "limitations": [
                "board constituents follow one provider's definition; other "
                "platforms classify the same theme differently",
                "board performance on one session does not predict the next session",
            ],
        }

    # -- members ----------------------------------------------------------

    def members(
        self,
        board_id: str,
        *,
        trade_date: str | None = None,
        sort: str = "change_pct",
        direction: str = "desc",
        limit: int = 10,
    ) -> dict[str, Any]:
        if sort not in MEMBER_SORT_FIELDS:
            raise ValueError(f"unsupported sort field: {sort}")
        if direction not in {"asc", "desc"}:
            raise ValueError(f"unsupported direction: {direction}")
        board = self.require_board(board_id)
        effective, session = self._effective_trade_date(trade_date)
        members = self._load_members(board, effective)
        breadth = compute_breadth(members)
        quoted = [member for member in members if getattr(member, sort) is not None]
        # Leaders and laggards are always best-first and worst-first by change,
        # independent of the requested ordering, so the two lists keep their
        # meaning no matter how the caller sorted the table.
        by_change = sorted(
            (member for member in members if member.change_pct is not None),
            key=lambda item: item.change_pct,
            reverse=True,
        )
        ordered = sorted(quoted, key=lambda item: getattr(item, sort), reverse=direction == "desc")
        safe_limit = max(1, min(int(limit), 50))
        insufficient = breadth.coverage_pct < self.min_coverage_pct
        warnings: list[str] = []
        if insufficient:
            warnings.append(
                f"only {breadth.covered_members} of {breadth.total_members} constituents "
                "published a quote at this observation point"
            )
        if session.intraday:
            warnings.append("the session is still open; rankings continue to change")
        return {
            "board": board.as_dict(),
            "board_id": board.id,
            "board_type": board.board_type,
            "provider": board.provider,
            "constituent_basis": board.constituent_basis,
            "name": board.name,
            "market_context": session.as_dict(),
            "trade_date": effective,
            "effective_trade_date": session.effective_trade_date,
            "sort": sort,
            "direction": direction,
            "limit": safe_limit,
            "members": [item.as_dict() for item in ordered[:safe_limit]],
            "leaders": [item.as_dict() for item in by_change[:safe_limit]],
            "laggards": [item.as_dict() for item in list(reversed(by_change))[:safe_limit]],
            "member_count": len(members),
            "breadth": breadth.as_dict(),
            "coverage": {
                "covered_members": breadth.covered_members,
                "total_members": breadth.total_members,
                "coverage_pct": breadth.coverage_pct,
                "minimum_pct": self.min_coverage_pct,
                "sufficient": not insufficient,
            },
            "insufficient_coverage": insufficient,
            "membership_as_of": self.store.membership_as_of(board.id, on_date=effective) or effective,
            "source": board.provider,
            "as_of": effective,
            "fetched_at": utc_now(),
            "data_basis": f"{board.provider}.board_members.{board.board_type}",
            "data_quality": DataQuality(
                status="warning" if warnings else "ok",
                warnings=tuple(dict.fromkeys(warnings)),
            ).as_dict(),
            "warnings": list(dict.fromkeys(warnings)),
        }


__all__ = [
    "CATALOG_TYPES",
    "MEMBER_SORT_FIELDS",
    "MIN_COVERAGE_PCT",
    "BoardService",
    "normalize_board_type",
]
