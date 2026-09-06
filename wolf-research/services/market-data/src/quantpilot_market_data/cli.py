import asyncio

import uvicorn


def selector_loop_factory() -> asyncio.AbstractEventLoop:
    return asyncio.SelectorEventLoop()


def main() -> None:
    uvicorn.run(
        "quantpilot_market_data.api:app",
        host="127.0.0.1",
        port=8001,
        loop="quantpilot_market_data.cli:selector_loop_factory",
        reload=False,
    )
