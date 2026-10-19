import asyncio
from unittest.mock import AsyncMock, patch

import pytest

from quantpilot_market_data.services.events import get_announcements


def test_announcement_pages_have_distinct_cache_keys_and_reach_provider():
    class Cache:
        def build_key(self, prefix, params):
            return f"{prefix}:{params['page']}"

    client = AsyncMock()
    client.get_announcements.return_value = []
    with (
        patch(
            "quantpilot_market_data.services.events.read_cached_response", return_value=None
        ) as read,
        patch(
            "quantpilot_market_data.services.events.cache_response",
            side_effect=lambda cache, key, ttl, response, model: response,
        ),
    ):
        first = asyncio.run(
            get_announcements(client, Cache(), symbol="600299", limit=100, ttl_seconds=30)
        )
        second = asyncio.run(
            get_announcements(client, Cache(), symbol="600299", limit=100, ttl_seconds=30, page=2)
        )
    assert first.page == 1 and second.page == 2
    assert not second.has_more
    assert read.call_args_list[0].args[1] != read.call_args_list[1].args[1]
    client.get_announcements.assert_awaited_with("600299", limit=100, page=2)


def test_invalid_announcement_page_is_rejected_before_network():
    with pytest.raises(ValueError, match="page"):
        asyncio.run(
            get_announcements(AsyncMock(), None, symbol="600299", limit=100, ttl_seconds=30, page=0)
        )
