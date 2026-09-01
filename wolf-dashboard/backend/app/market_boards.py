"""Board (industry/concept/theme/region) identity, quotes, and constituents.

``resolve_symbol`` in :mod:`.market_data` deliberately only resolves tradable
securities and indices.  A question about a sector, concept, or theme is a
different market object, and routing it through the security resolver produced
an HTTP 400 rather than a usable answer.  This module models boards as their
own object kind: identity and aliases, a point-in-time snapshot, market breadth,
and constituents.

Provider I/O is kept separate from the models so fixtures can exercise every
failure branch without network access.  A failed or malformed upstream response
is always reported as an upstream error -- it is never downgraded into "this
board does not exist" or an empty constituent list.
"""

from __future__ import annotations

import hashlib
import math
import random
import re
import time
import unicodedata
from dataclasses import dataclass, field
from typing import Any, Callable, Iterable, Mapping, Protocol

import requests

from .market_data import DataQuality, data_quality, security_from_symbol, utc_now


BOARD_TYPES = ("industry", "concept", "theme", "region")
DEFAULT_PROVIDER = "eastmoney"
BREADTH_ALGORITHM_VERSION = "breadth/1"

#: Suffixes a user routinely appends to a board name.  They carry the routing
#: signal ("this is a board") but are not part of the provider's own name.
_NAME_SUFFIXES = ("板块指数", "概念板块", "行业板块", "板块", "概念股", "概念", "行业", "指数", "题材", "赛道")
_PUNCTUATION = re.compile(r"[\s　·・\-_/()（）\[\]【】]+")


class BoardError(RuntimeError):
    """A board lookup or provider operation failed with a classified code."""

    code = "BOARD_ERROR"
    http_status = 502

    def __init__(self, message: str, *, details: Mapping[str, Any] | None = None) -> None:
        super().__init__(message)
        self.details = dict(details or {})

    def as_detail(self) -> dict[str, Any]:
        return {"code": self.code, "message": str(self), **self.details}


class BoardNotFoundError(BoardError):
    code = "BOARD_NOT_FOUND"
    http_status = 404


class BoardAmbiguityError(BoardError):
    code = "AMBIGUOUS_BOARD"
    http_status = 409

    def __init__(self, query: str, candidates: Iterable["Board"]):
        values = [item.as_dict() for item in candidates]
        super().__init__(
            f"board query matches multiple boards: {query}",
            details={"query": query, "candidates": values},
        )
        self.query = query


class BoardUpstreamUnavailableError(BoardError):
    code = "UPSTREAM_UNAVAILABLE"
    http_status = 502


class BoardRateLimitedError(BoardError):
    code = "UPSTREAM_RATE_LIMITED"
    http_status = 429


class BoardNoSessionDataError(BoardError):
    code = "NO_SESSION_DATA"
    http_status = 409


class BoardStaleDataError(BoardError):
    code = "STALE_BOARD_DATA"
    http_status = 409


class BoardCoverageError(BoardError):
    code = "INSUFFICIENT_COVERAGE"
    http_status = 409


class BoardInvalidResponseError(BoardError):
    code = "UPSTREAM_INVALID_RESPONSE"
    http_status = 502


def normalize_board_name(value: str) -> str:
    """Fold a user-supplied board name to a comparable key.

    Full-width characters, punctuation, and the routing suffixes users add
    ("液冷板块", "液冷概念") all collapse onto the same key so a provider name
    of "液冷服务器" can still be reached from several phrasings.
    """

    text = unicodedata.normalize("NFKC", str(value or "")).strip()
    text = _PUNCTUATION.sub("", text)
    for _ in range(len(_NAME_SUFFIXES)):
        for suffix in _NAME_SUFFIXES:
            if len(text) > len(suffix) and text.endswith(suffix):
                text = text[: -len(suffix)]
                break
        else:
            break
    return text.casefold()


def board_identity(provider: str, provider_board_code: str) -> str:
    """Derive the opaque internal board id the model is allowed to hold."""

    digest = hashlib.sha256(f"{provider}:{provider_board_code}".encode("utf-8")).hexdigest()
    return digest[:24]


@dataclass(frozen=True)
class Board:
    id: str
    provider: str
    provider_board_code: str
    name: str
    board_type: str
    normalized_name: str = ""
    aliases: tuple[str, ...] = ()
    definition: str = ""
    constituent_basis: str = "provider-defined"
    source_ref: str = ""
    active: bool = True
    fetched_at: str = ""
    updated_at: str = ""
    metadata: dict[str, Any] = field(default_factory=dict)

    def as_dict(self) -> dict[str, Any]:
        return {
            "board_id": self.id,
            "name": self.name,
            "board_type": self.board_type,
            "provider": self.provider,
            "constituent_basis": self.constituent_basis,
            "aliases": list(self.aliases),
            "definition": self.definition,
            "source_ref": self.source_ref,
            "active": self.active,
            "fetched_at": self.fetched_at,
        }


@dataclass(frozen=True)
class BoardResolution:
    query: str
    status: str
    candidates: tuple[Board, ...] = ()
    match_basis: str = ""
    confidence: float = 0.0
    message: str = ""
    source: str = "local-board-catalog"
    fetched_at: str = ""
    data_quality: DataQuality = field(default_factory=DataQuality)

    def as_dict(self) -> dict[str, Any]:
        candidates = [item.as_dict() for item in self.candidates]
        resolved = self.candidates[0] if self.status == "resolved" and self.candidates else None
        return {
            "query": self.query,
            "status": self.status,
            "ambiguous": self.status == "ambiguous",
            "candidates": candidates,
            "match_basis": self.match_basis,
            "confidence": self.confidence,
            "message": self.message,
            "source": self.source,
            "fetched_at": self.fetched_at,
            "data_quality": self.data_quality.as_dict(),
            **({"board": resolved.as_dict()} if resolved else {}),
            **(
                {
                    "board_id": resolved.id,
                    "board_type": resolved.board_type,
                    "provider": resolved.provider,
                    "constituent_basis": resolved.constituent_basis,
                    "name": resolved.name,
                }
                if resolved
                else {}
            ),
        }


@dataclass(frozen=True)
class BoardMember:
    symbol: str
    code: str
    name: str
    change_pct: float | None = None
    close: float | None = None
    amount: float | None = None
    turnover: float | None = None
    trade_status: str | None = None
    as_of: str = ""
    source: str = DEFAULT_PROVIDER

    def as_dict(self) -> dict[str, Any]:
        return {
            "symbol": self.symbol,
            "code": self.code,
            "name": self.name,
            "change_pct": self.change_pct,
            "close": self.close,
            "amount": self.amount,
            "turnover": self.turnover,
            "trade_status": self.trade_status,
            "as_of": self.as_of,
            "source": self.source,
        }


@dataclass(frozen=True)
class BoardBreadth:
    """Advance/decline counts plus the coverage they were computed from."""

    advancers: int | None = None
    decliners: int | None = None
    unchanged: int | None = None
    limit_up_count: int | None = None
    limit_down_count: int | None = None
    covered_members: int = 0
    total_members: int = 0
    coverage_pct: float = 0.0
    basis: str = ""
    algorithm_version: str = ""

    def as_dict(self) -> dict[str, Any]:
        return {
            "advancers": self.advancers,
            "decliners": self.decliners,
            "unchanged": self.unchanged,
            "limit_up_count": self.limit_up_count,
            "limit_down_count": self.limit_down_count,
            "covered_members": self.covered_members,
            "total_members": self.total_members,
            "coverage_pct": self.coverage_pct,
            "breadth_basis": self.basis,
            "algorithm_version": self.algorithm_version,
        }


@dataclass(frozen=True)
class BoardSnapshot:
    board_id: str
    trade_date: str
    snapshot_at: str
    market_phase: str = ""
    change_pct: float | None = None
    last: float | None = None
    open: float | None = None
    high: float | None = None
    low: float | None = None
    previous_close: float | None = None
    amount: float | None = None
    volume: float | None = None
    turnover: float | None = None
    breadth: BoardBreadth = field(default_factory=BoardBreadth)
    source: str = DEFAULT_PROVIDER
    fetched_at: str = ""
    data_quality: DataQuality = field(default_factory=DataQuality)
    metadata: dict[str, Any] = field(default_factory=dict)

    def as_dict(self) -> dict[str, Any]:
        return {
            "board_id": self.board_id,
            "trade_date": self.trade_date,
            "snapshot_at": self.snapshot_at,
            "market_phase": self.market_phase,
            "change_pct": self.change_pct,
            "last": self.last,
            "open": self.open,
            "high": self.high,
            "low": self.low,
            "previous_close": self.previous_close,
            "amount": self.amount,
            "volume": self.volume,
            "turnover": self.turnover,
            "source": self.source,
            "fetched_at": self.fetched_at,
            "data_quality": self.data_quality.as_dict(),
        }


class BoardProvider(Protocol):
    def list_boards(self, *, board_type: str) -> list[Board]: ...

    def quote(self, board: Board) -> BoardSnapshot: ...

    def members(self, board: Board) -> list[BoardMember]: ...


# ---------------------------------------------------------------------------
# EastMoney board provider
# ---------------------------------------------------------------------------

EASTMONEY_CLIST_URL = "https://push2.eastmoney.com/api/qt/clist/get"
#: EastMoney groups every board under market 90; ``t`` selects the board kind.
EASTMONEY_BOARD_FILTERS: dict[str, str] = {
    "industry": "m:90+t:2",
    "concept": "m:90+t:3",
    "theme": "m:90+t:3",
    "region": "m:90+t:1",
}
EASTMONEY_BOARD_FIELDS = "f12,f13,f14,f2,f3,f5,f6,f8"
EASTMONEY_MEMBER_FIELDS = "f12,f13,f14,f2,f3,f6,f8"
_BOARD_CODE_RE = re.compile(r"^BK\d{3,6}$", re.IGNORECASE)


def _text(value: Any) -> str:
    return str(value).strip() if value is not None else ""


def _optional_number(value: Any) -> float | None:
    """Parse an EastMoney numeric cell; ``-`` and empty mean "not published"."""

    if value is None:
        return None
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return float(value) if math.isfinite(float(value)) else None
    text = str(value).strip().replace(",", "")
    if text in {"", "-", "--"}:
        return None
    try:
        parsed = float(text)
    except ValueError:
        return None
    return parsed if math.isfinite(parsed) else None


def _rows_from_payload(payload: Any, *, label: str) -> list[Mapping[str, Any]]:
    """Normalize EastMoney's list and numeric-keyed-dict ``data.diff`` shapes."""

    if not isinstance(payload, Mapping):
        raise BoardInvalidResponseError(f"EastMoney {label} response must be a JSON object")
    for key in ("rc", "code"):
        if key in payload and payload[key] not in (0, "0", None):
            raise BoardInvalidResponseError(f"EastMoney {label} response returned {key}={payload[key]!r}")
    data = payload.get("data")
    if not isinstance(data, Mapping):
        raise BoardInvalidResponseError(f"EastMoney {label} response is missing object data")
    diff = data.get("diff")
    if isinstance(diff, Mapping):
        def sort_key(item: tuple[Any, Any]) -> tuple[int, str]:
            key = _text(item[0])
            return (0, f"{int(key):020d}") if key.isdigit() else (1, key)

        values: list[Any] = [item for _, item in sorted(diff.items(), key=sort_key)]
    elif isinstance(diff, list):
        values = list(diff)
    else:
        raise BoardInvalidResponseError(f"EastMoney {label} response is missing list/dict data.diff")
    rows: list[Mapping[str, Any]] = []
    for index, row in enumerate(values):
        if not isinstance(row, Mapping):
            raise BoardInvalidResponseError(f"EastMoney {label} row {index} is not an object")
        rows.append(row)
    if not rows:
        raise BoardInvalidResponseError(f"EastMoney {label} response contains no rows")
    return rows


def parse_eastmoney_board_catalog(
    payload: Any,
    *,
    board_type: str,
    provider: str = DEFAULT_PROVIDER,
    fetched_at: str | None = None,
) -> list[Board]:
    """Parse one EastMoney board-list page into canonical board identities."""

    if board_type not in BOARD_TYPES:
        raise ValueError(f"unsupported board_type: {board_type}")
    rows = _rows_from_payload(payload, label="board catalog")
    fetched = fetched_at or utc_now()
    boards: dict[str, Board] = {}
    for row in rows:
        code = _text(row.get("f12", row.get("code", ""))).upper()
        if not _BOARD_CODE_RE.fullmatch(code):
            raise BoardInvalidResponseError(f"EastMoney board row has an invalid board code: {code!r}")
        name = _text(row.get("f14", row.get("name", "")))
        if not name:
            raise BoardInvalidResponseError(f"EastMoney board {code} has no name")
        identity = board_identity(provider, code)
        boards[identity] = Board(
            id=identity,
            provider=provider,
            provider_board_code=code,
            name=name,
            board_type=board_type,
            normalized_name=normalize_board_name(name),
            constituent_basis="provider-defined",
            source_ref=f"{provider}:clist:{EASTMONEY_BOARD_FILTERS[board_type]}",
            active=True,
            fetched_at=fetched,
            updated_at=fetched,
            metadata={"market_id": _text(row.get("f13", ""))},
        )
    if not boards:
        raise BoardInvalidResponseError("EastMoney board catalog contains no usable boards")
    return [boards[key] for key in sorted(boards)]


def parse_eastmoney_board_quote(
    payload: Any,
    *,
    board: Board,
    trade_date: str,
    market_phase: str = "",
    snapshot_at: str | None = None,
) -> BoardSnapshot:
    """Parse the single board row EastMoney returns for one board code.

    Only the long-standing clist fields are read: ``f2`` last, ``f3`` change
    percent, ``f5`` volume, ``f6`` amount, ``f8`` turnover.  Advance/decline
    counts are deliberately **not** taken from the payload -- their field
    semantics are not verified here, and publishing a mislabelled count as
    market breadth would be worse than deriving it.  Breadth is left empty so
    the service computes it from constituent quotes at the same observation
    point and records that basis.
    """

    rows = _rows_from_payload(payload, label="board quote")
    wanted = board.provider_board_code.upper()
    row = next((item for item in rows if _text(item.get("f12", "")).upper() == wanted), None)
    if row is None:
        raise BoardInvalidResponseError(f"EastMoney board quote did not return {wanted}")
    change_pct = _optional_number(row.get("f3"))
    last = _optional_number(row.get("f2"))
    if change_pct is None and last is None:
        raise BoardInvalidResponseError(f"EastMoney board quote for {wanted} has no usable price fields")
    values = {"change_pct": change_pct, "last": last, "trade_date": trade_date}
    return BoardSnapshot(
        board_id=board.id,
        trade_date=trade_date,
        snapshot_at=snapshot_at or utc_now(),
        market_phase=market_phase,
        change_pct=change_pct,
        last=last,
        amount=_optional_number(row.get("f6")),
        volume=_optional_number(row.get("f5")),
        turnover=_optional_number(row.get("f8")),
        breadth=BoardBreadth(),
        source=board.provider,
        fetched_at=utc_now(),
        data_quality=data_quality(values, required=("change_pct", "trade_date")),
        metadata={"provider_board_code": board.provider_board_code},
    )


def parse_eastmoney_board_members(
    payload: Any,
    *,
    board: Board,
    as_of: str = "",
) -> list[BoardMember]:
    """Parse EastMoney's constituent rows for one board."""

    rows = _rows_from_payload(payload, label="board members")
    members: dict[str, BoardMember] = {}
    for row in rows:
        code = _text(row.get("f12", ""))
        if not re.fullmatch(r"\d{6}", code):
            raise BoardInvalidResponseError(f"EastMoney board member has an invalid security code: {code!r}")
        name = _text(row.get("f14", ""))
        if not name:
            raise BoardInvalidResponseError(f"EastMoney board member {code} has no name")
        market = _text(row.get("f13", ""))
        if market == "1":
            exchange = "sh"
        elif market == "0":
            exchange = "sz" if not code.startswith("920") else "bj"
        elif market == "2" or code.startswith("920"):
            exchange = "bj"
        elif code.startswith(("60", "68")):
            exchange = "sh"
        elif code.startswith(("00", "30")):
            exchange = "sz"
        else:
            raise BoardInvalidResponseError(f"EastMoney board member {code} has no resolvable venue")
        symbol = security_from_symbol(f"{exchange}{code}", name=name).symbol
        members[symbol] = BoardMember(
            symbol=symbol,
            code=code,
            name=name,
            change_pct=_optional_number(row.get("f3")),
            close=_optional_number(row.get("f2")),
            amount=_optional_number(row.get("f6")),
            turnover=_optional_number(row.get("f8")),
            as_of=as_of,
            source=board.provider,
        )
    if not members:
        raise BoardInvalidResponseError(f"EastMoney returned no constituents for {board.provider_board_code}")
    return [members[key] for key in sorted(members)]


def compute_breadth(
    members: Iterable[BoardMember],
    *,
    total_members: int | None = None,
) -> BoardBreadth:
    """Derive advance/decline counts from constituent quotes.

    Only members that actually published a change are counted as covered, so
    ``coverage_pct`` reports how much of the board the numbers really describe.
    """

    values = list(members)
    total = int(total_members) if total_members is not None else len(values)
    advancers = decliners = unchanged = covered = 0
    for member in values:
        if member.change_pct is None:
            continue
        covered += 1
        if member.change_pct > 0:
            advancers += 1
        elif member.change_pct < 0:
            decliners += 1
        else:
            unchanged += 1
    coverage = round(covered / total * 100.0, 2) if total else 0.0
    return BoardBreadth(
        advancers=advancers,
        decliners=decliners,
        unchanged=unchanged,
        covered_members=covered,
        total_members=total,
        coverage_pct=coverage,
        basis="computed_from_members",
        algorithm_version=BREADTH_ALGORITHM_VERSION,
    )


def _backoff(attempt: int, base: float) -> float:
    return max(0.0, base * (2 ** max(0, attempt - 1)))


class EastMoneyBoardProvider:
    """Serial, rate-limited EastMoney board client.

    The pacing, retry, and failure classification mirror
    :class:`~.market_data.EastMoneyUniverseProvider`, but the errors raised are
    board-specific so the agent can tell "no such board" apart from "upstream
    dropped the connection".  ``session``, ``sleep_fn`` and ``random_fn`` are
    injectable so every branch is reachable from a fixture.
    """

    def __init__(
        self,
        *,
        session: requests.Session | Any | None = None,
        timeout: float = 20.0,
        page_size: int = 500,
        max_pages: int = 20,
        max_retries: int = 3,
        min_interval: float = 1.0,
        jitter: float = 0.25,
        backoff: float = 0.5,
        sleep_fn: Callable[[float], None] | None = None,
        random_fn: Callable[[float, float], float] | None = None,
        url: str = EASTMONEY_CLIST_URL,
    ) -> None:
        self.session = session or requests.Session()
        self.timeout = float(timeout)
        self.page_size = max(1, min(int(page_size), 2000))
        self.max_pages = max(1, int(max_pages))
        self.max_retries = max(0, int(max_retries))
        self.min_interval = max(0.0, float(min_interval))
        self.jitter = max(0.0, float(jitter))
        self.backoff = max(0.0, float(backoff))
        self.sleep_fn = sleep_fn or time.sleep
        self.random_fn = random_fn or random.uniform
        self.url = url
        self.name = DEFAULT_PROVIDER
        self._last_request_at: float | None = None
        if hasattr(self.session, "headers"):
            self.session.headers.update(
                {
                    "User-Agent": (
                        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36"
                    ),
                    "Referer": "https://quote.eastmoney.com/",
                }
            )

    def _pace(self) -> None:
        if self._last_request_at is None:
            self._last_request_at = time.monotonic()
            return
        elapsed = time.monotonic() - self._last_request_at
        delay = self.min_interval + (self.random_fn(0.0, self.jitter) if self.jitter else 0.0)
        if elapsed < delay:
            self.sleep_fn(delay)
        self._last_request_at = time.monotonic()

    def _get(self, params: Mapping[str, Any], *, label: str) -> Any:
        for attempt in range(self.max_retries + 1):
            self._pace()
            try:
                response = self.session.get(self.url, params=dict(params), timeout=self.timeout)
            except (requests.ConnectionError, requests.Timeout) as exc:
                if attempt >= self.max_retries:
                    raise BoardUpstreamUnavailableError(
                        f"EastMoney {label} request failed: {exc}"
                    ) from exc
                delay = _backoff(attempt + 1, self.backoff)
                if delay:
                    self.sleep_fn(delay)
                continue
            except Exception as exc:
                raise BoardUpstreamUnavailableError(f"EastMoney {label} request failed: {exc}") from exc
            status = getattr(response, "status_code", 200)
            if not isinstance(status, int):
                raise BoardInvalidResponseError(
                    f"EastMoney {label} response has an invalid HTTP status: {status!r}"
                )
            if status == 403:
                raise BoardUpstreamUnavailableError(
                    f"EastMoney {label} request returned HTTP 403; refusing to retry"
                )
            if status == 429:
                if attempt >= self.max_retries:
                    raise BoardRateLimitedError(f"EastMoney {label} request was rate limited (HTTP 429)")
                delay = _backoff(attempt + 1, self.backoff)
                if delay:
                    self.sleep_fn(delay)
                continue
            if status >= 500:
                if attempt >= self.max_retries:
                    raise BoardUpstreamUnavailableError(
                        f"EastMoney {label} request returned HTTP {status}"
                    )
                delay = _backoff(attempt + 1, self.backoff)
                if delay:
                    self.sleep_fn(delay)
                continue
            if status >= 400:
                raise BoardUpstreamUnavailableError(f"EastMoney {label} request returned HTTP {status}")
            try:
                return response.json()
            except Exception as exc:
                raise BoardInvalidResponseError(f"EastMoney {label} response was not valid JSON") from exc
        raise BoardUpstreamUnavailableError(f"EastMoney {label} request exhausted retries")

    def _paged(self, *, market_filter: str, fields: str, label: str) -> list[Any]:
        payloads: list[Any] = []
        for page in range(1, self.max_pages + 1):
            payload = self._get(
                {
                    "pn": page,
                    "pz": self.page_size,
                    "po": 1,
                    "np": 1,
                    "ut": "bd1d9ddb04089700cf9c27f6f7426281",
                    "fltt": 2,
                    "invt": 2,
                    "fid": "f3",
                    "fs": market_filter,
                    "fields": fields,
                },
                label=label,
            )
            rows = _rows_from_payload(payload, label=label)
            payloads.append(payload)
            if len(rows) < self.page_size:
                break
        else:
            raise BoardInvalidResponseError(f"EastMoney {label} exceeded max_pages={self.max_pages}")
        return payloads

    def list_boards(self, *, board_type: str) -> list[Board]:
        if board_type not in EASTMONEY_BOARD_FILTERS:
            raise ValueError(f"unsupported board_type: {board_type}")
        fetched = utc_now()
        boards: dict[str, Board] = {}
        for payload in self._paged(
            market_filter=EASTMONEY_BOARD_FILTERS[board_type],
            fields=EASTMONEY_BOARD_FIELDS,
            label="board catalog",
        ):
            for board in parse_eastmoney_board_catalog(
                payload, board_type=board_type, provider=self.name, fetched_at=fetched
            ):
                boards.setdefault(board.id, board)
        return [boards[key] for key in sorted(boards)]

    def quote(self, board: Board, *, trade_date: str = "", market_phase: str = "") -> BoardSnapshot:
        payload = self._get(
            {
                "pn": 1,
                "pz": 1,
                "po": 1,
                "np": 1,
                "ut": "bd1d9ddb04089700cf9c27f6f7426281",
                "fltt": 2,
                "invt": 2,
                "fid": "f3",
                "fs": f"b:{board.provider_board_code}",
                "fields": EASTMONEY_BOARD_FIELDS,
            },
            label="board quote",
        )
        return parse_eastmoney_board_quote(
            payload, board=board, trade_date=trade_date, market_phase=market_phase
        )

    def members(self, board: Board, *, as_of: str = "") -> list[BoardMember]:
        members: dict[str, BoardMember] = {}
        for payload in self._paged(
            market_filter=f"b:{board.provider_board_code}",
            fields=EASTMONEY_MEMBER_FIELDS,
            label="board members",
        ):
            for member in parse_eastmoney_board_members(payload, board=board, as_of=as_of):
                members.setdefault(member.symbol, member)
        return [members[key] for key in sorted(members)]


__all__ = [
    "BOARD_TYPES",
    "BREADTH_ALGORITHM_VERSION",
    "DEFAULT_PROVIDER",
    "Board",
    "BoardAmbiguityError",
    "BoardBreadth",
    "BoardCoverageError",
    "BoardError",
    "BoardInvalidResponseError",
    "BoardMember",
    "BoardNoSessionDataError",
    "BoardNotFoundError",
    "BoardProvider",
    "BoardRateLimitedError",
    "BoardResolution",
    "BoardSnapshot",
    "BoardStaleDataError",
    "BoardUpstreamUnavailableError",
    "EastMoneyBoardProvider",
    "board_identity",
    "compute_breadth",
    "normalize_board_name",
    "parse_eastmoney_board_catalog",
    "parse_eastmoney_board_members",
    "parse_eastmoney_board_quote",
]
