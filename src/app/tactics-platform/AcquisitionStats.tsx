import type { TacticRun } from "@/lib/quant/tactics-types";

const duration = (seconds: number) =>
  seconds >= 60
    ? `${(seconds / 60).toFixed(1)} 分钟`
    : `${seconds.toFixed(2)} 秒`;
export default function AcquisitionStats({ run }: { run: TacticRun }) {
  const d = run.acquisition;
  if (!d)
    return <p className="mt-3 text-xs text-muted-foreground">暂无耗时统计</p>;
  return (
    <div className="mt-4 space-y-3 text-xs" aria-label="数据准备耗时统计">
      <p>
        已处理 {run.processed} / {run.total} · 已记录诊断 {d.recorded} 只
      </p>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
        {[
          ["缓存复用", d.cached],
          ["增量成功", d.incremental],
          ["全量取数", d.full],
          ["其中回退", d.fallback],
          ["数据缺口", run.gaps],
        ].map(([label, value]) => (
          <div key={label} className="rounded-lg bg-muted/50 p-3">
            <p className="text-muted-foreground">{label}</p>
            <p className="mt-1 text-base font-semibold">{value} 只</p>
          </div>
        ))}
      </div>
      <p>
        累计取数 {duration(d.fetch_seconds)} · 平均每只取数{" "}
        {d.average_fetch_seconds === null
          ? "—"
          : duration(d.average_fetch_seconds)}
      </p>
      <details className="rounded-lg border p-3">
        <summary className="cursor-pointer">耗时细分与回退原因</summary>
        <dl className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
          {[
            ["行情请求", d.fetch_seconds],
            ["固定等待及重试退避", d.wait_seconds],
            ["缓存读取", d.cache_seconds],
            ["校验", d.validation_seconds],
            ["持久化调用", d.persist_seconds],
            ["逐股准备累计", d.prepare_seconds],
          ].map(([label, value]) => (
            <div key={label} className="flex justify-between gap-3">
              <dt>{label}</dt>
              <dd>{duration(Number(value))}</dd>
            </div>
          ))}
        </dl>
        <p className="mt-3 text-muted-foreground">
          请求 {d.requests} 次 · 返回 {d.rows}{" "}
          根。平均耗时仅计算实际取数股票，包含重试；复用缓存不计入。持久化统计不含诊断落库与最终事务提交，逐股累计不含证券名单和最终选股阶段。
        </p>
        {Object.entries(d.fallback_reasons).map(([reason, count]) => (
          <p key={reason} className="mt-2 break-words">
            {reason}：{count} 只
          </p>
        ))}
      </details>
    </div>
  );
}
