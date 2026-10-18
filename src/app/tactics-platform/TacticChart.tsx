"use client";
import type { TacticBar } from "@/lib/quant/tactics-types";

export default function TacticChart({ bars }: { bars: TacticBar[] }) {
  const rows = bars
    .slice(-80)
    .filter(
      (b) =>
        b.high !== null &&
        b.low !== null &&
        b.close !== null &&
        b.open !== null,
    );
  if (!rows.length)
    return (
      <p className="p-6 text-sm text-muted-foreground">
        该事件没有可用的K线快照。
      </p>
    );
  const values = rows.flatMap((b) => [b.low!, b.high!, b.ma55 ?? b.close!]);
  const low = Math.min(...values) * 0.98;
  const high = Math.max(...values) * 1.02;
  const x = (i: number) => 55 + ((i + 0.5) * 820) / rows.length;
  const y = (v: number) => 230 - ((v - low) / (high - low || 1)) * 205;
  const colors = {
    ma5: "#3b82f6",
    ma10: "#a855f7",
    ma20: "#10b981",
    ma55: "#f59e0b",
  };
  return (
    <div className="overflow-hidden rounded-xl border bg-background p-3">
      <div className="mb-2 flex flex-wrap gap-4 text-xs">
        {Object.entries(colors).map(([key, color]) => (
          <span key={key} style={{ color }}>
            {key.toUpperCase()}
          </span>
        ))}
        <span className="text-muted-foreground">前复权 · 运行时数据快照</span>
      </div>
      <svg
        viewBox="0 0 900 260"
        role="img"
        aria-label="日K与MA5、MA10、MA20、MA55均线"
        className="w-full"
      >
        {[0, 1, 2, 3, 4].map((i) => {
          const v = low + ((high - low) * i) / 4;
          return (
            <g key={i}>
              <line
                x1="50"
                x2="885"
                y1={y(v)}
                y2={y(v)}
                stroke="currentColor"
                opacity=".1"
              />
              <text x="3" y={y(v) + 4} fontSize="10" fill="currentColor">
                {v.toFixed(2)}
              </text>
            </g>
          );
        })}
        {rows.map((b, i) => {
          const color = b.close! >= b.open! ? "#ef4444" : "#10b981";
          return (
            <g key={b.date}>
              <title>{`${b.date} 开${b.open} 收${b.close} 高${b.high} 低${b.low} MA55 ${b.ma55?.toFixed(2) ?? "-"}`}</title>
              <line
                x1={x(i)}
                x2={x(i)}
                y1={y(b.high!)}
                y2={y(b.low!)}
                stroke={color}
              />
              <rect
                x={x(i) - 3}
                y={Math.min(y(b.open!), y(b.close!))}
                width="6"
                height={Math.max(1, Math.abs(y(b.open!) - y(b.close!)))}
                fill={color}
              />
            </g>
          );
        })}
        {Object.entries(colors).map(([key, color]) => (
          <path
            key={key}
            d={rows
              .map((b, i) => {
                const v = b[key as keyof TacticBar];
                return typeof v === "number"
                  ? `${i && typeof rows[i - 1][key as keyof TacticBar] === "number" ? "L" : "M"}${x(i)},${y(v)}`
                  : "";
              })
              .join(" ")}
            fill="none"
            stroke={color}
            strokeWidth={key === "ma55" ? 2.5 : 1}
          />
        ))}
        {[0, Math.floor(rows.length / 2), rows.length - 1].map((i) => (
          <text
            key={i}
            x={x(i)}
            y="253"
            textAnchor="middle"
            fontSize="10"
            fill="currentColor"
          >
            {rows[i].date}
          </text>
        ))}
      </svg>
    </div>
  );
}
