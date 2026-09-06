from __future__ import annotations

from datetime import UTC, datetime

from quantpilot_market_data.cache import MarketDataCache, cache_response, read_cached_response
from quantpilot_market_data.config import MarketSettings
from quantpilot_market_data.models import AnnouncementResponse
from quantpilot_market_data.providers.eastmoney import EastMoneyClient


async def get_announcements(
    client: EastMoneyClient,
    cache: MarketDataCache,
    settings: MarketSettings,
    *,
    symbol: str,
    limit: int,
) -> AnnouncementResponse:
    normalized = max(1, min(limit, 100))
    key = cache.build_key("announcement-events", {"symbol": symbol, "limit": normalized})
    cached = read_cached_response(cache, key, AnnouncementResponse)
    if cached is not None:
        return cached
    response = AnnouncementResponse(
        symbol=symbol,
        announcements=await client.get_announcements(symbol, normalized),
        fetched_at=datetime.now(UTC),
    )
    return cache_response(
        cache, key, settings.announcement_cache_ttl_seconds, response, AnnouncementResponse
    )
