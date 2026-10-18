"""Fixed upstream adapters for the integrated market dashboard.

Amounts remain CNY and percentages remain percentage points. No bundled snapshots,
JSONP execution, filesystem captures, or client-selected upstream URLs are used.
"""

from __future__ import annotations

import asyncio
import math
import random
import re
import time
from contextvars import ContextVar
from datetime import datetime
from typing import Any
from zoneinfo import ZoneInfo

import httpx

SHANGHAI = ZoneInfo("Asia/Shanghai")
BACKGROUND_QUERY = ContextVar("dashboard_background", default=False)
ETF_SYMBOLS = [
    "sh588080",
    "sh588000",
    "sz159915",
    "sz159952",
    "sh510300",
    "sh510330",
    "sh510310",
    "sz159919",
    "sh510050",
    "sh510500",
    "sh512100",
    "sz159845",
    "sh560010",
]
INDEX_SYMBOLS = ["sh000001", "sz399001", "sz399006", "sh000688", "sh000300"]


class DashboardUpstreamError(Exception):
    """A provider failed or returned an incompatible response."""


def number(value: Any) -> float | None:
    try:
        result = float(value)
        return result if math.isfinite(result) else None
    except ValueError, TypeError:
        return None


def day(value: Any) -> str | None:
    text = str(value or "")
    if re.match(r"^\d{8}", text):
        text = f"{text[:4]}-{text[4:6]}-{text[6:8]}"
    try:
        return datetime.strptime(text[:10], "%Y-%m-%d").date().isoformat()
    except ValueError:
        return None


def stock_symbol(code: str) -> str:
    if code.lower().startswith(("sh", "sz", "bj")):
        return code.lower()
    return (
        "bj"
        if code.startswith(("4", "8", "92"))
        else "sh"
        if code.startswith(("5", "6", "9"))
        else "sz"
    ) + code


def result(
    rows: list[dict], source: str, trade_date: str | None = None, note: str = "", **extra: Any
) -> dict:
    return {"rows": rows, "source": source, "tradeDate": trade_date, "note": note, **extra}


class DashboardProvider:
    def __init__(self, client: httpx.AsyncClient | None = None) -> None:
        self.client = client or httpx.AsyncClient(
            timeout=httpx.Timeout(8, connect=4),
            follow_redirects=False,
            headers={"User-Agent": "Mozilla/5.0", "Referer": "https://quote.eastmoney.com/"},
            limits=httpx.Limits(max_connections=6, max_keepalive_connections=6),
        )
        self._em_lock = asyncio.Lock()
        self._last_em = 0.0
        self._em_pending = 0
        self._other_limit = asyncio.Semaphore(3)

    async def close(self) -> None:
        await self.client.aclose()

    async def _request(
        self,
        url: str,
        params: dict | None = None,
        data: dict | None = None,
        headers: dict | None = None,
    ) -> httpx.Response:
        async def perform() -> httpx.Response:
            response = await self.client.request(
                "POST" if data else "GET",
                url,
                params=params,
                data=data,
                headers=headers,
            )
            response.raise_for_status()
            if len(response.content) > 8_000_000:
                raise DashboardUpstreamError("上游响应过大")
            return response

        if "eastmoney.com" in httpx.URL(url).host:
            background = BACKGROUND_QUERY.get()
            if background:
                while self._em_pending:
                    await asyncio.sleep(0.05)
            else:
                self._em_pending += 1
            try:
                async with self._em_lock:
                    await asyncio.sleep(
                        max(0, 1.05 + random.random() * 0.2 - (time.monotonic() - self._last_em))
                    )
                    try:
                        return await perform()
                    finally:
                        self._last_em = time.monotonic()
            finally:
                if not background:
                    self._em_pending -= 1
        async with self._other_limit:
            return await perform()

    async def _json(self, url: str, params: dict | None = None, data: dict | None = None) -> dict:
        try:
            response = await self._request(url, params, data)
        except httpx.TransportError:
            # One bounded retry for transient Eastmoney transport failures.
            # Quotes use its equivalent host; dated reports retry the same URL.
            if url.startswith("https://push2.eastmoney.com/"):
                response = await self._request(
                    url.replace(
                        "https://push2.eastmoney.com/", "https://push2delay.eastmoney.com/", 1
                    ),
                    params,
                    data,
                )
            elif httpx.URL(url).host in {
                "push2his.eastmoney.com",
                "push2ex.eastmoney.com",
                "datacenter-web.eastmoney.com",
            }:
                response = await self._request(url, params, data)
            else:
                raise
        payload = response.json()
        if not isinstance(payload, dict):
            raise DashboardUpstreamError("上游响应格式不兼容")
        if payload.get("rc", 0) != 0 or payload.get("errcode", 0) not in (0, "0", None):
            raise DashboardUpstreamError("上游拒绝了请求")
        return payload

    async def quotes(self, etfs: bool = False) -> dict:
        symbols = ETF_SYMBOLS if etfs else INDEX_SYMBOLS
        response = await self._request("https://qt.gtimg.cn/q=" + ",".join(symbols))
        rows = []
        for symbol, text in re.findall(r'v_([a-z]+\d+)="([^"]*)"', response.content.decode("gbk")):
            values = text.split("~")
            if len(values) < 47 or symbol not in symbols:
                continue
            rows.append(
                {
                    "code": symbol,
                    "name": values[1],
                    "price": number(values[3]),
                    "previousClose": number(values[4]),
                    "changePct": number(values[32]),
                    "amount": (
                        number(values[37]) * 10000 if number(values[37]) is not None else None
                    ),
                    "turnover": number(values[38]),
                    "tradeDate": day(values[30]),
                    "quoteTime": values[30],
                    "volume": number(values[6]),
                }
            )
        if not rows:
            raise DashboardUpstreamError("腾讯未返回有效报价")
        dates = [row["tradeDate"] for row in rows if row["tradeDate"]]
        return result(
            rows,
            "腾讯财经",
            min(dates) if dates else None,
            "成交额单位为元；报价时间由数据源提供。",
            partial=len(rows) != len(symbols),
        )

    async def sectors(self, kind: str = "industry", page: int = 1, code: str | None = None) -> dict:
        fs = f"b:{code}" if code else ("m:90+t:2" if kind == "industry" else "m:90+t:3")
        payload = await self._json(
            "https://push2.eastmoney.com/api/qt/clist/get",
            {
                "fid": "f62",
                "po": 1,
                "pz": 100,
                "pn": page,
                "np": 1,
                "fltt": 2,
                "invt": 2,
                "fs": fs,
                "fields": "f12,f13,f14,f2,f3,f6,f8,f62,f184,f66,f72,f78,f84,f124,f100,f204",
            },
        )
        data = payload.get("data")
        if not isinstance(data, dict) or not isinstance(data.get("diff"), (list, dict)):
            raise DashboardUpstreamError("东方财富未返回板块数据")
        items = data["diff"]
        items = list(items.values()) if isinstance(items, dict) else items
        rows = [
            {
                "code": str(x.get("f12", "")),
                "name": str(x.get("f14", "")),
                "price": number(x.get("f2")),
                "changePct": number(x.get("f3")),
                "mainNet": number(x.get("f62")),
                "mainPct": number(x.get("f184")),
                "superNet": number(x.get("f66")),
                "largeNet": number(x.get("f72")),
                "mediumNet": number(x.get("f78")),
                "smallNet": number(x.get("f84")),
                "amount": number(x.get("f6")),
                "turnover": number(x.get("f8")),
                "industry": str(x.get("f100", "")),
                "leader": str(x.get("f204", "")),
                "tradeDate": datetime.fromtimestamp(float(x["f124"]), SHANGHAI).date().isoformat()
                if number(x.get("f124")) and 1_000_000_000 < float(x["f124"]) < 4_000_000_000
                else None,
            }
            for x in items
            if isinstance(x, dict)
        ]
        dates = [x["tradeDate"] for x in rows if x["tradeDate"]]
        return result(
            rows,
            "东方财富",
            min(dates) if dates else None,
            "主力净流入为超大单与大单净额之和，单位元；按主力净额降序分页。",
            total=int(data.get("total") or len(rows)),
            page=page,
            pageSize=100,
        )

    async def sector_history(self, code: str, period: str) -> dict:
        daily = period == "3d"
        payload = await self._json(
            ("https://push2his.eastmoney.com" if daily else "https://push2.eastmoney.com")
            + "/api/qt/stock/fflow/"
            + ("daykline/get" if daily else "kline/get"),
            {
                "secid": f"90.{code}",
                "lmt": 8 if daily else 0,
                "klt": 101 if daily else 1,
                "fields1": "f1,f2,f3,f7",
                "fields2": "f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61,f62,f63,f64,f65",
            },
        )
        data = payload.get("data")
        if not isinstance(data, dict) or not isinstance(data.get("klines"), list):
            raise DashboardUpstreamError("资金流历史未返回")
        rows = []
        cumulative = 0.0
        for line in data["klines"][-3:] if daily else data["klines"]:
            fields = line.split(",")
            if len(fields) < 2 or number(fields[1]) is None:
                continue
            value = number(fields[1])
            cumulative = cumulative + value if daily else value
            rows.append({"time": fields[0], "mainNet": value, "cumulative": cumulative})
        if daily:
            rows = rows[-3:]
        return result(
            rows,
            "东方财富",
            day(rows[-1]["time"]) if rows else None,
            "近三个交易日的日级净流入及累计值，非三天分钟曲线。"
            if daily
            else "日内累计主力净流入，单位元。",
            code=code,
            period=period,
            partial=daily and 0 < len(rows) < 3,
        )

    async def limits(self, pool: str, date: str) -> dict:
        endpoint = {
            "up": "getTopicZTPool",
            "down": "getTopicDTPool",
            "blow": "getTopicZBPool",
            "yesterday": "getYesterdayZTPool",
        }[pool]
        payload = await self._json(
            f"https://push2ex.eastmoney.com/{endpoint}",
            {
                "ut": "7eea3edcaed734bea9cbfc24409ed989",
                "dpt": "wz.ztzt",
                "Pageindex": 0,
                "pagesize": 1000,
                "sort": "fbt:asc" if pool in ("up", "blow") else "fund:desc",
                "date": date.replace("-", ""),
            },
        )
        data = payload.get("data")
        if not isinstance(data, dict) or not isinstance(data.get("pool"), list):
            raise DashboardUpstreamError("该日期的涨跌停池尚未发布或源不可用")
        if day(data.get("qdate")) and day(data["qdate"]) != date:
            raise DashboardUpstreamError("涨跌停池返回了其他业务日期")
        rows = [
            {
                "code": str(x.get("c", "")),
                "name": str(x.get("n", "")),
                "changePct": number(x.get("zdp")),
                "industry": x.get("hybk", ""),
                "boards": number(x.get("lbc", x.get("days", x.get("ylbc")))),
                "fund": number(x.get("fund")),
                "amount": number(x.get("amount")),
                "turnover": number(x.get("hs")),
                "openCount": number(x.get("zbc", x.get("oc"))),
                "firstTime": str(x.get("fbt", "")),
                "lastTime": str(x.get("lbt", "")),
            }
            for x in data["pool"]
            if isinstance(x, dict)
        ]
        return result(
            rows,
            "东方财富",
            day(data.get("qdate")) or date,
            "指定日期的涨跌停池；空列表不代表实时市场无涨跌停。",
            total=data.get("tc", len(rows)),
        )

    async def watch(self) -> dict:
        url = "https://apphwshhq.longhuvip.com/w1/api/index.php"
        params = {"apiv": "w44", "PhoneOSNew": 1, "VerSion": "5.23.0.4"}
        supervision = await self._json(
            url, params, {"c": "StockBidYiDong", "a": "GetYDTP_ZDJK_Today"}
        )
        abnormal = await self._json(
            url, params, {"c": "StockBidYiDong", "a": "GetPianLiZhi_Index", "ZDJK_Type": 1}
        )
        if not isinstance(supervision.get("List"), list) or not isinstance(
            abnormal.get("List"), list
        ):
            raise DashboardUpstreamError("开盘啦监管接口未返回有效名单")
        rows = []
        for row in supervision["List"]:
            if isinstance(row, list) and len(row) >= 4:
                rows.append(
                    {
                        "code": str(row[0]),
                        "name": str(row[1]),
                        "type": "监管期",
                        "rule": f"{row[2]} 至 {row[3]}",
                        "deviation": None,
                        "changePct": None,
                    }
                )
        for row in abnormal["List"]:
            if isinstance(row, list) and len(row) >= 9:
                rows.append(
                    {
                        "code": str(row[0]),
                        "name": str(row[1]),
                        "type": "次日预警" if str(row[2]) == "1" else "今日监控",
                        "rule": str(row[3]),
                        "changePct": number(row[4]),
                        "deviation": number(row[6]),
                        "trigger": str(row[7]),
                    }
                )
        return result(
            rows,
            "开盘啦",
            day(abnormal.get("Day")),
            "监管与严重异动观察名单；源返回空时不使用旧快照补齐。",
        )

    async def dragon_tiger(self, date: str, code: str | None = None) -> dict:
        report = "RPT_DAILYBILLBOARD_DETAILSNEW"
        filter_text = f"(TRADE_DATE='{date}')"
        reports = [report]
        if code:
            filter_text += f'(SECURITY_CODE="{code}")'
            reports = ["RPT_BILLBOARD_DAILYDETAILSBUY", "RPT_BILLBOARD_DAILYDETAILSSELL"]
        rows, seen = [], set()
        for name in reports:
            payload = await self._json(
                "https://datacenter-web.eastmoney.com/api/data/v1/get",
                {
                    "reportName": name,
                    "columns": "ALL",
                    "filter": filter_text,
                    "pageSize": 500,
                    "pageNumber": 1,
                    "source": "WEB",
                    "client": "WEB",
                    "sortColumns": "BUY" if code else "BILLBOARD_NET_AMT",
                    "sortTypes": -1,
                },
            )
            data = payload.get("result")
            if payload.get("success") is False:
                # A valid no-record response may have no result; a provider error is not empty data.
                raise DashboardUpstreamError("龙虎榜源尚未发布该日期数据或请求被拒绝")
            if not isinstance(data, dict) or not isinstance(data.get("data"), list):
                raise DashboardUpstreamError("龙虎榜返回格式不兼容")
            if int(data.get("pages") or 1) > 1:
                raise DashboardUpstreamError("龙虎榜超过单次查询上限，请缩小日期或按个股查询")
            for x in data["data"]:
                if day(x.get("TRADE_DATE")) != date:
                    continue
                if code:
                    key = (
                        x.get("SECURITY_CODE"),
                        x.get("OPERATEDEPT_NAME"),
                        x.get("EXPLANATION"),
                        x.get("BUY"),
                        x.get("SELL"),
                    )
                    if key in seen:
                        continue
                    seen.add(key)
                    rows.append(
                        {
                            "code": str(x.get("SECURITY_CODE", code)),
                            "name": str(x.get("OPERATEDEPT_NAME", "")),
                            "buy": number(x.get("BUY")),
                            "sell": number(x.get("SELL")),
                            "net": number(x.get("NET")),
                            "reason": str(x.get("EXPLANATION", "")),
                        }
                    )
                else:
                    rows.append(
                        {
                            "code": str(x.get("SECURITY_CODE", "")),
                            "name": str(x.get("SECURITY_NAME_ABBR", "")),
                            "reason": str(x.get("EXPLANATION", "")),
                            "price": number(x.get("CLOSE_PRICE")),
                            "changePct": number(x.get("CHANGE_RATE")),
                            "net": number(x.get("BILLBOARD_NET_AMT")),
                            "buy": number(x.get("BILLBOARD_BUY_AMT")),
                            "sell": number(x.get("BILLBOARD_SELL_AMT")),
                        }
                    )
        return result(
            rows,
            "东方财富龙虎榜",
            date,
            "金额单位元；同股可能因不同上榜原因重复出现，不能直接加总。席位名称不等同于游资身份。",
        )

    async def institutions(self, review: bool = False) -> dict:
        endpoint = "limit-up-review" if review else "futures-position-daily"
        payload = await self._json(f"https://www.bigamap.cn/api/v1/public/map/{endpoint}")
        if review:
            if not isinstance(payload.get("strong"), dict) or not day(payload.get("trade_date")):
                raise DashboardUpstreamError("强势股复盘格式不兼容")
            rows = [
                {
                    "code": x.get("stock_code"),
                    "name": x.get("stock_name"),
                    "changePct": number(x.get("change_percent")),
                    "reason": x.get("strong_reason"),
                    "industry": x.get("sw_level1_name"),
                    "price": number(x.get("latest_price")),
                }
                for x in payload["strong"].get("items", [])
            ]
            return result(
                rows, "BigAMap", day(payload["trade_date"]), "强势股复盘按源业务日期展示。"
            )
        if not isinstance(payload.get("table_sections"), list):
            raise DashboardUpstreamError("机构持仓返回格式不兼容")
        sections = []
        fields = [
            "index_name",
            "variety_code",
            "long_position",
            "short_position",
            "institution_net",
            "institution_action",
            "citic_long",
            "citic_short",
            "citic_net",
            "citic_action",
            "all_total",
            "citic_total",
        ]
        for section in payload["table_sections"][:30]:
            sections.append(
                {
                    "date": day(section.get("date")),
                    "rows": [{key: x.get(key) for key in fields} for x in section.get("rows", [])],
                    "allNet": number(section.get("all_summary")),
                    "citicNet": number(section.get("citic_summary")),
                }
            )
        return result(
            [],
            "BigAMap",
            sections[0]["date"] if sections else None,
            "股指期货机构及中信持仓，单位手；不代表股票资金净流入。",
            sections=sections,
            sourceGeneratedAt=payload.get("generated_at"),
        )

    async def minute(self, code: str, daily: bool = False) -> dict:
        symbol = stock_symbol(code)
        url = "https://web.ifzq.gtimg.cn/appstock/app/" + (
            "fqkline/get" if daily else "minute/query"
        )
        params = {"param": f"{symbol},day,,,90,qfq"} if daily else {"code": symbol}
        payload = await self._json(url, params)
        node = (payload.get("data") or {}).get(symbol)
        if payload.get("code") != 0 or not isinstance(node, dict):
            raise DashboardUpstreamError("腾讯分时或K线数据不可用")
        rows = []
        if daily:
            series = node.get("qfqday") or node.get("day") or []
            for x in series:
                if len(x) >= 6:
                    rows.append(
                        {
                            "time": x[0],
                            "open": number(x[1]),
                            "price": number(x[2]),
                            "high": number(x[3]),
                            "low": number(x[4]),
                            "volume": number(x[5]),
                        }
                    )
            date = day(rows[-1]["time"]) if rows else None
        else:
            data = node.get("data") or {}
            date = day(data.get("date"))
            previous_amount = 0.0
            for line in data.get("data", []):
                x = line.split()
                if len(x) < 4 or number(x[3]) is None:
                    continue
                amount = number(x[3])
                rows.append(
                    {
                        "time": x[0][:2] + ":" + x[0][2:],
                        "price": number(x[1]),
                        "volume": number(x[2]),
                        "amount": amount,
                        "minuteAmount": max(0, amount - previous_amount),
                    }
                )
                previous_amount = amount
        return result(
            rows,
            "腾讯财经",
            date,
            "前复权日K线；成交量为手。"
            if daily
            else "分时价格及累计成交额；量价观察不能识别资金主体。",
            code=code,
        )
