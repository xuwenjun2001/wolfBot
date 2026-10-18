"""Baidu daily amount supplement. Never replace existing adjusted prices or volumes."""

from __future__ import annotations

import re
from datetime import UTC, date, datetime
from decimal import Decimal, InvalidOperation

from quantpilot_market_data.providers.dashboard import DashboardProvider, DashboardUpstreamError

BAIDU_DAILY_URL = "https://finance.pae.baidu.com/selfselect/getstockquotation"


def supports_amount(secid: str, asset_type: str) -> bool:
    # This endpoint is verified for Shanghai/Shenzhen stocks only, not ETFs or indices.
    return asset_type == "stock" and bool(re.fullmatch(r"(?:1\.6\d{5}|0\.(?:00|30)\d{4})", secid))


def parse_daily_amounts(payload: dict, secid: str, fetched_at: str) -> dict[str, dict]:
    if str(payload.get("ResultCode")) != "0":
        raise DashboardUpstreamError("百度日线接口返回异常")
    result = payload.get("Result")
    market = result.get("newMarketData") if isinstance(result, dict) else None
    if not isinstance(market, dict):
        raise DashboardUpstreamError("百度日线缺少数据结构")
    keys, content = market.get("keys"), market.get("marketData")
    if (
        not isinstance(keys, list)
        or not all(isinstance(key, str) for key in keys)
        or len(keys) != len(set(keys))
        or not {"time", "amount"}.issubset(keys)
        or not isinstance(content, str)
    ):
        raise DashboardUpstreamError("百度日线缺少日期或成交额字段")
    rows = [line for line in content.split(";") if line.strip()]
    if len(rows) > 5000:
        raise DashboardUpstreamError("百度日线超过响应行数限制")
    amounts: dict[str, dict] = {}
    seen: dict[str, Decimal | None] = {}
    for line in rows:
        values = line.split(",")
        if len(values) != len(keys):
            raise DashboardUpstreamError("百度日线字段数量不匹配")
        row = dict(zip(keys, values, strict=True))
        try:
            trading_date = date.fromisoformat(row["time"]).isoformat()
        except ValueError as error:
            raise DashboardUpstreamError("百度日线日期格式异常") from error
        # The response normally has no security identifier; if it supplies one, verify it.
        if row.get("code") not in (None, "", secid[2:]):
            raise DashboardUpstreamError("百度日线标的与请求不一致")
        try:
            amount = Decimal(row["amount"])
            if not amount.is_finite() or amount < 0:
                amount = None
        except InvalidOperation:
            amount = None
        if trading_date in seen and seen[trading_date] != amount:
            raise DashboardUpstreamError("百度日线同一日期成交额冲突")
        seen[trading_date] = amount
        if amount is not None:
            amounts[trading_date] = {
                "value": amount,
                "source": "baidu",
                "fetchedAt": fetched_at,
                "unit": "元",
                "secid": secid,
                "endpoint": BAIDU_DAILY_URL,
                "identityBasis": "validated-market-code-request",
            }
    return amounts


async def fetch_daily_amounts(provider: DashboardProvider, secid: str) -> dict[str, dict]:
    response = await provider._request(
        BAIDU_DAILY_URL,
        params={
            "all": "1",
            "isIndex": "false",
            "isBk": "false",
            "isBlock": "false",
            "isFutures": "false",
            "isStock": "true",
            "newFormat": "1",
            "group": "quotation_kline_ab",
            "finClientType": "pc",
            "code": secid[2:],
            "start_time": "",
            "ktype": "1",
        },
        headers={
            "Accept": "application/vnd.finance-web.v1+json",
            "Origin": "https://gushitong.baidu.com",
            "Referer": "https://gushitong.baidu.com/",
        },
    )
    payload = response.json()
    if not isinstance(payload, dict):
        raise DashboardUpstreamError("百度日线响应不是对象")
    return parse_daily_amounts(payload, secid, datetime.now(UTC).isoformat())
