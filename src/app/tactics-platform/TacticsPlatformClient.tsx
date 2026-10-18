"use client";

import { useCallback, useEffect, useState } from "react";
import {
  ArrowRight,
  CalendarClock,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Loader2,
  Play,
  RefreshCw,
  Settings2,
  Target,
  X,
} from "lucide-react";
import { PageHeader } from "@/components/layout/PageHeader";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type {
  TacticEvent,
  TacticParameters,
  TacticRun,
  TacticsDashboard,
} from "@/lib/quant/tactics-types";
import TacticChartPanel from "./TacticChartPanel";
import AcquisitionStats from "./AcquisitionStats";
import TacticDialog from "./TacticDialog";
import ObservationGuide from "./ObservationGuide";
import TacticReviewPanel from "./TacticReviewPanel";
import TacticWorkflowNotes from "./TacticWorkflowNotes";

const LABELS: Record<string, string> = {
  queued: "等待执行",
  calendar: "核验交易日历",
  members: "同步主板名单",
  data: "准备日K数据",
  screening: "计算战法条件",
  waiting_data: "等待行情就绪",
  running: "执行中",
  waiting: "等待重试",
  completed: "已完成",
  failed: "失败",
  cancelled: "已停止",
  observing: "观察中",
  expired: "已到期",
  invalidated: "已失效",
  breakout: "新突破",
  pullback: "缩量回踩",
  outside_band: "尚未进入回踩区间",
  not_contracted: "尚未缩量",
  trend_invalid: "多头排列失效",
  support_broken: "回踩跌破容忍下限",
  below_support: "收盘未收回55线",
  is_st: "ST失效",
  delisted: "不再属于在市主板",
  suspended: "停牌",
  insufficient: "暂不可评估",
  data_gap: "数据缺失，暂不参与筛选",
};
const label = (v: string) => LABELS[v] || v;
const runLabel = (r: TacticRun) =>
  r.status === "completed" && r.gaps > 0
    ? "已完成（跳过缺口）"
    : label(r.status);
const number = (v: number | null | undefined, suffix = "") =>
  v == null ? "—" : `${v.toFixed(2)}${suffix}`;
const parameterFields: {
  key: Exclude<keyof TacticParameters, "rule_set">;
  label: string;
  min: number;
  max: number;
  step: number;
}[] = [
  { key: "body_pct", label: "阳线实体下限（%）", min: 0.1, max: 20, step: 0.1 },
  {
    key: "volume_ratio",
    label: "突破量／前5日均量",
    min: 1,
    max: 10,
    step: 0.1,
  },
  {
    key: "contraction_ratio",
    label: "回踩量／突破日量上限",
    min: 0.01,
    max: 1,
    step: 0.01,
  },
  {
    key: "distance_min_pct",
    label: "距55线下限（%）",
    min: -20,
    max: 0,
    step: 0.5,
  },
  {
    key: "distance_max_pct",
    label: "距55线上限（%）",
    min: 0,
    max: 10,
    step: 0.5,
  },
];
async function api(url = "", body?: unknown) {
  const response = await fetch(`/api/quant/tactics${url}`, {
    method: body ? "POST" : "GET",
    ...(body
      ? {
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }
      : {}),
    cache: "no-store",
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.message || "操作失败，请重试");
  return payload.data;
}

export default function TacticsPlatformClient({
  canRun,
  canManage,
}: {
  canRun: boolean;
  canManage: boolean;
}) {
  const [data, setData] = useState<TacticsDashboard | null>(null);
  const [view, setView] = useState("active");
  const [page, setPage] = useState(1);
  const [error, setError] = useState("");
  const [loadError, setLoadError] = useState("");
  const [busy, setBusy] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [draft, setDraft] = useState<{
    parameters: TacticParameters;
    version: number;
  } | null>(null);
  const [detail, setDetail] = useState<TacticEvent | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const latest = data?.runs[0];
  const active = data?.runs.find((r) =>
    ["queued", "running", "waiting"].includes(r.status),
  );
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const controller = new AbortController();
    async function load() {
      try {
        const response = await fetch(
          `/api/quant/tactics?view=${view}&page=${page}`,
          { signal: controller.signal, cache: "no-store" },
        );
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.message || "读取失败");
        if (!stopped) {
          setData(payload.data);
          setLoadError("");
        }
      } catch (e) {
        if (!stopped) setLoadError(e instanceof Error ? e.message : "读取失败");
      }
      if (!stopped) timer = setTimeout(load, 5000);
    }
    void load();
    return () => {
      stopped = true;
      controller.abort();
      clearTimeout(timer);
    };
  }, [view, page, refresh]);
  const mutate = useCallback(async (body: unknown) => {
    setBusy(true);
    setError("");
    try {
      await api("", body);
      setRefresh((v) => v + 1);
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : "操作失败");
      return false;
    } finally {
      setBusy(false);
    }
  }, []);
  const openDetail = async (event: TacticEvent) => {
    setLoadingDetail(true);
    setDetail(event);
    try {
      const result = await api(`?event=${encodeURIComponent(event.id)}`);
      setDetail((current) => (current?.id === event.id ? result : current));
    } catch (e) {
      setError(e instanceof Error ? e.message : "读取详情失败");
    } finally {
      setLoadingDetail(false);
    }
  };
  return (
    <div className="min-h-screen bg-background text-foreground">
      <PageHeader
        title="战法平台"
        subtitle="收盘筛选 · 规则证据 · 短期观察池"
      />
      <main className="mx-auto max-w-[1480px] space-y-6 p-4 md:p-7">
        {(error || loadError) && (
          <div
            role="alert"
            className="rounded-xl border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-600"
          >
            {error || loadError}
          </div>
        )}
        <section className="relative overflow-hidden rounded-2xl border border-amber-500/20 bg-gradient-to-br from-amber-500/10 via-card to-card p-6 md:p-8">
          <div className="flex flex-wrap items-start justify-between gap-5">
            <div className="max-w-3xl">
              <div className="mb-3 flex items-center gap-2 text-xs font-semibold text-amber-600">
                <Target className="h-4 w-4" /> 战法 001{" "}
                <span className="rounded-full border border-amber-500/30 px-2 py-0.5">
                  沪深主板专用
                </span>
              </div>
              <h2 className="text-2xl font-bold tracking-tight md:text-3xl">
                55线突破回踩
              </h2>
              <p className="mt-3 text-sm leading-7 text-muted-foreground">
                在MA5、MA10、MA20多头排列中，筛选放量大阳突破55线的股票，跟踪随后两个交易日的缩量回踩。突破当天入池，到期自动归档。
              </p>
              <div className="mt-4 flex flex-wrap gap-2 text-xs">
                {[
                  "仅主板A股",
                  "排除ST及停牌",
                  "平台共用股池",
                  "收盘后手动运行",
                  data?.config.parameters.rule_set === "discussion_v2" ? "讨论版日线" : "原版日线",
                ].map((t) => (
                  <span
                    className="rounded-md border bg-background/70 px-2.5 py-1.5"
                    key={t}
                  >
                    {t}
                  </span>
                ))}
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                disabled={!data || !canManage || busy}
                onClick={() =>
                  data &&
                  setDraft({
                    parameters: { ...data.config.parameters },
                    version: data.config.version,
                  })
                }
              >
                <Settings2 className="mr-2 h-4 w-4" />
                公共参数
              </Button>
              <Button
                disabled={!canRun || busy || !!active}
                onClick={() => void mutate({ action: "run" })}
              >
                {busy || active ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <Play className="mr-2 h-4 w-4" />
                )}
                {active ? "筛选任务进行中" : "运行收盘筛选"}
              </Button>
              <p className="w-full text-xs leading-5 text-muted-foreground">
                {active
                  ? `任务数据日期：${active.trade_date || "核验交易日历中"}`
                  : data?.runnable_trade_date
                    ? `本次筛选数据日期：${data.runnable_trade_date}（已收盘）`
                    : "按最近已收盘交易日筛选，运行时核验交易日历。"}
                <br />
                当日15:00前使用上一交易日；跨零点仍可重试。
              </p>
            </div>
          </div>
        </section>
        <TacticReviewPanel canRun={canRun} canManage={canManage} onOpenEvent={(id) => {
          setLoadingDetail(true);
          void api(`?event=${encodeURIComponent(id)}`).then(setDetail)
            .catch((e) => setError(e instanceof Error ? e.message : "读取详情失败"))
            .finally(() => setLoadingDetail(false));
        }} />
        <ObservationGuide
          guide={data?.guide}
          canEdit={canManage}
          onSaved={() => setRefresh((v) => v + 1)}
        />
        <TacticWorkflowNotes />
        <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {[
            [
              "主板基础范围",
              data ? `${data.universe_count} 只` : "—",
              data?.universe_count
                ? "名单中还将排除ST、停牌等标的"
                : "首次运行将同步完整主板名单",
            ],
            [
              "最近发布交易日",
              data?.latest_published?.trade_date || "尚未发布",
              "可用数据参与筛选，缺口单独记录",
            ],
            [
              "本次数据进度",
              latest ? `${latest.processed} / ${latest.total}` : "尚未运行",
              latest
                ? `就绪 ${latest.ready} · 排除 ${latest.excluded} · 缺口 ${latest.gaps}`
                : "首次准备历史日K需要较长时间",
            ],
            ["观察有效期", "2 个交易日", "从突破日之后开始计算，节假日不计"],
          ].map(([title, value, help]) => (
            <div key={title} className="rounded-xl border bg-card p-5">
              <p className="text-xs text-muted-foreground">{title}</p>
              <p className="mt-2 text-xl font-bold tabular-nums">{value}</p>
              <p className="mt-2 text-xs text-muted-foreground">{help}</p>
            </div>
          ))}
        </section>
        {!!data?.latest_published?.gaps && (
          <section className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-4 text-sm">
            <p className="font-semibold">
              结果已发布，已跳过 {data.latest_published.gaps} 只数据缺失股票
            </p>
            <p className="mt-2 text-xs leading-6 text-muted-foreground">
              {data.latest_published.trade_date} · 主板范围{" "}
              {data.latest_published.total} 只， 可筛选{" "}
              {data.latest_published.ready} 只，规则排除{" "}
              {data.latest_published.excluded} 只。
              缺口股票不参与本次选股，原观察记录保留且不延长有效期。
            </p>
            <div className="mt-2 max-h-48 space-y-1 overflow-y-auto text-xs">
              {data.published_gaps?.map((gap) => (
                <p key={gap.symbol}>
                  {gap.name} {gap.symbol}：{gap.reason}
                </p>
              ))}
              {data.latest_published.gaps > 100 && (
                <p>此处展示前100只，全部原因已保存在运行记录中。</p>
              )}
            </div>
          </section>
        )}
        {data && !data.worker_online && (
          <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-4 text-sm">
            后台执行服务离线。已提交的任务会保留，服务恢复后继续执行。
          </div>
        )}
        {latest && (
          <section className="rounded-xl border bg-card p-5" aria-live="polite">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <CalendarClock className="h-4 w-4 text-primary" />
                <span className="text-sm font-semibold">
                  {latest.trade_date || latest.requested_date} ·{" "}
                  {label(latest.phase)}
                </span>
                <span className="text-xs text-muted-foreground">
                  参数 v{latest.config_version}
                </span>
              </div>
              <div className="flex items-center gap-3">
                <span className="text-xs text-muted-foreground">
                  {runLabel(latest)}
                </span>
                {active && canManage && (
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy}
                    onClick={() =>
                      void mutate({ action: "cancel", run_id: active.id })
                    }
                  >
                    停止任务
                  </Button>
                )}
              </div>
            </div>
            <div
              role="progressbar"
              aria-label="股票数据准备进度"
              aria-valuenow={latest.processed}
              aria-valuemax={Math.max(1, latest.total)}
              className="mt-4 h-1.5 overflow-hidden rounded-full bg-muted"
            >
              <div
                className="h-full bg-primary transition-all"
                style={{
                  width: `${latest.total ? (latest.processed / latest.total) * 100 : 0}%`,
                }}
              />
            </div>
            <AcquisitionStats run={latest} />
            {latest.error && (
              <p className="mt-3 break-words text-xs leading-6 text-amber-600">
                {latest.error}
                {latest.status === "waiting" &&
                  ` · 下次重试 ${new Date(latest.next_attempt_at).toLocaleTimeString("zh-CN", { timeZone: "Asia/Shanghai" })}`}
              </p>
            )}
            {latest.status === "completed" && (
              <p className="mt-3 flex items-center gap-2 text-xs text-muted-foreground">
                <CheckCircle2 className="h-4 w-4 text-emerald-500" />
                今日新突破 {latest.summary.new_breakouts ?? 0} · 今日回踩{" "}
                {latest.summary.pullbacks ?? 0} · 本次到期{" "}
                {latest.summary.expired ?? 0}
              </p>
            )}
          </section>
        )}
        <section className="overflow-hidden rounded-xl border bg-card">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b p-4">
            <div className="flex gap-1">
              {[
                ["active", "有效观察池"],
                ["today", "最近筛选结果"],
                ["history", "历史事件"],
              ].map(([key, title]) => (
                <button
                  key={key}
                  onClick={() => {
                    setView(key);
                    setPage(1);
                  }}
                  className={cn(
                    "rounded-lg px-3 py-2 text-sm transition-colors",
                    view === key
                      ? "bg-primary/10 font-semibold text-primary"
                      : "text-muted-foreground hover:bg-muted",
                  )}
                >
                  {title}
                </button>
              ))}
            </div>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setRefresh((v) => v + 1)}
            >
              <RefreshCw className="mr-2 h-3.5 w-3.5" />
              刷新
            </Button>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full whitespace-nowrap text-left text-sm">
              <thead className="bg-muted/40 text-xs text-muted-foreground">
                <tr>
                  {[
                    "股票",
                    "突破日 / 到期日",
                    "观察状态",
                    "最新日线判断",
                    "收盘 / MA55",
                    "距55线",
                    "缩量比例",
                    "",
                  ].map((v, i) => (
                    <th key={i} className="px-4 py-3 font-medium">
                      {v}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {data?.events.map((e) => (
                  <tr
                    key={e.id}
                    className="border-t transition-colors hover:bg-muted/30"
                  >
                    <td className="px-4 py-4">
                      <button
                        className="text-left"
                        onClick={() => void openDetail(e)}
                      >
                        <span className="font-semibold">{e.name}</span>
                        <span className="mt-1 block font-mono text-xs text-muted-foreground">
                          {e.symbol}
                        </span>
                      </button>
                    </td>
                    <td className="px-4 py-4 text-xs">
                      {e.breakout_date}
                      <span className="mt-1 block text-muted-foreground">
                        至 {e.expires_date} 收盘
                      </span>
                    </td>
                    <td className="px-4 py-4">
                      <span
                        className={cn(
                          "rounded-full px-2 py-1 text-xs",
                          e.display_status === "observing"
                            ? "bg-blue-500/10 text-blue-600"
                            : "bg-muted text-muted-foreground",
                        )}
                      >
                        {label(e.display_status || e.status)}
                      </span>
                    </td>
                    <td className="px-4 py-4">
                      <span
                        className={cn(
                          "text-xs",
                          e.signal === "pullback" &&
                            "font-semibold text-amber-600",
                        )}
                      >
                        {label(e.signal)}
                      </span>
                      <span className="mt-1 block text-[11px] text-muted-foreground">
                        {e.last_evaluated}
                      </span>
                    </td>
                    <td className="px-4 py-4 font-mono text-xs">
                      {number(e.evidence.current?.close)} /{" "}
                      {number(e.evidence.current?.ma55)}
                    </td>
                    <td className="px-4 py-4 font-mono text-xs">
                      {number(e.evidence.distance_pct, "%")}
                    </td>
                    <td className="px-4 py-4 font-mono text-xs">
                      {number(
                        e.evidence.contraction_ratio == null
                          ? null
                          : e.evidence.contraction_ratio * 100,
                        "%",
                      )}
                    </td>
                    <td className="px-4 py-4">
                      <Button
                        size="sm"
                        variant="ghost"
                        aria-label={`查看${e.name}证据`}
                        onClick={() => void openDetail(e)}
                      >
                        <ArrowRight className="h-4 w-4" />
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!data ? (
            <div className="p-12 text-center text-sm text-muted-foreground">
              正在读取战法平台…
            </div>
          ) : (
            !data.events.length && (
              <div className="p-14 text-center">
                <Target className="mx-auto mb-3 h-8 w-8 text-muted-foreground/40" />
                <p className="font-medium">
                  {data.latest_published
                    ? "当前没有符合此视图的观察股票"
                    : active
                      ? "正在准备首次筛选"
                      : "从第一次收盘筛选开始"}
                </p>
                <p className="mt-2 text-sm text-muted-foreground">
                  {data.latest_published
                    ? "未出现合格信号时，股池可以为空。已到期事件可在历史中查看。"
                    : active
                      ? "数据任务在后台继续，完成后发布可用股票的筛选结果，并列出缺口原因。"
                      : "点击运行后，系统将准备主板数据，并逐条核验55线条件。"}
                </p>
              </div>
            )
          )}
          <div className="flex items-center justify-between border-t px-4 py-3 text-xs text-muted-foreground">
            <span>共 {data?.total ?? 0} 个观察事件 · 每页50条</span>
            <div className="flex items-center gap-2">
              <Button
                variant="ghost"
                size="sm"
                disabled={page === 1}
                onClick={() => setPage((p) => p - 1)}
                aria-label="上一页"
              >
                <ChevronLeft className="h-4 w-4" />
              </Button>
              {page}
              <Button
                variant="ghost"
                size="sm"
                disabled={page * 50 >= (data?.total || 0)}
                onClick={() => setPage((p) => p + 1)}
                aria-label="下一页"
              >
                <ChevronRight className="h-4 w-4" />
              </Button>
            </div>
          </div>
        </section>
        {!!data?.issues.length && (
          <details className="rounded-xl border bg-card p-5">
            <summary className="cursor-pointer text-sm font-semibold">
              本次数据缺口与排除原因（最多展示100条）
            </summary>
            <div className="mt-4 grid gap-2 md:grid-cols-2">
              {data.issues.map((i) => (
                <p
                  key={i.symbol}
                  className="rounded-lg bg-muted/40 p-3 text-xs"
                >
                  <span className="font-medium">
                    {i.name} {i.symbol}
                  </span>
                  <span className="ml-2 text-muted-foreground">{i.reason}</span>
                </p>
              ))}
            </div>
          </details>
        )}
        <details className="rounded-xl border bg-card p-5">
          <summary className="cursor-pointer text-sm font-semibold">
            规则说明与运行记录
          </summary>
          <p className="mt-4 text-sm leading-7 text-muted-foreground">
            均线采用前复权日K，要求MA5 &gt; MA10 &gt;
            MA20。突破需前收盘不高于前日MA55、当日收盘高于MA55，并同时满足阳线实体和放量阈值。讨论版额外要求相对前收盘涨幅达标、三条短均线上升且间距扩大；回踩日最低价不能跌破容忍下限，收盘须站回MA55。回踩判断使用突破后的两个交易日，多头失效提前退出；重复筛选不延长有效期。阈值属于研究参数，日线筛选不确认分钟买点。
          </p>
          <div className="mt-4 space-y-2">
            {data?.runs.map((r) => (
              <div
                key={r.id}
                className="flex flex-wrap justify-between gap-2 rounded-lg bg-muted/40 px-3 py-2 text-xs"
              >
                <span>
                  {r.trade_date || r.requested_date} · {runLabel(r)} · 参数 v
                  {r.config_version}
                </span>
                <span className="text-muted-foreground">
                  就绪 {r.ready} / 排除 {r.excluded} / 缺口 {r.gaps}
                </span>
              </div>
            ))}
          </div>
        </details>
      </main>
      {draft && (
        <TacticDialog title="公共战法参数" onClose={() => setDraft(null)}>
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-bold">公共战法参数</h2>
            <Button
              variant="ghost"
              size="icon"
              aria-label="关闭参数"
              onClick={() => setDraft(null)}
            >
              <X className="h-4 w-4" />
            </Button>
          </div>
          <p className="mt-2 text-xs leading-6 text-muted-foreground">
            对所有用户生效。新运行使用新参数，已有观察事件继续沿用其入池版本。筛选范围固定为沪深主板。
          </p>
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              if (
                await mutate({
                  action: "configure",
                  parameters: draft.parameters,
                  expected_version: draft.version,
                })
              )
                setDraft(null);
            }}
            className="mt-5 space-y-4"
          >
            {error && (
              <p role="alert" className="text-sm text-red-600">
                {error}
              </p>
            )}
            <label className="flex items-center justify-between gap-3 text-sm">
              日线规则版本
              <select
                className="max-w-[65%] rounded-md border bg-background px-3 py-2"
                value={draft.parameters.rule_set || "daily_v1"}
                onChange={(e) => setDraft({ ...draft, parameters: {
                  ...draft.parameters,
                  rule_set: e.target.value as "daily_v1" | "discussion_v2",
                  ...(e.target.value === "discussion_v2" ? {
                    change_pct: draft.parameters.change_pct ?? 5,
                    distance_min_pct: -1,
                  } : {}),
                } })}
              >
                <option value="daily_v1">原版 · 日线观察</option>
                <option value="discussion_v2">讨论版 · 严格日线观察</option>
              </select>
            </label>
            {draft.parameters.rule_set === "discussion_v2" && <>
              <p className="text-xs leading-6 text-muted-foreground">
                仅落实日线条件，不包含分钟买点、大盘或机构筛选。切入讨论版时将回踩下限设为−1%，可再调整；最低价跌破下限后事件失效，收盘未站回55线不记作回踩确认。参数仍需回测验证。
              </p>
              <label className="flex items-center justify-between gap-3 text-sm">
                相对前收盘涨幅下限（%）
                <input required type="number" min={0.1} max={20} step={0.1}
                  className="w-28 rounded-md border bg-background px-3 py-2"
                  value={draft.parameters.change_pct ?? 5}
                  onChange={(e) => setDraft({ ...draft, parameters: {
                    ...draft.parameters, change_pct: e.target.valueAsNumber,
                  } })} />
              </label>
            </>}
            {parameterFields.map((f) => (
              <label
                key={f.key}
                className="flex items-center justify-between gap-3 text-sm"
              >
                {f.label}
                <input
                  required
                  type="number"
                  className="w-28 rounded-md border bg-background px-3 py-2"
                  min={f.min}
                  max={f.max}
                  step={f.step}
                  value={draft.parameters[f.key]}
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      parameters: {
                        ...draft.parameters,
                        [f.key]: e.target.valueAsNumber,
                      },
                    })
                  }
                />
              </label>
            ))}
            <Button type="submit" className="w-full" disabled={busy}>
              保存为新版本
            </Button>
          </form>
        </TacticDialog>
      )}
      {detail && (
        <TacticDialog title="战法证据" onClose={() => setDetail(null)} wide>
          <div className="mb-5 flex items-center justify-between gap-3">
            <div>
              <h2 className="text-lg font-bold">
                {detail.name}{" "}
                <span className="font-mono text-sm text-muted-foreground">
                  {detail.symbol}
                </span>
              </h2>
              <p className="mt-1 text-xs text-muted-foreground">
                突破 {detail.breakout_date} · 到期 {detail.expires_date} 收盘 ·
                参数 v{detail.config_version} · {detail.parameters.rule_set === "discussion_v2" ? "讨论版日线" : "原版日线"}
              </p>
            </div>
            <Button
              variant="ghost"
              size="icon"
              aria-label="关闭证据"
              onClick={() => setDetail(null)}
            >
              <X className="h-4 w-4" />
            </Button>
          </div>
          {loadingDetail ? (
            <p className="p-10 text-center">读取运行证据…</p>
          ) : (
            <>
              <TacticChartPanel key={detail.id} event={detail} />
              <div className="mt-5 flex flex-wrap gap-3 text-sm">
                <span>突破涨幅（前收盘）：{number(detail.evidence.breakout.change_pct, "%")}</span>
                <span>
                  突破实体：
                  {number(
                    detail.evidence.breakout.open &&
                      detail.evidence.breakout.close
                      ? (detail.evidence.breakout.close /
                          detail.evidence.breakout.open -
                          1) *
                          100
                      : null,
                    "%",
                  )}
                </span>
                <span>
                  突破量比：
                  {number(
                    detail.evidence.breakout.prior_v5
                      ? (detail.evidence.breakout.volume || 0) /
                          detail.evidence.breakout.prior_v5
                      : null,
                  )}
                </span>
              </div>
              <div className="mt-5 space-y-2">
                {detail.evaluations?.map((e) => (
                  <p
                    key={e.trade_date}
                    className="rounded-lg bg-muted/40 p-3 text-sm"
                  >
                    {e.trade_date} · {label(e.signal)} · {label(e.status)}
                  </p>
                ))}
              </div>
            </>
          )}
        </TacticDialog>
      )}
    </div>
  );
}
