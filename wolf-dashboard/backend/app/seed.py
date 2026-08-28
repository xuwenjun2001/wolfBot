from __future__ import annotations

import re
from pathlib import Path

from .config import Settings, settings
from .db import Database, utc_now
from .text import parse_reply, safe_html


POST_HEADING = re.compile(
    r"^##\s+.*?(?P<date>\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}).*?PID\s*[=:]?\s*(?P<pid>\d+)",
    re.I,
)
RULE_ROW = re.compile(r"^\|\s*(E\d{2}-\d{2})\s*\|(.+?)\|(.+?)\|(.+?)\|\s*$")


def _read(path: Path) -> str:
    return path.read_text(encoding="utf-8", errors="replace")


def _insert_post(db: Database, tid: int, author_id: int, pid: str, date: str, body: str, source: str, line: int) -> bool:
    parsed = parse_reply(body)
    row = db.execute(
        """INSERT OR IGNORE INTO posts
        (tid,pid,author_id,author_name,page,post_at,subject,body,body_html,quote_text,quote_pid,url,source,discovered_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
        (
            tid,
            pid,
            str(author_id),
            "狼大",
            None,
            date,
            "",
            parsed.body,
            safe_html(parsed.body),
            parsed.quote,
            parsed.quote_pid,
            f"https://ngabbs.com/read.php?tid={tid}&pid={pid}",
            source,
            utc_now(),
        ),
    )
    if row.rowcount:
        try:
            db.execute(
                "INSERT INTO post_fts(rowid,pid,body,subject) SELECT rowid,pid,body,subject FROM posts WHERE tid=? AND pid=?",
                (tid, pid),
            )
        except Exception:
            pass
        return True
    return False


def seed_posts(db: Database, config: Settings = settings) -> int:
    candidates = [
        config.repo_root / "狼大新增发言_20260814-1457至今.md",
        config.repo_root / "狼大2026炒股策略分析_证据版.md",
        config.repo_root / "wolf-investing" / "references" / "evidence.md",
    ]
    inserted = 0
    for path in candidates:
        if not path.exists():
            continue
        lines = _read(path).splitlines()
        current: tuple[str, str, int] | None = None
        body: list[str] = []
        for line_number, line in enumerate(lines, 1):
            match = POST_HEADING.match(line.strip())
            if match:
                if current:
                    inserted += int(
                        _insert_post(
                            db,
                            config.nga_tid,
                            config.nga_author_id,
                            current[1],
                            current[0],
                            "\n".join(body).strip(),
                            path.name,
                            current[2],
                        )
                    )
                current = (match.group("date"), match.group("pid"), line_number)
                body = []
            elif current:
                body.append(line)
        if current:
            inserted += int(
                _insert_post(
                    db,
                    config.nga_tid,
                    config.nga_author_id,
                    current[1],
                    current[0],
                    "\n".join(body).strip(),
                    path.name,
                    current[2],
                )
            )
    return inserted


def seed_rules(db: Database, config: Settings = settings) -> int:
    paths = [
        config.repo_root / "狼大2026炒股策略分析_证据版.md",
        config.repo_root / "wolf-investing" / "references" / "evidence.md",
    ]
    inserted = 0
    for path in paths:
        if not path.exists():
            continue
        for line_number, line in enumerate(_read(path).splitlines(), 1):
            match = RULE_ROW.match(line)
            if not match:
                continue
            rule_id, evidence, summary, kind = (part.strip() for part in match.groups())
            clean_evidence = re.sub(r"[`]", "", evidence)
            clean_summary = re.sub(r"[`]", "", summary)
            cursor = db.execute(
                """INSERT OR IGNORE INTO rules(id,title,summary,evidence_ref,source_file,source_line,created_at)
                VALUES(?,?,?,?,?,?,?)""",
                (rule_id, clean_summary or rule_id, clean_summary, clean_evidence, path.name, line_number, utc_now()),
            )
            if cursor.rowcount:
                inserted += 1
                try:
                    db.execute(
                        "INSERT INTO rule_fts(rowid,id,title,summary) SELECT rowid,id,title,summary FROM rules WHERE id=?",
                        (rule_id,),
                    )
                except Exception:
                    pass
    return inserted


def seed_all(db: Database, config: Settings = settings) -> dict[str, int]:
    counts = {"posts": seed_posts(db, config), "rules": seed_rules(db, config)}
    db.add_event("seed", counts)
    return counts
