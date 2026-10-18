"""Read-only live paired benchmark; does not update screening state or caches."""
import itertools
import json
import statistics
import time
from datetime import datetime
from pathlib import Path

from quantpilot_market_data.cli import load_market_environment
from quantpilot_market_data.providers.tactics_source import TacticsSource
from quantpilot_market_data.repositories.tactics import connection


def main():
    load_market_environment()
    with connection() as conn:
        run = conn.execute("SELECT id,context,total,processed,created_at,updated_at FROM quant.tactic_runs ORDER BY created_at DESC LIMIT 1").fetchone()
        context = run["context"]
        target = context["target"]
        days = [d for d in context["sessions"] if d <= target]
        members = context["members"]
        symbols = [members[round(i * (len(members)-1) / 19)]["symbol"] for i in range(20)]
        old = conn.execute("SELECT symbol,trade_date,bars FROM quant.tactic_windows WHERE symbol=ANY(%s)", (symbols,)).fetchall()
    old = {r["symbol"]: r for r in old}
    starts = {"full120": days[-120], "overlap5": days[-5], "today1": target}
    output = {"started_at": datetime.now().isoformat(), "target": target, "starts": starts, "baseline_run": run, "samples": []}
    output["baseline_run"] = {k:v for k,v in run.items() if k != "context"}
    folder = Path("data/validation/tactic-incremental")
    folder.mkdir(parents=True, exist_ok=True)
    source = TacticsSource(timeout=20)
    def request(symbol, mode):
        began=time.perf_counter()
        try:
            bars=source.request("bars",symbol=symbol,start=starts[mode],end=target)
            return {"seconds":time.perf_counter()-began,"count":len(bars),"bars":bars,"error":None}
        except Exception as e:
            source.close()
            return {"seconds":time.perf_counter()-began,"count":0,"bars":[],"error":str(e)}
    try:
        warm=request(symbols[0],"today1")
        output["warmup"]={k:v for k,v in warm.items() if k!="bars"}
        orders=list(itertools.permutations(starts))
        for i,symbol in enumerate(symbols):
            sample={"symbol":symbol,"order":orders[i%6],"results":{}}
            for mode in sample["order"]:
                sample["results"][mode]=request(symbol,mode)
                time.sleep(0.3)
            full={b["date"]:b for b in sample["results"]["full120"]["bars"]}
            fields=("open","high","low","close")
            sample["checks"]={}
            for mode in ("overlap5","today1"):
                bars=sample["results"][mode]["bars"]
                sample["checks"][mode]={"has_target":any(b["date"]==target for b in bars),"matches_full":bool(bars) and all(b["date"] in full and all(b.get(k)==full[b["date"]].get(k) for k in fields) for b in bars)}
            cached=old.get(symbol)
            short={b["date"]:b for b in sample["results"]["overlap5"]["bars"]}
            overlap=[b for b in (cached or {}).get("bars",[]) if b["date"] in short]
            sample["local_overlap"]={"cached_date":str(cached["trade_date"]) if cached else None,"count":len(overlap),"price_changes":sum(any(b.get(k)!=short[b["date"]].get(k) for k in fields) for b in overlap)}
            output["samples"].append(sample)
            (folder/"results.json").write_text(json.dumps(output,ensure_ascii=False,default=str,indent=2),encoding="utf-8")
            print(json.dumps({"progress":f"{i+1}/20","symbol":symbol,"timings":{k:round(v["seconds"],3) for k,v in sample["results"].items()},"errors":{k:v["error"] for k,v in sample["results"].items() if v["error"]}},ensure_ascii=False),flush=True)
    finally:
        source.close()
    paired=[s for s in output["samples"] if all(not v["error"] and v["count"] for v in s["results"].values()) and all(c["has_target"] for c in s["checks"].values())]
    output["summary"]={"valid_paired":len(paired),"total_samples":len(symbols),"modes":{}}
    for mode in starts:
        times=[s["results"][mode]["seconds"] for s in paired]
        if times:
            output["summary"]["modes"][mode]={"mean_seconds":statistics.mean(times),"median_seconds":statistics.median(times),"max_seconds":max(times),"fetch_and_sleep_3195_minutes":(statistics.mean(times)+0.3)*3195/60}
    (folder/"results.json").write_text(json.dumps(output,ensure_ascii=False,default=str,indent=2),encoding="utf-8")
    print(json.dumps(output["summary"],ensure_ascii=False),flush=True)

if __name__ == "__main__":
    main()
