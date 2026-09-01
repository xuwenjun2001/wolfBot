"""End-to-end coverage of the five fixed board and market-session routes.

The provider is a fixture, so each failure branch is reachable without network
access.  The central assertion of this file is that failure classes stay
distinct: an unreachable upstream must never be reported as a missing board.
"""

from __future__ import annotations

from datetime import datetime

from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.board_router import create_board_router
from app.board_service import BoardService
from app.board_store import BoardStore
from app.db import Database
from app.market_boards import (
    Board,
    BoardBreadth,
    BoardMember,
    BoardRateLimitedError,
    BoardSnapshot,
    BoardUpstreamUnavailableError,
    board_identity,
    normalize_board_name,
)
from app.market_calendar import BJ, TradingCalendar


OBSERVED = ["2026-08-27", "2026-08-28", "2026-08-31"]


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


LIQUID_COOLING = _board("BK1138", "液冷服务器")
# Two boards whose names normalize identically: the only genuine ambiguity.
AMBIGUOUS_CONCEPT = _board("BK1139", "液冷", "concept")
AMBIGUOUS_INDUSTRY = _board("BK0490", "液冷", "industry")
AUTO_PARTS = _board("BK0491", "汽车零部件", "industry")


def _members(count: int = 10, quoted: int | None = None) -> list[BoardMember]:
    total = count if quoted is None else quoted
    result = []
    for index in range(count):
        change = round(1.5 - index * 0.4, 2) if index < total else None
        result.append(
            BoardMember(
                symbol=f"sh6000{index:02d}",
                code=f"6000{index:02d}",
                name=f"成分{index}",
                change_pct=change,
                close=10.0 + index,
                amount=1e8 - index * 1e6,
                turnover=3.0,
                as_of="2026-08-31",
                source="eastmoney",
            )
        )
    return result


class FakeBoardProvider:
    """Fixture provider whose failures are injectable per method."""

    def __init__(self, boards, members=None, *, quote_error=None, members_error=None):
        self._boards = list(boards)
        self._members = list(members if members is not None else _members())
        self.quote_error = quote_error
        self.members_error = members_error
        self.quote_calls = 0

    def list_boards(self, *, board_type: str):
        return [item for item in self._boards if item.board_type == board_type]

    def quote(self, board, *, trade_date="", market_phase=""):
        self.quote_calls += 1
        if self.quote_error is not None:
            raise self.quote_error
        return BoardSnapshot(
            board_id=board.id,
            trade_date=trade_date,
            snapshot_at="2026-08-31T15:00:05+00:00",
            market_phase=market_phase,
            change_pct=3.21,
            last=1234.5,
            amount=8.8e9,
            breadth=BoardBreadth(),
            source=board.provider,
            fetched_at="2026-08-31T15:00:05+00:00",
        )

    def members(self, board, *, as_of=""):
        if self.members_error is not None:
            raise self.members_error
        return list(self._members)


def _client(provider, *, now: str = "2026-09-01T02:01:00", tmp_path=None):
    db = Database(tmp_path / "boards.sqlite")
    store = BoardStore(db)
    moment = datetime.fromisoformat(now).replace(tzinfo=BJ)
    calendar = TradingCalendar(observed_trade_dates=lambda: list(OBSERVED), clock=lambda: moment)
    service = BoardService(store, provider, calendar)
    app = FastAPI()
    app.include_router(create_board_router(service=service, calendar=calendar))
    return TestClient(app), service, store


# -- market session -------------------------------------------------------

def test_market_session_route_reports_the_fallback(tmp_path) -> None:
    client, _service, _store = _client(FakeBoardProvider([LIQUID_COOLING]), tmp_path=tmp_path)
    with client:
        payload = client.get("/api/v1/market/session").json()
    assert payload["phase"] == "pre_open"
    assert payload["timezone"] == "Asia/Shanghai"
    assert payload["calendar_date"] == "2026-09-01"
    assert payload["effective_trade_date"] == "2026-08-31"
    assert payload["fallback_reason"] == "current_session_has_no_market_data"


def test_market_session_route_rejects_a_malformed_date(tmp_path) -> None:
    client, _service, _store = _client(FakeBoardProvider([LIQUID_COOLING]), tmp_path=tmp_path)
    with client:
        assert client.get("/api/v1/market/session?requested_date=not-a-date").status_code == 422


# -- resolution -----------------------------------------------------------

def test_resolve_board_imports_the_catalog_and_resolves(tmp_path) -> None:
    client, _service, store = _client(FakeBoardProvider([LIQUID_COOLING, AUTO_PARTS]), tmp_path=tmp_path)
    with client:
        response = client.get("/api/v1/boards/resolve?query=液冷板块")
    assert response.status_code == 200
    payload = response.json()
    assert payload["status"] == "resolved"
    assert payload["name"] == "液冷服务器"
    assert payload["board_type"] == "concept"
    assert payload["provider"] == "eastmoney"
    assert payload["constituent_basis"] == "provider-defined"
    assert payload["board_id"] == LIQUID_COOLING.id
    # The opaque id must not leak the provider's own board code.
    assert "BK1138" not in response.text
    assert store.get_board(LIQUID_COOLING.id) is not None


def test_resolve_board_reports_ambiguous_classifications(tmp_path) -> None:
    """A concept board and an industry board share the name: return candidates."""
    client, _service, _store = _client(
        FakeBoardProvider([AMBIGUOUS_CONCEPT, AMBIGUOUS_INDUSTRY]), tmp_path=tmp_path
    )
    with client:
        response = client.get("/api/v1/boards/resolve?query=液冷")
    assert response.status_code == 409
    detail = response.json()["detail"]
    assert detail["code"] == "AMBIGUOUS_BOARD"
    assert {item["board_type"] for item in detail["candidates"]} == {"concept", "industry"}


def test_resolve_board_uses_an_explicit_board_type_to_disambiguate(tmp_path) -> None:
    client, _service, _store = _client(
        FakeBoardProvider([AMBIGUOUS_CONCEPT, AMBIGUOUS_INDUSTRY]), tmp_path=tmp_path
    )
    with client:
        response = client.get("/api/v1/boards/resolve?query=液冷&board_type=industry")
    assert response.status_code == 200
    assert response.json()["board_type"] == "industry"


def test_resolve_board_reports_a_missing_board(tmp_path) -> None:
    client, _service, _store = _client(FakeBoardProvider([AUTO_PARTS]), tmp_path=tmp_path)
    with client:
        response = client.get("/api/v1/boards/resolve?query=不存在的板块")
    assert response.status_code == 404
    assert response.json()["detail"]["code"] == "BOARD_NOT_FOUND"


def test_resolve_board_rejects_an_unsupported_board_type(tmp_path) -> None:
    client, _service, _store = _client(FakeBoardProvider([LIQUID_COOLING]), tmp_path=tmp_path)
    with client:
        response = client.get("/api/v1/boards/resolve?query=液冷&board_type=sector")
    assert response.status_code == 400
    assert response.json()["detail"]["code"] == "INVALID_BOARD_TYPE"


def test_upstream_failure_during_resolution_is_not_a_missing_board(tmp_path) -> None:
    class FailingCatalog(FakeBoardProvider):
        def list_boards(self, *, board_type: str):
            raise BoardUpstreamUnavailableError("connection aborted by the remote host")

    client, _service, _store = _client(FailingCatalog([]), tmp_path=tmp_path)
    with client:
        response = client.get("/api/v1/boards/resolve?query=液冷板块")
    assert response.status_code == 502
    assert response.json()["detail"]["code"] == "UPSTREAM_UNAVAILABLE"


# -- snapshot and breadth -------------------------------------------------

def _resolved_client(provider, tmp_path, *, now="2026-09-01T02:01:00"):
    client, service, store = _client(provider, now=now, tmp_path=tmp_path)
    service.refresh_catalog()
    return client, service, store


def test_snapshot_reports_change_breadth_coverage_and_basis(tmp_path) -> None:
    client, _service, _store = _resolved_client(FakeBoardProvider([LIQUID_COOLING]), tmp_path)
    with client:
        payload = client.get(f"/api/v1/boards/{LIQUID_COOLING.id}/snapshot").json()
    assert payload["change_pct"] == 3.21
    assert payload["trade_date"] == "2026-08-31"
    assert payload["effective_trade_date"] == "2026-08-31"
    assert payload["breadth"]["advancers"] == 4
    assert payload["breadth"]["decliners"] == 6
    assert payload["breadth"]["breadth_basis"] == "computed_from_members"
    assert payload["coverage"]["coverage_pct"] == 100.0
    assert payload["insufficient_coverage"] is False
    assert payload["provider"] == "eastmoney"
    assert payload["constituent_basis"] == "provider-defined"
    assert payload["market_context"]["fallback_reason"] == "current_session_has_no_market_data"
    assert payload["limitations"]


def test_breadth_route_agrees_with_the_snapshot(tmp_path) -> None:
    client, _service, _store = _resolved_client(FakeBoardProvider([LIQUID_COOLING]), tmp_path)
    with client:
        snapshot = client.get(f"/api/v1/boards/{LIQUID_COOLING.id}/snapshot").json()
        breadth = client.get(f"/api/v1/boards/{LIQUID_COOLING.id}/breadth").json()
    assert breadth["view"] == "breadth"
    assert breadth["breadth"] == snapshot["breadth"]
    assert breadth["trade_date"] == snapshot["trade_date"]


def test_low_constituent_coverage_is_surfaced_not_hidden(tmp_path) -> None:
    provider = FakeBoardProvider([LIQUID_COOLING], members=_members(count=10, quoted=5))
    client, _service, _store = _resolved_client(provider, tmp_path)
    with client:
        payload = client.get(f"/api/v1/boards/{LIQUID_COOLING.id}/snapshot").json()
    assert payload["coverage"]["coverage_pct"] == 50.0
    assert payload["insufficient_coverage"] is True
    assert payload["data_quality"]["status"] == "warning"
    assert any("coverage" in warning for warning in payload["warnings"])


def test_unknown_board_id_is_reported_as_a_missing_board(tmp_path) -> None:
    client, _service, _store = _resolved_client(FakeBoardProvider([LIQUID_COOLING]), tmp_path)
    with client:
        response = client.get("/api/v1/boards/" + "a" * 24 + "/snapshot")
    assert response.status_code == 404
    assert response.json()["detail"]["code"] == "BOARD_NOT_FOUND"


def test_snapshot_upstream_drop_keeps_its_own_error_code(tmp_path) -> None:
    provider = FakeBoardProvider(
        [LIQUID_COOLING], quote_error=BoardUpstreamUnavailableError("connection aborted")
    )
    client, _service, _store = _resolved_client(provider, tmp_path)
    with client:
        response = client.get(f"/api/v1/boards/{LIQUID_COOLING.id}/snapshot")
    assert response.status_code == 502
    assert response.json()["detail"]["code"] == "UPSTREAM_UNAVAILABLE"


def test_rate_limited_snapshot_is_reported_as_such(tmp_path) -> None:
    provider = FakeBoardProvider([LIQUID_COOLING], quote_error=BoardRateLimitedError("429"))
    client, _service, _store = _resolved_client(provider, tmp_path)
    with client:
        response = client.get(f"/api/v1/boards/{LIQUID_COOLING.id}/snapshot")
    assert response.status_code == 429
    assert response.json()["detail"]["code"] == "UPSTREAM_RATE_LIMITED"


def test_a_stored_snapshot_is_reused_when_the_upstream_drops(tmp_path) -> None:
    # Intraday, so a stored snapshot is never preferred outright: the upstream
    # is called, fails, and only then is the stored copy served.
    provider = FakeBoardProvider([LIQUID_COOLING])
    client, _service, _store = _resolved_client(provider, tmp_path, now="2026-09-01T10:00:00")
    with client:
        first = client.get(f"/api/v1/boards/{LIQUID_COOLING.id}/snapshot")
        assert first.status_code == 200
        assert provider.quote_calls == 1
        provider.quote_error = BoardUpstreamUnavailableError("connection aborted")
        second = client.get(f"/api/v1/boards/{LIQUID_COOLING.id}/snapshot")
    assert second.status_code == 200
    assert provider.quote_calls == 2
    payload = second.json()
    assert payload["change_pct"] == 3.21
    assert any("stored snapshot" in warning for warning in payload["warnings"])


def test_upstream_drop_without_a_stored_snapshot_still_fails(tmp_path) -> None:
    provider = FakeBoardProvider(
        [LIQUID_COOLING], quote_error=BoardUpstreamUnavailableError("connection aborted")
    )
    client, _service, _store = _resolved_client(provider, tmp_path, now="2026-09-01T10:00:00")
    with client:
        response = client.get(f"/api/v1/boards/{LIQUID_COOLING.id}/snapshot")
    assert response.status_code == 502
    assert response.json()["detail"]["code"] == "UPSTREAM_UNAVAILABLE"


def test_intraday_snapshot_reports_that_values_still_change(tmp_path) -> None:
    provider = FakeBoardProvider([LIQUID_COOLING])
    client, _service, _store = _resolved_client(provider, tmp_path, now="2026-09-01T10:00:00")
    with client:
        payload = client.get(f"/api/v1/boards/{LIQUID_COOLING.id}/snapshot").json()
    assert payload["trade_date"] == "2026-09-01"
    assert payload["market_context"]["intraday"] is True
    assert any("still open" in warning for warning in payload["warnings"])


# -- members --------------------------------------------------------------

def test_members_return_leaders_and_laggards(tmp_path) -> None:
    client, _service, _store = _resolved_client(FakeBoardProvider([LIQUID_COOLING]), tmp_path)
    with client:
        payload = client.get(f"/api/v1/boards/{LIQUID_COOLING.id}/members?limit=3").json()
    assert [item["change_pct"] for item in payload["leaders"]] == [1.5, 1.1, 0.7]
    assert [item["change_pct"] for item in payload["laggards"]] == [-2.1, -1.7, -1.3]
    assert payload["member_count"] == 10
    assert payload["membership_as_of"] == "2026-08-31"
    assert payload["trade_date"] == "2026-08-31"


def test_members_reject_an_unsupported_sort_field(tmp_path) -> None:
    client, _service, _store = _resolved_client(FakeBoardProvider([LIQUID_COOLING]), tmp_path)
    with client:
        response = client.get(f"/api/v1/boards/{LIQUID_COOLING.id}/members?sort=pe_ratio")
    assert response.status_code == 400
    assert response.json()["detail"]["code"] == "INVALID_SORT_FIELD"


def test_members_reject_an_unsupported_direction(tmp_path) -> None:
    client, _service, _store = _resolved_client(FakeBoardProvider([LIQUID_COOLING]), tmp_path)
    with client:
        response = client.get(f"/api/v1/boards/{LIQUID_COOLING.id}/members?direction=sideways")
    assert response.status_code == 400
    assert response.json()["detail"]["code"] == "INVALID_SORT_DIRECTION"


def test_members_reject_an_out_of_range_limit(tmp_path) -> None:
    client, _service, _store = _resolved_client(FakeBoardProvider([LIQUID_COOLING]), tmp_path)
    with client:
        assert client.get(f"/api/v1/boards/{LIQUID_COOLING.id}/members?limit=500").status_code == 422


def test_members_upstream_failure_is_not_an_empty_constituent_list(tmp_path) -> None:
    provider = FakeBoardProvider(
        [LIQUID_COOLING], members_error=BoardUpstreamUnavailableError("connection aborted")
    )
    client, _service, _store = _resolved_client(provider, tmp_path)
    with client:
        response = client.get(f"/api/v1/boards/{LIQUID_COOLING.id}/members")
    assert response.status_code == 502
    assert response.json()["detail"]["code"] == "UPSTREAM_UNAVAILABLE"
