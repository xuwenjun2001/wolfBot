from __future__ import annotations

import hashlib
import json
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any, TypeVar

from pydantic import BaseModel

from quantpilot_market_data.config import MarketSettings
from quantpilot_market_data.errors import CacheError
from quantpilot_market_data.models import FetchMetadata

ModelT = TypeVar("ModelT", bound=BaseModel)


class MarketDataCache:
    """Small, process-independent JSON cache for read-heavy provider responses."""

    def __init__(self, settings: MarketSettings) -> None:
        self.enabled = settings.cache_enabled
        self.directory = settings.cache_dir

    def build_key(self, namespace: str, values: dict[str, Any]) -> str:
        encoded = json.dumps(values, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
        digest = hashlib.sha256(encoded.encode("utf-8")).hexdigest()
        return f"{namespace}-{digest}"

    def _path(self, key: str) -> Path:
        if not key or any(part in key for part in ("/", "\\", "..")):
            raise CacheError("缓存键包含非法路径字符。", code="CACHE_KEY_INVALID", retryable=False)
        return self.directory / f"{key}.json"

    def read(self, key: str, model_type: type[ModelT]) -> ModelT | None:
        if not self.enabled:
            return None
        path = self._path(key)
        try:
            raw = json.loads(path.read_text(encoding="utf-8"))
        except FileNotFoundError:
            return None
        except (OSError, json.JSONDecodeError) as error:
            raise CacheError(
                f"缓存读取失败（{path.name}）：{error}",
                code="CACHE_READ_FAILED",
                retryable=True,
            ) from error

        if not isinstance(raw, dict):
            raise CacheError(
                f"缓存载荷不是 JSON 对象（{path.name}）。",
                code="CACHE_PAYLOAD_INVALID",
                retryable=False,
            )
        expires_at = raw.get("_expires_at")
        if isinstance(expires_at, str):
            try:
                if datetime.fromisoformat(expires_at) <= datetime.now(UTC):
                    path.unlink(missing_ok=True)
                    return None
            except ValueError as error:
                raise CacheError(
                    f"缓存过期时间无效（{path.name}）。",
                    code="CACHE_METADATA_INVALID",
                    retryable=False,
                ) from error
        payload = raw.get("payload", raw)
        if not isinstance(payload, dict):
            raise CacheError(
                f"缓存 payload 不是 JSON 对象（{path.name}）。",
                code="CACHE_PAYLOAD_INVALID",
                retryable=False,
            )
        try:
            model = model_type.model_validate(payload)
            return (
                model.model_copy(
                    update={
                        "fetch": model.fetch.model_copy(
                            update={
                                "cache_status": "hit",
                                "cache_key": key,
                                "cache_path": str(path),
                            }
                        )
                    }
                )
                if hasattr(model, "fetch")
                else model
            )
        except Exception as error:  # Pydantic's concrete error is part of the diagnostic.
            raise CacheError(
                f"缓存载荷无法匹配 {model_type.__name__}（{path.name}）：{error}",
                code="CACHE_SCHEMA_INVALID",
                retryable=False,
            ) from error

    def write(self, key: str, model: BaseModel, ttl_seconds: int) -> FetchMetadata:
        now = datetime.now(UTC)
        expires_at = now + timedelta(seconds=max(1, ttl_seconds))
        path = self._path(key)
        if not self.enabled:
            return FetchMetadata(
                cache_status="disabled",
                cache_key=key,
                cache_ttl_seconds=ttl_seconds,
                cached_at=now,
                expires_at=expires_at,
            )
        try:
            self.directory.mkdir(parents=True, exist_ok=True)
            payload = {
                "_expires_at": expires_at.isoformat(),
                "payload": model.model_dump(mode="json"),
            }
            temporary = path.with_suffix(f".{path.name}.tmp")
            temporary.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
            temporary.replace(path)
        except OSError:
            return FetchMetadata(
                cache_status="disabled",
                cache_key=key,
                cache_ttl_seconds=ttl_seconds,
                cached_at=now,
                expires_at=expires_at,
            )
        return FetchMetadata(
            cache_status="miss",
            cache_key=key,
            cache_ttl_seconds=ttl_seconds,
            cached_at=now,
            expires_at=expires_at,
            cache_path=str(path),
        )


def read_cached_response[ModelT: BaseModel](
    cache: MarketDataCache,
    key: str,
    model_type: type[ModelT],
) -> ModelT | None:
    return cache.read(key, model_type)


def cache_response[ModelT: BaseModel](
    cache: MarketDataCache,
    key: str,
    ttl_seconds: int,
    value: ModelT,
    model_type: type[ModelT],
) -> ModelT:
    metadata = cache.write(key, value, ttl_seconds)
    return value.model_copy(update={"fetch": metadata})
