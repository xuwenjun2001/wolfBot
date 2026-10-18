"""Run one explicitly selected local review, optionally synthesize its report."""

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(
    0, str(Path(__file__).resolve().parents[2] / "services/market-data/src")
)


def main():
    from quantpilot_market_data.cli import load_market_environment
    from quantpilot_market_data.providers.tactics_source import TacticsSource
    from quantpilot_market_data.repositories import tactic_reviews as repo
    from quantpilot_market_data.repositories import tactics as base
    from quantpilot_market_data.services import tactic_reviews as service

    parser = argparse.ArgumentParser()
    parser.add_argument("--day", required=True)
    parser.add_argument("--with-report", action="store_true")
    args = parser.parse_args()
    load_market_environment()
    job = service.submit(args.day, "local-review-validation")
    owner = f"review-validation-{job['id']}"
    source = TacticsSource()
    try:
        claimed = repo.claim(owner, job["id"])
        if not claimed:
            raise RuntimeError("Review already claimed; inspect its existing job.")
        service.execute(claimed, owner, source)
        with base.connection() as c:
            result = c.execute(
                "SELECT id,status,result,error FROM quant.tactic_review_jobs WHERE id=%s",
                (job["id"],),
            ).fetchone()
            report_job = c.execute(
                "SELECT id FROM quant.tactic_review_jobs WHERE kind='report' "
                "AND trade_date=%s AND status='queued' ORDER BY created_at DESC LIMIT 1",
                (args.day,),
            ).fetchone()
        print(json.dumps(repo.plain(result), ensure_ascii=False), flush=True)
        if args.with_report and report_job:
            claimed = repo.claim(owner, report_job["id"])
            if claimed:
                service.execute(claimed, owner, source)
                with base.connection() as c:
                    result = c.execute(
                        "SELECT id,status,result,error FROM quant.tactic_review_jobs WHERE id=%s",
                        (claimed["id"],),
                    ).fetchone()
                print(json.dumps(repo.plain(result), ensure_ascii=False), flush=True)
                if result["status"] != "completed":
                    raise RuntimeError(
                        "Report did not complete; inspect persisted status."
                    )
    finally:
        source.close()


if __name__ == "__main__":
    main()
