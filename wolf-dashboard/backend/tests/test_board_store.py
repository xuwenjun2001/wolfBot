"""Board persistence: identity search, membership validity, and snapshots."""

from __future__ import annotations

from app.board_store import BoardStore
from app.db import Database
from app.market_boards import (
    Board,
    BoardBreadth,
    BoardMember,
    BoardSnapshot,
    board_identity,
    normalize_board_name,
)


def _board(code: str, name: str, board_type: str = "concept") -> Board:
    return Board(
        id=board_identity("eastmoney", code),
        provider="eastmoney",
        provider_board_code=code,
        name=name,
        board_type=board_type,
        normalized_name=normalize_board_name(name),
        fetched_at="2026-09-01T00:00:00+00:00",
    )


def _store(tmp_path) -> BoardStore:
    return BoardStore(Database(tmp_path / "boards.sqlite"))


def test_upsert_is_idempotent_and_updates_in_place(tmp_path) -> None:
    store = _store(tmp_path)
    store.upsert_boards([_board("BK1138", "液冷服务器")])
    store.upsert_boards([_board("BK1138", "液冷服务器概念")])
    assert store.catalog_size(board_type="concept") == 1
    stored = store.get_board(board_identity("eastmoney", "BK1138"))
    assert stored is not None and stored.name == "液冷服务器概念"


def test_exact_name_match_wins_over_a_longer_containing_name(tmp_path) -> None:
    store = _store(tmp_path)
    store.upsert_boards([_board("BK0001", "液冷"), _board("BK0002", "液冷服务器")])
    matches = store.search_boards("液冷板块")
    assert [item.name for item in matches] == ["液冷"]


def test_partial_match_returns_every_candidate(tmp_path) -> None:
    store = _store(tmp_path)
    store.upsert_boards([_board("BK0002", "液冷服务器"), _board("BK0003", "液冷机组")])
    matches = store.search_boards("液冷")
    assert {item.name for item in matches} == {"液冷服务器", "液冷机组"}


def test_search_can_be_restricted_by_board_type(tmp_path) -> None:
    store = _store(tmp_path)
    store.upsert_boards([_board("BK0001", "液冷"), _board("BK0490", "液冷", "industry")])
    assert len(store.search_boards("液冷")) == 2
    assert len(store.search_boards("液冷", board_type="industry")) == 1


def test_memberships_are_replaced_per_validity_date(tmp_path) -> None:
    store = _store(tmp_path)
    board = _board("BK1138", "液冷服务器")
    store.upsert_boards([board])
    first = [BoardMember(symbol="sh600000", code="600000", name="a")]
    second = [
        BoardMember(symbol="sh600000", code="600000", name="a"),
        BoardMember(symbol="sz000977", code="000977", name="b"),
    ]
    store.replace_memberships(board.id, first, valid_from="2026-08-28", source="eastmoney")
    store.replace_memberships(board.id, second, valid_from="2026-08-31", source="eastmoney")
    # A partial re-import for the same date replaces that vintage wholesale.
    store.replace_memberships(board.id, second, valid_from="2026-08-31", source="eastmoney")
    assert len(store.memberships(board.id, on_date="2026-08-31")) == 2
    assert len(store.memberships(board.id, on_date="2026-08-28")) == 1
    assert store.membership_as_of(board.id, on_date="2026-08-29") == "2026-08-28"


def test_memberships_never_mix_two_vintages(tmp_path) -> None:
    store = _store(tmp_path)
    board = _board("BK1138", "液冷服务器")
    store.upsert_boards([board])
    store.replace_memberships(
        board.id, [BoardMember(symbol="sh600000", code="600000", name="a")],
        valid_from="2026-08-28", source="eastmoney",
    )
    store.replace_memberships(
        board.id, [BoardMember(symbol="sz000977", code="000977", name="b")],
        valid_from="2026-08-31", source="eastmoney",
    )
    latest = store.memberships(board.id)
    assert [item.symbol for item in latest] == ["sz000977"]


def test_snapshot_round_trips_with_its_breadth_basis(tmp_path) -> None:
    store = _store(tmp_path)
    board = _board("BK1138", "液冷服务器")
    store.upsert_boards([board])
    snapshot = BoardSnapshot(
        board_id=board.id,
        trade_date="2026-08-31",
        snapshot_at="2026-08-31T15:00:05+00:00",
        market_phase="post_close",
        change_pct=3.21,
        last=1234.5,
        breadth=BoardBreadth(
            advancers=140, decliners=12, unchanged=3,
            covered_members=155, total_members=160, coverage_pct=96.88,
            basis="computed_from_members", algorithm_version="breadth/1",
        ),
        source="eastmoney",
        fetched_at="2026-08-31T15:00:06+00:00",
    )
    store.upsert_snapshot(snapshot)
    store.upsert_snapshot(snapshot)

    stored = store.latest_snapshot(board.id, trade_date="2026-08-31")
    assert stored is not None
    assert stored.change_pct == 3.21
    assert stored.market_phase == "post_close"
    assert stored.breadth.advancers == 140
    assert stored.breadth.coverage_pct == 96.88
    assert stored.breadth.basis == "computed_from_members"
    assert stored.breadth.algorithm_version == "breadth/1"


def test_latest_snapshot_prefers_the_newest_observation(tmp_path) -> None:
    store = _store(tmp_path)
    board = _board("BK1138", "液冷服务器")
    store.upsert_boards([board])
    for snapshot_at, change in (("2026-08-31T10:00:00+00:00", 1.0), ("2026-08-31T15:00:00+00:00", 3.2)):
        store.upsert_snapshot(
            BoardSnapshot(
                board_id=board.id, trade_date="2026-08-31", snapshot_at=snapshot_at,
                change_pct=change, source="eastmoney", fetched_at=snapshot_at,
            )
        )
    latest = store.latest_snapshot(board.id)
    assert latest is not None and latest.change_pct == 3.2


def test_unknown_board_reads_return_nothing(tmp_path) -> None:
    store = _store(tmp_path)
    assert store.get_board("0" * 24) is None
    assert store.latest_snapshot("0" * 24) is None
    assert store.memberships("0" * 24) == []
    assert store.search_boards("") == []
