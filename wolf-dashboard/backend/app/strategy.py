from __future__ import annotations

import json
import re
from datetime import date, datetime, timedelta, timezone
from typing import Any

import requests

from .config import Settings, settings
from .db import Database, utc_now
from .market import latest_snapshots, normalize_ticker


class StrategyError(RuntimeError):
    pass


def _date_text(value: str) -> str:
    match = re.search(r"(\d{4}-\d{2}-\d{2})", value or "")
    return match.group(1) if match else ""


def _today() -> str:
    return datetime.now(timezone(timedelta(hours=8))).date().isoformat()


def _json_content(content: Any) -> dict[str, Any]:
    if isinstance(content, dict):
        return content
    text = str(content or "").strip()
    text = re.sub(r"^```(?:json)?\s*|\s*```$", "", text, flags=re.I)
    try:
        parsed = json.loads(text)
    except json.JSONDecodeError as exc:
        raise StrategyError(f"AI 返回不是有效 JSON: {exc}") from exc
    if not isinstance(parsed, dict):
        raise StrategyError("AI 返回的顶层结构必须是对象")
    return parsed


def validate_items(
    payload: dict[str, Any], valid_pids: set[str], valid_rule_ids: set[str]
) -> tuple[list[dict[str, Any]], list[str]]:
    raw_items = payload.get("items")
    if not isinstance(raw_items, list):
        return [], ["AI 返回缺少 items 数组"]
    items: list[dict[str, Any]] = []
    errors: list[str] = []
    for index, raw in enumerate(raw_items, 1):
        if not isinstance(raw, dict):
            errors.append(f"第 {index} 条策略不是对象")
            continue
        title = str(raw.get("title", "")).strip()
        if not title:
            errors.append(f"第 {index} 条策略缺少 title")
            continue
        citations = raw.get("citations", [])
        if not isinstance(citations, list):
            errors.append(f"第 {index} 条策略 citations 必须是数组")
            continue
        normalized_citations: list[dict[str, str]] = []
        for citation in citations:
            if not isinstance(citation, dict):
                continue
            pids = citation.get("post_pids", citation.get("pids", []))
            rule_ids = citation.get("rule_ids", citation.get("rules", []))
            if isinstance(pids, str):
                pids = [pids]
            if isinstance(rule_ids, str):
                rule_ids = [rule_ids]
            pids = [str(pid) for pid in (pids or []) if str(pid) in valid_pids]
            rule_ids = [str(rule_id) for rule_id in (rule_ids or []) if str(rule_id) in valid_rule_ids]
            if pids and rule_ids:
                normalized_citations.append(
                    {
                        "post_pid": pids[0],
                        "rule_id": rule_ids[0],
                        "quote": str(citation.get("quote", "")).strip(),
                    }
                )
        if not normalized_citations:
            errors.append(f"第 {index} 条策略没有同时匹配的发言 PID 和规则 ID")
            continue
        confidence = raw.get("confidence", 0)
        try:
            confidence = max(0.0, min(1.0, float(confidence)))
        except (TypeError, ValueError):
            confidence = 0.0
        items.append(
            {
                "title": title,
                "stance": str(raw.get("stance", "observe")),
                "details": str(raw.get("details", "")).strip(),
                "triggers": str(raw.get("triggers", "")).strip(),
                "invalidation": str(raw.get("invalidation", "")).strip(),
                "confidence": confidence,
                "citations": normalized_citations,
            }
        )
    return items, errors


def validate_aliases(payload: dict[str, Any]) -> tuple[list[dict[str, Any]], list[str]]:
    raw_aliases = payload.get("aliases", [])
    if raw_aliases is None:
        return [], []
    if not isinstance(raw_aliases, list):
        return [], ["AI 返回 aliases 必须是数组"]
    accepted: dict[str, dict[str, Any]] = {}
    errors: list[str] = []
    for index, raw in enumerate(raw_aliases, 1):
        if not isinstance(raw, dict):
            errors.append(f"第 {index} 个别名不是对象")
            continue
        alias = str(raw.get("alias", "")).strip()
        if not alias:
            errors.append(f"第 {index} 个别名缺少 alias")
            continue
        try:
            code = normalize_ticker(str(raw.get("code", "")))
        except ValueError:
            errors.append(f"别名 {alias} 的证券代码无法归一化")
            continue
        try:
            confidence = max(0.0, min(1.0, float(raw.get("confidence", 0))))
        except (TypeError, ValueError):
            confidence = 0.0
        candidate = {"alias": alias, "code": code, "confidence": confidence, "source": "ai"}
        current = accepted.get(alias)
        if current is None or candidate["confidence"] > current["confidence"]:
            accepted[alias] = candidate
    return list(accepted.values()), errors


class StrategyService:
    def __init__(self, db: Database, config: Settings = settings, session: requests.Session | None = None):
        self.db = db
        self.config = config
        self.session = session or requests.Session()

    def _ensure_builtin_rule(self) -> None:
        if self.db.one("SELECT 1 FROM rules LIMIT 1"):
            return
        self.db.execute(
            """INSERT OR IGNORE INTO rules(id,title,summary,evidence_ref,source_file,created_at)
            VALUES(?,?,?,?,?,?)""",
            (
                "E25-01",
                "先看大级别行情，再看板块和个股量价",
                "先判断指数状态与流动性，再筛选板块、个股和 ETF。",
                "built-in fallback; 请导入 evidence.md 后复核",
                "system",
                utc_now(),
            ),
        )

    def _source_posts(self, strategy_date: str) -> list[dict[str, Any]]:
        rows = self.db.query(
            "SELECT * FROM posts WHERE author_id=? ORDER BY rowid DESC LIMIT 80",
            (str(self.config.nga_author_id),),
        )
        posts = [dict(row) for row in rows]
        try:
            previous_day = (date.fromisoformat(strategy_date) - timedelta(days=1)).isoformat()
        except ValueError:
            previous_day = ""
        yesterday = [post for post in posts if _date_text(str(post.get("post_at", ""))) == previous_day]
        # On the first run there may be no local copy of yesterday yet. Keep
        # the latest available viewpoint visible, while the prompt labels it
        # as a fallback source rather than silently treating it as fresh.
        return yesterday or posts[:30]

    def _rules(self) -> list[dict[str, Any]]:
        return [dict(row) for row in self.db.query("SELECT * FROM rules ORDER BY id")]

    def _prompt(self, strategy_date: str, posts: list[dict[str, Any]], rules: list[dict[str, Any]], market: list[dict[str, Any]]) -> str:
        post_text = "\n".join(
            f"PID={post['pid']} time={post['post_at']} body={post['body'][:1200]}" for post in posts[:30]
        )
        rule_text = "\n".join(
            f"RULE={rule['id']} ref={rule['evidence_ref']} summary={rule['summary']}" for rule in rules
        )
        market_text = json.dumps(market, ensure_ascii=False)
        return f"""你是一个审慎的A股盘前研究助手。日期：{strategy_date}。
只根据给出的作者原文、规则和行情快照生成观察清单，不构造持仓、收益承诺或确定性买卖指令。
每条策略必须至少引用一个真实 PID 和一个真实 RULE；引用只能从输入中选择。
输出严格 JSON：{{"aliases":[{{"alias":"作者称呼","code":"600519.SH","confidence":0.0}}],"items":[{{"title":"...","stance":"observe|watch|reduce|wait","details":"...","triggers":"...","invalidation":"...","confidence":0.0,"citations":[{{"post_pids":["..."],"rule_ids":["..."],"quote":"原文短摘录"}}]}}]}}。
aliases 只填写能从上下文明确判断的标的，重复 alias 只保留最高置信度候选。
行情只可用于说明观察阈值，必须注明来源和快照时间；数据缺失就写明待核验。

作者原文（优先昨日；若无昨日记录则使用最近可用内容，并在策略中标注待核验）：
{post_text or '(无新增原文)'}

已有规则：
{rule_text or '(无规则)'}

行情快照：
{market_text}
"""

    def _call_ai(self, prompt: str) -> dict[str, Any]:
        if not self.config.has_ai_credentials:
            raise StrategyError("未配置 OPENAI_API_KEY，策略版本标记为待配置")
        url = self.config.openai_base_url.rstrip("/") + "/chat/completions"
        request_body: dict[str, Any] = {
            "model": self.config.openai_model,
            "temperature": 0.1,
            "response_format": {"type": "json_object"},
            "messages": [
                {"role": "system", "content": "你只输出可解析 JSON，不要输出 Markdown。"},
                {"role": "user", "content": prompt},
            ],
        }
        if self.config.openai_reasoning_effort.strip():
            request_body["reasoning_effort"] = self.config.openai_reasoning_effort.strip()
        response = self.session.post(
            url,
            headers={"Authorization": f"Bearer {self.config.openai_api_key}", "Content-Type": "application/json"},
            json=request_body,
            timeout=min(1200.0, max(1.0, float(self.config.openai_request_timeout))),
        )
        response.raise_for_status()
        body = response.json()
        content = (((body.get("choices") or [{}])[0].get("message") or {}).get("content"))
        return _json_content(content)

    def _fallback(self, posts: list[dict[str, Any]], rules: list[dict[str, Any]], reason: str) -> tuple[list[dict[str, Any]], str]:
        if not posts or not rules:
            return [], reason
        post = posts[0]
        rule = rules[0]
        return [
            {
                "title": "先观察指数与量价，再决定是否跟踪个股或 ETF",
                "stance": "observe",
                "details": f"依据最近发言 {post['pid']}：{post['body'][:220]}。当前仅形成观察条件，不代表买入建议。",
                "triggers": "指数趋势未破且成交量/板块相对强度得到当日数据确认后再评估。",
                "invalidation": "放量跌破关键支撑、板块弱于指数或行情数据缺失时停止跟踪。",
                "confidence": 0.35,
                "citations": [{"post_pid": str(post["pid"]), "rule_id": str(rule["id"]), "quote": post["body"][:120]}],
            }
        ], reason

    def _save_aliases(self, aliases: list[dict[str, Any]]) -> None:
        if not aliases:
            return
        now = utc_now()
        with self.db.transaction() as conn:
            for alias in aliases:
                existing = conn.execute("SELECT * FROM aliases WHERE alias=?", (alias["alias"],)).fetchone()
                if existing and existing["source"] == "manual":
                    continue
                if existing and float(existing["confidence"]) > float(alias["confidence"]):
                    continue
                conn.execute(
                    """INSERT INTO aliases(alias,code,confidence,source,corrected_at) VALUES(?,?,?,?,?)
                    ON CONFLICT(alias) DO UPDATE SET code=excluded.code,confidence=excluded.confidence,
                    source=excluded.source,corrected_at=excluded.corrected_at""",
                    (alias["alias"], alias["code"], alias["confidence"], "ai", now),
                )

    def _store(
        self,
        strategy_date: str,
        kind: str,
        status: str,
        items: list[dict[str, Any]],
        source_count: int,
        market_asof: str,
        raw: dict[str, Any],
        continued: int = 0,
    ) -> int:
        version = self.db.execute(
            """INSERT INTO strategy_versions(strategy_date,kind,generated_at,status,source_post_count,market_asof,model,raw_json)
            VALUES(?,?,?,?,?,?,?,?)""",
            (
                strategy_date,
                kind,
                utc_now(),
                status,
                source_count,
                market_asof,
                self.config.openai_model if self.config.has_ai_credentials else "",
                json.dumps(raw, ensure_ascii=False),
            ),
        )
        version_id = int(version.lastrowid)
        with self.db.transaction() as conn:
            for rank, item in enumerate(items, 1):
                cursor = conn.execute(
                    """INSERT INTO strategy_items(version_id,rank,title,stance,details,triggers,invalidation,confidence,continued_days)
                    VALUES(?,?,?,?,?,?,?,?,?)""",
                    (
                        version_id,
                        rank,
                        item["title"],
                        item.get("stance", "observe"),
                        item.get("details", ""),
                        item.get("triggers", ""),
                        item.get("invalidation", ""),
                        item.get("confidence", 0),
                        continued,
                    ),
                )
                item_id = int(cursor.lastrowid)
                for citation in item.get("citations", []):
                    conn.execute(
                        "INSERT INTO strategy_citations(item_id,post_pid,rule_id,quote) VALUES(?,?,?,?)",
                        (item_id, citation.get("post_pid", ""), citation.get("rule_id", ""), citation.get("quote", "")),
                    )
        self.db.add_event("strategy", {"version_id": version_id, "date": strategy_date, "status": status})
        return version_id

    def generate(self, strategy_date: str | None = None, kind: str = "baseline") -> dict[str, Any]:
        self._ensure_builtin_rule()
        target_date = strategy_date or _today()
        if kind == "baseline":
            try:
                previous_day = (date.fromisoformat(target_date) - timedelta(days=1)).isoformat()
            except ValueError:
                previous_day = ""
            has_yesterday = self.db.one(
                "SELECT 1 FROM posts WHERE author_id=? AND substr(post_at,1,10)=? LIMIT 1",
                (str(self.config.nga_author_id), previous_day),
            )
            has_target_day = self.db.one(
                "SELECT 1 FROM posts WHERE author_id=? AND substr(post_at,1,10)=? LIMIT 1",
                (str(self.config.nga_author_id), target_date),
            )
            if not has_yesterday and not has_target_day:
                continued = self.continue_latest(target_date)
                if continued is not None:
                    return continued
        posts = self._source_posts(target_date)
        rules = self._rules()
        market = latest_snapshots(self.db)
        market_asof = max((str(item["snapshot_at"]) for item in market), default="")
        status = "ready"
        errors: list[str] = []
        aliases: list[dict[str, Any]] = []
        try:
            payload = self._call_ai(self._prompt(target_date, posts, rules, market))
            items, errors = validate_items(payload, {str(p["pid"]) for p in posts}, {str(r["id"]) for r in rules})
            aliases, alias_errors = validate_aliases(payload)
            errors.extend(alias_errors)
            if not items:
                raise StrategyError("AI 策略没有通过引用校验")
            raw = payload
        except Exception as exc:
            fallback, reason = self._fallback(posts, rules, str(exc))
            items = fallback
            raw = {"fallback_reason": reason, "items": items}
            status = "needs_configuration" if not self.config.has_ai_credentials else "fallback"
            errors.append(str(exc))
        if not items:
            # A configured but empty database is still a useful, explicit state.
            status = "needs_data"
        self._save_aliases(aliases)
        version_id = self._store(target_date, kind, status, items, len(posts), market_asof, raw)
        return {"version_id": version_id, "date": target_date, "status": status, "errors": errors, "aliases": aliases, "items": items}

    def continue_latest(self, strategy_date: str | None = None) -> dict[str, Any] | None:
        target_date = strategy_date or _today()
        previous = self.db.one(
            "SELECT * FROM strategy_versions WHERE strategy_date < ? ORDER BY strategy_date DESC, generated_at DESC LIMIT 1",
            (target_date,),
        )
        if not previous:
            return None
        items = self._items_for_version(int(previous["id"]))
        continued = max((int(item.get("continued_days", 0)) for item in items), default=0) + 1
        for item in items:
            item["continued_days"] = continued
        version_id = self._store(
            target_date,
            "continuation",
            "continued",
            items,
            int(previous["source_post_count"]),
            str(previous["market_asof"]),
            {"continued_from": int(previous["id"])},
            continued,
        )
        return {"version_id": version_id, "date": target_date, "status": "continued", "aliases": self.list_aliases(), "items": items}

    def _items_for_version(self, version_id: int) -> list[dict[str, Any]]:
        rows = self.db.query("SELECT * FROM strategy_items WHERE version_id=? ORDER BY rank", (version_id,))
        result = []
        for row in rows:
            citations = self.db.query("SELECT * FROM strategy_citations WHERE item_id=?", (row["id"],))
            citation_items = []
            for citation in citations:
                citation_item = dict(citation)
                post = self.db.one(
                    "SELECT pid,post_at,body,url FROM posts WHERE tid=? AND pid=? LIMIT 1",
                    (self.config.nga_tid, citation["post_pid"]),
                )
                rule = self.db.one(
                    "SELECT id,title,summary,evidence_ref FROM rules WHERE id=? LIMIT 1",
                    (citation["rule_id"],),
                )
                citation_item["post"] = dict(post) if post else None
                citation_item["rule"] = dict(rule) if rule else None
                citation_items.append(citation_item)
            result.append(
                {
                    "title": row["title"],
                    "stance": row["stance"],
                    "details": row["details"],
                    "triggers": row["triggers"],
                    "invalidation": row["invalidation"],
                    "confidence": row["confidence"],
                    "continued_days": row["continued_days"],
                    "citations": citation_items,
                }
            )
        return result

    def list_versions(self, strategy_date: str | None = None, limit: int = 10) -> list[dict[str, Any]]:
        if strategy_date:
            rows = self.db.query(
                "SELECT * FROM strategy_versions WHERE strategy_date=? ORDER BY generated_at DESC LIMIT ?",
                (strategy_date, limit),
            )
        else:
            rows = self.db.query("SELECT * FROM strategy_versions ORDER BY generated_at DESC LIMIT ?", (limit,))
        return [
            {
                **dict(row),
                "raw": json.loads(row["raw_json"] or "{}"),
                "items": self._items_for_version(int(row["id"])),
            }
            for row in rows
        ]

    def list_aliases(self) -> list[dict[str, Any]]:
        return [dict(row) for row in self.db.query("SELECT * FROM aliases ORDER BY alias")]
