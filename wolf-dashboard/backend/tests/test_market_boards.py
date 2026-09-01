"""Board catalog/quote/member parsing and upstream failure classification.

Every test injects a fake session: the suite never reaches the network, and a
dropped connection must stay an upstream error rather than becoming "no such
board" or an empty constituent list.
"""

from __future__ import annotations

import pytest
import requests

from app.market_boards import (
    BoardInvalidResponseError,
    BoardMember,
    BoardRateLimitedError,
    BoardUpstreamUnavailableError,
    EastMoneyBoardProvider,
    board_identity,
    compute_breadth,
    normalize_board_name,
    parse_eastmoney_board_catalog,
    parse_eastmoney_board_members,
    parse_eastmoney_board_quote,
)


def _catalog_payload(rows) -> dict:
    return {"rc": 0, "data": {"total": len(rows), "diff": rows}}


CATALOG_ROWS = [
    {"f12": "BK1138", "f13": "90", "f14": "液冷服务器", "f3": 3.21},
    {"f12": "BK0490", "f13": "90", "f14": "汽车零部件", "f3": -0.44},
]


class FakeResponse:
    def __init__(self, payload=None, *, status_code: int = 200, malformed: bool = False):
        self._payload = payload
        self.status_code = status_code
        self._malformed = malformed

    def json(self):
        if self._malformed:
            raise ValueError("not JSON")
        return self._payload


class FakeSession:
    """Records requests and replays a scripted list of responses/exceptions."""

    def __init__(self, script):
        self.script = list(script)
        self.calls: list[dict] = []
        self.headers: dict[str, str] = {}

    def get(self, url, params=None, timeout=None):
        self.calls.append({"url": url, "params": dict(params or {}), "timeout": timeout})
        if not self.script:
            raise AssertionError("fake session exhausted")
        item = self.script.pop(0)
        if isinstance(item, Exception):
            raise item
        return item


def _provider(script) -> EastMoneyBoardProvider:
    return EastMoneyBoardProvider(
        session=FakeSession(script),
        min_interval=0.0,
        jitter=0.0,
        backoff=0.0,
        sleep_fn=lambda _seconds: None,
        page_size=500,
    )


# -- name normalization ---------------------------------------------------

@pytest.mark.parametrize(
    "query",
    ["液冷", "液冷板块", "液冷概念", "液冷行业", " 液冷 "],
)
def test_board_name_normalization_folds_routing_suffixes(query: str) -> None:
    assert normalize_board_name(query) == "液冷"


def test_board_identity_is_opaque_and_stable() -> None:
    first = board_identity("eastmoney", "BK1138")
    assert first == board_identity("eastmoney", "BK1138")
    assert "BK1138" not in first
    assert len(first) == 24


# -- catalog parsing ------------------------------------------------------

def test_catalog_parses_list_and_dict_diff_shapes() -> None:
    from_list = parse_eastmoney_board_catalog(_catalog_payload(CATALOG_ROWS), board_type="concept")
    keyed = {str(index): row for index, row in enumerate(CATALOG_ROWS)}
    from_dict = parse_eastmoney_board_catalog(_catalog_payload(keyed), board_type="concept")
    assert [item.provider_board_code for item in from_list] == [item.provider_board_code for item in from_dict]
    assert {item.name for item in from_list} == {"液冷服务器", "汽车零部件"}
    assert all(item.board_type == "concept" for item in from_list)
    assert all(item.constituent_basis == "provider-defined" for item in from_list)


def test_catalog_rejects_an_invalid_board_code() -> None:
    with pytest.raises(BoardInvalidResponseError):
        parse_eastmoney_board_catalog(
            _catalog_payload([{"f12": "600519", "f14": "x"}]), board_type="concept"
        )


def test_catalog_rejects_a_missing_name() -> None:
    with pytest.raises(BoardInvalidResponseError):
        parse_eastmoney_board_catalog(
            _catalog_payload([{"f12": "BK1138", "f14": ""}]), board_type="concept"
        )


def test_catalog_rejects_an_empty_page() -> None:
    with pytest.raises(BoardInvalidResponseError):
        parse_eastmoney_board_catalog({"rc": 0, "data": {"diff": []}}, board_type="concept")


def test_catalog_rejects_a_non_zero_return_code() -> None:
    with pytest.raises(BoardInvalidResponseError):
        parse_eastmoney_board_catalog(
            {"rc": 1, "data": {"diff": CATALOG_ROWS}}, board_type="concept"
        )


# -- quote parsing --------------------------------------------------------

def _board():
    """Always the BK1138 board; catalog order follows the opaque id, not input."""
    boards = parse_eastmoney_board_catalog(_catalog_payload(CATALOG_ROWS), board_type="concept")
    return next(item for item in boards if item.provider_board_code == "BK1138")


def test_quote_reads_change_without_claiming_provider_breadth() -> None:
    payload = _catalog_payload([
        {"f12": "BK1138", "f14": "液冷服务器", "f2": 1234.5, "f3": 3.21, "f6": 8.8e9, "f104": 140, "f105": 12},
    ])
    snapshot = parse_eastmoney_board_quote(payload, board=_board(), trade_date="2026-08-31", market_phase="post_close")
    assert snapshot.change_pct == 3.21
    assert snapshot.last == 1234.5
    assert snapshot.amount == 8.8e9
    assert snapshot.trade_date == "2026-08-31"
    assert snapshot.market_phase == "post_close"
    assert snapshot.source == "eastmoney"
    # f104/f105 are not read: their semantics are unverified here, so breadth is
    # left for the service to derive from constituent quotes instead.
    assert snapshot.breadth.advancers is None
    assert snapshot.breadth.basis == ""


def test_quote_rejects_a_row_for_another_board() -> None:
    with pytest.raises(BoardInvalidResponseError):
        parse_eastmoney_board_quote(
            _catalog_payload([{"f12": "BK0490", "f14": "x", "f3": 1.0}]),
            board=_board(),
            trade_date="2026-08-31",
        )


def test_quote_rejects_a_row_with_no_usable_price_fields() -> None:
    with pytest.raises(BoardInvalidResponseError):
        parse_eastmoney_board_quote(
            _catalog_payload([{"f12": "BK1138", "f14": "x", "f2": "-", "f3": "-"}]),
            board=_board(),
            trade_date="2026-08-31",
        )


# -- member parsing -------------------------------------------------------

MEMBER_ROWS = [
    {"f12": "603259", "f13": "1", "f14": "药明康德", "f2": 60.1, "f3": 4.2},
    {"f12": "000977", "f13": "0", "f14": "浪潮信息", "f2": 44.5, "f3": 2.1},
    {"f12": "920002", "f13": "0", "f14": "北交样本", "f2": 12.0, "f3": -1.5},
]


def test_members_resolve_the_venue_from_the_market_id() -> None:
    members = parse_eastmoney_board_members(
        _catalog_payload(MEMBER_ROWS), board=_board(), as_of="2026-08-31"
    )
    assert {item.symbol for item in members} == {"sh603259", "sz000977", "bj920002"}
    assert next(item for item in members if item.code == "603259").change_pct == 4.2


def test_members_reject_an_invalid_security_code() -> None:
    with pytest.raises(BoardInvalidResponseError):
        parse_eastmoney_board_members(
            _catalog_payload([{"f12": "BK1138", "f13": "1", "f14": "x"}]), board=_board()
        )


def test_members_reject_a_row_with_no_resolvable_venue() -> None:
    with pytest.raises(BoardInvalidResponseError):
        parse_eastmoney_board_members(
            _catalog_payload([{"f12": "111111", "f13": "", "f14": "x"}]), board=_board()
        )


# -- breadth --------------------------------------------------------------

def test_computed_breadth_reports_coverage_and_its_basis() -> None:
    members = [
        BoardMember(symbol="sh600000", code="600000", name="a", change_pct=1.0),
        BoardMember(symbol="sh600001", code="600001", name="b", change_pct=-1.0),
        BoardMember(symbol="sh600002", code="600002", name="c", change_pct=0.0),
        BoardMember(symbol="sh600003", code="600003", name="d", change_pct=None),
    ]
    breadth = compute_breadth(members)
    assert (breadth.advancers, breadth.decliners, breadth.unchanged) == (1, 1, 1)
    assert breadth.covered_members == 3
    assert breadth.total_members == 4
    assert breadth.coverage_pct == 75.0
    assert breadth.basis == "computed_from_members"
    assert breadth.algorithm_version


# -- upstream failure classification --------------------------------------

def test_dropped_connection_is_an_upstream_error_not_a_missing_board() -> None:
    provider = _provider([requests.ConnectionError("connection aborted")] * 4)
    with pytest.raises(BoardUpstreamUnavailableError) as excinfo:
        provider.list_boards(board_type="concept")
    assert excinfo.value.code == "UPSTREAM_UNAVAILABLE"


def test_rate_limiting_is_reported_separately() -> None:
    provider = _provider([FakeResponse(status_code=429)] * 4)
    with pytest.raises(BoardRateLimitedError) as excinfo:
        provider.list_boards(board_type="concept")
    assert excinfo.value.code == "UPSTREAM_RATE_LIMITED"


def test_forbidden_is_not_retried() -> None:
    session = FakeSession([FakeResponse(status_code=403)])
    provider = EastMoneyBoardProvider(
        session=session, min_interval=0.0, jitter=0.0, backoff=0.0, sleep_fn=lambda _s: None
    )
    with pytest.raises(BoardUpstreamUnavailableError):
        provider.list_boards(board_type="concept")
    assert len(session.calls) == 1


def test_server_error_is_retried_then_classified() -> None:
    session = FakeSession([FakeResponse(status_code=503)] * 4)
    provider = EastMoneyBoardProvider(
        session=session, min_interval=0.0, jitter=0.0, backoff=0.0, sleep_fn=lambda _s: None
    )
    with pytest.raises(BoardUpstreamUnavailableError):
        provider.list_boards(board_type="concept")
    assert len(session.calls) == 4


def test_transient_failure_recovers_on_retry() -> None:
    provider = _provider([
        requests.ConnectionError("reset"),
        FakeResponse(_catalog_payload(CATALOG_ROWS)),
    ])
    boards = provider.list_boards(board_type="concept")
    assert len(boards) == 2


def test_malformed_json_is_an_invalid_response() -> None:
    provider = _provider([FakeResponse(malformed=True)])
    with pytest.raises(BoardInvalidResponseError):
        provider.list_boards(board_type="concept")


def test_empty_page_is_an_invalid_response_not_an_empty_catalog() -> None:
    provider = _provider([FakeResponse({"rc": 0, "data": {"diff": []}})])
    with pytest.raises(BoardInvalidResponseError):
        provider.list_boards(board_type="concept")


def test_provider_never_sends_a_caller_supplied_url() -> None:
    session = FakeSession([FakeResponse(_catalog_payload(CATALOG_ROWS))])
    provider = EastMoneyBoardProvider(
        session=session, min_interval=0.0, jitter=0.0, backoff=0.0, sleep_fn=lambda _s: None
    )
    provider.list_boards(board_type="industry")
    call = session.calls[0]
    assert call["url"].startswith("https://push2.eastmoney.com/")
    assert call["params"]["fs"] == "m:90+t:2"
