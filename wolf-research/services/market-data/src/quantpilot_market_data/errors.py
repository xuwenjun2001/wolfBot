from __future__ import annotations


class MarketDataError(RuntimeError):
    """A locateable error at the market-data service boundary."""

    status_code = 502
    code = "MARKET_DATA_ERROR"
    retryable = False

    def __init__(
        self,
        message: str,
        *,
        code: str | None = None,
        status_code: int | None = None,
        retryable: bool | None = None,
    ) -> None:
        super().__init__(message)
        if code is not None:
            self.code = code
        if status_code is not None:
            self.status_code = status_code
        if retryable is not None:
            self.retryable = retryable


class ProviderError(MarketDataError):
    """An upstream provider failed or returned an invalid response."""

    status_code = 502
    code = "PROVIDER_UNAVAILABLE"
    retryable = True


class DatabaseError(MarketDataError):
    """The local PostgreSQL store is unavailable or not initialized."""

    status_code = 503
    code = "DATABASE_UNAVAILABLE"
    retryable = True


class CacheError(MarketDataError):
    """A cache payload was malformed in a way callers should be able to diagnose."""

    status_code = 500
    code = "CACHE_ERROR"
