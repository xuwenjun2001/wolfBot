"""SQLite persistence for board identity, membership, and snapshots.

Mirrors :class:`~.market_store.MarketStore`: this module owns writes and reads,
never provider I/O.  Membership rows are stored with an explicit validity range
so a board's constituents can be read as of a trade date instead of silently
mixing today's membership with an older session's quotes.
"""

from __future__ import annotations

import json
from typing import Any, Iterable, Mapping

from .db import Database
from .market_boards import (
    Board,
    BoardBreadth,
    BoardMember,
    BoardSnapshot,
    normalize_board_name,
)
from .market_data import DataQuality, json_dumps, utc_now


def _json_list(value: Any) -> list[str]:
    if isinstance(value, (list, tuple)):
        return [str(item) for item in value]
    if not value:
        return []
    try:
        decoded = json.loads(str(value))
    except (TypeError, ValueError):
        return []
    return [str(item) for item in decoded] if isinstance(decoded, list) else []


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


def _board_from_row(row: Mapping[str, Any]) -> Board:
    return Board(
        id=str(row["id"]),
        provider=str(row["provider"]),
        provider_board_code=str(row["provider_board_code"]),
        name=str(row["name"]),
        board_type=str(row["board_type"] or "concept"),
        normalized_name=str(row["normalized_name"] or ""),
        aliases=tuple(_json_list(row["aliases_json"])),
        definition=str(row["definition"] or ""),
        constituent_basis=str(row["constituent_basis"] or "provider-defined"),
        source_ref=str(row["source_ref"] or ""),
        active=bool(row["active"]),
        fetched_at=str(row["fetched_at"] or ""),
        updated_at=str(row["updated_at"] or ""),
        metadata=_json_object(row["metadata_json"]),
    )


def _member_from_row(row: Mapping[str, Any]) -> BoardMember:
    return BoardMember(
        symbol=str(row["symbol"]),
        code=str(row["code"] or ""),
        name=str(row["name"] or ""),
        as_of=str(row["as_of"] or ""),
        source=str(row["source"] or ""),
    )


def _snapshot_from_row(row: Mapping[str, Any]) -> BoardSnapshot:
    breadth = BoardBreadth(
        advancers=row["advancers"],
        decliners=row["decliners"],
        unchanged=row["unchanged"],
        limit_up_count=row["limit_up_count"],
        limit_down_count=row["limit_down_count"],
        covered_members=int(row["covered_members"] or 0),
        total_members=int(row["total_members"] or 0),
        coverage_pct=float(row["coverage_pct"] or 0.0),
        basis=str(row["breadth_basis"] or ""),
        algorithm_version=str(row["algorithm_version"] or ""),
    )
    return BoardSnapshot(
        board_id=str(row["board_id"]),
        trade_date=str(row["trade_date"]),
        snapshot_at=str(row["snapshot_at"]),
        market_phase=str(row["market_phase"] or ""),
        change_pct=row["change_pct"],
        last=row["last"],
        open=row["open"],
        high=row["high"],
        low=row["low"],
        previous_close=row["previous_close"],
        amount=row["amount"],
        volume=row["volume"],
        turnover=row["turnover"],
        breadth=breadth,
        source=str(row["source"] or ""),
        fetched_at=str(row["fetched_at"] or ""),
        data_quality=DataQuality(status=str(row["data_quality"] or "ok")),
        metadata=_json_object(row["metadata_json"]),
    )


class BoardStore:
    """Repository for locally cached board identity, membership, and quotes."""

    def __init__(self, db: Database):
        self.db = db
        self.db.init()

    # -- identity ---------------------------------------------------------

    def upsert_boards(self, boards: Iterable[Board]) -> int:
        now = utc_now()
        count = 0
        with self.db.transaction() as conn:
            for board in boards:
                conn.execute(
                    """
                    INSERT INTO market_boards(
                      id, provider, provider_board_code, name, normalized_name,
                      aliases_json, board_type, definition, constituent_basis,
                      source_ref, active, fetched_at, created_at, updated_at,
                      metadata_json
                    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
                    ON CONFLICT(id) DO UPDATE SET
                      provider=excluded.provider,
                      provider_board_code=excluded.provider_board_code,
                      name=excluded.name,
                      normalized_name=excluded.normalized_name,
                      aliases_json=excluded.aliases_json,
                      board_type=excluded.board_type,
                      definition=excluded.definition,
                      constituent_basis=excluded.constituent_basis,
                      source_ref=excluded.source_ref,
                      active=excluded.active,
                      fetched_at=excluded.fetched_at,
                      updated_at=excluded.updated_at,
                      metadata_json=excluded.metadata_json
                    """,
                    (
                        board.id,
                        board.provider,
                        board.provider_board_code,
                        board.name,
                        board.normalized_name or normalize_board_name(board.name),
                        json_dumps(list(board.aliases)),
                        board.board_type,
                        board.definition,
                        board.constituent_basis,
                        board.source_ref,
                        int(board.active),
                        board.fetched_at or now,
                        now,
                        now,
                        json_dumps(board.metadata),
                    ),
                )
                count += 1
        return count

    def get_board(self, board_id: str) -> Board | None:
        row = self.db.one("SELECT * FROM market_boards WHERE id=?", (str(board_id),))
        return _board_from_row(row) if row else None

    def search_boards(
        self,
        query: str,
        *,
        board_type: str | None = None,
        limit: int = 20,
    ) -> list[Board]:
        """Exact-then-contains match on the normalized name.

        Exact matches are returned alone when present so a board whose name is
        exactly the query is never made ambiguous by longer names containing it.
        """

        normalized = normalize_board_name(query)
        if not normalized:
            return []
        clauses = ["active=1"]
        params: list[Any] = []
        if board_type:
            clauses.append("board_type=?")
            params.append(board_type)
        safe_limit = max(1, min(int(limit), 50))
        exact = self.db.query(
            f"SELECT * FROM market_boards WHERE {' AND '.join([*clauses, 'normalized_name=?'])} "
            "ORDER BY name LIMIT ?",
            tuple([*params, normalized, safe_limit]),
        )
        if exact:
            return [_board_from_row(row) for row in exact]
        partial = self.db.query(
            f"SELECT * FROM market_boards WHERE {' AND '.join([*clauses, 'normalized_name LIKE ?'])} "
            "ORDER BY length(normalized_name), name LIMIT ?",
            tuple([*params, f"%{normalized}%", safe_limit]),
        )
        return [_board_from_row(row) for row in partial]

    def catalog_size(self, *, board_type: str | None = None) -> int:
        if board_type:
            row = self.db.one(
                "SELECT COUNT(*) AS n FROM market_boards WHERE board_type=? AND active=1",
                (board_type,),
            )
        else:
            row = self.db.one("SELECT COUNT(*) AS n FROM market_boards WHERE active=1")
        return int(row["n"]) if row else 0

    def catalog_fetched_at(self, *, board_type: str | None = None) -> str | None:
        if board_type:
            row = self.db.one(
                "SELECT MAX(fetched_at) AS value FROM market_boards WHERE board_type=? AND active=1",
                (board_type,),
            )
        else:
            row = self.db.one("SELECT MAX(fetched_at) AS value FROM market_boards WHERE active=1")
        value = row["value"] if row else None
        return str(value) if value else None

    # -- membership -------------------------------------------------------

    def replace_memberships(
        self,
        board_id: str,
        members: Iterable[BoardMember],
        *,
        valid_from: str,
        source: str,
        as_of: str = "",
    ) -> int:
        """Write one board's constituents for a validity start date.

        Rows for the same ``valid_from`` are replaced wholesale so a partial
        upstream page can never leave a mixture of two membership vintages.
        """

        rows = list(members)
        now = utc_now()
        with self.db.transaction() as conn:
            conn.execute(
                "DELETE FROM market_board_memberships WHERE board_id=? AND valid_from=?",
                (str(board_id), str(valid_from)),
            )
            for member in rows:
                conn.execute(
                    """
                    INSERT INTO market_board_memberships(
                      board_id, symbol, code, name, valid_from, valid_to,
                      source, as_of, fetched_at, metadata_json
                    ) VALUES(?,?,?,?,?,?,?,?,?,?)
                    """,
                    (
                        str(board_id),
                        member.symbol,
                        member.code,
                        member.name,
                        str(valid_from),
                        "",
                        source,
                        as_of or str(valid_from),
                        now,
                        "{}",
                    ),
                )
        return len(rows)

    def memberships(self, board_id: str, *, on_date: str | None = None) -> list[BoardMember]:
        clauses = ["board_id=?"]
        params: list[Any] = [str(board_id)]
        if on_date:
            clauses.append("valid_from<=?")
            params.append(str(on_date))
            clauses.append("(valid_to='' OR valid_to>=?)")
            params.append(str(on_date))
        rows = self.db.query(
            f"SELECT * FROM market_board_memberships WHERE {' AND '.join(clauses)} "
            "ORDER BY valid_from DESC, symbol",
            tuple(params),
        )
        if not rows:
            return []
        newest = str(rows[0]["valid_from"])
        return [_member_from_row(row) for row in rows if str(row["valid_from"]) == newest]

    def membership_as_of(self, board_id: str, *, on_date: str | None = None) -> str | None:
        clauses = ["board_id=?"]
        params: list[Any] = [str(board_id)]
        if on_date:
            clauses.append("valid_from<=?")
            params.append(str(on_date))
        row = self.db.one(
            f"SELECT MAX(valid_from) AS value FROM market_board_memberships WHERE {' AND '.join(clauses)}",
            tuple(params),
        )
        value = row["value"] if row else None
        return str(value) if value else None

    # -- snapshots --------------------------------------------------------

    def upsert_snapshot(self, snapshot: BoardSnapshot) -> None:
        breadth = snapshot.breadth
        with self.db.transaction() as conn:
            conn.execute(
                """
                INSERT INTO market_board_snapshots(
                  board_id, trade_date, snapshot_at, market_phase, open, high,
                  low, last, previous_close, change_pct, amount, volume,
                  turnover, advancers, decliners, unchanged, limit_up_count,
                  limit_down_count, covered_members, total_members,
                  coverage_pct, breadth_basis, algorithm_version, source,
                  data_quality, fetched_at, metadata_json
                ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
                ON CONFLICT(board_id, trade_date, snapshot_at) DO UPDATE SET
                  market_phase=excluded.market_phase, open=excluded.open,
                  high=excluded.high, low=excluded.low, last=excluded.last,
                  previous_close=excluded.previous_close,
                  change_pct=excluded.change_pct, amount=excluded.amount,
                  volume=excluded.volume, turnover=excluded.turnover,
                  advancers=excluded.advancers, decliners=excluded.decliners,
                  unchanged=excluded.unchanged,
                  limit_up_count=excluded.limit_up_count,
                  limit_down_count=excluded.limit_down_count,
                  covered_members=excluded.covered_members,
                  total_members=excluded.total_members,
                  coverage_pct=excluded.coverage_pct,
                  breadth_basis=excluded.breadth_basis,
                  algorithm_version=excluded.algorithm_version,
                  source=excluded.source, data_quality=excluded.data_quality,
                  fetched_at=excluded.fetched_at,
                  metadata_json=excluded.metadata_json
                """,
                (
                    snapshot.board_id,
                    snapshot.trade_date,
                    snapshot.snapshot_at,
                    snapshot.market_phase,
                    snapshot.open,
                    snapshot.high,
                    snapshot.low,
                    snapshot.last,
                    snapshot.previous_close,
                    snapshot.change_pct,
                    snapshot.amount,
                    snapshot.volume,
                    snapshot.turnover,
                    breadth.advancers,
                    breadth.decliners,
                    breadth.unchanged,
                    breadth.limit_up_count,
                    breadth.limit_down_count,
                    breadth.covered_members,
                    breadth.total_members,
                    breadth.coverage_pct,
                    breadth.basis,
                    breadth.algorithm_version,
                    snapshot.source,
                    snapshot.data_quality.status,
                    snapshot.fetched_at or utc_now(),
                    json_dumps(snapshot.metadata),
                ),
            )

    def latest_snapshot(self, board_id: str, *, trade_date: str | None = None) -> BoardSnapshot | None:
        clauses = ["board_id=?"]
        params: list[Any] = [str(board_id)]
        if trade_date:
            clauses.append("trade_date=?")
            params.append(str(trade_date))
        row = self.db.one(
            f"SELECT * FROM market_board_snapshots WHERE {' AND '.join(clauses)} "
            "ORDER BY trade_date DESC, snapshot_at DESC LIMIT 1",
            tuple(params),
        )
        return _snapshot_from_row(row) if row else None


__all__ = ["BoardStore"]
