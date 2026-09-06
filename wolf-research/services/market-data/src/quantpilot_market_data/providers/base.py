from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol

from quantpilot_market_data.models import (
    Adjustment,
    AnnouncementItem,
    FinancialReportItem,
    KlinePeriod,
    KlineResponse,
    RealtimeQuote,
    SymbolResolveResult,
)


@dataclass(frozen=True)
class ProviderCapability:
    status: str
    markets: tuple[str, ...]
    supports_realtime: bool = False
    supports_history_kline: bool = False
    supports_events: bool = False
    supports_fundamentals: bool = False
    notes: tuple[str, ...] = ()


class MarketProvider(Protocol):
    id: str
    name: str
    capability: ProviderCapability


class QuoteProvider(MarketProvider, Protocol):
    async def resolve_symbol(self, query: str, count: int = 5) -> list[SymbolResolveResult]: ...

    async def get_realtime_quote(self, symbol_or_secid: str) -> RealtimeQuote: ...

    async def get_realtime_quotes(self, symbols_or_secids: list[str]) -> list[RealtimeQuote]: ...

    async def get_kline(
        self,
        symbol_or_secid: str,
        *,
        period: KlinePeriod,
        adjustment: Adjustment,
        limit: int,
        end: str,
    ) -> KlineResponse: ...


class FinancialProvider(MarketProvider, Protocol):
    async def get_financial_reports(
        self, symbol: str, limit: int = 8
    ) -> list[FinancialReportItem]: ...


class AnnouncementProvider(MarketProvider, Protocol):
    async def get_announcements(self, symbol: str, limit: int = 20) -> list[AnnouncementItem]: ...
