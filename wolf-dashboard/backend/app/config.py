from __future__ import annotations

import math
import os
from dataclasses import dataclass
from pathlib import Path


def _load_dotenv(path: Path) -> None:
    if not path.exists():
        return
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        os.environ.setdefault(key, value)


PACKAGE_ROOT = Path(__file__).resolve().parents[1]
DASHBOARD_ROOT = PACKAGE_ROOT.parent
REPO_ROOT = DASHBOARD_ROOT.parent
_load_dotenv(DASHBOARD_ROOT / ".env")
_load_dotenv(REPO_ROOT / ".env")


def _database_default() -> Path:
    raw = os.getenv("WOLF_DATABASE", "data/wolf.sqlite3")
    path = Path(raw)
    return path if path.is_absolute() else DASHBOARD_ROOT / path


def _bool(name: str, default: bool) -> bool:
    value = os.getenv(name)
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


def _bounded_float(name: str, default: float, maximum: float) -> float:
    raw = os.getenv(name)
    if raw is None or not raw.strip():
        return default
    try:
        value = float(raw)
    except ValueError as exc:
        raise ValueError(f"{name} must be a number") from exc
    if not math.isfinite(value) or value <= 0:
        raise ValueError(f"{name} must be greater than zero")
    return min(value, maximum)


@dataclass(frozen=True)
class Settings:
    repo_root: Path = REPO_ROOT
    dashboard_root: Path = DASHBOARD_ROOT
    database_path: Path = _database_default()
    nga_base_url: str = os.getenv("NGA_BASE_URL", "https://ngabbs.com")
    nga_tid: int = int(os.getenv("NGA_TID", "47288722"))
    nga_author_id: int = int(os.getenv("NGA_AUTHOR_ID", "150058"))
    nga_cookie: str = os.getenv("NGA_COOKIE", "")
    nga_user_agent: str = os.getenv(
        "NGA_USER_AGENT",
        "WolfDashboard/0.1 (+local monitoring; contact owner if blocked)",
    )
    request_timeout: float = float(os.getenv("REQUEST_TIMEOUT", "20"))
    crawl_interval_minutes: int = int(os.getenv("CRAWL_INTERVAL_MINUTES", "5"))
    openai_api_key: str = os.getenv("OPENAI_API_KEY", "")
    openai_base_url: str = os.getenv("OPENAI_BASE_URL", "https://api.openai.com/v1")
    openai_model: str = os.getenv("OPENAI_MODEL", "gpt-4o-mini")
    openai_reasoning_effort: str = os.getenv("OPENAI_REASONING_EFFORT", "")
    openai_request_timeout: float = _bounded_float("OPENAI_REQUEST_TIMEOUT", 120.0, 1200.0)
    ai_enabled: bool = _bool("AI_ENABLED", True)
    scheduler_enabled: bool = _bool("SCHEDULER_ENABLED", True)
    initial_page: int = int(os.getenv("NGA_INITIAL_PAGE", "29"))

    @property
    def has_nga_cookie(self) -> bool:
        return bool(self.nga_cookie.strip())

    @property
    def has_ai_credentials(self) -> bool:
        return bool(self.ai_enabled and self.openai_api_key.strip())


settings = Settings()
