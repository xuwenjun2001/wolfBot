from __future__ import annotations

from app.config import Settings
from app.market import MarketClient, parse_tencent_response


def test_tencent_quote_preserves_previous_close() -> None:
    body = 'v_sh600519="1~测试~600519~1300.00~1290.00~";'
    snapshot = parse_tencent_response(body, "2026-08-28T08:30:00+08:00")[0]
    assert snapshot.price == 1300
    assert snapshot.extra["previous_close"] == 1290


class FakeResponse:
    def raise_for_status(self) -> None:
        return None

    def json(self):
        return {"data": {"sh600519": {"day": [["2026-08-27", "1", "2", "3", "0.5", "100"]]}}}


class FakeSession:
    def __init__(self):
        self.headers = {}

    def get(self, *args, **kwargs):
        return FakeResponse()


def test_previous_day_bar_filters_partial_today() -> None:
    client = MarketClient(Settings(request_timeout=1), FakeSession())
    bar = client.previous_day_bar("600519.SH", "2026-08-28")
    assert bar["date"] == "2026-08-27"
    assert bar["close"] == 2
