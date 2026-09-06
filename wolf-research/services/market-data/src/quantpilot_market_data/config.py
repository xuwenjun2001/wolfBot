from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

DEFAULT_EASTMONEY_BASE_URLS = (
    "https://push2.eastmoney.com",
    "https://push2delay.eastmoney.com",
)
DEFAULT_EASTMONEY_KLINE_BASE_URLS = ("https://push2his.eastmoney.com",)


def _bool_env(name: str, default: bool) -> bool:
    value = os.getenv(name)
    if value is None:
        return default
    return value.strip().lower() not in {"0", "false", "no", "off", "disabled"}


def _float_env(name: str, default: float) -> float:
    try:
        return max(0.1, float(os.getenv(name, "")))
    except ValueError:
        return default


def _int_env(name: str, default: int, *, minimum: int = 0, maximum: int | None = None) -> int:
    try:
        value = int(os.getenv(name, ""))
    except ValueError:
        return default
    if maximum is not None:
        value = min(value, maximum)
    return max(minimum, value)


def _urls_env(name: str, default: tuple[str, ...]) -> tuple[str, ...]:
    values = tuple(
        value.strip().rstrip("/") for value in os.getenv(name, "").split(",") if value.strip()
    )
    return values or default


@dataclass(frozen=True)
class MarketSettings:
    host: str
    port: int
    database_url: str
    cache_enabled: bool
    cache_dir: Path
    provider_timeout_seconds: float
    provider_max_retries: int
    eastmoney_base_urls: tuple[str, ...]
    eastmoney_kline_base_urls: tuple[str, ...]
    tencent_kline_url: str
    eastmoney_search_url: str
    eastmoney_financial_url: str
    eastmoney_announcement_url: str
    quote_cache_ttl_seconds: int
    symbol_cache_ttl_seconds: int
    kline_cache_ttl_seconds: int
    financial_cache_ttl_seconds: int
    announcement_cache_ttl_seconds: int
    screener_cache_ttl_seconds: int


def get_settings() -> MarketSettings:
    cache_dir = os.getenv("WOLF_RESEARCH_MARKET_CACHE_DIR", "").strip()
    if not cache_dir:
        cache_dir = str(Path.home() / ".cache" / "wolf-research" / "market-data")
    return MarketSettings(
        host=os.getenv("WOLF_RESEARCH_MARKET_DATA_HOST", "127.0.0.1"),
        port=_int_env("WOLF_RESEARCH_MARKET_DATA_PORT", 8001, minimum=1, maximum=65535),
        database_url=os.getenv(
            "WOLF_RESEARCH_MARKET_DATABASE_URL", os.getenv("DATABASE_URL", "")
        ).strip(),
        cache_enabled=_bool_env("WOLF_RESEARCH_MARKET_CACHE_ENABLED", True),
        cache_dir=Path(cache_dir).expanduser(),
        provider_timeout_seconds=_float_env("WOLF_RESEARCH_MARKET_PROVIDER_TIMEOUT_SECONDS", 8.0),
        provider_max_retries=_int_env(
            "WOLF_RESEARCH_MARKET_PROVIDER_MAX_RETRIES", 2, minimum=1, maximum=5
        ),
        eastmoney_base_urls=_urls_env(
            "WOLF_RESEARCH_EASTMONEY_BASE_URLS", DEFAULT_EASTMONEY_BASE_URLS
        ),
        eastmoney_kline_base_urls=_urls_env(
            "WOLF_RESEARCH_EASTMONEY_KLINE_BASE_URLS",
            DEFAULT_EASTMONEY_KLINE_BASE_URLS,
        ),
        tencent_kline_url=os.getenv(
            "WOLF_RESEARCH_TENCENT_KLINE_URL",
            "https://web.ifzq.gtimg.cn/appstock/app/fqkline/get",
        ).strip(),
        eastmoney_search_url=os.getenv(
            "WOLF_RESEARCH_EASTMONEY_SEARCH_URL",
            "https://searchapi.eastmoney.com/api/suggest/get",
        ).strip(),
        eastmoney_financial_url=os.getenv(
            "WOLF_RESEARCH_EASTMONEY_FINANCIAL_URL",
            "https://datacenter-web.eastmoney.com/api/data/v1/get",
        ).strip(),
        eastmoney_announcement_url=os.getenv(
            "WOLF_RESEARCH_EASTMONEY_ANNOUNCEMENT_URL",
            "https://np-anotice-stock.eastmoney.com/api/security/ann",
        ).strip(),
        quote_cache_ttl_seconds=_int_env("WOLF_RESEARCH_MARKET_QUOTE_CACHE_TTL_SECONDS", 5),
        symbol_cache_ttl_seconds=_int_env("WOLF_RESEARCH_MARKET_SYMBOL_CACHE_TTL_SECONDS", 86_400),
        kline_cache_ttl_seconds=_int_env("WOLF_RESEARCH_MARKET_KLINE_CACHE_TTL_SECONDS", 1_800),
        financial_cache_ttl_seconds=_int_env(
            "WOLF_RESEARCH_MARKET_FINANCIAL_CACHE_TTL_SECONDS", 21_600
        ),
        announcement_cache_ttl_seconds=_int_env(
            "WOLF_RESEARCH_MARKET_ANNOUNCEMENT_CACHE_TTL_SECONDS", 600
        ),
        screener_cache_ttl_seconds=_int_env("WOLF_RESEARCH_MARKET_SCREENER_CACHE_TTL_SECONDS", 60),
    )
