from __future__ import annotations

import asyncio
import json
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.responses import FileResponse, JSONResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from .config import Settings, settings
from .db import Database
from .agent_router import create_agent_router
from .agent_service import AgentService
from .board_router import create_board_router
from .board_service import BoardService
from .board_store import BoardStore
from .market import latest_snapshots, normalize_ticker
from .market_boards import EastMoneyBoardProvider
from .market_calendar import calendar_from_store
from .market_router import create_market_router
from .market_store import MarketStore
from .nga import NGAClient, crawl_incremental
from .scheduler import SchedulerController
from .seed import seed_all
from .skills import SkillManager, create_skill_manager, create_skills_router
from .strategy import StrategyService


BJ = timezone(timedelta(hours=8))


def today_bj() -> str:
    return datetime.now(BJ).date().isoformat()


class WatchlistEntry(BaseModel):
    code: str
    name: str = ""
    asset_type: str = "stock"
    enabled: bool = True
    notes: str = ""


class WatchlistPayload(BaseModel):
    items: list[WatchlistEntry] = Field(default_factory=list)


class AliasPayload(BaseModel):
    code: str
    confidence: float = 0
    source: str = "manual"


class AppState:
    def __init__(
        self,
        db: Database,
        config: Settings,
        *,
        skill_manager: SkillManager | None = None,
        agent_service: AgentService | None = None,
    ):
        self.db = db
        self.config = config
        self.nga = NGAClient(config)
        self.strategy = StrategyService(db, config)
        self.scheduler = SchedulerController(db, config)
        self.market_store = MarketStore(db)
        self.board_store = BoardStore(db)
        # Trading days come from what the local database has actually observed;
        # the calendar reports when it had to fall back to the weekday rule.
        self.calendar = calendar_from_store(self.market_store)
        self.board_service = BoardService(
            self.board_store,
            EastMoneyBoardProvider(),
            self.calendar,
        )
        self.skills = skill_manager or create_skill_manager(db, config)
        self.agent = agent_service or AgentService(db, config, self.skills)
        if self.agent.skills is None:
            self.agent.skills = self.skills


def _post_dict(row: Any) -> dict[str, Any]:
    item = dict(row)
    item["is_today"] = str(item.get("post_at", "")).startswith(today_bj())
    return item


def create_app(
    db: Database | None = None,
    config: Settings = settings,
    *,
    skill_manager: SkillManager | None = None,
    agent_service: AgentService | None = None,
) -> FastAPI:
    database = db or Database(config.database_path)
    state = AppState(
        database,
        config,
        skill_manager=skill_manager,
        agent_service=agent_service,
    )

    @asynccontextmanager
    async def lifespan(_app: FastAPI):
        database.init()
        seed_all(database, config)
        state.scheduler.start()
        try:
            yield
        finally:
            await state.agent.shutdown()
            state.scheduler.shutdown()
            database.close()

    app = FastAPI(title="Wolf Dashboard", version="0.1.0", lifespan=lifespan)
    app.state.wolf = state

    frontend_root = config.dashboard_root / "frontend"
    if frontend_root.exists():
        app.mount("/static", StaticFiles(directory=frontend_root), name="static")

    def _page_response(filename: str, route: str) -> Any:
        """Serve a named frontend entrypoint, with an explicit JSON fallback."""

        path = frontend_root / filename
        if path.is_file():
            return FileResponse(path)
        return JSONResponse(
            {
                "service": "wolf-dashboard",
                "status": "ok",
                "page": route,
                "fallback": "frontend entrypoint is not installed",
            }
        )

    @app.get("/favicon.ico", include_in_schema=False)
    async def favicon() -> Any:
        path = frontend_root / "favicon.svg"
        if path.is_file():
            return FileResponse(path, media_type="image/svg+xml")
        return Response(status_code=204)

    app.include_router(create_market_router(store=state.market_store))
    app.include_router(create_board_router(service=state.board_service, calendar=state.calendar))
    app.include_router(create_skills_router(state.skills))
    app.include_router(create_agent_router(state.agent))
    # A descriptive alias is useful to clients that namespace Agent APIs;
    # both paths share the same durable service and active-run lock.
    app.include_router(create_agent_router(state.agent, prefix="/api/v1/agent/runs"))

    @app.get("/", include_in_schema=False)
    async def index() -> Any:
        return _page_response("agent.html", "/")

    @app.get("/skills", include_in_schema=False)
    async def skills_page() -> Any:
        return _page_response("skills.html", "/skills")

    @app.get("/monitor", include_in_schema=False)
    async def monitor() -> Any:
        return _page_response("index.html", "/monitor")

    @app.get("/healthz")
    async def healthz() -> dict[str, str]:
        return {"status": "ok"}

    @app.get("/api/status")
    async def status() -> dict[str, Any]:
        cursor = database.one("SELECT * FROM crawl_cursor WHERE tid=?", (config.nga_tid,))
        crawl = database.one("SELECT * FROM crawl_runs ORDER BY id DESC LIMIT 1")
        counts = {
            "posts": int(database.one("SELECT COUNT(*) AS n FROM posts")["n"]),
            "rules": int(database.one("SELECT COUNT(*) AS n FROM rules")["n"]),
            "strategies": int(database.one("SELECT COUNT(*) AS n FROM strategy_versions")["n"]),
        }
        return {
            "service": "wolf-dashboard",
            "now": datetime.now(BJ).isoformat(timespec="seconds"),
            "counts": counts,
            "crawl_cursor": dict(cursor) if cursor else None,
            "last_crawl": dict(crawl) if crawl else None,
            "configuration": {
                "nga_cookie": config.has_nga_cookie,
                "ai_credentials": config.has_ai_credentials,
                "scheduler": state.scheduler.scheduler is not None,
                "tid": config.nga_tid,
                "author_id": config.nga_author_id,
                "openai_request_timeout": config.openai_request_timeout,
            },
            "market": latest_snapshots(database),
        }

    @app.get("/api/posts")
    async def posts(
        date: str = Query("today"),
        limit: int = Query(50, ge=1, le=200),
        offset: int = Query(0, ge=0),
    ) -> dict[str, Any]:
        if date == "today":
            target = today_bj()
            rows = database.query(
                "SELECT * FROM posts WHERE substr(post_at,1,10)=? ORDER BY rowid DESC LIMIT ? OFFSET ?",
                (target, limit, offset),
            )
        elif date == "all":
            rows = database.query("SELECT * FROM posts ORDER BY rowid DESC LIMIT ? OFFSET ?", (limit, offset))
        else:
            rows = database.query(
                "SELECT * FROM posts WHERE substr(post_at,1,10)=? ORDER BY rowid DESC LIMIT ? OFFSET ?",
                (date, limit, offset),
            )
        return {"date": date, "items": [_post_dict(row) for row in rows], "count": len(rows)}

    @app.get("/api/strategies")
    async def strategies(date: str | None = None, limit: int = Query(10, ge=1, le=50)) -> dict[str, Any]:
        return {"date": date, "items": state.strategy.list_versions(date, limit)}

    @app.post("/api/tasks/crawl")
    async def task_crawl() -> dict[str, Any]:
        result = await asyncio.to_thread(crawl_incremental, database, state.nga)
        return result.__dict__

    @app.post("/api/tasks/strategy")
    async def task_strategy(kind: str = "baseline", date: str | None = None) -> dict[str, Any]:
        if kind not in {"baseline", "intraday", "continuation"}:
            raise HTTPException(status_code=400, detail="kind 必须是 baseline、intraday 或 continuation")
        if kind == "continuation":
            result = await asyncio.to_thread(state.strategy.continue_latest, date)
            if result is None:
                raise HTTPException(status_code=409, detail="没有可延续的历史策略版本")
            return result
        return await asyncio.to_thread(state.strategy.generate, date, kind)

    @app.get("/api/watchlist")
    async def get_watchlist() -> dict[str, Any]:
        rows = database.query("SELECT * FROM watchlist ORDER BY code")
        return {
            "items": [dict(row) for row in rows],
            "market": latest_snapshots(database),
        }

    @app.put("/api/watchlist")
    async def put_watchlist(payload: WatchlistPayload) -> dict[str, Any]:
        now = datetime.now(BJ).isoformat(timespec="seconds")
        with database.transaction() as conn:
            for item in payload.items:
                try:
                    code = normalize_ticker(item.code)
                except ValueError as exc:
                    raise HTTPException(status_code=400, detail=str(exc)) from exc
                conn.execute(
                    """INSERT INTO watchlist(code,name,asset_type,enabled,notes,created_at,updated_at)
                    VALUES(?,?,?,?,?,?,?) ON CONFLICT(code) DO UPDATE SET name=excluded.name,
                    asset_type=excluded.asset_type,enabled=excluded.enabled,notes=excluded.notes,updated_at=excluded.updated_at""",
                    (code, item.name, item.asset_type, int(item.enabled), item.notes, now, now),
                )
        database.add_event("watchlist", {"count": len(payload.items)})
        return await get_watchlist()

    @app.delete("/api/watchlist/{code}")
    async def delete_watchlist(code: str) -> dict[str, Any]:
        try:
            normalized = normalize_ticker(code)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        cursor = database.execute("DELETE FROM watchlist WHERE code=?", (normalized,))
        if cursor.rowcount == 0:
            raise HTTPException(status_code=404, detail="自选池中不存在该代码")
        database.add_event("watchlist", {"removed": normalized})
        return await get_watchlist()

    @app.put("/api/aliases/{alias}")
    async def put_alias(alias: str, payload: AliasPayload) -> dict[str, Any]:
        alias = alias.strip()
        if not alias:
            raise HTTPException(status_code=400, detail="别名不能为空")
        try:
            code = normalize_ticker(payload.code)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        confidence = max(0.0, min(1.0, payload.confidence))
        database.execute(
            """INSERT INTO aliases(alias,code,confidence,source,corrected_at) VALUES(?,?,?,?,?)
            ON CONFLICT(alias) DO UPDATE SET code=excluded.code,confidence=excluded.confidence,
            source=excluded.source,corrected_at=excluded.corrected_at""",
            (alias, code, confidence, payload.source, datetime.now(BJ).isoformat(timespec="seconds")),
        )
        database.add_event("alias", {"alias": alias, "code": code, "source": payload.source})
        return dict(database.one("SELECT * FROM aliases WHERE alias=?", (alias,)))

    @app.get("/api/aliases")
    async def get_aliases() -> dict[str, Any]:
        return {"items": state.strategy.list_aliases()}

    @app.get("/api/events")
    async def events(request: Request, after: int = Query(0, ge=0)) -> StreamingResponse:
        async def stream():
            cursor = after
            while True:
                if await request.is_disconnected():
                    break
                rows = database.query(
                    "SELECT * FROM events WHERE id>? ORDER BY id LIMIT 20",
                    (cursor,),
                )
                for row in rows:
                    cursor = int(row["id"])
                    payload = {"id": cursor, "type": row["event_type"], **json.loads(row["payload_json"] or "{}")}
                    yield f"id: {cursor}\ndata: {json.dumps(payload, ensure_ascii=False)}\n\n"
                await asyncio.sleep(2)

        return StreamingResponse(stream(), media_type="text/event-stream", headers={"Cache-Control": "no-cache"})

    return app


app = create_app()
