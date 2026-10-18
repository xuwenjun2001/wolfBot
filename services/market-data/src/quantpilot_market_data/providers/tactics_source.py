"""Persistent isolated Baostock session with a hard, killable request deadline."""

from __future__ import annotations

import asyncio
import multiprocessing
import time


def _serve(pipe):
    import baostock as bs

    from quantpilot_market_data.providers.baostock import (
        BaoStockClient,
        _run_baostock_query_with_reconnect,
        fetch_baostock_trade_dates,
    )

    def records(r):
        records = []
        while r.error_code == "0" and r.next():
            records.append(dict(zip(r.fields, r.get_row_data(), strict=True)))
        if r.error_code != "0":
            raise RuntimeError(f"证券名单请求失败：{r.error_msg}")
        return records

    while True:
        try:
            request = pipe.recv()
        except EOFError:
            break
        try:
            if request["kind"] == "master":
                value = _run_baostock_query_with_reconnect(
                    bs, operation=lambda: records(bs.query_stock_basic()), failure_label="证券名单"
                )
            elif request["kind"] == "daily_members":
                value = _run_baostock_query_with_reconnect(
                    bs,
                    operation=lambda day=request["end"]: records(bs.query_all_stock(day=day)),
                    failure_label="当日交易状态",
                )
            elif request["kind"] == "calendar":
                value = [
                    {"date": str(d.trade_date), "is_open": d.is_open}
                    for d in fetch_baostock_trade_dates(request["start"], request["end"])
                ]
            else:
                response = asyncio.run(
                    BaoStockClient().get_kline_range(
                        request["symbol"],
                        start_date=request["start"],
                        end_date=request["end"],
                        limit=400,
                    )
                )
                value = [
                    {
                        "date": b.date,
                        "open": float(b.open) if b.open is not None else None,
                        "high": float(b.high) if b.high is not None else None,
                        "low": float(b.low) if b.low is not None else None,
                        "close": float(b.close) if b.close is not None else None,
                        "volume": 0 if b.trade_status == "0" and b.volume is None else b.volume,
                        "trade_status": b.trade_status,
                        "is_st": b.is_st,
                        "amount": float(b.amount) if b.amount is not None else None,
                    }
                    for b in response.bars
                ]
            pipe.send({"ok": True, "value": value})
        except Exception as error:
            pipe.send({"ok": False, "error": str(error)[:1200]})


class TacticsSource:
    def __init__(self, timeout: float = 60, interrupted=lambda: False):
        self.timeout = timeout
        self.interrupted = interrupted
        self.process = None
        self.pipe = None

    def close(self):
        if self.process is not None:
            self.process.terminate()
            self.process.join(timeout=5)
            if self.process.is_alive():
                self.process.kill()
                self.process.join(timeout=5)
        if self.pipe is not None:
            self.pipe.close()
        self.process = self.pipe = None

    def request(self, kind: str, **kwargs):
        if self.process is None or not self.process.is_alive():
            self.close()
            ctx = multiprocessing.get_context("spawn")
            self.pipe, child = ctx.Pipe()
            self.process = ctx.Process(target=_serve, args=(child,), daemon=True)
            self.process.start()
            child.close()
        self.pipe.send({"kind": kind, **kwargs})
        deadline = time.monotonic() + self.timeout
        while not self.pipe.poll(0.25):
            if self.interrupted():
                self.close()
                raise InterruptedError("执行器停止，保留断点")
            if time.monotonic() >= deadline:
                self.close()
                raise TimeoutError("行情源请求超过60秒，已终止连接，等待重试")
        result = self.pipe.recv()
        if not result["ok"]:
            raise RuntimeError(result["error"])
        return result["value"]
