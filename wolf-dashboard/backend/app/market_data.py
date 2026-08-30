"""Controlled market-data primitives used by the WolfBot MVP.

The module deliberately keeps provider I/O separate from symbol resolution,
indicator calculation, and the SQLite store.  That makes fixture based tests
possible and prevents a failed provider request from turning into invented
market values.
"""

from __future__ import annotations

import json
import math
import random
import re
import time
from dataclasses import InitVar, asdict, dataclass, field
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation
from statistics import pstdev
from typing import Any, Callable, Iterable, Mapping, Protocol

import requests


UTC = timezone.utc
CANONICAL_RE = re.compile(r"^(sh|sz|bj)(\d{6})$", re.IGNORECASE)
DOT_RE = re.compile(r"^(\d{6})\.(sh|sz|bj)$", re.IGNORECASE)
BARE_RE = re.compile(r"^\d{6}$")
SAFE_TRADE_STATUSES = {"1", "active", "normal", "trading", "normal trading"}


class MarketDataError(RuntimeError):
    """A provider or local market-data operation failed."""


class EastMoneyUniverseError(MarketDataError):
    """EastMoney returned an unusable or incomplete security catalog."""


class SymbolResolutionError(ValueError):
    """A query cannot be safely resolved to one security."""


class SymbolAmbiguityError(SymbolResolutionError):
    def __init__(self, query: str, candidates: list["Security"]):
        self.query = query
        self.candidates = candidates
        super().__init__(f"ambiguous security query: {query}")


class MarketProvider(Protocol):
    def realtime(self, symbol: str) -> "Quote": ...

    def history(
        self,
        symbol: str,
        *,
        adjustment: str = "qfq",
        limit: int = 240,
    ) -> list["DailyBar"]: ...


@dataclass(frozen=True)
class DataQuality:
    status: str = "ok"
    missing_fields: tuple[str, ...] = ()
    warnings: tuple[str, ...] = ()

    def as_dict(self) -> dict[str, Any]:
        return {
            "status": self.status,
            "missing_fields": list(self.missing_fields),
            "warnings": list(self.warnings),
        }


def data_quality(
    values: Mapping[str, Any],
    *,
    required: Iterable[str] = (),
    warnings: Iterable[str] = (),
    error: bool = False,
) -> DataQuality:
    missing = tuple(dict.fromkeys(key for key in required if values.get(key) in (None, "")))
    warning_values = tuple(dict.fromkeys(str(item) for item in warnings if item))
    status = "error" if error else ("warning" if missing or warning_values else "ok")
    return DataQuality(status=status, missing_fields=missing, warnings=warning_values)


@dataclass(frozen=True)
class Security:
    symbol: str
    code: str
    name: str
    asset_type: str
    exchange: str
    board: str = ""
    universe_id: str = "a-share"
    is_st: bool | None = None
    enabled: bool = True
    status: str = "active"
    source: str = "fixture"
    metadata: dict[str, Any] = field(default_factory=dict)

    @property
    def secid(self) -> str:
        market_id = {"SH": "1", "SZ": "0", "BJ": "0"}.get(self.exchange, "")
        return f"{market_id}.{self.code}" if market_id else self.symbol

    def as_dict(self) -> dict[str, Any]:
        value = asdict(self)
        value["secid"] = self.secid
        value["market"] = self.exchange
        return value


@dataclass(frozen=True)
class SymbolResolution:
    query: str
    status: str
    candidates: tuple[Security, ...] = ()
    message: str = ""
    fetched_at: str = ""
    source: str = "local-catalog"
    data_quality: DataQuality = field(default_factory=DataQuality)

    def as_dict(self) -> dict[str, Any]:
        candidates = [item.as_dict() for item in self.candidates]
        return {
            "query": self.query,
            "status": self.status,
            "ambiguous": self.status == "ambiguous",
            "candidates": candidates,
            "results": candidates,
            "asset_type": self.candidates[0].asset_type if len(self.candidates) == 1 else "mixed",
            "exchange": self.candidates[0].exchange if len(self.candidates) == 1 else "UNKNOWN",
            "message": self.message,
            "source": self.source,
            "fetched_at": self.fetched_at,
            "data_quality": self.data_quality.as_dict(),
        }


@dataclass(frozen=True)
class Quote:
    symbol: str
    code: str
    name: str
    asset_type: str
    exchange: str
    price: float | None
    previous_close: float | None
    change_pct: float | None
    open: float | None = None
    high: float | None = None
    low: float | None = None
    volume: float | None = None
    amount: float | None = None
    turnover: float | None = None
    trade_status: str | None = None
    is_st: bool | None = None
    is_limit_up: bool | None = None
    is_limit_down: bool | None = None
    as_of: str | None = None
    fetched_at: str = ""
    source: str = "tencent"
    adjustment: str = "none"
    data_quality: DataQuality = field(default_factory=DataQuality)

    def as_dict(self) -> dict[str, Any]:
        value = asdict(self)
        value["data_quality"] = self.data_quality.as_dict()
        value.update({"asset_type": self.asset_type, "exchange": self.exchange, "market": self.exchange})
        return value


@dataclass(frozen=True)
class DailyBar:
    trade_date: str
    open: float | None
    high: float | None
    low: float | None
    close: float | None
    volume: float | None = None
    amount: float | None = None
    previous_close: float | None = None
    turnover: float | None = None
    change_pct: float | None = None
    trade_status: str | None = None
    is_st: bool | None = None
    is_limit_up: bool | None = None
    is_limit_down: bool | None = None
    symbol: str = ""
    source: str = "tencent"
    adjustment: str = "qfq"
    fetched_at: str = ""
    metadata: dict[str, Any] = field(default_factory=dict)
    # ``date`` is the public point-level API name; ``trade_date`` remains the
    # canonical storage/model field.  Keeping this as an InitVar lets
    # ``DailyBar(**bar.as_dict())`` round-trip without duplicating state.
    date: InitVar[str | None] = None

    def __post_init__(self, date: str | None) -> None:
        if date is not None and str(date) != self.trade_date:
            raise ValueError("date and trade_date must refer to the same trading day")

    def as_dict(self) -> dict[str, Any]:
        value = asdict(self)
        value["date"] = self.trade_date
        return value


@dataclass(frozen=True)
class TechnicalFeatures:
    symbol: str
    trade_date: str
    adjustment: str
    close: float | None
    amount: float | None
    turnover: float | None
    change_pct: float | None
    ma5: float | None
    ma10: float | None
    ma20: float | None
    ma30: float | None
    ma60: float | None
    return_5d_pct: float | None
    return_10d_pct: float | None
    return_20d_pct: float | None
    return_60d_pct: float | None
    amount_ratio_20d: float | None
    volatility_20d_pct: float | None
    max_drawdown_20d_pct: float | None
    max_drawdown_60d_pct: float | None
    limit_up_count_4d: int | None
    limit_up_count_10d: int | None
    is_st: bool | None
    is_limit_up: bool | None
    is_limit_down: bool | None
    trade_status: str | None
    sample_count: int
    source: str = "local"
    fetched_at: str = ""
    metadata: dict[str, Any] = field(default_factory=dict)

    def as_dict(self) -> dict[str, Any]:
        return asdict(self)


def utc_now() -> str:
    return datetime.now(UTC).isoformat(timespec="seconds")


def _number(value: Any) -> float | None:
    if value is None or value == "":
        return None
    try:
        result = float(str(value).replace(",", "").strip())
    except (TypeError, ValueError):
        return None
    return result if math.isfinite(result) else None


def _bool(value: Any) -> bool | None:
    if value is None or value == "":
        return None
    if isinstance(value, bool):
        return value
    text = str(value).strip().lower()
    if text in {"1", "true", "yes", "y", "up", "limit_up"}:
        return True
    if text in {"0", "false", "no", "n", "down", "limit_down"}:
        return False
    return None


def _exchange_for_prefix(prefix: str) -> str:
    return {"sh": "SH", "sz": "SZ", "bj": "BJ"}[prefix.lower()]


def _board_for(security_code: str, exchange: str, asset_type: str) -> str:
    if asset_type == "index":
        return "index"
    if asset_type == "etf":
        return "etf"
    if exchange == "BJ":
        return "beijing"
    if security_code.startswith("68"):
        return "star"
    if security_code.startswith("30"):
        return "chinext"
    if security_code.startswith("00"):
        return "main"
    if security_code.startswith("60"):
        return "main"
    return "other"


def infer_asset_type(code: str, exchange: str, name: str = "") -> str:
    upper = name.upper()
    if code in {"000001", "000016", "000300", "000905", "000852", "000688", "399001", "399006", "399300"}:
        return "index"
    if "ETF" in upper or code.startswith(("15", "16", "5", "56", "58")):
        return "etf"
    return "stock"


def security_from_symbol(symbol: str, *, name: str = "", asset_type: str | None = None) -> Security:
    """Parse an explicit canonical symbol without guessing a bare market."""
    raw = str(symbol or "").strip().lower()
    match = CANONICAL_RE.fullmatch(raw)
    if not match:
        match_dot = DOT_RE.fullmatch(raw)
        if match_dot:
            code, prefix = match_dot.groups()
            raw = f"{prefix}{code}"
            match = CANONICAL_RE.fullmatch(raw)
    if not match:
        raise SymbolResolutionError(f"explicit exchange prefix required: {symbol}")
    prefix, code = match.groups()
    exchange = _exchange_for_prefix(prefix)
    resolved_type = asset_type or infer_asset_type(code, exchange, name)
    return Security(
        symbol=f"{prefix.lower()}{code}",
        code=code,
        name=name or code,
        asset_type=resolved_type,
        exchange=exchange,
        board=_board_for(code, exchange, resolved_type),
        source="parser",
    )


EASTMONEY_CLIST_URL = "https://push2.eastmoney.com/api/qt/clist/get"
EASTMONEY_UNIVERSE_FILTERS = (
    "m:1+t:2",
    "m:1+t:23",
    "m:0+t:6",
    "m:0+t:80",
    "m:0+t:81+s:2048",
)
EASTMONEY_UNIVERSE_FS = ",".join(EASTMONEY_UNIVERSE_FILTERS)
EASTMONEY_A_SHARE_FILTERS = EASTMONEY_UNIVERSE_FILTERS
EASTMONEY_A_SHARE_FS = EASTMONEY_UNIVERSE_FS
EASTMONEY_FIELDS = "f12,f13,f14"


def _eastmoney_text(value: Any) -> str:
    return str(value).strip() if value is not None else ""


def _eastmoney_market(row: Mapping[str, Any]) -> str:
    value = row.get("f13", row.get("market", row.get("exchange", "")))
    text = _eastmoney_text(value).upper()
    if text in {"1", "SH", "SSE", "\u4e0a\u4ea4\u6240", "\u4e0a\u6d77"}:
        return "SH"
    if text in {"0", "SZ", "SZSE", "\u6df1\u4ea4\u6240", "\u6df1\u5733"}:
        return "SZ"
    if text in {"2", "BJ", "BSE", "\u5317\u4ea4\u6240", "\u5317\u4eac"}:
        return "BJ"
    return ""


def _eastmoney_code(row: Mapping[str, Any]) -> str:
    value = row.get(
        "f12",
        row.get(
            "code",
            row.get("symbol", row.get("SECURITY_CODE", row.get("security_code", ""))),
        ),
    )
    code = _eastmoney_text(value)
    if code.upper().endswith((".SH", ".SZ", ".BJ")):
        code = code[:-3]
    if not re.fullmatch(r"\d{6}", code):
        raise EastMoneyUniverseError(f"EastMoney universe row has invalid security code: {value!r}")
    return code


def _eastmoney_name(row: Mapping[str, Any], code: str) -> str:
    value = row.get(
        "f14",
        row.get("name", row.get("SECURITY_NAME_ABBR", row.get("security_name", ""))),
    )
    name = _eastmoney_text(value)
    if not name:
        raise EastMoneyUniverseError(f"EastMoney universe row {code} has no security name")
    return name


def _eastmoney_is_st(name: str, row: Mapping[str, Any]) -> bool | None:
    explicit = row.get("is_st", row.get("isST", row.get("is_st_stock")))
    if explicit is not None:
        parsed = _bool(explicit)
        if parsed is not None:
            return parsed
    upper = name.strip().upper()
    return upper.startswith("ST") or upper.startswith("*ST")


def _eastmoney_status(row: Mapping[str, Any]) -> str:
    value = row.get("status", row.get("trade_status", row.get("listing_status", "active")))
    text = _eastmoney_text(value)
    return text or "active"


def _eastmoney_board(code: str, exchange: str) -> str:
    if exchange == "BJ":
        return "beijing"
    if code.startswith("68"):
        return "star"
    if code.startswith("30"):
        return "chinext"
    if code.startswith(("60", "00")):
        return "main"
    return "other"


def _eastmoney_is_a_share(code: str, exchange: str, name: str, row: Mapping[str, Any]) -> bool:
    """Keep listed A-share common stock rows and reject fund/index/B-share rows."""
    if exchange == "BJ":
        valid_code = code.startswith("920")
    elif exchange == "SH":
        valid_code = code.startswith(("60", "68"))
    elif exchange == "SZ":
        valid_code = code.startswith(("00", "30"))
    else:
        return False
    if not valid_code:
        return False
    declared_type = _eastmoney_text(row.get("asset_type", row.get("assetType", ""))).lower()
    if declared_type and declared_type not in {"stock", "a-share", "ashare", "equity"}:
        return False
    upper = name.upper()
    excluded_markers = (
        "ETF",
        "LOF",
        "INDEX",
        "FUND",
        "B SHARE",
        "B\u80a1",
        "\u6307\u6570",
        "\u57fa\u91d1",
        "\u503a\u5238",
        "\u8f6c\u503a",
    )
    return not any(marker in upper for marker in excluded_markers)


def _eastmoney_rows(payload: Mapping[str, Any]) -> tuple[list[Mapping[str, Any]], int | None]:
    if not isinstance(payload, Mapping):
        raise EastMoneyUniverseError("EastMoney universe response must be a JSON object")
    for key in ("rc", "code"):
        if key in payload and payload[key] not in (0, "0", None):
            raise EastMoneyUniverseError(f"EastMoney universe response returned {key}={payload[key]!r}")
    data = payload.get("data")
    if not isinstance(data, Mapping):
        raise EastMoneyUniverseError("EastMoney universe response is missing object data")
    raw_diff = data.get("diff")
    if isinstance(raw_diff, Mapping):
        def sort_key(item: tuple[Any, Any]) -> tuple[int, str]:
            key = _eastmoney_text(item[0])
            return (0, f"{int(key):020d}") if key.isdigit() else (1, key)

        values = [item for _, item in sorted(raw_diff.items(), key=sort_key)]
    elif isinstance(raw_diff, list):
        values = list(raw_diff)
    else:
        raise EastMoneyUniverseError("EastMoney universe response is missing list/dict data.diff")
    rows: list[Mapping[str, Any]] = []
    for index, row in enumerate(values):
        if not isinstance(row, Mapping):
            raise EastMoneyUniverseError(f"EastMoney universe row {index} is not an object")
        rows.append(row)
    total_value = data.get("total")
    total: int | None = None
    if total_value not in (None, ""):
        try:
            total = int(total_value)
        except (TypeError, ValueError) as exc:
            raise EastMoneyUniverseError(f"EastMoney universe total is invalid: {total_value!r}") from exc
        if total < 0:
            raise EastMoneyUniverseError(f"EastMoney universe total is invalid: {total_value!r}")
    return rows, total


def parse_eastmoney_universe_payload(
    payload: Mapping[str, Any],
    *,
    market_filter: str = EASTMONEY_UNIVERSE_FS,
    universe_id: str = "a-share",
    fetched_at: str | None = None,
    allow_no_supported: bool = False,
) -> list[Security]:
    """Parse one EastMoney clist page into canonical, stock-only securities.

    EastMoney has returned both list and numeric-keyed dict ``data.diff``
    shapes over time.  The parser normalizes both and deliberately rejects
    malformed rows instead of inventing a venue or silently using fixtures.
    """
    rows, _ = _eastmoney_rows(payload)
    if not rows:
        raise EastMoneyUniverseError("EastMoney universe response contains no securities")
    fetched = fetched_at or utc_now()
    selected: dict[str, Security] = {}
    for row in rows:
        code = _eastmoney_code(row)
        row_market = _eastmoney_market(row)
        filter_market = "BJ" if "t:81" in market_filter else ""
        exchange = "BJ" if code.startswith("920") else (row_market or filter_market)
        if not exchange:
            if code.startswith(("60", "68")):
                exchange = "SH"
            elif code.startswith(("00", "30")):
                exchange = "SZ"
        name = _eastmoney_name(row, code)
        # 43/83/87 were historical BSE aliases and are not active MVP
        # securities.  Only the current 920xxx BSE namespace is imported.
        if code.startswith(("43", "83", "87")):
            continue
        if not _eastmoney_is_a_share(code, exchange, name, row):
            continue
        prefix = exchange.lower()
        symbol = f"{prefix}{code}"
        status = _eastmoney_status(row)
        security = Security(
            symbol=symbol,
            code=code,
            name=name,
            asset_type="stock",
            exchange=exchange,
            board=_eastmoney_board(code, exchange),
            universe_id=universe_id,
            is_st=_eastmoney_is_st(name, row),
            enabled=status.strip().lower() not in {"delisted", "inactive", "\u9000\u5e02"},
            status=status,
            source="eastmoney",
            metadata={
                "provider": "eastmoney",
                "source": "eastmoney",
                "endpoint": EASTMONEY_CLIST_URL,
                "market_filter": market_filter,
                "market_id": _eastmoney_text(row.get("f13", "")),
                "fetched_at": fetched,
            },
        )
        existing = selected.get(symbol)
        if existing is None or (
            (not existing.name or existing.name == code, existing.name, existing.status)
            > (not security.name or security.name == code, security.name, security.status)
        ):
            selected[symbol] = security
    if not selected and not allow_no_supported:
        raise EastMoneyUniverseError("EastMoney universe response contains no supported A-share securities")
    return [selected[key] for key in sorted(selected)]


def _eastmoney_backoff(attempt: int, base: float) -> float:
    return max(0.0, base * (2 ** max(0, attempt - 1)))


class EastMoneyUniverseProvider:
    """Serial, rate-limited EastMoney A-share universe importer.

    The provider makes only paginated ``push2/api/qt/clist/get`` calls.  It
    never performs a per-symbol lookup; Tencent remains the history provider.
    ``session``, ``sleep_fn`` and ``random_fn`` are injectable for fixtures.
    """

    def __init__(
        self,
        *,
        session: requests.Session | Any | None = None,
        timeout: float = 20.0,
        page_size: int = 1000,
        max_pages: int = 100,
        max_retries: int = 3,
        min_interval: float = 1.0,
        jitter: float = 0.25,
        backoff: float = 0.5,
        sleep_fn: Callable[[float], None] | None = None,
        random_fn: Callable[[float, float], float] | None = None,
        url: str = EASTMONEY_CLIST_URL,
    ):
        self.session = session or requests.Session()
        self.timeout = float(timeout)
        self.page_size = max(1, min(int(page_size), 5000))
        self.max_pages = max(1, int(max_pages))
        self.max_retries = max(0, int(max_retries))
        self.min_interval = max(0.0, float(min_interval))
        self.jitter = max(0.0, float(jitter))
        self.backoff = max(0.0, float(backoff))
        self.sleep_fn = sleep_fn or time.sleep
        self.random_fn = random_fn or random.uniform
        self.url = url
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
            # Sleep the complete interval.  A fake clock or a slow request
            # must never make the next request occur sooner than the policy.
            self.sleep_fn(delay)
        self._last_request_at = time.monotonic()

    def _get_page(self, page: int, *, market_filter: str) -> tuple[Mapping[str, Any], list[Mapping[str, Any]], int | None]:
        params = {
            "pn": page,
            "pz": self.page_size,
            "po": 1,
            "np": 1,
            "ut": "bd1d9ddb04089700cf9c27f6f7426281",
            "fltt": 2,
            "invt": 2,
            "fid": "f3",
            "fs": market_filter,
            "fields": EASTMONEY_FIELDS,
        }
        for attempt in range(self.max_retries + 1):
            self._pace()
            try:
                response = self.session.get(self.url, params=params, timeout=self.timeout)
            except (requests.ConnectionError, requests.Timeout) as exc:
                if attempt >= self.max_retries:
                    raise EastMoneyUniverseError(f"EastMoney universe request failed: {exc}") from exc
                delay = _eastmoney_backoff(attempt + 1, self.backoff)
                if delay:
                    self.sleep_fn(delay)
                continue
            except Exception as exc:
                raise EastMoneyUniverseError(f"EastMoney universe request failed: {exc}") from exc
            status = getattr(response, "status_code", 200)
            if not isinstance(status, int):
                raise EastMoneyUniverseError(f"EastMoney universe response has invalid HTTP status: {status!r}")
            if status == 403:
                raise EastMoneyUniverseError("EastMoney universe request returned HTTP 403; refusing to retry")
            if status == 429 or status >= 500:
                if attempt >= self.max_retries:
                    raise EastMoneyUniverseError(f"EastMoney universe request returned HTTP {status}")
                delay = _eastmoney_backoff(attempt + 1, self.backoff)
                if delay:
                    self.sleep_fn(delay)
                continue
            if status >= 400:
                raise EastMoneyUniverseError(f"EastMoney universe request returned HTTP {status}")
            raise_for_status = getattr(response, "raise_for_status", None)
            if callable(raise_for_status):
                try:
                    raise_for_status()
                except requests.HTTPError as exc:
                    error_response = getattr(exc, "response", None)
                    error_status = getattr(error_response, "status_code", status)
                    if not isinstance(error_status, int):
                        error_status = status
                    if error_status == 403:
                        raise EastMoneyUniverseError(
                            "EastMoney universe request returned HTTP 403; refusing to retry"
                        ) from exc
                    if error_status == 429 or error_status >= 500:
                        if attempt >= self.max_retries:
                            raise EastMoneyUniverseError(
                                f"EastMoney universe request returned HTTP {error_status}"
                            ) from exc
                        delay = _eastmoney_backoff(attempt + 1, self.backoff)
                        if delay:
                            self.sleep_fn(delay)
                        continue
                    raise EastMoneyUniverseError(
                        f"EastMoney universe request returned HTTP {error_status}"
                    ) from exc
                except Exception as exc:
                    raise EastMoneyUniverseError(f"EastMoney universe request failed: {exc}") from exc
            try:
                payload = response.json()
            except Exception as exc:
                raise EastMoneyUniverseError("EastMoney universe response was not valid JSON") from exc
            rows, total = _eastmoney_rows(payload)
            return payload, rows, total
        raise EastMoneyUniverseError("EastMoney universe request exhausted retries")

    def list_securities(
        self,
        universe_id: str = "a-share",
        *,
        market_filter: str = EASTMONEY_UNIVERSE_FS,
        max_symbols: int | None = None,
    ) -> list[Security]:
        if max_symbols is not None and int(max_symbols) < 1:
            raise ValueError("max_symbols must be positive")
        cap = int(max_symbols) if max_symbols is not None else None
        securities: dict[str, Security] = {}
        raw_seen = 0
        reported_total: int | None = None
        catalog_fetched_at = utc_now()
        for page in range(1, self.max_pages + 1):
            payload, raw_rows, total = self._get_page(page, market_filter=market_filter)
            if total is not None:
                if total == 0:
                    raise EastMoneyUniverseError("EastMoney universe response reports zero securities")
                reported_total = total if reported_total is None else max(reported_total, total)
            if not raw_rows:
                if raw_seen and reported_total is None:
                    break
                raise EastMoneyUniverseError("EastMoney universe response ended with an incomplete page")
            if len(raw_rows) > self.page_size:
                raise EastMoneyUniverseError(
                    f"EastMoney universe page contains {len(raw_rows)} rows; page size is {self.page_size}"
                )
            raw_seen += len(raw_rows)
            if reported_total is not None and raw_seen > reported_total:
                raise EastMoneyUniverseError(
                    f"EastMoney universe payload exceeds reported total {reported_total}: received {raw_seen} rows"
                )
            page_securities = parse_eastmoney_universe_payload(
                payload,
                market_filter=market_filter,
                universe_id=universe_id,
                fetched_at=catalog_fetched_at,
                allow_no_supported=True,
            )
            for security in page_securities:
                securities.setdefault(security.symbol, security)
                if cap is not None and len(securities) >= cap:
                    return [securities[key] for key in sorted(securities)[:cap]]
            if reported_total is not None and raw_seen >= reported_total:
                break
            if reported_total is None and len(raw_rows) < self.page_size:
                break
        else:
            raise EastMoneyUniverseError(f"EastMoney universe exceeded max_pages={self.max_pages}")
        if not securities:
            raise EastMoneyUniverseError("EastMoney universe import produced no supported securities")
        if reported_total is not None and raw_seen < reported_total:
            raise EastMoneyUniverseError(
                f"EastMoney universe payload incomplete: received {raw_seen} of {reported_total} rows"
            )
        return [securities[key] for key in sorted(securities)]

    # Naming aliases keep the provider convenient for CLI and integrations.
    fetch_universe = list_securities
    universe = list_securities
    list_symbols = list_securities
    fetch_symbols = list_securities
    fetch = list_securities
    get_universe = list_securities


def default_catalog() -> list[Security]:
    """Small deterministic catalog used for local operation and fixtures."""
    values = [
        ("sh000001", "000001", "SSE Composite", "index", "SH"),
        ("sz000001", "000001", "Ping An Bank", "stock", "SZ"),
        ("sh600519", "600519", "Kweichow Moutai", "stock", "SH"),
        ("sz300750", "300750", "CATL", "stock", "SZ"),
        ("sh510300", "510300", "CSI 300 ETF", "etf", "SH"),
        ("sz159919", "159919", "CSI 300 ETF SZ", "etf", "SZ"),
        ("sh000300", "000300", "CSI 300", "index", "SH"),
        ("bj920002", "920002", "Beijing Sample", "stock", "BJ"),
        ("bj832982", "832982", "Beijing Sample 2", "stock", "BJ"),
        ("sz399001", "399001", "SZ Component", "index", "SZ"),
    ]
    return [
        Security(
            symbol=symbol,
            code=code,
            name=name,
            asset_type=asset_type,
            exchange=exchange,
            board=_board_for(code, exchange, asset_type),
            source="fixture-catalog",
        )
        for symbol, code, name, asset_type, exchange in values
    ]


def resolve_symbol(
    query: str,
    *,
    catalog: Iterable[Security] | None = None,
    now: str | None = None,
) -> SymbolResolution:
    """Resolve a query while retaining ambiguity as a first-class result."""
    raw = str(query or "").strip()
    if not raw:
        raise SymbolResolutionError("security query is empty")
    values = list(catalog if catalog is not None else default_catalog())
    fetched_at = now or utc_now()

    aliases = {
        "上证指数": "sh000001",
        "上证综指": "sh000001",
        "深证成指": "sz399001",
        "创业板指": "sz399006",
        "沪深300": "sh000300",
    }
    alias_symbol = aliases.get(raw) or aliases.get(raw.upper())
    if alias_symbol:
        alias_security = security_from_symbol(alias_symbol)
        matches = [item for item in values if item.symbol == alias_symbol]
        return SymbolResolution(
            query=raw,
            status="resolved",
            candidates=(matches[0] if matches else alias_security,),
            fetched_at=fetched_at,
            source="local-alias",
        )

    explicit = CANONICAL_RE.fullmatch(raw.lower()) or DOT_RE.fullmatch(raw.lower())
    if explicit:
        security = security_from_symbol(raw)
        matches = [item for item in values if item.symbol == security.symbol]
        candidate = matches[0] if matches else security
        return SymbolResolution(
            query=raw,
            status="resolved",
            candidates=(candidate,),
            fetched_at=fetched_at,
            data_quality=data_quality(candidate.as_dict(), required=("symbol", "code", "asset_type", "exchange")),
        )

    if not BARE_RE.fullmatch(raw):
        # Names and exact aliases are accepted only when they identify one row.
        matches = [item for item in values if item.name.casefold() == raw.casefold()]
        if len(matches) == 1:
            return SymbolResolution(raw, "resolved", (matches[0],), fetched_at=fetched_at)
        if len(matches) > 1:
            return SymbolResolution(
                raw,
                "ambiguous",
                tuple(matches),
                message="name matches multiple securities",
                fetched_at=fetched_at,
                data_quality=DataQuality(status="warning", warnings=("name is ambiguous",)),
            )
        raise SymbolResolutionError(f"unrecognized security query: {query}")

    # 000001 is intentionally ambiguous even when a caller supplies a
    # partial catalog containing only one of its two well-known securities.
    if raw == "000001":
        candidates = [
            item for item in values if item.code == raw
        ]
        by_symbol = {item.symbol: item for item in candidates}
        for item in (
            security_from_symbol("sh000001", name="SSE Composite", asset_type="index"),
            security_from_symbol("sz000001", name="Ping An Bank", asset_type="stock"),
        ):
            by_symbol.setdefault(item.symbol, item)
        return SymbolResolution(
            query=raw,
            status="ambiguous",
            candidates=tuple(by_symbol.values()),
            message="bare code requires an explicit exchange prefix",
            fetched_at=fetched_at,
            data_quality=DataQuality(status="warning", warnings=("explicit exchange prefix required",)),
        )

    matches = [item for item in values if item.code == raw]
    if len(matches) > 1:
        return SymbolResolution(
            query=raw,
            status="ambiguous",
            candidates=tuple(matches),
            message="bare code requires an explicit exchange prefix",
            fetched_at=fetched_at,
            data_quality=DataQuality(status="warning", warnings=("explicit exchange prefix required",)),
        )
    if len(matches) == 1:
        # A one-row catalog is safe, but the parser still records that the
        # caller supplied a bare code for auditability.
        return SymbolResolution(
            query=raw,
            status="resolved",
            candidates=(matches[0],),
            message="resolved from a unique local catalog entry",
            fetched_at=fetched_at,
            data_quality=DataQuality(status="warning", warnings=("bare code resolved from local catalog",)),
        )

    # Never invent a single venue for an unknown bare code.  Generate only
    # structurally plausible candidates so an agent can ask for clarification.
    possible: list[Security] = []
    if raw == "000001":
        possible = [
            security_from_symbol("sh000001", name="SSE Composite", asset_type="index"),
            security_from_symbol("sz000001", name="Ping An Bank", asset_type="stock"),
        ]
    elif raw.startswith(("4", "8", "92")):
        possible = [security_from_symbol(f"bj{raw}")]
    elif raw.startswith(("6", "9")):
        possible = [security_from_symbol(f"sh{raw}")]
    elif raw.startswith(("0", "2", "3")):
        possible = [security_from_symbol(f"sz{raw}")]
    elif raw.startswith(("5",)):
        possible = [security_from_symbol(f"sh{raw}", asset_type="etf")]
    elif raw.startswith(("15", "16")):
        possible = [security_from_symbol(f"sz{raw}", asset_type="etf")]
    if possible:
        return SymbolResolution(
            query=raw,
            status="ambiguous",
            candidates=tuple(possible),
            message="bare code was not found in the local catalog; explicit exchange is required",
            fetched_at=fetched_at,
            data_quality=DataQuality(status="warning", warnings=("unverified bare code",)),
        )
    raise SymbolResolutionError(f"unrecognized security code: {query}")


def _round(value: float | None, places: int = 6) -> float | None:
    if value is None or not math.isfinite(value):
        return None
    return round(value, places)


def _rolling_mean(values: list[float | None], index: int, window: int) -> float | None:
    if index + 1 < window:
        return None
    current = values[index + 1 - window : index + 1]
    if any(item is None for item in current):
        return None
    return _round(sum(item for item in current if item is not None) / window)


def _return_pct(values: list[float | None], index: int, window: int) -> float | None:
    if index < window or values[index] is None or values[index - window] in (None, 0):
        return None
    return _round((values[index] / values[index - window] - 1.0) * 100.0)


def _max_drawdown(values: list[float | None]) -> float | None:
    peak: float | None = None
    lowest: float | None = None
    for value in values:
        if value is None or value <= 0:
            continue
        peak = value if peak is None else max(peak, value)
        drawdown = (value / peak - 1.0) * 100.0
        lowest = drawdown if lowest is None else min(lowest, drawdown)
    return _round(lowest)


def _volatility(values: list[float | None]) -> float | None:
    returns: list[float] = []
    for previous, current in zip(values, values[1:]):
        if previous not in (None, 0) and current is not None:
            returns.append(current / previous - 1.0)
    if len(returns) < 2:
        return None
    return _round(pstdev(returns) * math.sqrt(252.0) * 100.0)


def compute_features(
    bars: Iterable[DailyBar],
    *,
    symbol: str,
    adjustment: str = "qfq",
    now: str | None = None,
) -> TechnicalFeatures:
    """Compute all MVP features from one adjustment-specific bar series."""
    ordered = sorted(
        [bar for bar in bars if not bar.symbol or bar.symbol == symbol],
        key=lambda item: item.trade_date,
    )
    if any(bar.adjustment != adjustment for bar in ordered):
        raise MarketDataError("bars with different adjustment modes cannot be mixed")
    closes = [bar.close for bar in ordered]
    latest = ordered[-1] if ordered else None
    amounts = [bar.amount for bar in ordered]
    amount_ratio: float | None = None
    if latest and latest.amount is not None and len(ordered) >= 20:
        sample = [value for value in amounts[-20:] if value is not None]
        if sample and sum(sample) != 0:
            amount_ratio = _round(latest.amount / (sum(sample) / len(sample)))
    limit_flags = [bar.is_limit_up for bar in ordered]
    count4 = sum(1 for flag in limit_flags[-4:] if flag is True) if len(ordered) >= 4 else None
    count10 = sum(1 for flag in limit_flags[-10:] if flag is True) if len(ordered) >= 10 else None
    recent20 = closes[-20:]
    recent60 = closes[-60:]
    return TechnicalFeatures(
        symbol=symbol,
        trade_date=latest.trade_date if latest else "",
        adjustment=adjustment,
        close=latest.close if latest else None,
        amount=latest.amount if latest else None,
        turnover=latest.turnover if latest else None,
        change_pct=latest.change_pct if latest else None,
        ma5=_rolling_mean(closes, len(closes) - 1, 5) if closes else None,
        ma10=_rolling_mean(closes, len(closes) - 1, 10) if closes else None,
        ma20=_rolling_mean(closes, len(closes) - 1, 20) if closes else None,
        ma30=_rolling_mean(closes, len(closes) - 1, 30) if closes else None,
        ma60=_rolling_mean(closes, len(closes) - 1, 60) if closes else None,
        return_5d_pct=_return_pct(closes, len(closes) - 1, 5) if closes else None,
        return_10d_pct=_return_pct(closes, len(closes) - 1, 10) if closes else None,
        return_20d_pct=_return_pct(closes, len(closes) - 1, 20) if closes else None,
        return_60d_pct=_return_pct(closes, len(closes) - 1, 60) if closes else None,
        amount_ratio_20d=amount_ratio,
        volatility_20d_pct=_volatility(recent20),
        max_drawdown_20d_pct=_max_drawdown(recent20),
        max_drawdown_60d_pct=_max_drawdown(recent60),
        limit_up_count_4d=count4,
        limit_up_count_10d=count10,
        is_st=latest.is_st if latest else None,
        is_limit_up=latest.is_limit_up if latest else None,
        is_limit_down=latest.is_limit_down if latest else None,
        trade_status=latest.trade_status if latest else None,
        sample_count=len(ordered),
        source="local",
        fetched_at=now or (latest.fetched_at if latest else utc_now()),
        metadata={"bar_count": len(ordered), "adjustment": adjustment},
    )


def parse_tencent_response(body: str, snapshot_at: str | None = None) -> list[Quote]:
    """Parse qt.gtimg.cn's tilde-delimited response without fallback values."""
    fetched_at = snapshot_at or utc_now()
    result: list[Quote] = []
    for match in re.finditer(r'v_([a-z]{2}\d{6})="([^"]*)"', body, re.IGNORECASE):
        symbol = match.group(1).lower()
        prefix, code = symbol[:2], symbol[2:]
        fields = match.group(2).split("~")
        name = fields[1] if len(fields) > 1 else code
        price = _number(fields[3] if len(fields) > 3 else None)
        previous_close = _number(fields[4] if len(fields) > 4 else None)
        change_pct = _number(fields[32] if len(fields) > 32 else None)
        if change_pct is None and price is not None and previous_close not in (None, 0):
            change_pct = (price / previous_close - 1.0) * 100.0
        security = security_from_symbol(symbol, name=name)
        values = {
            "symbol": symbol,
            "code": code,
            "name": name,
            "price": price,
            "previous_close": previous_close,
            "change_pct": change_pct,
            "as_of": fields[30] if len(fields) > 30 and fields[30] else None,
        }
        quality = data_quality(values, required=("symbol", "code", "name", "price", "previous_close"))
        result.append(
            Quote(
                symbol=symbol,
                code=code,
                name=name,
                asset_type=security.asset_type,
                exchange=security.exchange,
                price=price,
                previous_close=previous_close,
                change_pct=_round(change_pct),
                open=_number(fields[5] if len(fields) > 5 else None),
                high=_number(fields[33] if len(fields) > 33 else None),
                low=_number(fields[34] if len(fields) > 34 else None),
                volume=_number(fields[6] if len(fields) > 6 else None),
                amount=_number(fields[37] if len(fields) > 37 else None),
                as_of=values["as_of"],
                fetched_at=fetched_at,
                data_quality=quality,
            )
        )
    return result


def parse_tencent_history_payload(
    payload: Mapping[str, Any],
    *,
    symbol: str,
    adjustment: str = "qfq",
    fetched_at: str | None = None,
) -> list[DailyBar]:
    """Parse Tencent fqkline JSON and require the requested adjustment series."""
    if payload.get("code") not in (0, "0"):
        raise MarketDataError(f"Tencent history returned code={payload.get('code')!r}")
    security = security_from_symbol(symbol)
    data = payload.get("data")
    key = security.symbol
    value = data.get(key) if isinstance(data, Mapping) else None
    if not isinstance(value, Mapping):
        raise MarketDataError(f"Tencent history did not return {key}")
    period_key = f"{adjustment}day" if adjustment in {"qfq", "hfq"} else "day"
    rows = value.get(period_key)
    if not isinstance(rows, list):
        raise MarketDataError(f"Tencent history missing {period_key} for {key}")
    fetched = fetched_at or utc_now()
    parsed: list[DailyBar] = []
    for row in rows:
        if not isinstance(row, list) or len(row) < 6:
            continue
        previous_close = _number(row[7]) if len(row) > 7 else None
        close = _number(row[2])
        change_pct = None
        if close is not None and previous_close not in (None, 0):
            change_pct = (close / previous_close - 1.0) * 100.0
        parsed.append(
            DailyBar(
                trade_date=str(row[0]),
                open=_number(row[1]),
                close=close,
                high=_number(row[3]),
                low=_number(row[4]),
                volume=_number(row[5]),
                previous_close=previous_close,
                change_pct=_round(change_pct),
                symbol=security.symbol,
                source="tencent",
                adjustment=adjustment,
                fetched_at=fetched,
                metadata={"raw": row, "series": period_key},
            )
        )
    if not parsed:
        raise MarketDataError(f"Tencent history returned no valid bars for {key}")
    return parsed


class TencentProvider:
    """Small synchronous Tencent client with injectable session for fixtures."""

    quote_url = "https://qt.gtimg.cn/q="
    history_url = "https://web.ifzq.gtimg.cn/appstock/app/fqkline/get"

    def __init__(self, *, session: requests.Session | Any | None = None, timeout: float = 20.0):
        self.session = session or requests.Session()
        self.timeout = timeout
        if hasattr(self.session, "headers"):
            self.session.headers.update(
                {"User-Agent": "Mozilla/5.0 (WolfBot; local)", "Referer": "https://gu.qq.com/"}
            )

    def realtime(self, symbol: str) -> Quote:
        security = security_from_symbol(symbol)
        try:
            response = self.session.get(f"{self.quote_url}{security.symbol}", timeout=self.timeout)
            response.raise_for_status()
            body = response.content.decode("gb18030", errors="replace")
            quotes = parse_tencent_response(body)
        except Exception as exc:
            raise MarketDataError(f"Tencent realtime request failed for {security.symbol}: {exc}") from exc
        for quote in quotes:
            if quote.symbol == security.symbol:
                return quote
        raise MarketDataError(f"Tencent realtime returned no quote for {security.symbol}")

    def history(self, symbol: str, *, adjustment: str = "qfq", limit: int = 240) -> list[DailyBar]:
        if adjustment not in {"none", "qfq", "hfq"}:
            raise ValueError("adjustment must be one of none, qfq, hfq")
        safe_limit = max(1, min(int(limit), 800))
        security = security_from_symbol(symbol)
        period = "day"
        adj = "" if adjustment == "none" else adjustment
        param = f"{security.symbol},{period},,,{safe_limit},{adj}"
        try:
            response = self.session.get(self.history_url, params={"param": param}, timeout=self.timeout)
            response.raise_for_status()
            payload = response.json()
        except Exception as exc:
            raise MarketDataError(f"Tencent history request failed for {security.symbol}: {exc}") from exc
        return parse_tencent_history_payload(payload, symbol=security.symbol, adjustment=adjustment)


def quality_for_bars(bars: Iterable[DailyBar], *, adjustment: str) -> DataQuality:
    values = list(bars)
    warnings: list[str] = []
    if not values:
        warnings.append("history returned no bars")
    if any(bar.adjustment != adjustment for bar in values):
        warnings.append("bar adjustment does not match requested adjustment")
    if values and len(values) < 60:
        warnings.append("less than 60 daily bars; long-window indicators are incomplete")
    return data_quality(
        {"bars": values, "adjustment": adjustment},
        required=("bars", "adjustment"),
        warnings=warnings,
    )


def json_dumps(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), default=str)


# Compatibility names keep the small module easy to adopt from integrations
# that use QuantPilot's longer service naming.
resolve_security = resolve_symbol
parse_tencent_quote_response = parse_tencent_response
parse_tencent_kline_payload = parse_tencent_history_payload
calculate_technical_features = compute_features
TencentMarketClient = TencentProvider
EastMoneyClient = EastMoneyUniverseProvider
EastMoneyProvider = EastMoneyUniverseProvider
EastMoneyUniverseClient = EastMoneyUniverseProvider
EastMoneyUniverseImporter = EastMoneyUniverseProvider
parse_eastmoney_payload = parse_eastmoney_universe_payload
parse_eastmoney_security_payload = parse_eastmoney_universe_payload
parse_eastmoney_clist_payload = parse_eastmoney_universe_payload
parse_eastmoney_universe = parse_eastmoney_universe_payload
