"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import type {
  ReportDetail,
  ReviewDashboard,
  ReviewMutation,
} from "@/lib/quant/tactic-review-types";

const titles = {
  pool: "B 池复盘",
  stats: "胜率统计",
  reports: "战法日报",
  knowledge: "日报知识库",
  prompt: "提示词与日程",
};
type Tab = keyof typeof titles;
const statusLabels: Record<string, string> = {
  ready: "已评估",
  gap: "数据缺失",
  pending: "待到期",
  suspended: "停牌",
  tracked: "实际跟踪",
  retrospective: "事后识别",
  unknown: "时间未知",
  all: "全部来源",
  queued: "等待执行",
  running: "执行中",
  waiting: "等待重试",
  completed: "已完成",
  failed: "失败",
  pullback: "缩量回踩",
  trend_invalid: "趋势失效",
  support_broken: "回踩跌破容忍下限",
  below_support: "收盘未收回55线",
  is_st: "ST失效",
  delisted: "不再属于在市主板",
  outside_band: "未进入回踩区间",
  not_contracted: "尚未缩量",
  insufficient: "不可判断",
};
const num = (v: number | null | undefined, unit = "") =>
  v == null ? "—" : `${v.toFixed(2)}${unit}`;
const inputClass = "rounded-md border bg-background px-3 py-2 text-sm";
async function request(
  query = "",
  body?: ReviewMutation,
  signal?: AbortSignal,
) {
  const res = await fetch(`/api/quant/tactics/reviews${query}`, {
    method: body ? "POST" : "GET",
    headers: { "Content-Type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal,
  });
  const result = await res.json();
  if (!res.ok) throw new Error(result.message || "读取复盘数据失败");
  return result.data;
}

export default function TacticReviewPanel({
  canRun,
  canManage,
  onOpenEvent,
}: {
  canRun: boolean;
  canManage: boolean;
  onOpenEvent: (id: string) => void;
}) {
  const [tab, setTab] = useState<Tab>("pool");
  const [data, setData] = useState<ReviewDashboard | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [day, setDay] = useState("");
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [origin, setOrigin] = useState("tracked");
  const [version, setVersion] = useState("");
  const [search, setSearch] = useState("");
  const [refresh, setRefresh] = useState(0);
  const [draft, setDraft] = useState<{
    content: string;
    version: number;
  } | null>(null);
  const [report, setReport] = useState<ReportDetail | null>(null);
  const reportRequest = useRef(0);
  const [reportLoading, setReportLoading] = useState(false);
  const [schedule, setSchedule] = useState<{
    enabled: boolean;
    start_time: string;
    version: number;
  } | null>(null);
  const latestPrompt = data?.prompts[0];
  useEffect(() => {
    const controller = new AbortController();
    const query = new URLSearchParams({ origin, search });
    for (const [key, value] of Object.entries({ day, start, end, version }))
      if (value) query.set(key, value);
    let timer: ReturnType<typeof setTimeout>;
    async function load() {
      try {
        const value = (await request(
          `?${query}`,
          undefined,
          controller.signal,
        )) as ReviewDashboard;
        if (controller.signal.aborted) return;
        setData(value);
        setError("");
      } catch (e) {
        if (!controller.signal.aborted)
          setError(e instanceof Error ? e.message : "加载失败");
      } finally {
        if (!controller.signal.aborted) timer = setTimeout(load, 15000);
      }
    }
    void load();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [day, start, end, origin, version, search, refresh]);

  const mutate = useCallback(async (body: ReviewMutation) => {
    setBusy(true);
    setNotice("");
    setError("");
    try {
      await request("", body);
      setRefresh((x) => x + 1);
      setNotice(
        ["run", "regenerate"].includes(body.action)
          ? "任务已提交，关闭页面后后台仍会继续。"
          : "已保存。",
      );
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : "保存失败");
      return false;
    } finally {
      setBusy(false);
    }
  }, []);
  async function openReport(id: string) {
    const sequence = ++reportRequest.current;
    setReportLoading(true);
    try {
      const value = (await request(
        `?report=${encodeURIComponent(id)}`,
      )) as ReportDetail;
      if (sequence === reportRequest.current) {
        setReport(value);
        setTab("reports");
      }
    } catch (e) {
      if (sequence === reportRequest.current)
        setError(e instanceof Error ? e.message : "日报读取失败");
    } finally {
      if (sequence === reportRequest.current) setReportLoading(false);
    }
  }
  return (
    <section
      className="rounded-2xl border bg-card p-4 md:p-6"
      aria-label="收盘复盘与日报"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-xl font-bold">收盘复盘与日报</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            跟踪 B+1 / B+2 选股表现，积累可追溯的战法研究。
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={() => setRefresh((v) => v + 1)}>
            刷新
          </Button>
          {canRun && (
            <Button
              disabled={busy}
              onClick={() =>
                void mutate({ action: "run", ...(day ? { day } : {}) })
              }
            >
              运行收盘复盘
            </Button>
          )}
        </div>
      </div>
      <div
        className="my-4 flex flex-wrap gap-2"
        role="tablist"
        aria-label="复盘栏目"
      >
        {Object.entries(titles).map(([key, title]) => (
          <button
            key={key}
            role="tab"
            aria-selected={tab === key}
            onClick={() => setTab(key as Tab)}
            className={`rounded-lg px-3 py-2 text-sm ${tab === key ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground"}`}
          >
            {title}
          </button>
        ))}
      </div>
      {error && (
        <p role="alert" className="my-3 text-sm text-red-600">
          {error}
          {draft ? "（编辑草稿已保留）" : ""}
        </p>
      )}
      {notice && (
        <p role="status" className="my-3 text-sm text-emerald-600">
          {notice}
        </p>
      )}
      {!data ? (
        <p className="py-6 text-muted-foreground">
          {error ? "请检查复盘服务与数据库迁移。" : "正在读取收盘复盘…"}
        </p>
      ) : (
        <>
          <div className="mb-4 flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
            <span>
              自动流程：
              {data.settings.enabled
                ? `交易日 ${data.settings.start_time}（上海）`
                : "已暂停"}
            </span>
            <span>DS V4.1 Flash · max</span>
            <span>业务提示词 v{latestPrompt?.version}</span>
          </div>
          {tab === "pool" && (
            <>
              <label className="mb-4 flex items-center gap-2 text-sm">
                复盘日期
                <input
                  aria-label="复盘日期"
                  type="date"
                  className={inputClass}
                  value={day || data.trade_date}
                  onChange={(e) => setDay(e.target.value)}
                />
              </label>
              <div className="overflow-x-auto">
                <table className="w-full whitespace-nowrap text-left text-sm">
                  <thead>
                    <tr className="border-b text-xs text-muted-foreground">
                      {[
                        "股票 / 来源",
                        "突破日 / 阶段",
                        "可比参考价 / 收盘价",
                        "相对 B 日",
                        "窗口最高 / 最低",
                        "收盘条件 / 首次满足",
                        "评估状态",
                      ].map((t) => (
                        <th className="p-3" key={t}>
                          {t}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {data.rows.map((r) => (
                      <tr key={r.event_id} className="border-b">
                        <td className="p-3">
                          <button
                            className="font-semibold text-primary"
                            onClick={() => onOpenEvent(r.event_id)}
                          >
                            {r.name} {r.symbol}
                          </button>
                          <div className="text-xs text-muted-foreground">
                            {statusLabels[r.origin]} · 参数 v{r.config_version}
                          </div>
                        </td>
                        <td className="p-3">
                          {r.breakout_date}
                          <div>B+{r.horizon}</div>
                        </td>
                        <td className="p-3">
                          {num(r.reference_price)} / {num(r.close)}
                        </td>
                        <td
                          className={`p-3 font-mono ${(r.return_pct || 0) > 0 ? "text-red-600" : (r.return_pct || 0) < 0 ? "text-emerald-600" : ""}`}
                        >
                          {num(r.return_pct, "%")}
                        </td>
                        <td className="p-3">
                          {num(r.high_pct, "%")} / {num(r.low_pct, "%")}
                        </td>
                        <td className="p-3">
                          {statusLabels[r.signal] || r.signal}
                          <div className="text-xs text-muted-foreground">
                            {r.first_pullback_date || "尚未满足"}
                          </div>
                        </td>
                        <td className="p-3" title={r.reason}>
                          {statusLabels[r.status]}
                          <div className="text-xs text-muted-foreground">
                            {r.reason}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {!data.rows.length && (
                <p className="py-8 text-center text-muted-foreground">
                  该日暂无复盘记录。运行收盘复盘后将补齐已有事件的表现。
                </p>
              )}
              <p className="mt-3 text-xs text-muted-foreground">
                参考价与收盘价采用同源前复权口径。满足回踩条件不代表已买入；提前失效的样本仍保留。
              </p>
            </>
          )}
          {tab === "stats" && (
            <>
              <div className="mb-4 flex flex-wrap items-end gap-3">
                <label className="text-xs">
                  突破起始日
                  <input
                    aria-label="突破起始日"
                    type="date"
                    value={start || data.start}
                    onChange={(e) => setStart(e.target.value)}
                    className={`${inputClass} mt-1 block`}
                  />
                </label>
                <label className="text-xs">
                  突破结束日
                  <input
                    aria-label="突破结束日"
                    type="date"
                    value={end || data.end}
                    onChange={(e) => setEnd(e.target.value)}
                    className={`${inputClass} mt-1 block`}
                  />
                </label>
                <select
                  aria-label="样本来源"
                  className={inputClass}
                  value={origin}
                  onChange={(e) => setOrigin(e.target.value)}
                >
                  {["tracked", "retrospective", "unknown", "all"].map((v) => (
                    <option key={v} value={v}>
                      {statusLabels[v]}
                    </option>
                  ))}
                </select>
                <select
                  aria-label="参数版本"
                  className={inputClass}
                  value={version}
                  onChange={(e) => setVersion(e.target.value)}
                >
                  <option value="">全部参数版本</option>
                  {data.versions.map((v) => (
                    <option key={v} value={v}>
                      参数 v{v}
                    </option>
                  ))}
                </select>
              </div>
              <p className="mb-4 text-sm text-muted-foreground">
                共 {data.sample_count}{" "}
                个独立事件。上涨计胜，持平计入分母；价格变化是选股表现，不是实际交易收益。
              </p>
              <div className="grid gap-4 md:grid-cols-2">
                {data.statistics.map((s) => (
                  <article
                    key={s.horizon}
                    className="rounded-xl border bg-background p-5"
                  >
                    <h3 className="font-semibold">
                      B+{s.horizon} 收盘上涨比例
                      {s.horizon === 2 ? " · 主指标" : ""}
                    </h3>
                    <p className="my-3 text-3xl font-bold">
                      {s.win_rate == null
                        ? "暂无有效样本"
                        : num(s.win_rate, "%")}
                    </p>
                    <p className="text-sm">
                      {s.wins} / {s.valid} 有效样本 · 下跌 {s.losses} · 持平{" "}
                      {s.flat}
                    </p>
                    <dl className="mt-4 grid grid-cols-2 gap-3 text-sm">
                      {[
                        ["平均涨跌幅", num(s.mean, "%")],
                        ["中位数", num(s.median, "%")],
                        ["上涨样本均值", num(s.mean_win, "%")],
                        ["下跌样本均值", num(s.mean_loss, "%")],
                      ].map(([label, value]) => (
                        <div key={label}>
                          <dt className="text-muted-foreground">{label}</dt>
                          <dd className="font-mono">{value}</dd>
                        </div>
                      ))}
                    </dl>
                    <p className="mt-4 text-xs text-muted-foreground">
                      未纳入：待到期 {s.pending} · 停牌 {s.suspended} · 缺数据{" "}
                      {s.gaps}
                    </p>
                  </article>
                ))}
              </div>
            </>
          )}
          {(tab === "reports" || tab === "knowledge") && (
            <>
              <div className="mb-4 flex flex-wrap items-center gap-3">
                <input
                  aria-label="搜索日报"
                  placeholder="搜索日报与历史建议"
                  className={inputClass}
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
                {canRun && (
                  <Button
                    variant="outline"
                    disabled={busy}
                    onClick={() =>
                      void mutate({
                        action: "regenerate",
                        day: day || data.trade_date,
                      })
                    }
                  >
                    重新生成 {day || data.trade_date} 日报
                  </Button>
                )}
              </div>
              {reportLoading && <p role="status">正在读取日报…</p>}
              {report && tab === "reports" && (
                <article className="mb-5 rounded-xl border bg-background p-4 md:p-6">
                  <div className="flex justify-between gap-3">
                    <h3 className="text-lg font-bold">
                      {report.trade_date} 战法日报 · 版本 {report.revision}
                    </h3>
                    <Button
                      variant="ghost"
                      onClick={() => {
                        reportRequest.current++;
                        setReport(null);
                      }}
                    >
                      关闭
                    </Button>
                  </div>
                  <p className="mt-2 text-xs text-muted-foreground">
                    {report.model} · {report.effort} · 提示词 v
                    {report.prompt_version} · {num(report.duration_seconds)} 秒
                  </p>
                  <p className="my-4 leading-7">{report.summary}</p>
                  {report.content.sections.map((s, i) => (
                    <section key={i} className="my-5">
                      <h4 className="font-semibold">{s.title}</h4>
                      <p className="mt-2 whitespace-pre-wrap break-words text-sm leading-7">
                        {s.content}
                      </p>
                      <div className="mt-2 flex flex-wrap gap-2 text-xs">
                        {s.event_ids.map((id) => (
                          <button
                            key={id}
                            className="text-primary underline"
                            onClick={() => onOpenEvent(id)}
                          >
                            查看股票证据
                          </button>
                        ))}
                        {s.citations.map((id) => {
                          const ref = report.input.knowledge.find(
                            (k) => k.id === id,
                          );
                          return ref ? (
                            <button
                              key={id}
                              className="text-primary underline"
                              onClick={() => void openReport(ref.report_id)}
                            >
                              历史引用 {ref.trade_date}
                            </button>
                          ) : (
                            <span key={id} className="text-muted-foreground">
                              {id}
                            </span>
                          );
                        })}
                      </div>
                    </section>
                  ))}
                  <details className="mt-4 rounded-lg border p-3">
                    <summary className="cursor-pointer text-sm">
                      本次生成依据：提示词、行情快照与历史知识
                    </summary>
                    {report.input.knowledge.map((k) => (
                      <div key={k.id} className="my-3 border-b pb-3 text-sm">
                        <button
                          className="text-primary underline"
                          onClick={() => void openReport(k.report_id)}
                        >
                          {k.trade_date} · {k.reason}
                        </button>
                        <p className="whitespace-pre-wrap">{k.content}</p>
                      </div>
                    ))}
                    {!report.input.knowledge.length && (
                      <p className="my-3 text-sm">本次没有可用的历史日报。</p>
                    )}
                    <pre className="mt-3 max-h-96 overflow-auto whitespace-pre-wrap break-all rounded bg-muted p-3 text-xs">
                      {JSON.stringify(report.messages, null, 2)}
                    </pre>
                  </details>
                </article>
              )}
              <div className="grid gap-3 md:grid-cols-2">
                {data.reports.map((r) => (
                  <article key={r.id} className="rounded-xl border p-4">
                    <button
                      className="font-semibold text-primary"
                      onClick={() => void openReport(r.id)}
                    >
                      {r.trade_date} 日报 · v{r.revision}
                    </button>
                    <p className="my-2 line-clamp-3 text-sm leading-6 text-muted-foreground">
                      {r.summary}
                    </p>
                    <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                      <span>
                        {r.knowledge_enabled
                          ? "允许知识引用（按版本及时间筛选）"
                          : "已停用知识引用"}
                      </span>
                      {canManage && (
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={busy}
                          onClick={() =>
                            void mutate({
                              action: "knowledge",
                              report_id: r.id,
                              enabled: !r.knowledge_enabled,
                            })
                          }
                        >
                          {r.knowledge_enabled ? "不再引用" : "恢复引用"}
                        </Button>
                      )}
                    </div>
                  </article>
                ))}
              </div>
              {!data.reports.length && (
                <p className="py-8 text-center text-muted-foreground">
                  暂无匹配日报。完成收盘复盘后将自动生成并保存。
                </p>
              )}
            </>
          )}
          {tab === "prompt" && (
            <div className="space-y-5">
              <div className="rounded-xl border p-4">
                <h3 className="font-semibold">自动日程</h3>
                <p className="my-2 text-sm text-muted-foreground">
                  每个交易日依次筛选、更新表现、生成日报。数据缺口重试至 22:00。
                </p>
                <div className="flex flex-wrap items-center gap-3">
                  <label className="flex gap-2 text-sm">
                    <input
                      type="checkbox"
                      disabled={!canManage || busy}
                      checked={(schedule || data.settings).enabled}
                      onChange={(e) =>
                        setSchedule({
                          ...(schedule || data.settings),
                          enabled: e.target.checked,
                        })
                      }
                    />
                    启用自动流程
                  </label>
                  <input
                    aria-label="自动运行时间"
                    type="time"
                    min="15:00"
                    max="21:59"
                    className={inputClass}
                    disabled={!canManage || busy}
                    value={(schedule || data.settings).start_time}
                    onChange={(e) =>
                      setSchedule({
                        ...(schedule || data.settings),
                        start_time: e.target.value,
                      })
                    }
                  />
                  {canManage && (
                    <Button
                      disabled={!schedule || busy}
                      onClick={async () => {
                        if (
                          schedule &&
                          (await mutate({
                            action: "schedule",
                            enabled: schedule.enabled,
                            start_time: schedule.start_time,
                            expected_version: schedule.version,
                          }))
                        )
                          setSchedule(null);
                      }}
                    >
                      保存日程
                    </Button>
                  )}
                </div>
              </div>
              <div className="rounded-xl border p-4">
                <div className="flex items-center justify-between">
                  <h3 className="font-semibold">
                    业务分析提示词 · v{latestPrompt?.version}
                  </h3>
                  {canManage && !draft && latestPrompt && (
                    <Button
                      variant="outline"
                      onClick={() =>
                        setDraft({
                          content: latestPrompt.content,
                          version: latestPrompt.version,
                        })
                      }
                    >
                      编辑提示词
                    </Button>
                  )}
                </div>
                {draft ? (
                  <>
                    <textarea
                      aria-label="业务分析提示词"
                      className="mt-4 min-h-72 w-full rounded-lg border bg-background p-3 text-sm leading-7"
                      maxLength={20000}
                      value={draft.content}
                      onChange={(e) =>
                        setDraft({ ...draft, content: e.target.value })
                      }
                    />
                    <div className="mt-3 flex gap-3">
                      <Button
                        disabled={busy || !draft.content.trim()}
                        onClick={async () => {
                          if (
                            await mutate({
                              action: "prompt",
                              content: draft.content,
                              expected_version: draft.version,
                            })
                          )
                            setDraft(null);
                        }}
                      >
                        保存新版本
                      </Button>
                      <Button
                        variant="ghost"
                        disabled={busy}
                        onClick={() => setDraft(null)}
                      >
                        取消
                      </Button>
                    </div>
                  </>
                ) : (
                  <p className="mt-3 whitespace-pre-wrap text-sm leading-7">
                    {latestPrompt?.content}
                  </p>
                )}
                <p className="mt-3 text-xs text-muted-foreground">
                  保存后用于新建日报任务，已运行任务与旧日报保留原提示词。
                </p>
                <details className="mt-4">
                  <summary className="cursor-pointer text-sm">
                    历史提示词版本
                  </summary>
                  {data.prompts.map((p) => (
                    <div key={p.version} className="my-3 rounded border p-3">
                      <p className="text-xs text-muted-foreground">
                        v{p.version} · {p.actor} · {p.created_at}
                      </p>
                      <p className="my-2 whitespace-pre-wrap text-sm">
                        {p.content}
                      </p>
                      {canManage && latestPrompt && (
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={busy}
                          onClick={() =>
                            setDraft({
                              content: p.content,
                              version: latestPrompt.version,
                            })
                          }
                        >
                          以此版本恢复到编辑器
                        </Button>
                      )}
                    </div>
                  ))}
                </details>
              </div>
              <details className="rounded-xl border p-4">
                <summary className="cursor-pointer font-semibold">
                  固定系统约束（只读）
                </summary>
                <p className="mt-3 whitespace-pre-wrap text-sm leading-7">
                  {data.system_prompt}
                </p>
              </details>
            </div>
          )}
          <details className="mt-5 border-t pt-3">
            <summary className="cursor-pointer text-xs text-muted-foreground">
              最近执行记录
            </summary>
            <div className="mt-2 space-y-2">
              {data.jobs.map((j) => (
                <div key={j.id} className="flex flex-wrap gap-3 text-xs">
                  <span>{j.trade_date}</span>
                  <span>{j.kind === "review" ? "收盘复盘" : "日报生成"}</span>
                  <span>{statusLabels[j.status]}</span>
                  {j.error && <span className="text-red-600">{j.error}</span>}
                </div>
              ))}
            </div>
          </details>
        </>
      )}
    </section>
  );
}
