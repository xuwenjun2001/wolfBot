from __future__ import annotations

import asyncio
from collections.abc import Awaitable
from time import perf_counter

from pydantic import BaseModel

from quantpilot_market_data.cache import MarketDataCache
from quantpilot_market_data.config import MarketSettings
from quantpilot_market_data.models import (
    Adjustment,
    AnalysisContextResponse,
    AnalysisContextSection,
    DataQuality,
    FinancialReportsResponse,
    KlinePeriod,
)
from quantpilot_market_data.providers.eastmoney import EastMoneyClient
from quantpilot_market_data.services.events import get_announcements
from quantpilot_market_data.services.fundamentals import (
    build_fundamental_indicators,
    get_financial_reports,
)
from quantpilot_market_data.services.indicators import build_technical_indicators
from quantpilot_market_data.services.quotes import get_history_quote, get_realtime_quote

DEFAULT_SECTIONS = ("quote", "history", "technical", "financials", "fundamental", "announcements")


async def get_analysis_context(
    client: EastMoneyClient,
    cache: MarketDataCache,
    settings: MarketSettings,
    *,
    symbol: str,
    sections: list[str],
    period: KlinePeriod,
    adjustment: Adjustment,
    limit: int,
    end: str,
    financial_limit: int,
    announcement_limit: int,
) -> AnalysisContextResponse:
    started = perf_counter()
    requested = list(dict.fromkeys(sections))
    tasks: dict[str, Awaitable[BaseModel]] = {}
    if "quote" in requested:
        tasks["quote"] = get_realtime_quote(client, cache, settings, symbol=symbol)
    if "history" in requested or "technical" in requested:
        tasks["history"] = get_history_quote(
            client,
            cache,
            settings,
            symbol=symbol,
            period=period,
            adjustment=adjustment,
            limit=limit,
            end=end,
        )
    if "financials" in requested or "fundamental" in requested:
        tasks["financials"] = get_financial_reports(
            client, cache, settings, symbol=symbol, limit=financial_limit
        )
    if "announcements" in requested:
        tasks["announcements"] = get_announcements(
            client, cache, settings, symbol=symbol, limit=announcement_limit
        )

    async def capture(
        awaitable: Awaitable[BaseModel],
    ) -> tuple[BaseModel | None, Exception | None, int]:
        section_started = perf_counter()
        try:
            return await awaitable, None, max(0, round((perf_counter() - section_started) * 1000))
        except Exception as error:  # Each aggregate section is independently inspectable.
            return None, error, max(0, round((perf_counter() - section_started) * 1000))

    names = list(tasks)
    captured = dict(
        zip(names, await asyncio.gather(*(capture(tasks[name]) for name in names)), strict=True)
    )
    output: dict[str, AnalysisContextSection] = {}
    for name in requested:
        if name == "technical":
            value, error, duration = captured["history"]
            if value is not None:
                derived = build_technical_indicators(value)
                output[name] = AnalysisContextSection(
                    status=derived.data_quality.status,
                    duration_ms=duration,
                    data=derived.model_dump(mode="json"),
                    data_quality=derived.data_quality,
                )
            else:
                output[name] = _section_error("history", error, duration)
        elif name == "fundamental":
            value, error, duration = captured["financials"]
            if isinstance(value, FinancialReportsResponse):
                derived = build_fundamental_indicators(symbol, value.reports)
                output[name] = AnalysisContextSection(
                    status=derived.data_quality.status,
                    duration_ms=duration,
                    data=derived.model_dump(mode="json"),
                    data_quality=derived.data_quality,
                )
            else:
                output[name] = _section_error("financials", error, duration)
        else:
            value, error, duration = captured[name]
            if value is not None:
                quality = getattr(value, "data_quality", DataQuality())
                output[name] = AnalysisContextSection(
                    status=quality.status,
                    duration_ms=duration,
                    data=value.model_dump(mode="json"),
                    data_quality=quality,
                )
            else:
                output[name] = _section_error(name, error, duration)
    failed = [name for name, section in output.items() if section.status == "error"]
    warned = [name for name, section in output.items() if section.status == "warning"]
    if failed and len(failed) == len(output):
        status = "unavailable"
        quality = DataQuality(
            status="error", missing_fields=failed, warnings=["所有请求的数据区块均不可用。"]
        )
    elif failed or warned:
        status = "partial"
        quality = DataQuality(
            status="warning",
            missing_fields=failed,
            warnings=[
                *(f"部分数据区块不可用：{', '.join(failed)}" for _ in [0] if failed),
                *(f"部分数据区块存在质量警告：{', '.join(warned)}" for _ in [0] if warned),
            ],
        )
    else:
        status = "ready"
        quality = DataQuality(status="ok")
    return AnalysisContextResponse(
        symbol=symbol,
        status=status,
        requested_sections=requested,
        sections=output,
        duration_ms=max(0, round((perf_counter() - started) * 1000)),
        data_quality=quality,
    )


def _section_error(
    dependency: str, error: Exception | None, duration: int
) -> AnalysisContextSection:
    detail = str(error) if error is not None else f"{dependency} 未返回数据"
    invalid = isinstance(error, ValueError)
    quality = DataQuality(
        status="error", missing_fields=["data"], warnings=[f"依赖 {dependency} 不可用：{detail}"]
    )
    return AnalysisContextSection(
        status="error",
        duration_ms=duration,
        data_quality=quality,
        error={
            "code": "INVALID_REQUEST" if invalid else "DEPENDENCY_UNAVAILABLE",
            "message": detail,
            "retryable": not invalid,
        },
    )
