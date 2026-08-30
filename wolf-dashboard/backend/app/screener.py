"""Deterministic A-share presets and a deliberately small whitelist DSL."""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from datetime import date
from typing import Any, Iterable, Mapping

from .market_data import SAFE_TRADE_STATUSES, DataQuality, Security, TechnicalFeatures, utc_now
from .market_store import DEFAULT_UNIVERSE_ID, MarketStore


class ScreenerValidationError(ValueError):
    """The request is outside the executable whitelist DSL."""


ALLOWED_FIELDS = frozenset(
    {
        "exchange",
        "board",
        "asset_type",
        "close",
        "change_pct",
        "amount",
        "turnover",
        "ma5",
        "ma10",
        "ma20",
        "ma30",
        "ma60",
        "return_5d_pct",
        "return_10d_pct",
        "return_20d_pct",
        "return_60d_pct",
        "amount_ratio_20d",
        "volatility_20d_pct",
        "max_drawdown_20d_pct",
        "max_drawdown_60d_pct",
        "is_st",
        "is_limit_up",
        "is_limit_down",
        "trade_status",
        "limit_up_count_4d",
        "limit_up_count_10d",
    }
)
NUMERIC_FIELDS = frozenset(
    {
        "close",
        "change_pct",
        "amount",
        "turnover",
        "ma5",
        "ma10",
        "ma20",
        "ma30",
        "ma60",
        "return_5d_pct",
        "return_10d_pct",
        "return_20d_pct",
        "return_60d_pct",
        "amount_ratio_20d",
        "volatility_20d_pct",
        "max_drawdown_20d_pct",
        "max_drawdown_60d_pct",
        "limit_up_count_4d",
        "limit_up_count_10d",
    }
)
BOOL_FIELDS = frozenset({"is_st", "is_limit_up", "is_limit_down"})
TEXT_FIELDS = frozenset({"exchange", "board", "asset_type", "trade_status"})
ALLOWED_OPERATORS = frozenset({"eq", "gt", "gte", "lt", "lte", "between"})
MODES = frozenset({"short_term", "limit_up_relay", "trend_liquidity"})
SAFE_COVERAGE_MIN_PCT = 95.0

# Bounds prevent accidental unit mistakes and make the DSL resistant to
# values intended as SQL/script fragments.  The bounds are intentionally
# broad enough for ordinary A-share data.
FIELD_RANGES: dict[str, tuple[float, float]] = {
    "close": (0.0, 1_000_000.0),
    "change_pct": (-100.0, 1_000.0),
    "amount": (0.0, 1e16),
    "turnover": (0.0, 100.0),
    "ma5": (0.0, 1_000_000.0),
    "ma10": (0.0, 1_000_000.0),
    "ma20": (0.0, 1_000_000.0),
    "ma30": (0.0, 1_000_000.0),
    "ma60": (0.0, 1_000_000.0),
    "return_5d_pct": (-100.0, 10_000.0),
    "return_10d_pct": (-100.0, 10_000.0),
    "return_20d_pct": (-100.0, 10_000.0),
    "return_60d_pct": (-100.0, 10_000.0),
    "amount_ratio_20d": (0.0, 100.0),
    "volatility_20d_pct": (0.0, 1_000.0),
    "max_drawdown_20d_pct": (-100.0, 0.0),
    "max_drawdown_60d_pct": (-100.0, 0.0),
    "limit_up_count_4d": (0.0, 4.0),
    "limit_up_count_10d": (0.0, 10.0),
}


@dataclass(frozen=True)
class Condition:
    field: str
    op: str
    value: Any = None
    right_field: str | None = None

    def as_dict(self) -> dict[str, Any]:
        value = {"field": self.field, "op": self.op}
        if self.right_field is not None:
            value["right_field"] = self.right_field
        else:
            value["value"] = self.value
        return value


@dataclass(frozen=True)
class SortSpec:
    field: str
    direction: str = "desc"

    def as_dict(self) -> dict[str, str]:
        return {"field": self.field, "direction": self.direction}


@dataclass(frozen=True)
class ScreenRequest:
    universe_id: str = DEFAULT_UNIVERSE_ID
    as_of: str | None = None
    conditions: tuple[Condition, ...] = ()
    sort: tuple[SortSpec, ...] = ()
    limit: int = 10

    @classmethod
    def from_mapping(cls, payload: Mapping[str, Any]) -> "ScreenRequest":
        if not isinstance(payload, Mapping):
            raise ScreenerValidationError("request must be an object")
        for forbidden in ("or", "OR", "expression", "formula", "sql", "where"):
            if forbidden in payload:
                raise ScreenerValidationError("OR, expressions, and SQL are not supported")
        universe_id = payload.get("universe_id", DEFAULT_UNIVERSE_ID)
        if not isinstance(universe_id, str) or not universe_id.strip() or len(universe_id) > 80:
            raise ScreenerValidationError("universe_id must be a non-empty string")
        raw_conditions = payload.get("conditions")
        if not isinstance(raw_conditions, list) or not raw_conditions:
            raise ScreenerValidationError("conditions must contain at least one AND condition")
        if len(raw_conditions) > 12:
            raise ScreenerValidationError("at most 12 conditions are supported")
        conditions = tuple(validate_condition(item) for item in raw_conditions)

        raw_sort = payload.get("sort", [])
        if raw_sort is None:
            raw_sort = []
        if not isinstance(raw_sort, list) or len(raw_sort) > 4:
            raise ScreenerValidationError("sort must be a list with at most 4 fields")
        sort = tuple(validate_sort(item) for item in raw_sort)
        raw_limit = payload.get("limit", 10)
        if isinstance(raw_limit, bool) or not isinstance(raw_limit, int) or not 1 <= raw_limit <= 20:
            raise ScreenerValidationError("limit must be an integer between 1 and 20")
        as_of = payload.get("as_of", payload.get("trade_date"))
        if as_of is not None:
            if not isinstance(as_of, str):
                raise ScreenerValidationError("as_of must be an ISO date")
            try:
                date.fromisoformat(as_of)
            except ValueError as exc:
                raise ScreenerValidationError("as_of must be an ISO date") from exc
        return cls(universe_id=universe_id.strip(), as_of=as_of, conditions=conditions, sort=sort, limit=raw_limit)


def _reject_string(value: str) -> None:
    lowered = value.lower()
    if any(token in lowered for token in (";", "--", "/*", "*/", " union ", "select ", "drop ", "exec", "import ", "__", " or ")):
        raise ScreenerValidationError("SQL, scripts, and OR expressions are not supported")


def _validate_number(field: str, value: Any) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ScreenerValidationError(f"{field} requires a finite numeric value")
    numeric = float(value)
    if not math.isfinite(numeric):
        raise ScreenerValidationError(f"{field} requires a finite numeric value")
    lower, upper = FIELD_RANGES[field]
    if numeric < lower or numeric > upper:
        raise ScreenerValidationError(f"{field} value is outside the supported range")
    return numeric


def validate_condition(raw: Any) -> Condition:
    if not isinstance(raw, Mapping):
        raise ScreenerValidationError("each condition must be an object")
    if set(raw) - {"field", "op", "value", "right_field"}:
        raise ScreenerValidationError("condition contains an unknown key")
    field_name = raw.get("field")
    op = raw.get("op")
    if not isinstance(field_name, str) or field_name not in ALLOWED_FIELDS:
        raise ScreenerValidationError(f"unsupported field: {field_name}")
    if not isinstance(op, str) or op not in ALLOWED_OPERATORS:
        raise ScreenerValidationError(f"unsupported operator: {op}")
    right_field = raw.get("right_field")
    if right_field is not None:
        if op == "between":
            raise ScreenerValidationError("between cannot use right_field")
        if not isinstance(right_field, str) or right_field not in ALLOWED_FIELDS:
            raise ScreenerValidationError("right_field is not in the whitelist")
        if field_name in NUMERIC_FIELDS and right_field not in NUMERIC_FIELDS:
            raise ScreenerValidationError("right_field type is incompatible")
        if field_name in TEXT_FIELDS and right_field not in TEXT_FIELDS:
            raise ScreenerValidationError("right_field type is incompatible")
        if field_name in BOOL_FIELDS and right_field not in BOOL_FIELDS:
            raise ScreenerValidationError("right_field type is incompatible")
        if field_name in BOOL_FIELDS or field_name in TEXT_FIELDS:
            if op != "eq":
                raise ScreenerValidationError("text and boolean fields only support eq")
        return Condition(field_name, op, right_field=right_field)

    if "value" not in raw:
        raise ScreenerValidationError("condition requires value or right_field")
    value = raw["value"]
    if isinstance(value, str):
        _reject_string(value)
    if field_name in NUMERIC_FIELDS:
        if op == "between":
            if not isinstance(value, (list, tuple)) or len(value) != 2:
                raise ScreenerValidationError("between requires exactly two numeric values")
            first = _validate_number(field_name, value[0])
            second = _validate_number(field_name, value[1])
            if first > second:
                raise ScreenerValidationError("between lower bound must not exceed upper bound")
            value = [first, second]
        else:
            value = _validate_number(field_name, value)
    elif field_name in BOOL_FIELDS:
        if op != "eq" or not isinstance(value, bool):
            raise ScreenerValidationError(f"{field_name} requires a boolean eq value")
    elif field_name in TEXT_FIELDS:
        if op != "eq" or not isinstance(value, str) or not value.strip() or len(value) > 80:
            raise ScreenerValidationError(f"{field_name} requires a non-empty eq string")
        _reject_string(value)
    return Condition(field_name, op, value=value)


def validate_sort(raw: Any) -> SortSpec:
    if not isinstance(raw, Mapping) or set(raw) - {"field", "direction"}:
        raise ScreenerValidationError("sort entries must contain field and direction")
    field_name = raw.get("field")
    direction = raw.get("direction", "desc")
    if field_name not in ALLOWED_FIELDS:
        raise ScreenerValidationError(f"unsupported sort field: {field_name}")
    if direction not in {"asc", "desc"}:
        raise ScreenerValidationError("sort direction must be asc or desc")
    return SortSpec(field=str(field_name), direction=str(direction))


def _value(row: Mapping[str, Any], field_name: str) -> Any:
    aliases = {
        "latest_close": "close",
        "latest_change_percent": "change_pct",
        "latest_amount": "amount",
        "latest_turnover": "turnover",
        "latest_is_st": "is_st",
        "latest_limit_up": "is_limit_up",
        "latest_limit_down": "is_limit_down",
        "latest_trade_status": "trade_status",
    }
    if field_name in row:
        return row[field_name]
    return row.get(aliases.get(field_name, field_name))


def _safety_fields_complete(row: Mapping[str, Any]) -> bool:
    return all(_value(row, name) is not None for name in ("is_st", "is_limit_up", "is_limit_down", "trade_status"))


def _is_safe(row: Mapping[str, Any]) -> bool:
    status = str(_value(row, "trade_status") or "").strip().lower()
    return bool(
        _value(row, "is_st") is False
        and _value(row, "is_limit_up") is False
        and _value(row, "is_limit_down") is False
        and status in SAFE_TRADE_STATUSES
    )


def _row_date(row: Mapping[str, Any]) -> str | None:
    value = row.get("trade_date") or row.get("latest_trade_date")
    return str(value) if value not in (None, "") else None


def _eligibility_reasons(row: Mapping[str, Any], target_date: str | None) -> list[str]:
    reasons: list[str] = []
    exchange = str(row.get("exchange") or "UNKNOWN").upper()
    code = str(row.get("code") or "")
    name = str(row.get("name") or "")
    if row.get("asset_type", "stock") != "stock":
        reasons.append("non_stock_asset")
    if exchange == "BJ":
        reasons.append("unsupported_exchange")
    if code.startswith(("688", "8", "4")):
        reasons.append("unsupported_board")
    if "ST" in name.upper():
        reasons.append("name_st_marker")
    row_date = _row_date(row)
    if row_date is None:
        reasons.append("missing_latest_bar")
    elif target_date and row_date != target_date:
        reasons.append("stale_latest_bar")
    if int(row.get("sample_count") or 0) < 20:
        reasons.append("insufficient_history")
    if _value(row, "close") is None:
        reasons.append("missing_close")
    fields = (("is_st", "missing_is_st"), ("is_limit_up", "missing_limit_up"), ("is_limit_down", "missing_limit_down"))
    for field_name, missing_reason in fields:
        current = _value(row, field_name)
        if current is None:
            reasons.append(missing_reason)
        elif current is True:
            reasons.append(field_name)
    status = _value(row, "trade_status")
    if status in (None, ""):
        reasons.append("missing_trade_status")
    elif str(status).strip().lower() not in SAFE_TRADE_STATUSES:
        reasons.append("unsafe_trade_status")
    return reasons


def _score(row: Mapping[str, Any]) -> float:
    close = _value(row, "close")
    open_price = row.get("open")
    previous_close = row.get("previous_close")
    amount = _value(row, "amount")
    ratio = _value(row, "amount_ratio_20d")
    strength = _value(row, "return_20d_pct")
    score = 0.0
    mas = [_value(row, name) for name in ("ma5", "ma10", "ma20", "ma30", "ma60")]
    if all(value is not None for value in mas) and mas == sorted(mas, reverse=True):
        score += 28
    elif all(value is not None for value in (mas[0], mas[1], mas[2], mas[4])) and mas[0] >= mas[1] >= mas[2] >= mas[4]:
        score += 20
    if close is not None and _value(row, "ma5") is not None and close >= _value(row, "ma5"):
        score += 12
        if _value(row, "ma5") and close / _value(row, "ma5") > 1.12:
            score -= 6
    if strength is not None:
        score += max(0.0, min(18.0, float(strength) / 2.0))
    if ratio is not None:
        score += max(0.0, min(16.0, float(ratio) * 5.0))
    if _value(row, "change_pct") is not None and _value(row, "change_pct") > 0:
        score += 8
    if open_price is not None and previous_close is not None and open_price > previous_close:
        score += 6
    if row.get("previous_change_pct") is not None and row["previous_change_pct"] >= 0:
        score += 4
    if int(_value(row, "limit_up_count_4d") or 0) > 0:
        score += 10
    elif int(_value(row, "limit_up_count_10d") or 0) > 0:
        score += 5
    return round(score, 2)


def _preset_matches(row: Mapping[str, Any], mode: str) -> bool:
    close = _value(row, "close")
    ma5, ma10, ma20, ma30, ma60 = (_value(row, name) for name in ("ma5", "ma10", "ma20", "ma30", "ma60"))
    amount = _value(row, "amount")
    ratio = _value(row, "amount_ratio_20d")
    change = _value(row, "change_pct")
    strength = _value(row, "return_20d_pct")
    has_liquidity = amount is not None and amount >= 100_000_000
    stack60 = all(value is not None for value in (ma5, ma10, ma20, ma30, ma60)) and ma5 >= ma10 >= ma20 >= ma30 >= ma60
    stack20 = all(value is not None for value in (ma5, ma10, ma20)) and ma5 >= ma10 >= ma20
    close_above_ma5 = close is not None and ma5 is not None and close >= ma5
    if mode == "limit_up_relay":
        return bool(
            int(_value(row, "limit_up_count_4d") or 0) >= 1
            and stack60
            and close_above_ma5
            and row.get("open") is not None
            and row.get("previous_close") is not None
            and row["open"] > row["previous_close"]
            and change is not None
            and change > 0
            and row.get("previous_change_pct") is not None
            and row["previous_change_pct"] >= 0
            and has_liquidity
        )
    if mode == "trend_liquidity":
        return bool(stack20 and close_above_ma5 and strength is not None and strength > 0 and ratio is not None and ratio >= 1.1 and has_liquidity)
    return bool(
        has_liquidity
        and close_above_ma5
        and change is not None
        and change > 0
        and (stack60 or int(_value(row, "limit_up_count_4d") or 0) >= 1 or (strength is not None and strength >= 8 and ratio is not None and ratio >= 1.2))
    )


def _candidate(row: Mapping[str, Any], matched_conditions: list[dict[str, Any]], mode: str) -> dict[str, Any]:
    key_fields = {name: _value(row, name) for name in sorted(ALLOWED_FIELDS)}
    warnings: list[str] = []
    if int(row.get("sample_count") or 0) < 60:
        warnings.append("less than 60 daily bars; MA60 stability is limited")
    if _value(row, "amount") is None:
        warnings.append("missing amount; liquidity interpretation is incomplete")
    if _value(row, "turnover") is None:
        warnings.append("missing turnover")
    candidate = {
        "symbol": row.get("symbol", ""),
        "code": row.get("code", ""),
        "name": row.get("name", ""),
        "exchange": row.get("exchange", "UNKNOWN"),
        "asset_type": row.get("asset_type", "stock"),
        "board": row.get("board", ""),
        "trade_date": _row_date(row),
        "values": key_fields,
        "matched_conditions": matched_conditions,
        "mode": mode,
        "score": _score(row),
        "warnings": warnings,
        "missing_fields": [field_name for field_name, value in key_fields.items() if value is None],
        "risk_warning": "screener match is not an investment recommendation",
    }
    # Keep the evidence both grouped and directly addressable for clients
    # that render tabular candidates without knowing the nested contract.
    candidate.update(key_fields)
    return candidate


def _condition_match(row: Mapping[str, Any], condition: Condition) -> bool:
    left = _value(row, condition.field)
    if left is None:
        return False
    right = _value(row, condition.right_field) if condition.right_field else condition.value
    if right is None:
        return False
    try:
        if condition.op == "eq":
            return left == right
        if condition.op == "gt":
            return left > right
        if condition.op == "gte":
            return left >= right
        if condition.op == "lt":
            return left < right
        if condition.op == "lte":
            return left <= right
        return right[0] <= left <= right[1]
    except (TypeError, IndexError):
        return False


def _sort_key(row: Mapping[str, Any], field_name: str) -> tuple[int, Any]:
    value = _value(row, field_name)
    return (value is None, value if value is not None else 0)


@dataclass(frozen=True)
class ScreenerResponse:
    universe_id: str
    mode: str | None
    trade_date: str | None
    timeframe: str
    adjustment: str
    total_symbols: int
    scanned_symbols: int
    eligible_symbols: int
    excluded_symbols: int
    excluded_reasons: dict[str, int]
    safety_complete_symbols: int
    safety_coverage_pct: float
    coverage_warning: str | None
    conditions: tuple[dict[str, Any], ...]
    sort: tuple[dict[str, str], ...]
    matched_count: int
    candidates: list[dict[str, Any]]
    source: str
    data_basis: str
    fetched_at: str
    data_quality: DataQuality
    status: str = "completed"
    empty_result: bool = False

    def as_dict(self) -> dict[str, Any]:
        return {
            "universe_id": self.universe_id,
            "mode": self.mode,
            "trade_date": self.trade_date,
            "timeframe": self.timeframe,
            "adjustment": self.adjustment,
            "total_symbols": self.total_symbols,
            "scanned_symbols": self.scanned_symbols,
            "eligible_symbols": self.eligible_symbols,
            "excluded_symbols": self.excluded_symbols,
            "excluded_reasons": self.excluded_reasons,
            "safety_complete_symbols": self.safety_complete_symbols,
            "safety_coverage_pct": self.safety_coverage_pct,
            "coverage_pct": self.safety_coverage_pct,
            "coverage_warning": self.coverage_warning,
            "conditions": list(self.conditions),
            "sort": list(self.sort),
            "matched_count": self.matched_count,
            "total_candidates": self.matched_count,
            "candidates": self.candidates,
            "source": self.source,
            "data_basis": self.data_basis,
            "analytics": {"engine": "sqlite", "status": "disabled", "basis": self.data_basis},
            "fetched_at": self.fetched_at,
            "data_quality": self.data_quality.as_dict(),
            "status": self.status,
            "empty_result": self.empty_result,
        }


class Screener:
    def __init__(self, store: MarketStore | None = None):
        self.store = store

    def screen_fixed(
        self,
        mode: str,
        *,
        universe_id: str = DEFAULT_UNIVERSE_ID,
        as_of: str | None = None,
        limit: int = 10,
        rows: Iterable[Mapping[str, Any]] | None = None,
    ) -> ScreenerResponse:
        if mode not in MODES:
            raise ScreenerValidationError(f"unsupported screener mode: {mode}")
        if isinstance(limit, bool) or not isinstance(limit, int) or not 1 <= limit <= 20:
            raise ScreenerValidationError("limit must be an integer between 1 and 20")
        if rows is None:
            if self.store is None:
                raise ScreenerValidationError("a MarketStore or fixture rows is required")
            rows = self.store.latest_feature_rows(universe_id, trade_date=as_of)
        return self._execute(list(rows), universe_id=universe_id, as_of=as_of, mode=mode, conditions=(), sort=(), limit=limit)

    def screen(self, request: ScreenRequest | Mapping[str, Any], *, rows: Iterable[Mapping[str, Any]] | None = None) -> ScreenerResponse:
        normalized = request if isinstance(request, ScreenRequest) else ScreenRequest.from_mapping(request)
        if rows is None:
            if self.store is None:
                raise ScreenerValidationError("a MarketStore or fixture rows is required")
            rows = self.store.latest_feature_rows(normalized.universe_id, trade_date=normalized.as_of)
        return self._execute(
            list(rows),
            universe_id=normalized.universe_id,
            as_of=normalized.as_of,
            mode=None,
            conditions=normalized.conditions,
            sort=normalized.sort,
            limit=normalized.limit,
        )

    def _execute(
        self,
        rows: list[Mapping[str, Any]],
        *,
        universe_id: str,
        as_of: str | None,
        mode: str | None,
        conditions: tuple[Condition, ...],
        sort: tuple[SortSpec, ...],
        limit: int,
    ) -> ScreenerResponse:
        dates = [value for value in (_row_date(row) for row in rows) if value]
        target_date = as_of or (max(dates) if dates else None)
        eligible: list[Mapping[str, Any]] = []
        excluded_reasons: dict[str, int] = {}
        safety_complete = 0
        for row in rows:
            if _safety_fields_complete(row):
                safety_complete += 1
            reasons = _eligibility_reasons(row, target_date)
            if not reasons:
                eligible.append(row)
            for reason in set(reasons):
                excluded_reasons[reason] = excluded_reasons.get(reason, 0) + 1
        safety_pct = round(safety_complete / len(rows) * 100.0, 2) if rows else 0.0
        warning: str | None = None
        if rows and safety_pct < SAFE_COVERAGE_MIN_PCT:
            warning = f"safety fields cover {safety_complete}/{len(rows)} symbols ({safety_pct:.2f}%), below {SAFE_COVERAGE_MIN_PCT:.0f}%"
        if rows and len(set(dates)) > 1 and as_of is None:
            warning = warning or "symbols do not share one latest trade date"
        matched: list[tuple[Mapping[str, Any], list[dict[str, Any]]]] = []
        for row in eligible:
            if mode is not None:
                if _preset_matches(row, mode):
                    matched.append((row, [{"preset": mode}]))
            else:
                matched_values: list[dict[str, Any]] = []
                for condition in conditions:
                    if not _condition_match(row, condition):
                        break
                    matched_values.append({**condition.as_dict(), "actual": _value(row, condition.field)})
                else:
                    matched.append((row, matched_values))
        if mode is not None:
            default_sort = (SortSpec("return_20d_pct", "desc"), SortSpec("amount", "desc"), SortSpec("symbol", "asc"))
            sort = default_sort
        for spec in reversed(sort):
            matched.sort(key=lambda pair: _sort_key(pair[0], spec.field), reverse=spec.direction == "desc")
        candidates = [_candidate(row, values, mode or "custom") for row, values in matched[:limit]]
        status = "insufficient_evidence" if warning else "completed"
        quality_warnings = [warning] if warning else []
        if not candidates:
            quality_warnings.append("no symbol matched all conditions" if not warning else "candidate result withheld because coverage is insufficient")
        quality = DataQuality(
            status="warning" if quality_warnings else "ok",
            missing_fields=["candidates"] if not candidates else (),
            warnings=tuple(quality_warnings),
        )
        return ScreenerResponse(
            universe_id=universe_id,
            mode=mode,
            trade_date=target_date,
            timeframe="daily",
            adjustment="qfq",
            total_symbols=len(rows),
            scanned_symbols=len(rows),
            eligible_symbols=len(eligible),
            excluded_symbols=len(rows) - len(eligible),
            excluded_reasons=dict(sorted(excluded_reasons.items())),
            safety_complete_symbols=safety_complete,
            safety_coverage_pct=safety_pct,
            coverage_warning=warning,
            conditions=tuple(item.as_dict() for item in conditions),
            sort=tuple(item.as_dict() for item in sort),
            matched_count=len(matched),
            candidates=candidates,
            source="sqlite",
            data_basis="sqlite.market_daily_features",
            fetched_at=utc_now(),
            data_quality=quality,
            status=status,
            empty_result=not matched and not warning,
        )


def screen_stocks(
    request: ScreenRequest | Mapping[str, Any] | None = None,
    *,
    rows: Iterable[Mapping[str, Any]] | None = None,
    store: MarketStore | None = None,
    mode: str = "short_term",
    universe_id: str = DEFAULT_UNIVERSE_ID,
    as_of: str | None = None,
    limit: int = 10,
) -> ScreenerResponse:
    """Tool-shaped entrypoint for fixed modes and custom DSL requests."""
    service = Screener(store)
    if request is not None:
        return service.screen(request, rows=rows)
    return service.screen_fixed(mode, universe_id=universe_id, as_of=as_of, limit=limit, rows=rows)


validate_dsl = ScreenRequest.from_mapping
ScreenerRequest = ScreenRequest
execute_screener = screen_stocks


__all__ = [
    "ALLOWED_FIELDS",
    "ALLOWED_OPERATORS",
    "Condition",
    "MODES",
    "ScreenRequest",
    "Screener",
    "ScreenerResponse",
    "ScreenerValidationError",
    "ScreenerRequest",
    "SortSpec",
    "screen_stocks",
    "execute_screener",
    "validate_dsl",
    "validate_condition",
    "validate_sort",
]
