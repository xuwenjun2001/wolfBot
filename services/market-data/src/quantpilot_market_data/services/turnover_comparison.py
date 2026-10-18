"""Same-minute comparisons with fixed calendar baselines, independent per metric."""

from quantpilot_market_data.providers.market_layout import cumulative


def metric_comparisons(sessions: list[dict], trading_dates: list[str]) -> dict:
    current = max(s["tradeDate"] for s in sessions)
    matched = all(s["tradeDate"] == current for s in sessions)
    calendar_known = current in trading_dates
    preceding = sorted({d for d in trading_dates if d < current})[-5:] if calendar_known else []
    previous_date = preceding[-1] if preceding else None
    output = {}
    for metric, field, unit in (("amount", "minuteAmount", "元"), ("volume", "minuteVolume", "手")):

        def totals(date, field=field):
            values = [cumulative(s["days"].get(date, {}), field) for s in sessions]
            common = set.intersection(*(set(v) for v in values))
            return {t: sum(v[t] for v in values) for t in sorted(common)}

        now = totals(current) if matched else {}
        previous = totals(previous_date) if previous_date else {}
        history = [totals(d) for d in preceding]
        ma5 = {}
        if len(preceding) == 5:
            common = set.intersection(*(set(v) for v in history))
            ma5 = {t: sum(v[t] for v in history) / 5 for t in sorted(common)}
        rows = []
        for minute, value in now.items():
            row = {"time": minute, "current": value}
            for label, baseline in (("previous", previous), ("ma5", ma5)):
                base = baseline.get(minute)
                difference = value - base if base is not None else None
                row.update(
                    {
                        label: base,
                        label + "Difference": difference,
                        label + "ChangePct": difference / base * 100 if base else None,
                    }
                )
            rows.append(row)
        cutoff = rows[-1]["time"] if rows else None
        stamp_field = "amountFetchedAt" if metric == "amount" else "volumeFetchedAt"
        stamps, retained = [], False
        for session in sessions:
            for minute in now:
                raw = session["days"].get(current, {}).get(minute, {})
                stamp = raw.get(stamp_field, raw.get("fetchedAt"))
                if stamp:
                    stamps.append(stamp)
                    retained = retained or stamp < session.get("fetchedAt", stamp)
        raw_cutoff = min(max(s["days"].get(current, {}), default="") for s in sessions)
        # Count days usable through the current comparison point, not arbitrary old dates.
        sample_count = sum(bool(v) and (cutoff in v if cutoff else "15:00" in v) for v in history)

        def baseline_status(label, values, now=now, sample_count=sample_count, cutoff=cutoff):
            aligned = [t for t in now if t in values]
            end = aligned[-1] if aligned else None
            if not calendar_known or not previous_date:
                reason, code = "交易日历不足，暂不能确认比较日期。", "calendar_missing"
            elif label == "ma5" and (len(preceding) < 5 or sample_count < 5):
                reason = f"历史数据积累中，当前时点已具备 {sample_count}/5 日。"
                code = "history_incomplete"
            elif not values:
                reason, code = "缺少上一交易日的连续分钟数据。", "previous_missing"
            elif end != cutoff or end is None:
                reason, code = "分钟数据存在缺口，仅比较已对齐的区间。", "minute_gap"
            else:
                reason, code = None, None
            return {
                "cutoff": end,
                "reason": reason,
                "reasonCode": code,
                "complete": end is not None and end == cutoff,
            }

        reason = None
        if not matched:
            reason = "沪深数据日期尚未对齐，暂不能计算合计。"
        elif not now or cutoff != raw_cutoff:
            reason = "当日分钟数据存在缺口，仅展示可连续累计的区间。"
        output[metric] = {
            "currentDate": current,
            "currentCutoff": cutoff,
            "fetchedAt": min(stamps) if stamps else None,
            "retained": retained,
            "unit": unit,
            "previousDate": previous_date,
            "sampleDates": preceding,
            "sampleCount": sample_count,
            "rows": rows,
            "reason": reason,
            "previousStatus": baseline_status("previous", previous),
            "ma5Status": baseline_status("ma5", ma5),
        }
    return output


def legacy_comparison(metric: dict) -> dict:
    rows = [
        {
            "time": r["time"],
            "current": r["current"],
            "previous": r["previous"],
            "difference": r["previousDifference"],
            "changePct": r["previousChangePct"],
        }
        for r in metric["rows"]
        if r["previous"] is not None
    ]
    return {
        "currentDate": metric["currentDate"],
        "previousDate": metric["previousDate"],
        "cutoff": metric["previousStatus"]["cutoff"],
        "complete": metric["previousStatus"]["complete"] and not metric["reason"],
        "reason": metric["reason"] or metric["previousStatus"]["reason"],
        "currentTotal": metric["rows"][-1]["current"] if metric["rows"] else None,
        "currentCutoff": metric["currentCutoff"],
        "rows": rows,
    }
