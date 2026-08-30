"""Import the EastMoney A-share catalog and initialize Tencent daily history.

With no explicit symbols this command imports the current SH/SZ/BJ common
stock universe from EastMoney and then initializes each symbol through the
existing Tencent ``MarketSyncService``.  Explicit symbols remain available
for bounded recovery runs.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path


SCRIPT_ROOT = Path(__file__).resolve().parent
BACKEND_ROOT = SCRIPT_ROOT.parent / "backend"
sys.path.insert(0, str(BACKEND_ROOT))

from app.config import settings  # noqa: E402
from app.db import Database  # noqa: E402
from app.market_data import (  # noqa: E402
    EastMoneyUniverseProvider,
    Security,
    TencentProvider,
    security_from_symbol,
)
from app.market_store import DEFAULT_UNIVERSE_ID, MarketStore, initialize_market  # noqa: E402


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description=(
            "Import the EastMoney A-share universe and initialize Tencent daily bars. "
            "Use --symbol/--symbols-file for bounded recovery."
        )
    )
    parser.add_argument(
        "--symbol",
        action="append",
        default=[],
        metavar="SH600519",
        help="Canonical symbol with exchange prefix; repeat for each security.",
    )
    parser.add_argument(
        "--symbols-file",
        type=Path,
        metavar="PATH",
        help="UTF-8 text file containing one canonical symbol per line.",
    )
    parser.add_argument(
        "--universe-id",
        default=DEFAULT_UNIVERSE_ID,
        help="Local universe identifier (default: a-share).",
    )
    parser.add_argument(
        "--adjustment",
        choices=("qfq", "none", "hfq"),
        default="qfq",
        help="Tencent history adjustment (default: qfq).",
    )
    parser.add_argument(
        "--history-limit",
        type=int,
        default=800,
        metavar="N",
        help="Maximum Tencent daily bars per symbol (1..800, default: 800).",
    )
    parser.add_argument(
        "--max-symbols",
        type=int,
        metavar="N",
        help="Bound the imported or explicit symbol count for smoke/recovery runs.",
    )
    parser.add_argument(
        "--eastmoney-page-size",
        type=int,
        default=1000,
        metavar="N",
        help="EastMoney clist page size (1..5000, default: 1000).",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Print the import/sync plan without opening SQLite or calling Tencent history.",
    )
    return parser


def _read_file(path: Path) -> list[str]:
    resolved = path.expanduser().resolve()
    if not resolved.is_file():
        raise ValueError(f"symbols file does not exist: {resolved}")
    try:
        content = resolved.read_text(encoding="utf-8")
    except OSError as exc:
        raise ValueError(f"could not read symbols file: {resolved}") from exc
    return [line.split("#", 1)[0].strip() for line in content.splitlines() if line.split("#", 1)[0].strip()]


def _securities(values: list[str], universe_id: str, *, max_symbols: int | None = None) -> list[Security]:
    if not values:
        raise ValueError("at least one explicit symbol is required")
    result: list[Security] = []
    seen: set[str] = set()
    for raw in values:
        try:
            security = security_from_symbol(raw)
        except ValueError as exc:
            raise ValueError(f"invalid symbol {raw!r}: explicit sh/sz/bj prefix is required") from exc
        if security.symbol in seen:
            continue
        seen.add(security.symbol)
        result.append(
            Security(
                symbol=security.symbol,
                code=security.code,
                name=security.name,
                asset_type=security.asset_type,
                exchange=security.exchange,
                board=security.board,
                universe_id=universe_id,
                is_st=security.is_st,
                enabled=security.enabled,
                status=security.status,
                source="manual-cli",
                metadata=security.metadata,
            )
        )
    if max_symbols is not None:
        return result[:max_symbols]
    return result


def _validate_args(args: argparse.Namespace) -> None:
    if args.history_limit < 1 or args.history_limit > 800:
        raise ValueError("--history-limit must be between 1 and 800")
    if args.max_symbols is not None and args.max_symbols < 1:
        raise ValueError("--max-symbols must be positive")
    if args.eastmoney_page_size < 1 or args.eastmoney_page_size > 5000:
        raise ValueError("--eastmoney-page-size must be between 1 and 5000")


def _progress(index: int, total: int, security: Security, error: str | None) -> None:
    if error:
        print(f"[{index}/{total}] {security.symbol}: ERROR {error}", file=sys.stderr)
    else:
        print(f"[{index}/{total}] {security.symbol}: ok", file=sys.stderr)


def main(argv: list[str] | None = None) -> int:
    parser = _parser()
    args = parser.parse_args(argv)
    try:
        _validate_args(args)
        values = list(args.symbol)
        if args.symbols_file is not None:
            values.extend(_read_file(args.symbols_file))
    except ValueError as exc:
        parser.error(str(exc))

    catalog_source = "manual-cli"
    explicit_mode = bool(args.symbol) or args.symbols_file is not None
    if explicit_mode:
        try:
            securities = _securities(values, args.universe_id, max_symbols=args.max_symbols)
        except ValueError as exc:
            parser.error(str(exc))
    else:
        catalog_source = "eastmoney"
        try:
            eastmoney = EastMoneyUniverseProvider(
                timeout=settings.request_timeout,
                page_size=args.eastmoney_page_size,
            )
            securities = eastmoney.list_securities(
                universe_id=args.universe_id,
                max_symbols=args.max_symbols,
            )
        except Exception as exc:
            print(f"EastMoney universe import failed: {exc}", file=sys.stderr)
            return 1

    plan = {
        "operation": "initialize",
        "universe_id": args.universe_id,
        "adjustment": args.adjustment,
        "catalog_source": catalog_source,
        "history_source": "tencent",
        "source": f"{catalog_source}+tencent",
        "symbols": [item.symbol for item in securities],
        "count": len(securities),
        "history_limit": args.history_limit,
        "max_symbols": args.max_symbols,
        "database": str(settings.database_path),
    }
    if args.dry_run:
        plan["dry_run"] = True
        print(json.dumps(plan, ensure_ascii=False, indent=2))
        return 0

    database = Database(settings.database_path)
    try:
        store = MarketStore(database)
        provider = TencentProvider(timeout=settings.request_timeout)
        result = initialize_market(
            store,
            securities,
            provider=provider,
            universe_id=args.universe_id,
            adjustment=args.adjustment,
            history_limit=args.history_limit,
            source=f"{catalog_source}+tencent",
            progress=_progress,
        )
        print(json.dumps(result.as_dict(), ensure_ascii=False, indent=2))
        return 0 if result.status == "completed" else 1
    except Exception as exc:
        print(f"market initialization failed: {exc}", file=sys.stderr)
        return 1
    finally:
        database.close()


if __name__ == "__main__":
    raise SystemExit(main())
