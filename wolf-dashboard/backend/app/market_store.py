"""SQLite persistence and deterministic fixture/market synchronization."""

from __future__ import annotations

import json
import uuid
from dataclasses import dataclass, field, replace
from datetime import date
from typing import Any, Callable, Iterable, Mapping

from .db import Database
from .market_data import (
    DailyBar,
    Security,
    TechnicalFeatures,
    compute_features,
    json_dumps,
    utc_now,
)


DEFAULT_UNIVERSE_ID = "a-share"


def _as_bool(value: Any) -> bool | None:
    if value is None:
        return None
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return bool(value)
    text = str(value).strip().lower()
    if text in {"1", "true", "yes", "y"}:
        return True
    if text in {"0", "false", "no", "n"}:
        return False
    return None


def _json_object(value: Any) -> dict[str, Any]:
    if isinstance(value, Mapping):
        return dict(value)
    if not value:
        return {}
    try:
        decoded = json.loads(str(value))
    except (TypeError, ValueError):
        return {}
    return dict(decoded) if isinstance(decoded, Mapping) else {}


def _security_from_row(row: Mapping[str, Any]) -> Security:
    return Security(
        symbol=str(row["symbol"]),
        code=str(row["code"]),
        name=str(row["name"] or row["code"]),
        asset_type=str(row["asset_type"] or "stock"),
        exchange=str(row["exchange"] or "UNKNOWN").upper(),
        board=str(row["board"] or ""),
        universe_id=str(row["universe_id"] or DEFAULT_UNIVERSE_ID),
        is_st=_as_bool(row["is_st"]),
        enabled=bool(row["enabled"]),
        status=str(row["status"] or "active"),
        source=str(row["source"] or "local"),
        metadata=_json_object(row["metadata_json"]),
    )


def _bar_from_row(row: Mapping[str, Any]) -> DailyBar:
    return DailyBar(
        trade_date=str(row["trade_date"]),
        open=row["open"],
        high=row["high"],
        low=row["low"],
        close=row["close"],
        volume=row["volume"],
        amount=row["amount"],
        previous_close=row["previous_close"],
        turnover=row["turnover"],
        change_pct=row["change_pct"],
        trade_status=row["trade_status"],
        is_st=_as_bool(row["is_st"]),
        is_limit_up=_as_bool(row["limit_up"]),
        is_limit_down=_as_bool(row["limit_down"]),
        symbol=str(row["symbol"]),
        source=str(row["source"] or "local"),
        adjustment=str(row["adjustment"] or "qfq"),
        fetched_at=str(row["fetched_at"] or ""),
        metadata=_json_object(row["metadata_json"]),
    )


def _feature_from_row(row: Mapping[str, Any]) -> TechnicalFeatures:
    fields = TechnicalFeatures.__dataclass_fields__
    row_keys = set(row.keys()) if hasattr(row, "keys") else set(row)
    values: dict[str, Any] = {}
    for name in fields:
        if name == "metadata":
            values[name] = _json_object(row["feature_metadata_json"] if "feature_metadata_json" in row_keys else row["metadata_json"])
        elif name == "source" and "feature_source" in row_keys:
            values[name] = row["feature_source"]
        elif name in row_keys:
            values[name] = row[name]
        elif name not in {"source", "fetched_at"}:
            values[name] = None
    values.setdefault("source", "local")
    values.setdefault("fetched_at", "")
    values["symbol"] = str(row["symbol"])
    values["trade_date"] = str(row["trade_date"])
    values["adjustment"] = str(row["adjustment"] or "qfq")
    values["sample_count"] = int(row["sample_count"] or 0) if "sample_count" in row else int(values.get("sample_count") or 0)
    for key in ("is_st", "is_limit_up", "is_limit_down"):
        values[key] = _as_bool(values.get(key))
    return TechnicalFeatures(**values)


@dataclass(frozen=True)
class SyncResult:
    run_id: str
    universe_id: str
    operation: str
    source: str
    status: str
    total_symbols: int
    succeeded_symbols: int
    failed_symbols: int
    rows_written: int
    coverage_pct: float
    first_trade_date: str | None = None
    last_trade_date: str | None = None
    errors: dict[str, str] = field(default_factory=dict)
    started_at: str = ""
    finished_at: str = ""

    def as_dict(self) -> dict[str, Any]:
        return {
            "run_id": self.run_id,
            "universe_id": self.universe_id,
            "operation": self.operation,
            "source": self.source,
            "status": self.status,
            "total_symbols": self.total_symbols,
            "succeeded_symbols": self.succeeded_symbols,
            "failed_symbols": self.failed_symbols,
            "rows_written": self.rows_written,
            "coverage_pct": self.coverage_pct,
            "first_trade_date": self.first_trade_date,
            "last_trade_date": self.last_trade_date,
            "errors": dict(self.errors),
            "started_at": self.started_at,
            "finished_at": self.finished_at,
        }


class MarketStore:
    """Repository for local symbols, bars, and derived features."""

    def __init__(self, db: Database):
        self.db = db
        self.db.init()

    def upsert_symbols(self, symbols: Iterable[Security]) -> int:
        now = utc_now()
        count = 0
        with self.db.transaction() as conn:
            for item in symbols:
                conn.execute(
                    """
                    INSERT INTO market_symbols(
                      symbol, code, name, exchange, asset_type, board,
                      universe_id, is_st, enabled, status, source,
                      created_at, updated_at, metadata_json
                    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)
                    ON CONFLICT(symbol) DO UPDATE SET
                      code=excluded.code, name=excluded.name,
                      exchange=excluded.exchange, asset_type=excluded.asset_type,
                      board=excluded.board, universe_id=excluded.universe_id,
                      is_st=excluded.is_st, enabled=excluded.enabled,
                      status=excluded.status, source=excluded.source,
                      updated_at=excluded.updated_at, metadata_json=excluded.metadata_json
                    """,
                    (
                        item.symbol,
                        item.code,
                        item.name,
                        item.exchange,
                        item.asset_type,
                        item.board,
                        item.universe_id,
                        None if item.is_st is None else int(item.is_st),
                        int(item.enabled),
                        item.status,
                        item.source,
                        now,
                        now,
                        json_dumps(item.metadata),
                    ),
                )
                count += 1
        return count

    def get_symbol(self, symbol: str) -> Security | None:
        row = self.db.one("SELECT * FROM market_symbols WHERE symbol=?", (symbol.lower(),))
        return _security_from_row(row) if row else None

    def list_symbols(
        self,
        universe_id: str = DEFAULT_UNIVERSE_ID,
        *,
        enabled_only: bool = True,
        asset_type: str | None = None,
    ) -> list[Security]:
        clauses = ["universe_id=?"]
        params: list[Any] = [universe_id]
        if enabled_only:
            clauses.append("enabled=1")
        if asset_type:
            clauses.append("asset_type=?")
            params.append(asset_type)
        rows = self.db.query(
            f"SELECT * FROM market_symbols WHERE {' AND '.join(clauses)} ORDER BY symbol",
            tuple(params),
        )
        return [_security_from_row(row) for row in rows]

    def upsert_bars(
        self,
        symbol: str,
        bars: Iterable[DailyBar],
        *,
        adjustment: str = "qfq",
    ) -> int:
        rows = list(bars)
        if any(bar.symbol and bar.symbol != symbol for bar in rows):
            raise ValueError("bar symbol does not match requested symbol")
        if any(bar.adjustment != adjustment for bar in rows):
            raise ValueError("bar adjustment does not match requested adjustment")
        fetched_at = utc_now()
        with self.db.transaction() as conn:
            for bar in rows:
                conn.execute(
                    """
                    INSERT INTO market_daily_bars(
                      symbol, trade_date, timeframe, adjustment, open, high,
                      low, close, previous_close, volume, amount, turnover,
                      change_pct, trade_status, is_st, limit_up, limit_down,
                      source, fetched_at, metadata_json
                    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
                    ON CONFLICT(symbol, trade_date, timeframe, adjustment) DO UPDATE SET
                      open=excluded.open, high=excluded.high, low=excluded.low,
                      close=excluded.close, previous_close=excluded.previous_close,
                      volume=excluded.volume, amount=excluded.amount,
                      turnover=excluded.turnover, change_pct=excluded.change_pct,
                      trade_status=excluded.trade_status, is_st=excluded.is_st,
                      limit_up=excluded.limit_up, limit_down=excluded.limit_down,
                      source=excluded.source, fetched_at=excluded.fetched_at,
                      metadata_json=excluded.metadata_json
                    """,
                    (
                        symbol,
                        bar.trade_date,
                        "daily",
                        adjustment,
                        bar.open,
                        bar.high,
                        bar.low,
                        bar.close,
                        bar.previous_close,
                        bar.volume,
                        bar.amount,
                        bar.turnover,
                        bar.change_pct,
                        bar.trade_status,
                        None if bar.is_st is None else int(bar.is_st),
                        None if bar.is_limit_up is None else int(bar.is_limit_up),
                        None if bar.is_limit_down is None else int(bar.is_limit_down),
                        bar.source,
                        bar.fetched_at or fetched_at,
                        json_dumps(bar.metadata),
                    ),
                )
        return len(rows)

    def bars(
        self,
        symbol: str,
        *,
        adjustment: str = "qfq",
        limit: int = 240,
        as_of: str | None = None,
    ) -> list[DailyBar]:
        clauses = ["symbol=?", "timeframe='daily'", "adjustment=?"]
        params: list[Any] = [symbol.lower(), adjustment]
        if as_of:
            clauses.append("trade_date<=?")
            params.append(as_of)
        safe_limit = max(1, min(int(limit), 800))
        rows = self.db.query(
            f"SELECT * FROM market_daily_bars WHERE {' AND '.join(clauses)} ORDER BY trade_date DESC LIMIT ?",
            tuple([*params, safe_limit]),
        )
        return list(reversed([_bar_from_row(row) for row in rows]))

    def save_features(self, features: TechnicalFeatures) -> None:
        values = features.as_dict()
        with self.db.transaction() as conn:
            conn.execute(
                """
                INSERT INTO market_daily_features(
                  symbol, trade_date, timeframe, adjustment, ma5, ma10, ma20,
                  ma30, ma60, return_5d_pct, return_10d_pct, return_20d_pct,
                  return_60d_pct, amount_ratio_20d, volatility_20d_pct,
                  max_drawdown_20d_pct, max_drawdown_60d_pct, limit_up_count_4d,
                  limit_up_count_10d, close, amount, turnover, change_pct, is_st,
                  is_limit_up, is_limit_down, trade_status, sample_count, source, fetched_at,
                  metadata_json
                ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
                ON CONFLICT(symbol, trade_date, timeframe, adjustment) DO UPDATE SET
                  ma5=excluded.ma5, ma10=excluded.ma10, ma20=excluded.ma20,
                  ma30=excluded.ma30, ma60=excluded.ma60,
                  return_5d_pct=excluded.return_5d_pct,
                  return_10d_pct=excluded.return_10d_pct,
                  return_20d_pct=excluded.return_20d_pct,
                  return_60d_pct=excluded.return_60d_pct,
                  amount_ratio_20d=excluded.amount_ratio_20d,
                  volatility_20d_pct=excluded.volatility_20d_pct,
                  max_drawdown_20d_pct=excluded.max_drawdown_20d_pct,
                  max_drawdown_60d_pct=excluded.max_drawdown_60d_pct,
                  limit_up_count_4d=excluded.limit_up_count_4d,
                  limit_up_count_10d=excluded.limit_up_count_10d,
                  close=excluded.close, amount=excluded.amount,
                  turnover=excluded.turnover, change_pct=excluded.change_pct,
                  is_st=excluded.is_st, is_limit_up=excluded.is_limit_up,
                  is_limit_down=excluded.is_limit_down,
                  trade_status=excluded.trade_status, sample_count=excluded.sample_count,
                  source=excluded.source,
                  fetched_at=excluded.fetched_at, metadata_json=excluded.metadata_json
                """,
                (
                    values["symbol"],
                    values["trade_date"],
                    "daily",
                    values["adjustment"],
                    values["ma5"],
                    values["ma10"],
                    values["ma20"],
                    values["ma30"],
                    values["ma60"],
                    values["return_5d_pct"],
                    values["return_10d_pct"],
                    values["return_20d_pct"],
                    values["return_60d_pct"],
                    values["amount_ratio_20d"],
                    values["volatility_20d_pct"],
                    values["max_drawdown_20d_pct"],
                    values["max_drawdown_60d_pct"],
                    values["limit_up_count_4d"],
                    values["limit_up_count_10d"],
                    values["close"],
                    values["amount"],
                    values["turnover"],
                    values["change_pct"],
                    None if values["is_st"] is None else int(values["is_st"]),
                    None if values["is_limit_up"] is None else int(values["is_limit_up"]),
                    None if values["is_limit_down"] is None else int(values["is_limit_down"]),
                     values["trade_status"],
                     values["sample_count"],
                     values["source"],
                    values["fetched_at"] or utc_now(),
                    json_dumps(values["metadata"]),
                ),
            )

    def features(
        self,
        universe_id: str = DEFAULT_UNIVERSE_ID,
        *,
        trade_date: str | None = None,
        adjustment: str = "qfq",
        asset_type: str = "stock",
    ) -> list[tuple[Security, TechnicalFeatures]]:
        clauses = ["s.universe_id=?", "s.enabled=1", "s.asset_type=?", "f.adjustment=?"]
        params: list[Any] = [universe_id, asset_type, adjustment]
        date_filter = ""
        join_params: list[Any] = [adjustment, adjustment]
        if trade_date:
            date_filter = " AND f2.trade_date<=?"
            join_params.append(trade_date)
        rows = self.db.query(
            f"""
            SELECT s.*, f.*, f.source AS feature_source,
                   f.metadata_json AS feature_metadata_json FROM market_symbols s
            LEFT JOIN market_daily_features f
              ON f.symbol=s.symbol AND f.adjustment=?
             AND f.trade_date=(
               SELECT MAX(f2.trade_date) FROM market_daily_features f2
               WHERE f2.symbol=s.symbol AND f2.adjustment=?{date_filter}
             )
            WHERE {' AND '.join(clauses)}
            ORDER BY s.symbol
            """,
            tuple([*join_params, *params]),
        )
        result: list[tuple[Security, TechnicalFeatures]] = []
        for row in rows:
            if row["trade_date"] is None:
                continue
            result.append((_security_from_row(row), _feature_from_row(row)))
        return result

    def latest_feature_rows(
        self,
        universe_id: str = DEFAULT_UNIVERSE_ID,
        *,
        trade_date: str | None = None,
        adjustment: str = "qfq",
        asset_type: str = "stock",
    ) -> list[dict[str, Any]]:
        pairs = self.features(
            universe_id,
            trade_date=trade_date,
            adjustment=adjustment,
            asset_type=asset_type,
        )
        rows: list[dict[str, Any]] = []
        for security, feature in pairs:
            value = security.as_dict()
            value.update(feature.as_dict())
            latest_bars = self.bars(security.symbol, adjustment=adjustment, limit=2, as_of=trade_date)
            if latest_bars:
                latest = latest_bars[-1]
                value.update(
                    {
                        "open": latest.open,
                        "high": latest.high,
                        "low": latest.low,
                        "previous_close": latest.previous_close,
                    }
                )
            rows.append(value)
        return rows

    def universe_summary(self, universe_id: str = DEFAULT_UNIVERSE_ID) -> dict[str, Any]:
        symbols = self.list_symbols(universe_id)
        latest_dates: list[str] = []
        ready = 0
        bars_total = 0
        common_dates: set[str] | None = None
        for security in symbols:
            rows = self.db.query(
                "SELECT trade_date FROM market_daily_bars WHERE symbol=? AND adjustment='qfq' ORDER BY trade_date",
                (security.symbol,),
            )
            dates = {str(row["trade_date"]) for row in rows}
            bars_total += len(dates)
            if dates:
                ready += 1
                latest_dates.append(max(dates))
                common_dates = dates if common_dates is None else common_dates & dates
        total = len(symbols)
        coverage = round(ready / total * 100.0, 2) if total else 0.0
        return {
            "id": universe_id,
            "name": universe_id,
            "member_count": total,
            "stock_count": sum(item.asset_type == "stock" for item in symbols),
            "etf_count": sum(item.asset_type == "etf" for item in symbols),
            "index_count": sum(item.asset_type == "index" for item in symbols),
            "ready_count": ready,
            "bar_count": bars_total,
            "latest_trade_date": max(latest_dates) if latest_dates else None,
            "common_trade_dates": sorted(common_dates or set()),
            "coverage_pct": coverage,
            "source": "sqlite",
            "data_basis": "sqlite.market_daily_bars",
            "data_quality": {
                "status": "ok" if coverage == 100.0 else "warning",
                "missing_fields": [] if ready else ["bars"],
                "warnings": [] if coverage == 100.0 else ["unavailable symbol history reduces coverage"],
            },
        }

    def universe_members(
        self,
        universe_id: str = DEFAULT_UNIVERSE_ID,
        *,
        page: int = 1,
        page_size: int = 50,
    ) -> dict[str, Any]:
        symbols = self.list_symbols(universe_id)
        safe_page = max(1, int(page))
        safe_size = max(1, min(int(page_size), 200))
        start = (safe_page - 1) * safe_size
        items = []
        for item in symbols[start : start + safe_size]:
            bars = self.bars(item.symbol, limit=1)
            items.append(
                {
                    **item.as_dict(),
                    "data_status": "ready" if bars else "missing",
                    "last_trade_date": bars[-1].trade_date if bars else None,
                    "bar_count": len(self.bars(item.symbol, limit=800)),
                }
            )
        return {
            "universe_id": universe_id,
            "page": safe_page,
            "page_size": safe_size,
            "total": len(symbols),
            "total_pages": max(1, (len(symbols) + safe_size - 1) // safe_size),
            "members": items,
            "data_basis": "sqlite.market_symbols",
            "source": "sqlite",
            "fetched_at": utc_now(),
        }


class MarketSyncService:
    """Explicit, fixture-friendly initialization and incremental sync entrypoint."""

    def __init__(self, store: MarketStore, provider: Any | None = None):
        self.store = store
        self.provider = provider

    def sync(
        self,
        symbols: Iterable[Security],
        *,
        universe_id: str = DEFAULT_UNIVERSE_ID,
        bars_by_symbol: Mapping[str, Iterable[DailyBar]] | None = None,
        adjustment: str = "qfq",
        history_limit: int = 800,
        operation: str = "manual",
        source: str | None = None,
        progress: Callable[[int, int, Security, str | None], None] | None = None,
    ) -> SyncResult:
        started_at = utc_now()
        run_id = uuid.uuid4().hex
        safe_history_limit = max(1, min(int(history_limit), 800))
        symbols_list = [
            item if item.universe_id == universe_id else replace(item, universe_id=universe_id)
            for item in symbols
        ]
        self.store.upsert_symbols(symbols_list)
        errors: dict[str, str] = {}
        rows_written = 0
        succeeded = 0
        all_dates: list[str] = []
        with self.store.db.transaction() as conn:
            conn.execute(
                """
                INSERT INTO market_sync_runs(
                  id, universe_id, operation, source, status, total_symbols,
                  started_at
                ) VALUES(?,?,?,?,?,?,?)
                """,
                (run_id, universe_id, operation, source or "fixture", "running", len(symbols_list), started_at),
            )
        for index, security in enumerate(symbols_list, start=1):
            error_message: str | None = None
            try:
                if bars_by_symbol is not None:
                    raw_bars = bars_by_symbol.get(security.symbol)
                    if raw_bars is None:
                        raise ValueError("fixture did not provide bars")
                    bars = list(raw_bars)
                elif self.provider is not None:
                    bars = list(
                        self.provider.history(
                            security.symbol,
                            adjustment=adjustment,
                            limit=safe_history_limit,
                        )
                    )
                else:
                    raise ValueError("no fixture bars or market provider configured")
                if not bars:
                    raise ValueError("provider returned no bars")
                rows_written += self.store.upsert_bars(security.symbol, bars, adjustment=adjustment)
                ordered_bars = sorted(bars, key=lambda item: item.trade_date)
                for end_index in range(len(ordered_bars)):
                    feature = compute_features(
                        ordered_bars[: end_index + 1],
                        symbol=security.symbol,
                        adjustment=adjustment,
                    )
                    self.store.save_features(feature)
                succeeded += 1
                all_dates.extend(bar.trade_date for bar in bars)
            except Exception as exc:
                error_message = str(exc)
                errors[security.symbol] = error_message
            if progress is not None:
                progress(index, len(symbols_list), security, error_message)
        finished_at = utc_now()
        total = len(symbols_list)
        failed = total - succeeded
        coverage = round(succeeded / total * 100.0, 2) if total else 0.0
        status = "completed" if total and not failed else ("partial" if succeeded else "failed")
        with self.store.db.transaction() as conn:
            conn.execute(
                """
                UPDATE market_sync_runs SET status=?, succeeded_symbols=?,
                  failed_symbols=?, rows_written=?, coverage_pct=?,
                  first_trade_date=?, last_trade_date=?, error_json=?, finished_at=?
                WHERE id=?
                """,
                (
                    status,
                    succeeded,
                    failed,
                    rows_written,
                    coverage,
                    min(all_dates) if all_dates else None,
                    max(all_dates) if all_dates else None,
                    json_dumps(errors),
                    finished_at,
                    run_id,
                ),
            )
        return SyncResult(
            run_id=run_id,
            universe_id=universe_id,
            operation=operation,
            source=source or "fixture",
            status=status,
            total_symbols=total,
            succeeded_symbols=succeeded,
            failed_symbols=failed,
            rows_written=rows_written,
            coverage_pct=coverage,
            first_trade_date=min(all_dates) if all_dates else None,
            last_trade_date=max(all_dates) if all_dates else None,
            errors=errors,
            started_at=started_at,
            finished_at=finished_at,
        )


def initialize_market(
    store: MarketStore,
    symbols: Iterable[Security],
    *,
    bars_by_symbol: Mapping[str, Iterable[DailyBar]] | None = None,
    provider: Any | None = None,
    universe_id: str = DEFAULT_UNIVERSE_ID,
    adjustment: str = "qfq",
    history_limit: int = 800,
    source: str | None = None,
    progress: Callable[[int, int, Security, str | None], None] | None = None,
) -> SyncResult:
    """Explicit hand-invoked initialization; never called from app startup."""
    return MarketSyncService(store, provider).sync(
        symbols,
        universe_id=universe_id,
        bars_by_symbol=bars_by_symbol,
        adjustment=adjustment,
        history_limit=history_limit,
        operation="initialize",
        source=source or ("fixture" if bars_by_symbol is not None else "tencent"),
        progress=progress,
    )


MarketDataStore = MarketStore
MarketSynchronizer = MarketSyncService
sync_market = initialize_market


__all__ = [
    "DEFAULT_UNIVERSE_ID",
    "MarketStore",
    "MarketDataStore",
    "MarketSyncService",
    "MarketSynchronizer",
    "SyncResult",
    "initialize_market",
    "sync_market",
]
