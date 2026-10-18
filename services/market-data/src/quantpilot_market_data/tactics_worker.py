"""Independent worker: python -m quantpilot_market_data.tactics_worker [--once]."""

import argparse
import logging
import signal
import time
from uuid import uuid4

from quantpilot_market_data.cli import load_market_environment
from quantpilot_market_data.providers.tactics_source import TacticsSource
from quantpilot_market_data.repositories import tactic_reviews as review_repo
from quantpilot_market_data.repositories import tactics as repo
from quantpilot_market_data.services import tactic_reviews as reviews
from quantpilot_market_data.services.tactics import execute


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--once", action="store_true")
    args = parser.parse_args()
    load_market_environment()
    logging.basicConfig(level=logging.INFO)
    owner = f"tactics-{uuid4()}"
    stopping = False

    def stop(*_):
        nonlocal stopping
        stopping = True

    signal.signal(signal.SIGINT, stop)
    signal.signal(signal.SIGTERM, stop)
    source = TacticsSource(interrupted=lambda: stopping)
    next_schedule = 0.0
    try:
        while not stopping:
            try:
                repo.worker_heartbeat(owner)
                if time.monotonic() >= next_schedule:
                    reviews.schedule()
                    next_schedule = time.monotonic() + 60
                run = repo.claim(owner)
                if run:
                    execute(run, owner, source)
                else:
                    review = review_repo.claim(owner)
                    if review:
                        reviews.execute(review, owner, source)
            except Exception:
                logging.exception("战法worker轮询失败，请检查数据库迁移")
                if args.once:
                    raise
            if args.once:
                break
            time.sleep(2)
    finally:
        source.close()


if __name__ == "__main__":
    main()
