from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Any

from psycopg import AsyncConnection
from psycopg.rows import dict_row

from quantpilot_market_data.config import MarketSettings
from quantpilot_market_data.errors import DatabaseError


@asynccontextmanager
async def connection(settings: MarketSettings) -> AsyncIterator[AsyncConnection[Any]]:
    if not settings.database_url:
        raise DatabaseError(
            "未配置 WOLF_RESEARCH_MARKET_DATABASE_URL 或 DATABASE_URL，市场数据库功能不可用。",
            code="DATABASE_NOT_CONFIGURED",
            retryable=False,
        )
    try:
        async with await AsyncConnection.connect(
            settings.database_url, row_factory=dict_row
        ) as conn:
            yield conn
    except DatabaseError:
        raise
    except Exception as error:  # psycopg exposes different OS/database exceptions by platform.
        raise DatabaseError(
            f"市场 PostgreSQL 连接失败：{error}",
            code="DATABASE_CONNECTION_FAILED",
            retryable=True,
        ) from error


async def ping(settings: MarketSettings) -> None:
    async with connection(settings) as conn:
        try:
            async with conn.cursor() as cursor:
                await cursor.execute("SELECT 1")
                await cursor.fetchone()
        except Exception as error:
            raise DatabaseError(
                f"市场 PostgreSQL 探针失败：{error}",
                code="DATABASE_PROBE_FAILED",
                retryable=True,
            ) from error
