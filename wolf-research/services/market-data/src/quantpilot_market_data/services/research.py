from __future__ import annotations

import json
from collections import defaultdict
from datetime import date, datetime
from decimal import Decimal
from typing import Any

from quantpilot_market_data.config import MarketSettings
from quantpilot_market_data.database import connection
from quantpilot_market_data.errors import DatabaseError
from quantpilot_market_data.models import (
    AnalyticsExecutionMetadata,
    AShareScreenerResponse,
    DataQuality,
    LocalKlineBar,
    LocalKlineResponse,
    LocalKlineSummary,
    ResearchUniverseMember,
    ResearchUniverseMembersResponse,
    ResearchUniverseSummary,
    ResearchUniverseSummaryResponse,
    ScreenerCandidate,
)

DEFAULT_UNIVERSE_ID = "a-share-sample-research-pool"
SAFE_STATUSES = {"1", "active", "normal", "trading", "正常", "正常交易"}


async def get_universe_summary(settings: MarketSettings) -> ResearchUniverseSummaryResponse:
    async with connection(settings) as conn:
        try:
            async with conn.cursor() as cursor:
                await cursor.execute(
                    """
                    SELECT u.id, u.name,
                           COUNT(m.symbol)::int AS member_count,
                           COUNT(m.symbol) FILTER (
                             WHERE s.asset_type = 'stock'
                           )::int AS stock_count,
                           COUNT(DISTINCT b.symbol)::int AS ready_count,
                           COUNT(b.symbol)::int AS bar_count,
                           MAX(b.ts) AS latest_ts
                    FROM quant.security_universes u
                    LEFT JOIN quant.security_universe_members m ON m.universe_id = u.id AND m.active
                    LEFT JOIN quant.securities s ON s.symbol = m.symbol
                    LEFT JOIN quant.canonical_stock_bars b ON b.symbol = m.symbol
                    GROUP BY u.id, u.name
                    ORDER BY u.id
                    """
                )
                rows = await cursor.fetchall()
        except Exception as error:
            raise DatabaseError(
                f"研究股票池摘要查询失败：{error}", code="UNIVERSE_QUERY_FAILED"
            ) from error
    return ResearchUniverseSummaryResponse(
        universes=[ResearchUniverseSummary(**dict(row)) for row in rows],
        data_quality=DataQuality(
            status="ok" if rows else "warning",
            missing_fields=[] if rows else ["universes"],
            warnings=[] if rows else ["本地数据库没有已配置的研究股票池。"],
        ),
    )


async def get_universe_members(
    settings: MarketSettings,
    *,
    universe_id: str,
    page: int,
    page_size: int,
    keyword: str | None = None,
) -> ResearchUniverseMembersResponse:
    normalized_page = max(1, page)
    normalized_size = max(1, min(page_size, 500))
    pattern = f"%{keyword.strip()}%" if keyword and keyword.strip() else None
    async with connection(settings) as conn:
        try:
            async with conn.cursor() as cursor:
                await cursor.execute(
                    """
                    SELECT COUNT(*)::int AS total
                    FROM quant.security_universe_members m
                    JOIN quant.securities s ON s.symbol = m.symbol
                    WHERE m.universe_id = %s AND m.active
                      AND (%s::text IS NULL OR s.symbol ILIKE %s OR COALESCE(s.name, '') ILIKE %s)
                    """,
                    (universe_id, pattern, pattern, pattern),
                )
                total = int((await cursor.fetchone())["total"])
                await cursor.execute(
                    """
                    SELECT s.symbol, s.code, s.name, s.exchange, s.asset_type,
                           m.role, m.metadata
                    FROM quant.security_universe_members m
                    JOIN quant.securities s ON s.symbol = m.symbol
                    WHERE m.universe_id = %s AND m.active
                      AND (%s::text IS NULL OR s.symbol ILIKE %s OR COALESCE(s.name, '') ILIKE %s)
                    ORDER BY s.symbol
                    LIMIT %s OFFSET %s
                    """,
                    (
                        universe_id,
                        pattern,
                        pattern,
                        pattern,
                        normalized_size,
                        (normalized_page - 1) * normalized_size,
                    ),
                )
                rows = await cursor.fetchall()
        except Exception as error:
            raise DatabaseError(
                f"研究股票池成员查询失败：{error}", code="UNIVERSE_MEMBERS_QUERY_FAILED"
            ) from error
    members = [
        ResearchUniverseMember(
            symbol=str(row["symbol"]),
            code=str(row["code"] or row["symbol"]),
            name=row.get("name"),
            exchange=str(row.get("exchange") or "UNKNOWN"),
            asset_type=str(row.get("asset_type") or "stock"),
            role=str(row.get("role") or "member"),
            metadata=_json_object(row.get("metadata")),
        )
        for row in rows
    ]
    return ResearchUniverseMembersResponse(
        universe_id=universe_id,
        page=normalized_page,
        page_size=normalized_size,
        total=total,
        total_pages=(total + normalized_size - 1) // normalized_size,
        members=members,
    )


async def get_local_bars(
    settings: MarketSettings,
    *,
    symbol: str,
    limit: int,
    provider: str | None = None,
) -> LocalKlineResponse:
    normalized = symbol.strip().upper()
    async with connection(settings) as conn:
        try:
            async with conn.cursor() as cursor:
                await cursor.execute(
                    """
                    SELECT b.symbol, b.code, b.name, b.exchange, b.asset_type, b.secid, b.provider,
                           b.timeframe, b.adjustment, b.ts, b.open, b.high, b.low, b.close,
                           b.previous_close, b.volume, b.amount, b.change_percent, b.turnover,
                           b.trade_status, b.is_st, b.limit_up, b.limit_down, b.metadata
                    FROM quant.canonical_stock_bars b
                    WHERE (b.symbol = %s OR b.code = %s)
                      AND (%s::text IS NULL OR b.provider = %s)
                    ORDER BY b.ts DESC
                    LIMIT %s
                    """,
                    (normalized, normalized, provider, provider, max(1, min(limit, 2_000))),
                )
                rows = list(await cursor.fetchall())
        except Exception as error:
            raise DatabaseError(
                f"本地 K 线查询失败：{error}", code="LOCAL_BARS_QUERY_FAILED"
            ) from error
    rows.reverse()
    bars = [_local_bar(dict(row)) for row in rows]
    first_row = rows[0] if rows else {}
    latest = bars[-1] if bars else None
    previous = bars[0].close if bars else None
    return_pct = (
        ((latest.close - previous) / previous * Decimal("100"))
        if latest and previous not in (None, Decimal("0"))
        else None
    )
    summary = LocalKlineSummary(
        row_count=len(bars),
        first_ts=bars[0].ts if bars else None,
        last_ts=latest.ts if latest else None,
        latest_close=latest.close if latest else None,
        previous_close=previous,
        return_pct=return_pct,
        high=max((bar.high for bar in bars), default=None),
        low=min((bar.low for bar in bars), default=None),
        total_volume=sum((bar.volume for bar in bars), Decimal("0")),
        total_amount=sum((bar.amount for bar in bars if bar.amount is not None), Decimal("0"))
        if bars
        else None,
    )
    quality = DataQuality(
        status="ok" if bars else "warning",
        missing_fields=[] if bars else ["bars"],
        warnings=[] if bars else ["本地数据库没有该标的 K 线。"],
    )
    return LocalKlineResponse(
        symbol=normalized,
        code=str(first_row["code"]) if first_row.get("code") else None,
        name=str(first_row["name"]) if first_row.get("name") else None,
        exchange=str(first_row.get("exchange") or "UNKNOWN"),
        asset_type=str(first_row.get("asset_type") or "stock"),
        secid=str(first_row["secid"]) if first_row.get("secid") else None,
        provider=str(first_row["provider"]) if first_row.get("provider") else provider,
        timeframe=str(first_row.get("timeframe") or "daily"),
        adjustment=str(first_row.get("adjustment") or "qfq"),
        bars=bars,
        summary=summary,
        data_quality=quality,
    )


async def screen_short_term_candidates(
    settings: MarketSettings,
    *,
    universe_id: str,
    trade_date: date | None,
    limit: int,
    sector: str | None,
    mode: str = "short_term",
) -> AShareScreenerResponse:
    async with connection(settings) as conn:
        try:
            async with conn.cursor() as cursor:
                await cursor.execute(
                    """
                    SELECT s.symbol, s.code, s.name, s.exchange,
                           s.metadata AS security_metadata,
                           b.ts, b.open, b.high, b.low, b.close, b.previous_close,
                           b.volume, b.amount,
                           b.change_percent, b.turnover, b.trade_status,
                           b.is_st, b.limit_up, b.limit_down,
                           b.provider
                    FROM quant.security_universe_members m
                    JOIN quant.securities s ON s.symbol = m.symbol
                    LEFT JOIN LATERAL (
                      SELECT * FROM quant.canonical_stock_bars cb
                      WHERE cb.symbol = m.symbol
                        AND cb.timeframe = 'daily'
                        AND cb.adjustment = 'qfq'
                      ORDER BY cb.ts DESC LIMIT 120
                    ) b ON TRUE
                    WHERE m.universe_id = %s AND m.active AND s.asset_type = 'stock'
                    ORDER BY s.symbol, b.ts DESC
                    """,
                    (universe_id,),
                )
                rows = [dict(row) for row in await cursor.fetchall()]
        except Exception as error:
            raise DatabaseError(
                f"A 股筛选查询失败：{error}", code="SCREENER_QUERY_FAILED"
            ) from error

    grouped: dict[str, list[dict[str, Any]]] = defaultdict(list)
    members: dict[str, dict[str, Any]] = {}
    for row in rows:
        symbol = str(row["symbol"])
        members[symbol] = row
        if row.get("ts") is not None:
            grouped[symbol].append(row)
    target = trade_date or max(
        (_trade_date(row.get("ts")) for row in rows if row.get("ts") is not None), default=None
    )
    candidates: list[ScreenerCandidate] = []
    excluded: dict[str, int] = defaultdict(int)
    complete = 0
    for symbol, member in members.items():
        history = sorted(grouped.get(symbol, []), key=lambda item: item["ts"])
        latest = history[-1] if history else member
        reasons = _exclusion_reasons(member, history, latest, target, sector)
        complete += int(_safety_complete(latest))
        for reason in set(reasons):
            excluded[reason] += 1
        if reasons:
            continue
        candidate = _candidate(member, history, latest, target)
        candidates.append(candidate)
    candidates.sort(key=lambda item: item.score or Decimal("0"), reverse=True)
    selected = candidates[: max(1, min(limit, 100))]
    total = len(members)
    coverage = round(complete / total * 100, 2) if total else 0.0
    quality = DataQuality(
        status="ok" if selected else "warning",
        missing_fields=[] if selected else ["candidates"],
        warnings=[] if selected else ["本地研究池没有满足筛选条件的候选，或尚未导入足够历史行情。"],
    )
    return AShareScreenerResponse(
        universe_id=universe_id,
        mode=mode,
        trade_date=target,
        scanned_symbols=total,
        total_symbols=total,
        eligible_symbols=len(candidates),
        excluded_symbols=total - len(candidates),
        excluded_reasons=dict(sorted(excluded.items())),
        safety_complete_symbols=complete,
        safety_coverage_pct=coverage,
        coverage_warning=(
            f"交易安全字段仅覆盖 {complete}/{total} 个标的，未知状态按不可交易排除。"
            if total and coverage < 95
            else None
        ),
        limit=max(1, min(limit, 100)),
        candidates=selected,
        cache_status="bypass",
        cache_ttl_seconds=settings.screener_cache_ttl_seconds,
        analytics=AnalyticsExecutionMetadata(
            engine="postgresql",
            status="ready",
            basis="postgresql.quant.canonical_stock_bars",
            target_trade_date=target,
        ),
        notes=["筛选仅使用本地 PostgreSQL 日线数据；未启用 ClickHouse 或 shadow replay。"],
        data_quality=quality,
    )


def _json_object(value: Any) -> dict[str, Any]:
    if isinstance(value, dict):
        return value
    if isinstance(value, str):
        try:
            parsed = json.loads(value)
            return parsed if isinstance(parsed, dict) else {}
        except json.JSONDecodeError:
            return {}
    return {}


def _trade_date(value: Any) -> date | None:
    if isinstance(value, datetime):
        return value.date()
    return (
        value if isinstance(value, date) else date.fromisoformat(str(value)[:10]) if value else None
    )


def _local_bar(row: dict[str, Any]) -> LocalKlineBar:
    return LocalKlineBar(
        ts=row["ts"],
        open=row["open"],
        high=row["high"],
        low=row["low"],
        close=row["close"],
        previous_close=row.get("previous_close"),
        volume=row.get("volume") or Decimal("0"),
        amount=row.get("amount"),
        change_percent=row.get("change_percent"),
        turnover=row.get("turnover"),
        trade_status=row.get("trade_status"),
        is_st=row.get("is_st"),
        limit_up=row.get("limit_up"),
        limit_down=row.get("limit_down"),
        provider=str(row.get("provider") or "local"),
        metadata=_json_object(row.get("metadata")),
    )


def _safety_complete(row: dict[str, Any]) -> bool:
    return all(
        row.get(key) is not None for key in ("is_st", "limit_up", "limit_down", "trade_status")
    )


def _exclusion_reasons(
    member: dict[str, Any],
    history: list[dict[str, Any]],
    latest: dict[str, Any],
    target: date | None,
    sector: str | None,
) -> list[str]:
    reasons: list[str] = []
    code = str(member.get("code") or member.get("symbol") or "")
    name = str(member.get("name") or "")
    exchange = str(member.get("exchange") or "UNKNOWN").upper()
    if exchange == "BJ" or code.startswith(("4", "8", "688")):
        reasons.append("unsupported_board")
    if "ST" in name.upper():
        reasons.append("name_st_marker")
    latest_date = _trade_date(latest.get("ts"))
    if latest_date is None:
        reasons.append("missing_latest_bar")
    elif target and latest_date != target:
        reasons.append("stale_latest_bar")
    if len(history) < 20:
        reasons.append("insufficient_history")
    if sector and not _sector_matches(member.get("security_metadata"), sector):
        reasons.append("sector_mismatch")
    if not _safety_complete(latest):
        reasons.extend(
            key
            for key in (
                "missing_is_st",
                "missing_limit_up",
                "missing_limit_down",
                "missing_trade_status",
            )
            if latest.get(key.removeprefix("missing_")) is None
        )
    else:
        if latest.get("is_st") is True:
            reasons.append("is_st")
        if latest.get("limit_up") is True:
            reasons.append("is_limit_up")
        if latest.get("limit_down") is True:
            reasons.append("is_limit_down")
        if str(latest.get("trade_status") or "").lower() not in SAFE_STATUSES:
            reasons.append("unsafe_trade_status")
    return reasons


def _sector_matches(metadata: Any, requested: str) -> bool:
    normalized = (
        "".join(requested.split())
        .removesuffix("板块")
        .removesuffix("行业")
        .removesuffix("概念")
        .casefold()
    )
    values = _json_object(metadata)
    candidates = [
        values.get(key) for key in ("industry", "region", "sector_hint", "concepts", "sector_tags")
    ]
    flattened = json.dumps(candidates, ensure_ascii=False).casefold().replace(" ", "")
    return not normalized or normalized in flattened


def _candidate(
    member: dict[str, Any],
    history: list[dict[str, Any]],
    latest: dict[str, Any],
    target: date | None,
) -> ScreenerCandidate:
    closes = [row.get("close") for row in history]

    def ma(window: int) -> Decimal | None:
        sample = [value for value in closes[-window:] if value is not None]
        return sum(sample, Decimal("0")) / Decimal(len(sample)) if len(sample) == window else None

    close_20 = closes[-21] if len(closes) >= 21 else None
    latest_close = latest.get("close")
    strength = (
        (latest_close - close_20) / close_20 * Decimal("100")
        if latest_close is not None and close_20 not in (None, Decimal("0"))
        else None
    )
    amounts = [row.get("amount") for row in history[-21:-1] if row.get("amount") is not None]
    average_amount = sum(amounts, Decimal("0")) / Decimal(len(amounts)) if amounts else None
    amount_ratio = (
        latest.get("amount") / average_amount
        if latest.get("amount") is not None and average_amount not in (None, Decimal("0"))
        else None
    )
    ma5, ma10, ma20, ma30, ma60 = (ma(window) for window in (5, 10, 20, 30, 60))
    score = Decimal("0")
    if (
        all(value is not None for value in (ma5, ma10, ma20, ma30, ma60))
        and ma5 >= ma10 >= ma20 >= ma30 >= ma60
    ):
        score += Decimal("28")
    if latest_close is not None and ma5 is not None and latest_close >= ma5:
        score += Decimal("12")
    if strength is not None:
        score += max(Decimal("0"), min(Decimal("18"), strength / Decimal("2")))
    if amount_ratio is not None:
        score += max(Decimal("0"), min(Decimal("16"), amount_ratio * Decimal("5")))
    if latest.get("change_percent") is not None and latest["change_percent"] > 0:
        score += Decimal("8")
    signals = (
        ["收盘价站上 MA5"]
        if latest_close is not None and ma5 is not None and latest_close >= ma5
        else []
    )
    if latest.get("change_percent") is not None and latest["change_percent"] > 0:
        signals.append("今日上涨")
    if amount_ratio is not None and amount_ratio >= Decimal("1.2"):
        signals.append("成交额较20日均额放大")
    limit_up_dates = [
        _trade_date(row.get("ts")) for row in history[-10:] if row.get("limit_up") is True
    ]
    return ScreenerCandidate(
        symbol=str(member.get("symbol")),
        code=str(member.get("code") or member.get("symbol")),
        name=member.get("name"),
        exchange=str(member.get("exchange") or "UNKNOWN"),
        trade_date=target or _trade_date(latest.get("ts")) or date.today(),
        close=latest_close,
        open=latest.get("open"),
        high=latest.get("high"),
        low=latest.get("low"),
        previous_close=latest.get("previous_close"),
        change_percent=latest.get("change_percent"),
        amount=latest.get("amount"),
        turnover=latest.get("turnover"),
        ma5=ma5,
        ma10=ma10,
        ma20=ma20,
        ma30=ma30,
        ma60=ma60,
        strength_20d_pct=strength,
        amount_ratio_20d=amount_ratio,
        limit_up_count_4d=sum(row.get("limit_up") is True for row in history[-4:]),
        limit_up_count_10d=len(limit_up_dates),
        latest_limit_up_date=max(limit_up_dates, default=None),
        is_limit_up=latest.get("limit_up"),
        is_limit_down=latest.get("limit_down"),
        is_st=latest.get("is_st"),
        trade_status=str(latest.get("trade_status") or ""),
        sample_count=len(history),
        score=score.quantize(Decimal("0.01")),
        signals=signals,
    )
