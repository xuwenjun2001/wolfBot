from __future__ import annotations

from collections import deque

import pytest
import requests

from app.market_data import (
    EASTMONEY_UNIVERSE_FS,
    EastMoneyUniverseError,
    EastMoneyUniverseProvider,
    parse_eastmoney_universe_payload,
)


def _row(code: str, name: str, market: int = 0, **extra):
    value = {"f12": code, "f13": market, "f14": name}
    value.update(extra)
    return value


def test_parser_accepts_list_and_dict_diff_and_maps_identity() -> None:
    list_payload = {
        "rc": 0,
        "data": {
            "total": 3,
            "diff": [
                _row("000001", "Ping An Bank", 0),
                _row("688001", "Star Example", 1),
                _row("920001", "Beijing Example", 0),
            ],
        },
    }
    values = parse_eastmoney_universe_payload(list_payload, fetched_at="2026-08-29T00:00:00+00:00")
    assert [item.symbol for item in values] == ["bj920001", "sh688001", "sz000001"]
    assert values[0].exchange == "BJ"
    assert values[0].board == "beijing"
    assert values[1].board == "star"
    assert values[2].board == "main"
    assert all(item.asset_type == "stock" for item in values)
    assert all(item.source == "eastmoney" for item in values)
    assert values[0].metadata["provider"] == "eastmoney"

    dict_payload = {
        "data": {
            "total": "1",
            "diff": {"0": _row("300001", "ChiNext Example", 0)},
        }
    }
    parsed = parse_eastmoney_universe_payload(dict_payload)
    assert parsed[0].symbol == "sz300001"
    assert parsed[0].board == "chinext"


def test_parser_deduplicates_and_excludes_non_stock_and_stale_bj_codes() -> None:
    payload = {
        "data": {
            "diff": [
                _row("600001", "ST Example", 1),
                _row("600001", "ST Example", 1),
                _row("510300", "CSI 300 ETF", 1),
                _row("399001", "SZ Component", 0),
                _row("200001", "B Share", 0),
                _row("832001", "Old Beijing", 0),
                _row("920002", "Current Beijing", 0),
            ]
        }
    }
    values = parse_eastmoney_universe_payload(payload)
    assert [item.symbol for item in values] == ["bj920002", "sh600001"]
    assert values[1].is_st is True


@pytest.mark.parametrize(
    "payload",
    [
        None,
        {},
        {"data": None},
        {"data": {"diff": None}},
        {"data": {"diff": []}},
        {"rc": 1, "data": {"diff": []}},
        {"data": {"diff": [{"f12": "bad", "f14": "Broken"}]}},
    ],
)
def test_parser_rejects_malformed_or_empty_payload(payload) -> None:
    with pytest.raises(EastMoneyUniverseError):
        parse_eastmoney_universe_payload(payload)


class FakeResponse:
    def __init__(self, payload=None, *, status_code=200, json_error: Exception | None = None):
        self.payload = payload
        self.status_code = status_code
        self.json_error = json_error

    def json(self):
        if self.json_error:
            raise self.json_error
        return self.payload


class FakeSession:
    def __init__(self, responses):
        self.headers = {}
        self.responses = deque(responses)
        self.calls = []

    def get(self, url, **kwargs):
        self.calls.append((url, kwargs))
        if not self.responses:
            raise AssertionError("fixture did not provide another EastMoney response")
        response = self.responses.popleft()
        if isinstance(response, Exception):
            raise response
        return response


def _page(rows, total):
    return {"rc": 0, "data": {"total": total, "diff": rows}}


def test_provider_paginates_serially_with_filters_and_at_least_one_second_pacing() -> None:
    session = FakeSession(
        [
            FakeResponse(_page([_row("000001", "One"), _row("000002", "Two")], 3)),
            FakeResponse(_page([_row("000003", "Three")], 3)),
        ]
    )
    sleeps: list[float] = []
    provider = EastMoneyUniverseProvider(
        session=session,
        page_size=2,
        min_interval=1.0,
        jitter=0.0,
        sleep_fn=sleeps.append,
        max_retries=0,
    )
    values = provider.list_securities()
    assert [item.symbol for item in values] == ["sz000001", "sz000002", "sz000003"]
    assert len(session.calls) == 2
    assert session.calls[0][1]["params"]["pn"] == 1
    assert session.calls[1][1]["params"]["pn"] == 2
    assert session.calls[0][1]["params"]["pz"] == 2
    assert session.calls[0][1]["params"]["fs"] == EASTMONEY_UNIVERSE_FS
    assert sleeps and sleeps[0] >= 1.0
    assert session.headers["Referer"] == "https://quote.eastmoney.com/"
    assert "Mozilla/5.0" in session.headers["User-Agent"]


def test_provider_retries_transient_http_and_connection_errors_but_not_403() -> None:
    payload = _page([_row("000001", "One")], 1)
    session = FakeSession(
        [
            FakeResponse(status_code=503),
            requests.ConnectionError("reset"),
            FakeResponse(payload),
        ]
    )
    provider = EastMoneyUniverseProvider(
        session=session,
        min_interval=0,
        jitter=0,
        backoff=0,
        max_retries=2,
    )
    assert provider.list_securities()[0].symbol == "sz000001"
    assert len(session.calls) == 3

    forbidden = FakeSession([FakeResponse(status_code=403), FakeResponse(payload)])
    provider = EastMoneyUniverseProvider(session=forbidden, min_interval=0, jitter=0, max_retries=3)
    with pytest.raises(EastMoneyUniverseError, match="403"):
        provider.list_securities()
    assert len(forbidden.calls) == 1


def test_provider_rejects_bad_json_empty_or_incomplete_pages_and_honors_cap() -> None:
    bad_json = FakeSession([FakeResponse(json_error=ValueError("not json"))])
    provider = EastMoneyUniverseProvider(session=bad_json, min_interval=0, jitter=0, max_retries=0)
    with pytest.raises(EastMoneyUniverseError, match="valid JSON"):
        provider.list_securities()

    empty = FakeSession([FakeResponse(_page([], 0))])
    provider = EastMoneyUniverseProvider(session=empty, min_interval=0, jitter=0, max_retries=0)
    with pytest.raises(EastMoneyUniverseError, match="zero securities"):
        provider.list_securities()

    incomplete = FakeSession([FakeResponse(_page([_row("000001", "One")], 2)), FakeResponse(_page([], 2))])
    provider = EastMoneyUniverseProvider(session=incomplete, min_interval=0, jitter=0, max_retries=0)
    with pytest.raises(EastMoneyUniverseError, match="incomplete"):
        provider.list_securities()

    capped = FakeSession([FakeResponse(_page([_row("000001", "One"), _row("000002", "Two")], 10))])
    provider = EastMoneyUniverseProvider(session=capped, page_size=2, min_interval=0, jitter=0, max_retries=0)
    assert [item.symbol for item in provider.list_securities(max_symbols=1)] == ["sz000001"]
    assert len(capped.calls) == 1
