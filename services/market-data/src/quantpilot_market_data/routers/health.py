from fastapi import APIRouter
from fastapi.responses import JSONResponse

from quantpilot_market_data.cache import RedisJsonCache
from quantpilot_market_data.database_core import connect
from quantpilot_market_data.readiness import get_market_readiness


def create_health_router(intraday_redis_cache: RedisJsonCache) -> APIRouter:
    router = APIRouter()

    @router.get("/health")
    async def health() -> dict[str, str]:
        return {"status": "ok"}

    @router.get("/ready")
    async def ready() -> JSONResponse:
        async def database_probe() -> None:
            connection = await connect()
            async with connection:
                await connection.execute("SELECT 1")

        result = await get_market_readiness(
            database_probe=database_probe,
            redis_probe=intraday_redis_cache.ping,
        )
        return JSONResponse(
            content=result,
            status_code=200 if result["ok"] else 503,
            headers={"Cache-Control": "no-store, max-age=0"},
        )

    return router
