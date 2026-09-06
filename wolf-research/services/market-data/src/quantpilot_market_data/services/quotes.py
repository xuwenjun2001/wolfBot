from __future__ import annotations

from datetime import UTC, datetime

from quantpilot_market_data.cache import MarketDataCache, cache_response, read_cached_response
from quantpilot_market_data.config import MarketSettings
from quantpilot_market_data.models import (
    Adjustment,
    BatchQuoteResponse,
    KlinePeriod,
    KlineResponse,
    RealtimeQuote,
    SymbolResolveResponse,
)
from quantpilot_market_data.providers.eastmoney import EastMoneyClient, asset_type, normalize_secid


def _effective_history_adjustment(symbol: str, adjustment: Adjustment) -> Adjustment:
    secid = normalize_secid(symbol)
    code = secid.split(".", 1)[1]
    return "none" if asset_type(code, secid) == "index" else adjustment


async def resolve_symbol(
    client: EastMoneyClient,
    cache: MarketDataCache,
    settings: MarketSettings,
    *,
    query: str,
    count: int,
) -> SymbolResolveResponse:
    normalized_count = max(1, min(count, 20))
    key = cache.build_key("symbols-resolve-v2", {"query": query, "count": normalized_count})
    cached = read_cached_response(cache, key, SymbolResolveResponse)
    if cached is not None:
        return cached
    results = await client.resolve_symbol(query, normalized_count)
    response = SymbolResolveResponse(results=results, fetched_at=datetime.now(UTC))
    if not results:
        return response
    return cache_response(
        cache, key, settings.symbol_cache_ttl_seconds, response, SymbolResolveResponse
    )


async def get_realtime_quote(
    client: EastMoneyClient,
    cache: MarketDataCache,
    settings: MarketSettings,
    *,
    symbol: str,
) -> RealtimeQuote:
    key = cache.build_key("quote-realtime", {"symbol": symbol})
    cached = read_cached_response(cache, key, RealtimeQuote)
    if cached is not None:
        return cached
    quote = await client.get_realtime_quote(symbol)
    return cache_response(cache, key, settings.quote_cache_ttl_seconds, quote, RealtimeQuote)


async def get_realtime_quotes(
    client: EastMoneyClient,
    cache: MarketDataCache,
    settings: MarketSettings,
    *,
    symbols: list[str],
) -> BatchQuoteResponse:
    normalized = [symbol.strip() for symbol in symbols]
    key = cache.build_key("quote-realtime-batch", {"symbols": normalized})
    cached = read_cached_response(cache, key, BatchQuoteResponse)
    if cached is not None:
        return cached
    response = BatchQuoteResponse(
        quotes=await client.get_realtime_quotes(normalized),
        fetched_at=datetime.now(UTC),
    )
    return cache_response(
        cache, key, settings.quote_cache_ttl_seconds, response, BatchQuoteResponse
    )


async def get_history_quote(
    client: EastMoneyClient,
    cache: MarketDataCache,
    settings: MarketSettings,
    *,
    symbol: str,
    period: KlinePeriod,
    adjustment: Adjustment,
    limit: int,
    end: str,
    refresh: bool = False,
) -> KlineResponse:
    normalized_limit = max(1, min(limit, 2_000))
    effective_adjustment = _effective_history_adjustment(symbol, adjustment)
    key = cache.build_key(
        "quote-history",
        {
            "symbol": symbol,
            "period": period,
            "adjustment": effective_adjustment,
            "limit": normalized_limit,
            "end": end,
        },
    )
    if not refresh:
        cached = read_cached_response(cache, key, KlineResponse)
        if cached is not None:
            return cached
    response = await client.get_kline(
        symbol,
        period=period,
        adjustment=effective_adjustment,
        limit=normalized_limit,
        end=end,
    )
    return cache_response(cache, key, settings.kline_cache_ttl_seconds, response, KlineResponse)
