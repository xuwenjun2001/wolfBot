"use client";
import { useCallback } from "react";
import PriceVolumeChart, {
  type ChartLoader,
  type RecordValue,
} from "@/components/quant/PriceVolumeChart";
import type { TacticEvent } from "@/lib/quant/tactics-types";

const averages = [5, 10, 20, 55, 60, 233];
export default function TacticChartPanel({ event }: { event: TacticEvent }) {
  const loadData = useCallback<ChartLoader>(
    async (mode, refresh, signal) => {
      const response = await fetch(
        refresh
          ? "/api/quant/tactics"
          : `/api/quant/tactics?event=${encodeURIComponent(event.id)}&chart=${mode}`,
        {
          signal,
          cache: "no-store",
          method: refresh ? "POST" : "GET",
          ...(refresh
            ? {
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  action: "chart",
                  event_id: event.id,
                  mode,
                }),
              }
            : {}),
        },
      );
      const result = await response.json();
      if (!response.ok)
        throw new Error(result.message || "刷新失败，保留原数据");
      return result.data;
    },
    [event.id],
  );
  return (
    <>
      <PriceVolumeChart
        key={event.id}
        symbol={event.symbol}
        bars={(event.bars || []) as RecordValue[]}
        averagePeriods={averages}
        source="baostock"
        metadata={{ volumeUnit: "手" }}
        loadData={loadData}
      />
      <p className="mt-5 border-t pt-4 text-xs text-muted-foreground">
        以下为筛选时保存的战法证据 · 评估日期 {event.last_evaluated}
        。刷新上方行情不会改变入池依据或有效期。
      </p>
    </>
  );
}
