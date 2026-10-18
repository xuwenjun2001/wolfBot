import os
from datetime import datetime
from pathlib import Path

import pytest
from psycopg.types.json import Jsonb
from test_tactic_reviews import sample
from test_tactics_postgres import db as db

from quantpilot_market_data.repositories import tactic_reviews as repo
from quantpilot_market_data.repositories import tactics as base
from quantpilot_market_data.tactic_reviews import performance

pytestmark = pytest.mark.skipif(
    os.getenv("TACTICS_TEST_POSTGRES") != "1", reason="local PostgreSQL"
)


@pytest.fixture
def review_db(db):
    db.execute(
        (Path(__file__).parents[3] / "sqls/015-tactic-reviews.sql").read_text(encoding="utf-8")
    )
    return db


def seed(db):
    days, bars, event = sample()
    run = base.enqueue(datetime.fromisoformat(days[60]).date(), "test")
    db.execute(
        "INSERT INTO quant.tactic_events(id,tactic_id,symbol,name,breakout_date,expires_date,"
        "config_version,parameters,status,signal,last_evaluated,evidence,run_id,created_at) "
        "VALUES(%s,'ma55-breakout-pullback',%s,%s,%s,%s,1,%s,'invalidated','trend_invalid',%s,%s,%s,%s)",
        (
            event["id"],
            event["symbol"],
            event["name"],
            days[60],
            days[62],
            Jsonb(event["parameters"]),
            days[62],
            Jsonb(event["evidence"]),
            run["id"],
            event["created_at"],
        ),
    )
    return days, bars, event


def test_prompt_version_conflict_and_restore_preserve_strategy(review_db):
    before = base.get_config()
    original = repo.prompt_history()[0]
    second = repo.save_prompt("新提示词", 1, "editor")
    assert second["version"] == 2
    with pytest.raises(ValueError, match="已被更新"):
        repo.save_prompt("旧草稿", 1, "editor2")
    restored = repo.save_prompt(original["content"], 2, "editor")
    assert restored["version"] == 3 and base.get_config() == before
    assert len(repo.prompt_history()) == 3


def test_job_idempotency_lease_fence_and_expired_sample_retention(review_db):
    days, bars, event = seed(review_db)
    job = repo.enqueue("review", days[-1], "test")
    assert repo.enqueue("review", days[-1], "other")["id"] == job["id"]
    claimed = repo.claim("owner")
    rows = performance(event, bars, days, days[-1])
    repo.save_performances(claimed["id"], "owner", rows)
    repo.save_performances(claimed["id"], "owner", rows)
    assert len(repo.all_performances()) == 2
    older_rows = performance(event, bars, days, days[-2])
    repo.save_performances(claimed["id"], "owner", older_rows)
    assert repo.all_performances()[1]["status"] == "ready"
    review_db.execute("UPDATE quant.tactic_review_jobs SET lease_until=now()-interval '1 second'")
    repo.claim("new-owner")
    with pytest.raises(base.LeaseLost):
        repo.save_performances(claimed["id"], "owner", rows)
    repo.finish(claimed["id"], "new-owner", {"done": True})


def test_report_freezes_prompt_and_context_retains_versions_and_chunks(review_db):
    days, bars, event = seed(review_db)
    job = repo.enqueue("review", days[-1], "test")
    repo.claim("owner")
    repo.save_performances(job["id"], "owner", performance(event, bars, days, days[-1]))
    snap = repo.snapshot(job["id"], "owner", days[-1], {})
    repo.prepare_report(snap, "test")
    repo.finish(job["id"], "owner")
    repo.save_prompt("之后编辑", 1, "editor")
    report_job = repo.claim("owner")
    assert report_job["input"]["prompt"]["version"] == 1
    content = dict(
        summary="报告摘要",
        sections=[
            dict(
                title="趋势",
                content="历史研究观点",
                event_ids=["event"],
                citations=[],
                rule_tags=["trend"],
            )
        ],
    )
    report_id = repo.publish_report(report_job, "owner", content, "deepseek-flash", {}, 0.1)
    assert repo.prepare_report(snap, "test")["id"] == report_id
    repo.prepare_report(snap, "test", force=True)
    next_job = repo.claim("owner")
    assert next_job["input"]["prompt"]["version"] == 2
    second = repo.publish_report(next_job, "owner", content, "deepseek-flash", {}, 0.1)
    assert repo.report_detail(second)["revision"] == 2
    assert repo.report_detail(report_id)["revision"] == 1
    assert (
        review_db.execute("SELECT count(*) n FROM quant.tactic_report_chunks").fetchone()["n"] == 2
    )
    repo.enable_knowledge(report_id, False, "editor")
    assert repo.report_detail(report_id)["knowledge_enabled"] is False
    assert repo.report_detail(report_id)["input"]["prompt"]["version"] == 1
    # Controlled historical availability in the isolated fixture, never production data.
    review_db.execute(
        "UPDATE quant.tactic_reports SET created_at='2026-08-02 18:00+08' WHERE id=%s", (second,)
    )
    next_review = repo.enqueue("review", "2026-08-03", "test")
    repo.claim("owner", next_review["id"])
    next_snapshot = repo.snapshot(next_review["id"], "owner", "2026-08-03", {})
    generated = repo.prepare_report(next_snapshot, "test")
    repo.finish(next_review["id"], "owner")
    frozen_job = repo.claim("owner", generated["id"])
    assert frozen_job["input"]["knowledge"][0]["report_id"] == second
    repo.enable_knowledge(second, False, "editor")
    assert frozen_job["input"]["knowledge"][0]["report_id"] == second
