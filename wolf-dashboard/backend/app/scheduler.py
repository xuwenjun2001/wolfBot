from __future__ import annotations

import logging
from datetime import datetime
from threading import Lock
from zoneinfo import ZoneInfo

from .config import Settings, settings
from .db import Database
from .market import MarketClient, update_watchlist_snapshots
from .nga import NGAClient, crawl_incremental
from .strategy import StrategyService

log = logging.getLogger(__name__)


class SchedulerController:
    def __init__(self, db: Database, config: Settings = settings):
        self.db = db
        self.config = config
        self.strategy = StrategyService(db, config)
        self.nga = NGAClient(config)
        self.market = MarketClient(config)
        self._lock = Lock()
        self.scheduler = None

    def crawl_job(self) -> None:
        if not self._lock.acquire(blocking=False):
            return
        try:
            crawl_incremental(self.db, self.nga)
        except Exception:
            log.exception("NGA crawl failed")
        finally:
            self._lock.release()

    def market_job(self) -> None:
        try:
            update_watchlist_snapshots(self.db, self.market)
        except Exception:
            log.exception("Market snapshot failed")

    def baseline_job(self) -> None:
        try:
            self.strategy.generate(kind="baseline")
        except Exception:
            log.exception("Strategy baseline failed")

    def intraday_job(self) -> None:
        try:
            self.strategy.generate(kind="intraday")
        except Exception:
            log.exception("Intraday strategy failed")

    def start(self) -> bool:
        if not self.config.scheduler_enabled or self.scheduler is not None:
            return False
        try:
            from apscheduler.schedulers.background import BackgroundScheduler
            from apscheduler.triggers.cron import CronTrigger
            from apscheduler.triggers.interval import IntervalTrigger

            timezone = ZoneInfo("Asia/Shanghai")
            self.scheduler = BackgroundScheduler(timezone=timezone)
            self.scheduler.add_job(
                self.crawl_job,
                IntervalTrigger(minutes=self.config.crawl_interval_minutes, timezone=timezone),
                id="nga-crawl",
                max_instances=1,
                coalesce=True,
                next_run_time=datetime.now(timezone),
            )
            self.scheduler.add_job(
                self.market_job,
                IntervalTrigger(minutes=self.config.crawl_interval_minutes, timezone=timezone),
                id="market-snapshot",
                max_instances=1,
                coalesce=True,
                next_run_time=datetime.now(timezone),
            )
            self.scheduler.add_job(
                self.baseline_job,
                CronTrigger(hour=8, minute=30, timezone=timezone),
                id="strategy-baseline",
                max_instances=1,
                coalesce=True,
            )
            self.scheduler.add_job(
                self.intraday_job,
                CronTrigger(day_of_week="mon-fri", hour="9-15", minute="*/30", timezone=timezone),
                id="strategy-intraday",
                max_instances=1,
                coalesce=True,
            )
            self.scheduler.start()
            return True
        except Exception as exc:
            log.warning("Scheduler unavailable: %s", exc)
            self.scheduler = None
            return False

    def shutdown(self) -> None:
        if self.scheduler is not None:
            self.scheduler.shutdown(wait=False)
            self.scheduler = None
