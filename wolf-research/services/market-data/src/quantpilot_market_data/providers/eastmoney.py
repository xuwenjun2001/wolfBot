from __future__ import annotations

import asyncio
from datetime import UTC, datetime
from decimal import Decimal, InvalidOperation
from typing import Any

import httpx

from quantpilot_market_data.config import MarketSettings
from quantpilot_market_data.errors import ProviderError
from quantpilot_market_data.models import (
    Adjustment,
    AnnouncementItem,
    AssetType,
    FinancialReportItem,
    KlineBar,
    KlinePeriod,
    KlineResponse,
    MarketCode,
    RealtimeQuote,
    SymbolResolveResult,
)
from quantpilot_market_data.providers.base import ProviderCapability

REALTIME_PATH = "/api/qt/ulist.np/get"
KLINE_PATH = "/api/qt/stock/kline/get"
SYMBOL_LIST_PATH = "/api/qt/clist/get"
QUOTE_FIELDS = ",".join(
    [
        "f2",
        "f3",
        "f4",
        "f5",
        "f6",
        "f7",
        "f8",
        "f9",
        "f12",
        "f13",
        "f14",
        "f15",
        "f16",
        "f17",
        "f18",
        "f20",
        "f21",
        "f23",
        "f100",
        "f102",
        "f103",
        "f124",
    ]
)
KLINE_FIELDS = "f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61"
A_SHARE_FS = "m:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23,m:0+t:81+s:2048"
ETF_FS = "b:MK0021,b:MK0022,b:MK0023,b:MK0024"
INDEX_CODES = {"000001", "000300", "000688", "000852", "000905", "399001", "399006", "399300"}
SH_ETF_PREFIXES = (
    "510",
    "511",
    "512",
    "513",
    "515",
    "516",
    "517",
    "518",
    "519",
    "520",
    "521",
    "522",
    "523",
    "524",
    "525",
    "526",
    "527",
    "528",
    "529",
    "530",
    "531",
    "532",
    "560",
    "561",
    "562",
    "563",
    "588",
    "589",
)
ALIASES = {
    "沪深300": "1.000300",
    "沪深 300": "1.000300",
    "HS300": "1.000300",
    "上证指数": "1.000001",
    "上证综指": "1.000001",
    "上证": "1.000001",
    "深证成指": "0.399001",
    "深成指": "0.399001",
    "创业板指": "0.399006",
    "创业板指数": "0.399006",
    "科创50": "1.000688",
    "科创 50": "1.000688",
    "中证500": "1.000905",
    "中证 500": "1.000905",
    "中证1000": "1.000852",
    "中证 1000": "1.000852",
    "沪深300ETF": "1.510300",
    "沪深300 ETF": "1.510300",
    "300ETF": "1.510300",
}


def _text(value: Any) -> str | None:
    if value in (None, "", "-"):
        return None
    return str(value).strip() or None


def _decimal(value: Any) -> Decimal | None:
    if value in (None, "", "-"):
        return None
    try:
        result = Decimal(str(value).replace(",", "").strip())
    except InvalidOperation, ValueError:
        return None
    return result if result.is_finite() else None


def _integer(value: Any) -> int | None:
    decimal = _decimal(value)
    return int(decimal) if decimal is not None else None


def _datetime(value: Any) -> datetime | None:
    if value in (None, "", "-"):
        return None
    if isinstance(value, (int, float)) or (isinstance(value, str) and value.isdigit()):
        seconds = _integer(value)
        return datetime.fromtimestamp(seconds, UTC) if seconds and seconds > 0 else None
    text = str(value).replace(":", "-", 2) if str(value).count(":") > 2 else str(value)
    for candidate in (text, text.replace(" ", "T")):
        try:
            parsed = datetime.fromisoformat(candidate)
            return parsed.replace(tzinfo=UTC) if parsed.tzinfo is None else parsed.astimezone(UTC)
        except ValueError:
            continue
    for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%d"):
        try:
            return datetime.strptime(text, fmt).replace(tzinfo=UTC)
        except ValueError:
            continue
    return None


def normalize_secid(value: str) -> str:
    raw = value.strip()
    if not raw:
        raise ValueError("股票代码不能为空")
    alias = ALIASES.get(raw) or ALIASES.get(raw.upper())
    if alias:
        return alias
    if "." in raw:
        market, code = raw.split(".", 1)
        if market in {"0", "1", "2"} and code.isdigit() and len(code) == 6:
            return f"{market}.{code}"
        if len(market) == 6 and code.upper() in {"SH", "SZ", "BJ"}:
            return normalize_secid(market)
        raise ValueError(f"无效的东方财富 secid：{value}")
    code = raw.upper().removeprefix("SH").removeprefix("SZ").removeprefix("BJ")
    if not code.isdigit() or len(code) != 6:
        raise ValueError(f"无效的股票代码：{value}")
    if code in INDEX_CODES:
        return f"{'1' if code.startswith('000') else '0'}.{code}"
    if code.startswith(SH_ETF_PREFIXES) or code.startswith(("6", "9")):
        return f"1.{code}"
    if code.startswith(("0", "2", "3", "4", "8")):
        return f"0.{code}"
    raise ValueError(f"无法推断东方财富市场编号：{value}")


def _build_tencent_kline_param(
    secid: str,
    *,
    period: KlinePeriod,
    adjustment: Adjustment,
    limit: int,
    end: str,
) -> str:
    market_id, symbol = secid.split(".", 1)
    market_prefix = "bj" if symbol.startswith(("4", "8", "920")) else (
        "sh" if market_id == "1" else "sz"
    )
    period_value = {"daily": "day", "weekly": "week", "monthly": "month"}[period]
    adjustment_prefix = {"none": "", "qfq": "qfq", "hfq": "hfq"}[adjustment]
    end_value = end.strip()
    if not end_value or end_value == "20500101":
        end_value = ""
    elif len(end_value) == 8 and end_value.isdigit():
        end_value = f"{end_value[:4]}-{end_value[4:6]}-{end_value[6:]}"
    return (
        f"{market_prefix}{symbol},{period_value},,{end_value},{limit},{adjustment_prefix}"
    )


def _tencent_kline_row_key(
    period: KlinePeriod,
    adjustment: Adjustment,
) -> str:
    period_value = {"daily": "day", "weekly": "week", "monthly": "month"}[period]
    if adjustment == "qfq":
        return f"qfq{period_value}"
    if adjustment == "hfq":
        return f"hfq{period_value}"
    return period_value


def market_from_secid(secid: str) -> MarketCode:
    market, code = secid.split(".", 1)
    if code.startswith(("4", "8", "920")):
        return "BJ"
    if market == "1" or code.startswith(("6", "9")):
        return "SH"
    if market == "0" or code.startswith(("0", "2", "3")):
        return "SZ"
    return "UNKNOWN"


def asset_type(symbol: str, secid: str, name: str | None = None) -> AssetType:
    upper_name = (name or "").upper()
    if symbol in INDEX_CODES or "指数" in (name or ""):
        return "index"
    if (
        "ETF" in upper_name
        or symbol.startswith(SH_ETF_PREFIXES)
        or (secid.startswith("0.") and symbol.startswith(("15", "16", "18")))
    ):
        return "etf"
    return "stock"


def _concepts(value: Any) -> list[str]:
    if isinstance(value, list):
        candidates = value
    else:
        text = str(value or "").replace("，", ",").replace("、", ",").replace("；", ",")
        candidates = text.replace(";", ",").replace("|", ",").split(",")
    seen: set[str] = set()
    result: list[str] = []
    for candidate in candidates:
        clean = _text(candidate)
        if clean and clean not in seen:
            seen.add(clean)
            result.append(clean)
    return result


class EastMoneyClient:
    id = "eastmoney"
    name = "东方财富"
    capability = ProviderCapability(
        status="degraded",
        markets=("a-share", "index-etf"),
        supports_realtime=True,
        supports_history_kline=True,
        supports_events=True,
        supports_fundamentals=True,
        notes=("公开接口需要网络可达。历史 K 线失败时按配置尝试腾讯公开接口。",),
    )

    def __init__(self, settings: MarketSettings) -> None:
        self.settings = settings
        self.headers = {
            "Accept": "application/json,text/plain,*/*",
            "User-Agent": "WolfResearch/0.1 (+local-market-data)",
            "Referer": "https://quote.eastmoney.com/",
        }

    def _client(self) -> httpx.AsyncClient:
        return httpx.AsyncClient(
            timeout=self.settings.provider_timeout_seconds,
            trust_env=True,
            headers=self.headers,
        )

    async def _get_json(self, urls: tuple[str, ...], params: dict[str, Any]) -> dict[str, Any]:
        errors: list[str] = []
        attempts = self.settings.provider_max_retries + 1
        async with self._client() as client:
            for url in urls:
                for attempt in range(attempts):
                    try:
                        response = await client.get(url, params=params)
                        response.raise_for_status()
                        payload = response.json()
                        if not isinstance(payload, dict):
                            raise ValueError("响应根节点不是 JSON 对象")
                        return payload
                    except (httpx.HTTPError, ValueError) as error:
                        errors.append(f"{url} attempt={attempt + 1}: {error}")
                        if attempt < attempts - 1:
                            await asyncio.sleep(0.25 * (attempt + 1))
        raise ProviderError(
            f"东方财富公开接口请求失败：{'；'.join(errors)[:2_000]}",
            code="EASTMONEY_REQUEST_FAILED",
            retryable=True,
        )

    async def resolve_symbol(self, query: str, count: int = 5) -> list[SymbolResolveResult]:
        normalized = query.strip()
        alias = ALIASES.get(normalized) or ALIASES.get(normalized.upper())
        if alias:
            symbol = alias.split(".", 1)[1]
            return [
                SymbolResolveResult(
                    query=query,
                    symbol=symbol,
                    name=normalized,
                    asset_type=asset_type(symbol, alias, normalized),
                    market=market_from_secid(alias),
                    secid=alias,
                    source=self.id,
                    confidence=1,
                    raw={"resolution": "known_alias"},
                )
            ]
        payload = await self._get_json(
            (self.settings.eastmoney_search_url,),
            {"input": normalized, "type": "14", "count": max(1, min(count, 20))},
        )
        table = payload.get("QuotationCodeTable")
        rows = table.get("Data") if isinstance(table, dict) else None
        if not isinstance(rows, list):
            return []
        result: list[SymbolResolveResult] = []
        for row in rows:
            if not isinstance(row, dict):
                continue
            code = str(row.get("Code") or row.get("UnifiedCode") or "")
            quote_id = str(row.get("QuoteID") or "")
            try:
                secid = normalize_secid(quote_id or code)
            except ValueError:
                continue
            symbol = code or secid.split(".", 1)[1]
            name = _text(row.get("Name"))
            result.append(
                SymbolResolveResult(
                    query=query,
                    symbol=symbol,
                    name=name,
                    asset_type=asset_type(symbol, secid, name),
                    market=market_from_secid(secid),
                    secid=secid,
                    source=self.id,
                    raw=row,
                )
            )
        return result

    async def get_realtime_quote(self, symbol_or_secid: str) -> RealtimeQuote:
        quotes = await self.get_realtime_quotes([symbol_or_secid])
        if not quotes:
            raise ProviderError(
                f"东方财富未返回行情数据：{symbol_or_secid}",
                code="QUOTE_NOT_FOUND",
                retryable=False,
            )
        return quotes[0]

    async def get_realtime_quotes(self, symbols_or_secids: list[str]) -> list[RealtimeQuote]:
        secids = [normalize_secid(value) for value in symbols_or_secids]
        payload = await self._get_json(
            tuple(
                f"{base.rstrip('/')}{REALTIME_PATH}" for base in self.settings.eastmoney_base_urls
            ),
            {"secids": ",".join(secids), "fields": QUOTE_FIELDS, "fltt": "2", "invt": "2"},
        )
        if payload.get("rc") != 0:
            raise ProviderError(
                f"东方财富行情接口返回异常 rc={payload.get('rc')}。",
                code="QUOTE_PAYLOAD_INVALID",
                retryable=True,
            )
        data = payload.get("data")
        rows = data.get("diff") if isinstance(data, dict) else None
        if not isinstance(rows, list):
            raise ProviderError(
                "东方财富未返回行情列表。", code="QUOTE_PAYLOAD_INVALID", retryable=True
            )
        requested = {secid.split(".", 1)[1]: secid for secid in secids}
        return [
            self._parse_quote(requested.get(str(row.get("f12")), ""), row)
            for row in rows
            if isinstance(row, dict)
        ]

    def _parse_quote(self, requested_secid: str, row: dict[str, Any]) -> RealtimeQuote:
        symbol = str(
            row.get("f12") or (requested_secid.split(".", 1)[1] if requested_secid else "")
        )
        secid = requested_secid or f"{row.get('f13', '')}.{symbol}"
        name = _text(row.get("f14"))
        return RealtimeQuote(
            symbol=symbol,
            secid=secid,
            name=name,
            asset_type=asset_type(symbol, secid, name),
            market=market_from_secid(secid),
            source=self.id,
            price=_decimal(row.get("f2")),
            open=_decimal(row.get("f17")),
            high=_decimal(row.get("f15")),
            low=_decimal(row.get("f16")),
            previous_close=_decimal(row.get("f18")),
            change_percent=_decimal(row.get("f3")),
            change_amount=_decimal(row.get("f4")),
            amplitude=_decimal(row.get("f7")),
            turnover=_decimal(row.get("f8")),
            volume=_integer(row.get("f5")),
            amount=_decimal(row.get("f6")),
            market_cap=_decimal(row.get("f20")),
            float_market_cap=_decimal(row.get("f21")),
            pe_ttm=_decimal(row.get("f9")),
            pb_mrq=_decimal(row.get("f23")),
            industry=_text(row.get("f100")),
            region=_text(row.get("f102")),
            concepts=_concepts(row.get("f103")),
            quote_time=_datetime(row.get("f124")),
            fetched_at=datetime.now(UTC),
        )

    async def get_kline(
        self,
        symbol_or_secid: str,
        *,
        period: KlinePeriod,
        adjustment: Adjustment,
        limit: int,
        end: str,
    ) -> KlineResponse:
        secid = normalize_secid(symbol_or_secid)
        params = {
            "secid": secid,
            "fields1": "f1,f2,f3,f4,f5,f6",
            "fields2": KLINE_FIELDS,
            "klt": {
                "daily": 101,
                "weekly": 102,
                "monthly": 103,
                "minute1": 1,
                "minute5": 5,
                "minute15": 15,
                "minute30": 30,
                "minute60": 60,
            }[period],
            "fqt": {"none": 0, "qfq": 1, "hfq": 2}[adjustment],
            "end": end,
            "lmt": max(1, min(limit, 2_000)),
        }
        errors: list[str] = []
        try:
            payload = await self._get_json(
                tuple(
                    f"{base.rstrip('/')}{KLINE_PATH}"
                    for base in self.settings.eastmoney_kline_base_urls
                ),
                params,
            )
            return self._parse_eastmoney_kline(secid, period, adjustment, payload)
        except ProviderError as error:
            errors.append(str(error))

        if period in {"daily", "weekly", "monthly"}:
            try:
                payload = await self._get_json(
                    (self.settings.tencent_kline_url,),
                    {
                        "param": _build_tencent_kline_param(
                            secid,
                            period=period,
                            adjustment=adjustment,
                            limit=min(limit, 800),
                            end=end,
                        ),
                    },
                )
                return self._parse_tencent_kline(secid, period, adjustment, payload)
            except (ProviderError, ValueError) as error:
                errors.append(str(error))
        raise ProviderError(
            f"历史 K 线请求失败：{'；'.join(errors)[:2_000]}",
            code="KLINE_UNAVAILABLE",
            retryable=True,
        )

    def _parse_eastmoney_kline(
        self, secid: str, period: KlinePeriod, adjustment: Adjustment, payload: dict[str, Any]
    ) -> KlineResponse:
        if payload.get("rc") != 0:
            raise ProviderError(
                f"东方财富 K 线接口返回异常 rc={payload.get('rc')}。", code="KLINE_PAYLOAD_INVALID"
            )
        data = payload.get("data")
        rows = data.get("klines") if isinstance(data, dict) else None
        if not isinstance(rows, list):
            raise ProviderError("东方财富未返回 K 线列表。", code="KLINE_PAYLOAD_INVALID")
        bars = [self._parse_kline_row(row) for row in rows if isinstance(row, str)]
        return KlineResponse(
            symbol=str(data.get("code") or secid.split(".", 1)[1]),
            name=_text(data.get("name")),
            secid=secid,
            asset_type=asset_type(
                str(data.get("code") or secid.split(".", 1)[1]), secid, _text(data.get("name"))
            ),
            market=market_from_secid(secid),
            source=self.id,
            period=period,
            adjustment=adjustment,
            bars=bars,
            as_of=bars[-1].date if bars else None,
            fetched_at=datetime.now(UTC),
            metadata={
                "data_basis": "eastmoney_push2his",
                "provider_payload": {k: v for k, v in data.items() if k != "klines"},
            },
        )

    def _parse_kline_row(self, row: str) -> KlineBar:
        values = row.split(",") + [""] * 11
        return KlineBar(
            date=values[0],
            open=_decimal(values[1]),
            close=_decimal(values[2]),
            high=_decimal(values[3]),
            low=_decimal(values[4]),
            volume=_integer(values[5]),
            amount=_decimal(values[6]),
            amplitude=_decimal(values[7]),
            change_percent=_decimal(values[8]),
            change_amount=_decimal(values[9]),
            turnover=_decimal(values[10]),
            metadata={"source": self.id, "raw": row},
        )

    def _parse_tencent_kline(
        self, secid: str, period: KlinePeriod, adjustment: Adjustment, payload: dict[str, Any]
    ) -> KlineResponse:
        if payload.get("code") != 0:
            raise ProviderError("腾讯 K 线接口返回异常。", code="TENCENT_KLINE_PAYLOAD_INVALID")
        market, symbol = secid.split(".", 1)
        prefix = "bj" if symbol.startswith(("4", "8", "920")) else (
            "sh" if market == "1" else "sz"
        )
        key = prefix + symbol
        data = payload.get("data")
        item = data.get(key) if isinstance(data, dict) else None
        if not isinstance(item, dict):
            raise ProviderError("腾讯未返回 K 线数据。", code="TENCENT_KLINE_PAYLOAD_INVALID")
        period_key = _tencent_kline_row_key(period, adjustment)
        rows = item.get(period_key) or []
        if not isinstance(rows, list):
            raise ProviderError("腾讯未返回 K 线列表。", code="TENCENT_KLINE_PAYLOAD_INVALID")
        bars: list[KlineBar] = []
        previous: Decimal | None = None
        for row in rows:
            if not isinstance(row, list) or len(row) < 6:
                continue
            close = _decimal(row[2])
            change = (
                ((close - previous) / previous * Decimal("100"))
                if close is not None and previous
                else None
            )
            bars.append(
                KlineBar(
                    date=str(row[0]),
                    open=_decimal(row[1]),
                    close=close,
                    high=_decimal(row[3]),
                    low=_decimal(row[4]),
                    previous_close=previous,
                    volume=_integer(row[5]),
                    change_percent=change,
                    change_amount=close - previous
                    if close is not None and previous is not None
                    else None,
                    metadata={"source": "tencent", "raw": row},
                )
            )
            previous = close
        quote = item.get("qt", {}).get(key) if isinstance(item.get("qt"), dict) else None
        name = quote[1] if isinstance(quote, list) and len(quote) > 1 else None
        return KlineResponse(
            symbol=symbol,
            name=_text(name),
            secid=secid,
            asset_type=asset_type(symbol, secid, _text(name)),
            market=market_from_secid(secid),
            source="tencent",
            period=period,
            adjustment=adjustment,
            bars=bars,
            as_of=bars[-1].date if bars else None,
            fetched_at=datetime.now(UTC),
            metadata={"data_basis": "tencent"},
        )

    async def get_financial_reports(self, symbol: str, limit: int = 8) -> list[FinancialReportItem]:
        code = normalize_secid(symbol).split(".", 1)[1]
        payload = await self._get_json(
            (self.settings.eastmoney_financial_url,),
            {
                "reportName": "RPT_LICO_FN_CPD",
                "columns": "ALL",
                "filter": f'(SECURITY_CODE="{code}")',
                "pageNumber": 1,
                "pageSize": max(1, min(limit, 40)),
                "sortTypes": -1,
                "sortColumns": "REPORTDATE",
                "source": "WEB",
                "client": "WEB",
            },
        )
        if payload.get("success") is False:
            raise ProviderError("东方财富财务摘要接口返回异常。", code="FINANCIAL_PAYLOAD_INVALID")
        result = payload.get("result")
        rows = result.get("data") if isinstance(result, dict) else None
        if not isinstance(rows, list):
            return []
        return [
            FinancialReportItem(
                symbol=str(row.get("SECURITY_CODE") or code),
                name=_text(row.get("SECURITY_NAME_ABBR")),
                secucode=_text(row.get("SECUCODE")),
                report_date=_datetime(row.get("REPORTDATE")),
                data_type=_text(row.get("DATATYPE")),
                basic_eps=_decimal(row.get("BASIC_EPS")),
                revenue=_decimal(row.get("TOTAL_OPERATE_INCOME")),
                parent_net_profit=_decimal(row.get("PARENT_NETPROFIT")),
                weighted_roe=_decimal(row.get("WEIGHTAVG_ROE")),
                gross_margin=_decimal(row.get("XSMLL")),
                revenue_yoy=_decimal(row.get("YSTZ")),
                net_profit_yoy=_decimal(row.get("SJLTZ")),
                operating_cash_flow_per_share=_decimal(row.get("MGJYXJJE")),
                notice_date=_datetime(row.get("NOTICE_DATE")),
                source=self.id,
                raw=row,
            )
            for row in rows
            if isinstance(row, dict)
        ]

    async def get_announcements(self, symbol: str, limit: int = 20) -> list[AnnouncementItem]:
        secid = normalize_secid(symbol)
        market, code = secid.split(".", 1)
        payload = await self._get_json(
            (self.settings.eastmoney_announcement_url,),
            {
                "sr": -1,
                "page_size": max(1, min(limit, 100)),
                "page_index": 1,
                "ann_type": "A",
                "client_source": "web",
                "stock_list": f"{code},{market}",
            },
        )
        data = payload.get("data")
        rows = data.get("list") if isinstance(data, dict) else None
        if not isinstance(rows, list):
            return []
        result: list[AnnouncementItem] = []
        for row in rows:
            if not isinstance(row, dict):
                continue
            codes = row.get("codes")
            code_info = (
                codes[0] if isinstance(codes, list) and codes and isinstance(codes[0], dict) else {}
            )
            article = _text(row.get("art_code")) or ""
            columns = row.get("columns")
            column_names = (
                [
                    str(column.get("column_name"))
                    for column in columns
                    if isinstance(column, dict) and column.get("column_name")
                ]
                if isinstance(columns, list)
                else []
            )
            result.append(
                AnnouncementItem(
                    art_code=article,
                    title=str(row.get("title_ch") or row.get("title") or ""),
                    symbol=_text(code_info.get("stock_code")) or code,
                    name=_text(code_info.get("short_name")),
                    notice_date=_datetime(row.get("notice_date")),
                    display_time=_datetime(row.get("display_time")),
                    columns=column_names,
                    url=f"https://data.eastmoney.com/notices/detail/{code}/{article}.html"
                    if article
                    else None,
                    pdf_url=f"https://pdf.dfcfw.com/pdf/H2_{article}_1.pdf" if article else None,
                    source=self.id,
                    raw=row,
                )
            )
        return result

    async def list_a_share_symbols(
        self, page: int = 1, page_size: int = 100
    ) -> tuple[int, list[SymbolResolveResult]]:
        return await self._list_symbols(page=page, page_size=page_size, fs=A_SHARE_FS, kind="stock")

    async def list_etf_symbols(
        self, page: int = 1, page_size: int = 100
    ) -> tuple[int, list[SymbolResolveResult]]:
        return await self._list_symbols(page=page, page_size=page_size, fs=ETF_FS, kind="etf")

    async def _list_symbols(
        self, *, page: int, page_size: int, fs: str, kind: AssetType
    ) -> tuple[int, list[SymbolResolveResult]]:
        payload = await self._get_json(
            tuple(
                f"{base.rstrip('/')}{SYMBOL_LIST_PATH}"
                for base in self.settings.eastmoney_base_urls
            ),
            {
                "pn": page,
                "pz": page_size,
                "po": 1,
                "np": 1,
                "fltt": 2,
                "invt": 2,
                "fid": "f12",
                "fs": fs,
                "fields": "f12,f13,f14,f100,f102,f103",
            },
        )
        data = payload.get("data")
        if not isinstance(data, dict):
            raise ProviderError("东方财富未返回证券列表。", code="SYMBOL_LIST_PAYLOAD_INVALID")
        raw_rows = data.get("diff")
        rows = (
            list(raw_rows.values())
            if isinstance(raw_rows, dict)
            else raw_rows
            if isinstance(raw_rows, list)
            else []
        )
        result: list[SymbolResolveResult] = []
        for row in rows:
            if not isinstance(row, dict):
                continue
            code = str(row.get("f12") or "")
            if len(code) != 6 or not code.isdigit():
                continue
            market = str(row.get("f13") or "1" if code.startswith(("6", "9")) else "0")
            secid = f"{market}.{code}"
            result.append(
                SymbolResolveResult(
                    query=f"{kind}-page-{page}",
                    symbol=code,
                    name=_text(row.get("f14")),
                    asset_type=kind,
                    market=market_from_secid(secid),
                    secid=secid,
                    source=self.id,
                    raw=row,
                )
            )
        return int(data.get("total") or 0), result
