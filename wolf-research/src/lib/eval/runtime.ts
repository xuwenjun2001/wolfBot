import fs from 'fs/promises';
import path from 'path';
import { createHash } from 'node:crypto';
import { spawn, type ChildProcess } from 'child_process';
import { prisma } from '@/lib/db/client';
import { buildModelComparison, buildSkillVersionImpact } from './analysis';
import { evaluateEvalJudgeCalibration, type EvalJudgeCalibrationSample } from './judge-calibration';
import { getQuantEvalCases, getQuantEvalSets } from './cases';
import { getEvalEvaluatorDefinition } from './evaluators';
import {
  DEFAULT_EVAL_CONCURRENCY,
  DEFAULT_EVALUATOR_ID,
  EVAL_CAPABILITY_LABELS,
  EVAL_RUNTIME_OPTIONS,
  EVAL_TYPE_LABELS,
  MAX_EVAL_CONCURRENCY,
} from './constants';
import {
  CASES_PATH,
  LOG_DIR,
  REPORTS_DIR,
  ROOT,
} from './paths';
import type {
  EvalCheckStatus,
  QuantEvalArtifactSummary,
  QuantEvalCase,
  QuantEvalCheck,
  QuantEvalDashboardData,
  QuantEvalFlowSimulation,
  QuantEvalFlowStep,
  QuantEvalQueueItem,
  QuantEvalQueueStatus,
  QuantEvalRepairTicket,
  QuantEvalResult,
  QuantEvalRun,
  QuantEvalScheduleConfig,
  StartQuantEvalOptions,
  UpdateQuantEvalScheduleInput,
} from './types';
import {
  booleanValue,
  dateOrNow,
  isRecord,
  jsonArray,
  jsonObject,
  numberValue,
  readJson,
  readRecordArray,
  stringArray,
  stringValue,
  toDate,
  uniqueId,
  type JsonRecord,
} from './runtime-utils';
import { defaultScheduleConfig } from './schedule-defaults';
import { EvalStorageError } from '@/lib/ports/eval-repository';
import {
  mapDbEvalRun,
  mapDbQueueItem,
  mapDbRepairTicket,
  normalizeRun,
} from './runtime-mappers';

export {
  createQuantEvalCase,
  createQuantEvalSet,
  getQuantEvalCases,
  getQuantEvalSets,
} from './cases';

let queueKickoffInProgress = false;
const runningChildren = new Map<string, ChildProcess>();
const EVAL_CLI = 'pi';

export class EvalArtifactError extends Error {
  readonly code = 'EVAL_REPORT_UNAVAILABLE';
  readonly status = 502;

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'EvalArtifactError';
  }
}

export class EvalScheduleNotConfiguredError extends Error {
  readonly code = 'EVAL_SCHEDULE_NOT_CONFIGURED';
  readonly status = 501;

  constructor() {
    super('自动评测 schedule 尚未接入独立 worker；请手动发起 contract 或 E2E 评测。');
    this.name = 'EvalScheduleNotConfiguredError';
  }
}

function normalizeExecutionMode(value: unknown): QuantEvalQueueItem['mode'] {
  return value === 'e2e' ? 'e2e' : 'contract';
}

function supportsReasoningEffort(cli: string | null | undefined): boolean {
  return EVAL_RUNTIME_OPTIONS.some((option) => option.cli === cli && option.supportsReasoningEffort);
}

function normalizeEvalConcurrency(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return DEFAULT_EVAL_CONCURRENCY;
  }
  return Math.min(MAX_EVAL_CONCURRENCY, Math.max(1, Math.floor(value)));
}

function normalizeEvalRepeat(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed)) return 1;
  return Math.min(5, Math.max(1, Math.floor(parsed)));
}

async function writeEvalRunToDatabase(run: QuantEvalRun, reportSha256: string | null = null): Promise<void> {
  try {
    await prisma.evalRun.upsert({
    where: { id: run.id },
    update: {
      fileName: run.fileName,
      filePath: run.filePath,
      reportCreatedAt: dateOrNow(run.createdAt),
      mtimeMs: run.mtimeMs,
      passed: run.passed,
      total: run.total,
      passedCount: run.passedCount,
      failedCount: run.failedCount,
      passRate: run.passRate,
      averageScore: run.averageScore,
      durationMs: run.durationMs,
      reportSha256,
      metadata: jsonObject(run.metadata),
      coverage: jsonObject(run.coverage),
      results: jsonArray(run.results),
    },
    create: {
      id: run.id,
      fileName: run.fileName,
      filePath: run.filePath,
      reportCreatedAt: dateOrNow(run.createdAt),
      mtimeMs: run.mtimeMs,
      passed: run.passed,
      total: run.total,
      passedCount: run.passedCount,
      failedCount: run.failedCount,
      passRate: run.passRate,
      averageScore: run.averageScore,
      durationMs: run.durationMs,
      reportSha256,
      metadata: jsonObject(run.metadata),
      coverage: jsonObject(run.coverage),
      results: jsonArray(run.results),
    },
    });
  } catch (error) {
    throw new EvalStorageError(`写入评测运行记录失败：${run.id}。`, { cause: error });
  }
}

async function listEvalRunsFromDatabase(limit: number): Promise<QuantEvalRun[]> {
  try {
    const records = await prisma.evalRun.findMany({
      orderBy: { reportCreatedAt: 'desc' },
      take: limit,
    });
    return records.map(mapDbEvalRun);
  } catch (error) {
    throw new EvalStorageError('读取评测运行记录失败。', { cause: error });
  }
}

async function readQueue(): Promise<QuantEvalQueueItem[]> {
  try {
    const items = await prisma.evalQueueItem.findMany({
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    return items.map(mapDbQueueItem);
  } catch (error) {
    throw new EvalStorageError('读取评测队列失败。', { cause: error });
  }
}

async function writeQueue(items: QuantEvalQueueItem[]): Promise<void> {
  const limited = items.slice(0, 80);
  try {
    await prisma.$transaction(limited.map((item) => {
      const data = {
        status: item.status,
        cli: item.cli,
        model: item.model,
        reasoningEffort: item.reasoningEffort,
        evaluatorId: item.evaluatorId,
        concurrency: item.concurrency,
        repeat: item.repeat,
        mode: item.mode,
        selectedCases: jsonArray(item.selectedCases),
        limit: item.limit,
        keepProjects: item.keepProjects,
        reportId: item.reportId,
        reportPath: item.reportPath,
        logPath: item.logPath,
        pid: item.pid,
        exitCode: item.exitCode,
        error: item.error,
        createdAt: dateOrNow(item.createdAt),
        startedAt: toDate(item.startedAt),
        finishedAt: toDate(item.finishedAt),
      };
      return prisma.evalQueueItem.upsert({
        where: { id: item.id },
        update: data,
        create: { id: item.id, ...data },
      });
    }));
  } catch (error) {
    throw new EvalStorageError('写入评测队列失败。', { cause: error });
  }
}

function buildVirtualQueueItem(options: StartQuantEvalOptions = {}): QuantEvalQueueItem {
  const selectedCases = Array.isArray(options.selectedCases)
    ? options.selectedCases.map(String).filter(Boolean)
    : [];
  const limit =
    typeof options.limit === 'number' && Number.isFinite(options.limit) && options.limit > 0
      ? Math.floor(options.limit)
      : null;
  const mode = normalizeExecutionMode(options.mode);
  const requestedEvaluatorId = stringValue(options.evaluatorId, DEFAULT_EVALUATOR_ID).trim() || DEFAULT_EVALUATOR_ID;
  const evaluator = getEvalEvaluatorDefinition(requestedEvaluatorId);
  if (!evaluator.supportedModes.includes(mode)) {
    throw new Error(`${evaluator.id} 不支持 ${mode} 模式。`);
  }
  const requestedCli = stringValue(options.cli, EVAL_CLI).trim() || EVAL_CLI;
  const runtime = EVAL_RUNTIME_OPTIONS.find((candidate) => candidate.cli === requestedCli);
  if (!runtime) {
    throw new Error(`未注册评测运行器：${requestedCli}。`);
  }
  const requestedModel = stringValue(options.model, runtime.defaultModel).trim() || runtime.defaultModel;
  const model = runtime.models.find((candidate) => candidate.id === requestedModel);
  if (!model) {
    throw new Error(`运行器 ${runtime.cli} 未注册评测模型：${requestedModel}。`);
  }

  return {
    id: 'eval-run-simulation',
    status: 'queued',
    createdAt: new Date().toISOString(),
    startedAt: null,
    finishedAt: null,
    cli: runtime.cli,
    model: model.id,
    reasoningEffort: supportsReasoningEffort(runtime.cli)
      ? stringValue(options.reasoningEffort).trim()
      : '',
    evaluatorId: evaluator.id,
    concurrency: normalizeEvalConcurrency(options.concurrency),
    repeat: normalizeEvalRepeat(options.repeat),
    mode,
    selectedCases,
    limit,
    keepProjects: Boolean(options.keepProjects),
    reportId: uniqueId('report'),
    reportPath: null,
    logPath: null,
    pid: null,
    exitCode: null,
    error: null,
  };
}

async function updateQueueItem(id: string, patch: Partial<QuantEvalQueueItem>): Promise<QuantEvalQueueItem | null> {
  const queue = await readQueue();
  const index = queue.findIndex((item) => item.id === id);
  if (index < 0) return null;
  queue[index] = { ...queue[index], ...patch };
  await writeQueue(queue);
  return queue[index];
}

async function readRepairTickets(): Promise<QuantEvalRepairTicket[]> {
  try {
    const records = await prisma.evalRepairTicket.findMany({ orderBy: { createdAt: 'desc' } });
    return records.map(mapDbRepairTicket);
  } catch (error) {
    throw new EvalStorageError('读取评测修复单失败。', { cause: error });
  }
}

async function writeRepairTickets(items: QuantEvalRepairTicket[]): Promise<void> {
  const limited = items.slice(0, 200);
  try {
    await prisma.$transaction(limited.map((item) => {
      const data = {
        runId: item.runId,
        caseId: item.caseId,
        title: item.title,
        status: item.status,
        severity: item.severity,
        model: item.model,
        reportPath: item.reportPath,
        projectId: item.projectId,
        failures: jsonArray(item.failures),
        validationSummaries: jsonArray(item.validationSummaries),
        suggestedActions: jsonArray(item.suggestedActions),
        skillVersions: jsonObject(item.skillVersions),
        createdAt: dateOrNow(item.createdAt),
        updatedAt: dateOrNow(item.updatedAt),
      };
      return prisma.evalRepairTicket.upsert({
        where: { id: item.id },
        update: data,
        create: { id: item.id, ...data },
      });
    }));
  } catch (error) {
    throw new EvalStorageError('写入评测修复单失败。', { cause: error });
  }
}

function suggestedActionsForResult(result: QuantEvalResult): string[] {
  const actions = new Set<string>();
  result.validationChecks.forEach((check) => {
    if (check.status !== 'failed') return;
    if (check.id.includes('build')) actions.add('检查生成项目依赖和 Next.js build 输出，优先修复编译错误。');
    if (check.id.includes('chart')) actions.add('检查可视化模板是否生成 K 线、成交量或场景化图表容器。');
    if (check.id.includes('market')) actions.add('确认 /api/market 同源代理和后端 8001 数据服务可用。');
    if (check.id.includes('artifact')) actions.add('清理外部 CDN、mock 数据、明文密钥和非标准数据绑定。');
    if (check.id.includes('data')) actions.add('检查 data_file/final/dashboard-data.json、evidence/sources.json 和 data_quality.json。');
  });
  if (result.eventAudit?.errorCount) {
    actions.add('检查 .data-agent/events.jsonl 中 error 事件，补齐阶段化执行事件。');
  }
  if (!actions.size) {
    actions.add('查看失败用例的 failures 和 validation checks，定位生成链路的第一个失败点。');
  }
  return Array.from(actions);
}

async function createRepairTicketsForRun(run: QuantEvalRun): Promise<QuantEvalRepairTicket[]> {
  if (run.passed) return readRepairTickets();
  const existing = await readRepairTickets();
  const existingKeys = new Set(existing.map((ticket) => `${ticket.runId}:${ticket.caseId}`));
  const skillVersions = Object.fromEntries(
    Object.entries(run.metadata.skillLockSnapshot.skills).map(([skillId, entry]) => [skillId, entry.version])
  );
  const createdAt = new Date().toISOString();
  const newTickets = run.results
    .filter((result) => !result.passed)
    .filter((result) => !existingKeys.has(`${run.id}:${result.id}`))
    .map((result): QuantEvalRepairTicket => ({
      id: uniqueId('repair'),
      runId: run.id,
      caseId: result.id,
      title: `${result.name} 回归失败`,
      status: 'open',
      severity: result.validationChecks.some((check) => check.status === 'failed') ? 'high' : 'medium',
      createdAt,
      updatedAt: createdAt,
      model: `${run.metadata.runtime.cli ?? '-'} / ${run.metadata.runtime.model ?? '-'}`,
      reportPath: run.filePath,
      projectId: result.projectId,
      failures: result.failures,
      validationSummaries: result.validationChecks
        .filter((check) => check.status !== 'passed')
        .map((check) => `${check.name || check.id}: ${check.summary}`),
      suggestedActions: suggestedActionsForResult(result),
      skillVersions,
    }));
  if (!newTickets.length) return existing;
  const merged = [...newTickets, ...existing];
  await writeRepairTickets(merged);
  return merged;
}

function readScheduleConfig(): QuantEvalScheduleConfig {
  return defaultScheduleConfig();
}

function buildBenchmarkArgs(item: QuantEvalQueueItem): string[] {
  if (!item.reportId) {
    throw new Error(`评测队列任务 ${item.id} 缺少预分配 reportId。`);
  }
  const args = [
    'scripts/evals/run-quant-benchmarks.js',
    '--trigger=eval-backend',
    '--queue-id', item.id,
    '--report-id', item.reportId,
    `--evaluator=${item.evaluatorId}`,
    `--concurrency=${item.concurrency}`,
    `--repeat=${item.repeat}`,
    `--mode=${item.mode}`,
    `--cli=${item.cli}`,
    `--model=${item.model}`,
  ];
  if (supportsReasoningEffort(item.cli)) {
    args.push(`--reasoning-effort=${item.reasoningEffort || 'low'}`);
  }

  item.selectedCases.forEach((caseId) => {
    args.push('--case', caseId);
  });
  if (item.limit) {
    args.push('--limit', String(item.limit));
  }
  if (item.keepProjects) {
    args.push('--keep-projects');
  }
  return args;
}

async function readEvalReportArtifact(
  reportId: string,
  cases?: QuantEvalCase[],
): Promise<{ run: QuantEvalRun; sha256: string }> {
  if (!/^report-[A-Za-z0-9_-]+$/u.test(reportId)) {
    throw new EvalArtifactError(`评测报告 ID 无效：${reportId}`);
  }
  const filePath = path.join(REPORTS_DIR, `${reportId}.json`);
  let stat;
  try {
    stat = await fs.stat(filePath);
  } catch (error) {
    throw new EvalArtifactError(`评测报告 artifact 不存在：${path.relative(ROOT, filePath)}`, { cause: error });
  }
  let content: string;
  try {
    content = await fs.readFile(filePath, 'utf8');
  } catch (error) {
    throw new EvalArtifactError(`读取评测报告 artifact 失败：${path.relative(ROOT, filePath)}`, { cause: error });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    throw new EvalArtifactError(`评测报告 artifact 不是有效 JSON：${path.relative(ROOT, filePath)}`, { cause: error });
  }
  if (!isRecord(parsed)) {
    throw new EvalArtifactError(`评测报告 artifact 根节点无效：${path.relative(ROOT, filePath)}`);
  }
  const metadata = isRecord(parsed.metadata) ? parsed.metadata : {};
  const embeddedReportId = stringValue(metadata.reportId);
  if (embeddedReportId && embeddedReportId !== reportId) {
    throw new EvalArtifactError(
      `评测报告 ID 不一致：队列要求 ${reportId}，artifact 声明 ${embeddedReportId}。`,
    );
  }
  return {
    run: normalizeRun(filePath, stat.mtimeMs, parsed, cases ?? await getQuantEvalCases()),
    sha256: createHash('sha256').update(content, 'utf8').digest('hex'),
  };
}

export const __evalRuntimeTesting = { buildVirtualQueueItem };

async function readEvalReportArtifactIfPresent(
  reportId: string,
  cases: QuantEvalCase[],
): Promise<{ run: QuantEvalRun; sha256: string } | null> {
  const filePath = path.join(REPORTS_DIR, `${reportId}.json`);
  try {
    await fs.stat(filePath);
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return null;
    throw new EvalArtifactError(`检查评测报告 artifact 失败：${path.relative(ROOT, filePath)}`, { cause: error });
  }
  return readEvalReportArtifact(reportId, cases);
}

function runBenchmarkQueueItem(item: QuantEvalQueueItem) {
  const startedAtMs = Date.now();
  const logPath = path.join(LOG_DIR, `${item.id}.log`);
  void (async () => {
    await fs.mkdir(LOG_DIR, { recursive: true });
    await updateQueueItem(item.id, {
      status: 'running',
      startedAt: new Date(startedAtMs).toISOString(),
      logPath: path.relative(ROOT, logPath),
      error: null,
    });

    const args = buildBenchmarkArgs(item);
    const child = spawn(process.execPath, args, {
      cwd: ROOT,
      env: {
        ...process.env,
        WOLF_RESEARCH_EVAL_TRIGGER: 'eval-backend',
        WOLF_RESEARCH_EVAL_QUEUE_ID: item.id,
        WOLF_RESEARCH_EVAL_REPORT_ID: item.reportId ?? '',
        WOLF_RESEARCH_EVAL_EVALUATOR: item.evaluatorId,
        WOLF_RESEARCH_EVAL_CONCURRENCY: String(item.concurrency),
        WOLF_RESEARCH_EVAL_REPEAT: String(item.repeat),
        WOLF_RESEARCH_EVAL_MODE: item.mode,
        WOLF_RESEARCH_EVAL_CLI: item.cli,
        WOLF_RESEARCH_EVAL_MODEL: item.model,
        ...(supportsReasoningEffort(item.cli) ? { WOLF_RESEARCH_EVAL_REASONING_EFFORT: item.reasoningEffort || 'low' } : {}),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    runningChildren.set(item.id, child);
    await updateQueueItem(item.id, { pid: child.pid ?? null });

    const appendLog = async (chunk: Buffer | string) => {
      await fs.appendFile(logPath, chunk);
    };

    child.stdout.on('data', (chunk) => {
      void appendLog(chunk);
    });
    child.stderr.on('data', (chunk) => {
      void appendLog(chunk);
    });
    child.on('error', (error) => {
      void (async () => {
        const current = (await readQueue()).find((entry) => entry.id === item.id);
        if (current?.status === 'cancelled') {
          runningChildren.delete(item.id);
          await processEvalQueue();
          return;
        }
        await updateQueueItem(item.id, {
          status: 'failed',
          finishedAt: new Date().toISOString(),
          exitCode: null,
          error: error.message,
        });
        runningChildren.delete(item.id);
        await processEvalQueue();
      })();
    });
    child.on('close', (code, signal) => {
      void (async () => {
        const current = (await readQueue()).find((entry) => entry.id === item.id);
        if (current?.status === 'cancelled') {
          runningChildren.delete(item.id);
          await processEvalQueue();
          return;
        }
        let report: QuantEvalRun | null = null;
        let reportError: Error | null = null;
        try {
          const artifact = await readEvalReportArtifact(item.reportId ?? '');
          report = artifact.run;
          await writeEvalRunToDatabase(report, artifact.sha256);
        } catch (error) {
          reportError = error instanceof Error ? error : new Error(String(error));
        }
        const queuePassed = code === 0 && report?.passed === true;
        await updateQueueItem(item.id, {
          status: queuePassed ? 'passed' : 'failed',
          finishedAt: new Date().toISOString(),
          exitCode: code,
          reportId: item.reportId,
          reportPath: item.reportPath,
          error: reportError
            ? reportError.message
            : queuePassed
              ? null
              : report && !report.passed
                ? `benchmark 报告未通过：${report.id}`
                : `benchmark 退出码 ${code ?? signal ?? 'unknown'}`,
        });
        runningChildren.delete(item.id);
        if (report && !report.passed) {
          await createRepairTicketsForRun(report);
        }
        await processEvalQueue();
      })();
    });
  })();
}

async function processEvalQueue(): Promise<void> {
  if (queueKickoffInProgress) return;
  queueKickoffInProgress = true;
  try {
    const queue = await readQueue();
    if (queue.some((item) => item.status === 'running')) {
      return;
    }
    const next = queue
      .filter((item) => item.status === 'queued')
      .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())[0];
    if (!next) return;
    runBenchmarkQueueItem(next);
  } finally {
    queueKickoffInProgress = false;
  }
}

export async function getQuantEvalRuns(limit = 30): Promise<QuantEvalRun[]> {
  const cases = await getQuantEvalCases();
  const files = await fs.readdir(REPORTS_DIR).catch((error) => {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return [];
    throw new EvalArtifactError('读取评测报告目录失败。', { cause: error });
  });
  const reportFiles = files.filter((fileName) => /^report-[A-Za-z0-9_-]+\.json$/u.test(fileName));
  for (const fileName of reportFiles) {
    const reportId = fileName.replace(/\.json$/u, '');
    const artifact = await readEvalReportArtifact(reportId, cases);
    await writeEvalRunToDatabase(artifact.run, artifact.sha256);
  }
  return listEvalRunsFromDatabase(limit);
}

export async function getQuantEvalQueue(): Promise<QuantEvalQueueItem[]> {
  return readQueue();
}

export async function cancelQuantEvalRun(queueId: string): Promise<QuantEvalQueueItem> {
  const queue = await readQueue();
  const item = queue.find((entry) => entry.id === queueId);
  if (!item) {
    throw new Error('未找到评测队列任务。');
  }
  if (item.status !== 'queued' && item.status !== 'running') {
    return item;
  }

  if (item.status === 'running') {
    const child = runningChildren.get(item.id);
    if (child && !child.killed) {
      child.kill('SIGTERM');
    } else if (item.pid) {
      try {
        process.kill(item.pid, 'SIGTERM');
      } catch {
        // 进程可能已经自然退出，队列状态仍然按取消处理。
      }
    }
    runningChildren.delete(item.id);
  }

  const updated = await updateQueueItem(item.id, {
    status: 'cancelled',
    finishedAt: new Date().toISOString(),
    error: '用户取消评测任务。',
    exitCode: null,
  });
  await processEvalQueue();
  if (!updated) {
    throw new Error('取消评测任务失败。');
  }
  return updated;
}

export async function simulateQuantEvalFlow(options: StartQuantEvalOptions = {}): Promise<QuantEvalFlowSimulation> {
  const generatedAt = new Date().toISOString();
  const steps: QuantEvalFlowStep[] = [];
  const warnings: string[] = [];
  const allCases = await getQuantEvalCases();
  const selectedCases = Array.isArray(options.selectedCases)
    ? options.selectedCases.map(String).filter(Boolean)
    : [];
  const selectedSet = selectedCases.length
    ? allCases.filter((testCase) => selectedCases.includes(testCase.id))
    : allCases;
  const limit =
    typeof options.limit === 'number' && Number.isFinite(options.limit) && options.limit > 0
      ? Math.floor(options.limit)
      : null;
  const scopedCases = limit ? selectedSet.slice(0, limit) : selectedSet;
  const missingCases = selectedCases.filter((caseId) => !allCases.some((testCase) => testCase.id === caseId));
  const virtualItem = buildVirtualQueueItem({ ...options, selectedCases, limit });
  const command = [process.execPath, ...buildBenchmarkArgs(virtualItem)];

  const pushStep = (step: QuantEvalFlowStep) => {
    steps.push(step);
    if (step.status === 'warning') {
      warnings.push(step.summary);
    }
  };

  pushStep({
    id: 'case-selection',
    name: '用例选择',
    status: scopedCases.length && !missingCases.length ? 'passed' : 'failed',
    summary: scopedCases.length
      ? `已选择 ${scopedCases.length} 个用例。`
      : '没有匹配的评测用例。',
    detail: missingCases.length ? `未找到用例：${missingCases.join(', ')}` : null,
  });

  pushStep({
    id: 'evaluator',
    name: '评测器配置',
    status: virtualItem.evaluatorId ? 'passed' : 'failed',
    summary: `${virtualItem.evaluatorId}@${getEvalEvaluatorDefinition(virtualItem.evaluatorId).version} · 并发 ${virtualItem.concurrency} · 重复 ${virtualItem.repeat}`,
    detail: getEvalEvaluatorDefinition(virtualItem.evaluatorId).rubricVersion,
  });

  const runtime = EVAL_RUNTIME_OPTIONS.find((option) => option.cli === virtualItem.cli);
  const modelKnown = runtime?.models.some((model) => model.id === virtualItem.model);
  pushStep({
    id: 'runtime',
    name: '底层执行能力',
    status: runtime && modelKnown ? 'passed' : runtime ? 'warning' : 'failed',
    summary: runtime
      ? '已匹配评测器所需的执行能力。'
      : `未注册执行能力：${virtualItem.cli}`,
    detail: runtime && !modelKnown ? '底层模型不在运行器白名单内，将按传入配置尝试执行。' : null,
  });

  const benchmarkScript = path.join(ROOT, 'scripts', 'evals', 'run-quant-benchmarks.js');
  const scriptStat = await fs.stat(benchmarkScript).catch(() => null);
  pushStep({
    id: 'benchmark-script',
    name: 'Benchmark 脚本',
    status: scriptStat ? 'passed' : 'failed',
    summary: scriptStat ? 'benchmark 入口脚本存在。' : 'benchmark 入口脚本缺失。',
    detail: path.relative(ROOT, benchmarkScript),
  });

  const logReady = await fs.mkdir(LOG_DIR, { recursive: true }).then(() => true).catch(() => false);
  const reportReady = await fs.mkdir(REPORTS_DIR, { recursive: true }).then(() => true).catch(() => false);
  pushStep({
    id: 'storage',
    name: '本地存储',
    status: logReady && reportReady ? 'passed' : 'failed',
    summary: logReady && reportReady
      ? 'PostgreSQL 队列/修复单与本地日志/报告 artifact 已准备。'
      : '本地日志或报告目录不可写。',
    detail: [LOG_DIR, REPORTS_DIR].map((item) => path.relative(ROOT, item)).join(' · '),
  });

  const runs = await getQuantEvalRuns(3);
  pushStep({
    id: 'report-parser',
    name: '报告解析',
    status: runs.length ? 'passed' : 'warning',
    summary: runs.length ? `已解析 ${runs.length} 份最近报告。` : '暂无历史报告，首次运行后才会生成运行记录。',
    detail: runs[0]?.filePath ?? null,
  });

  const tickets = await readRepairTickets();
  pushStep({
    id: 'repair-sink',
    name: '修复单沉淀',
    status: 'passed',
    summary: `修复单存储可读，当前 ${tickets.length} 条。`,
    detail: 'PostgreSQL.eval_repair_tickets',
  });

  pushStep({
    id: 'command',
    name: '执行命令',
    status: command.length > 2 ? 'passed' : 'failed',
    summary: '已生成 benchmark 执行命令。',
    detail: command.join(' '),
  });

  return {
    generatedAt,
    ready: steps.every((step) => step.status !== 'failed'),
    runtime: {
      cli: virtualItem.cli,
      model: virtualItem.model,
      reasoningEffort: virtualItem.reasoningEffort,
      mode: virtualItem.mode,
    },
    evaluator: {
      id: virtualItem.evaluatorId,
      concurrency: virtualItem.concurrency,
    },
    selection: {
      selectedCases,
      limit,
      keepProjects: virtualItem.keepProjects,
      caseCount: scopedCases.length,
      concurrency: virtualItem.concurrency,
      repeat: virtualItem.repeat,
    },
    selectedCaseIds: scopedCases.map((testCase) => testCase.id),
    command,
    steps,
    warnings,
  };
}

export async function startQuantEvalRun(options: StartQuantEvalOptions = {}): Promise<QuantEvalQueueItem> {
  const queue = await readQueue();
  const reportId = uniqueId('report');
  const reportPath = path.relative(ROOT, path.join(REPORTS_DIR, `${reportId}.json`));
  const item: QuantEvalQueueItem = {
    ...buildVirtualQueueItem(options),
    id: uniqueId('eval-run'),
    createdAt: new Date().toISOString(),
    reportId,
    reportPath,
  };

  await writeQueue([item, ...queue]);
  await processEvalQueue();
  return item;
}

export async function updateQuantEvalSchedule(input: UpdateQuantEvalScheduleInput): Promise<QuantEvalScheduleConfig> {
  void input;
  throw new EvalScheduleNotConfiguredError();
}

export async function checkQuantEvalSchedule(): Promise<{ queued: boolean; schedule: QuantEvalScheduleConfig; item: QuantEvalQueueItem | null }> {
  throw new EvalScheduleNotConfiguredError();
}

export async function getQuantEvalRun(runId: string): Promise<QuantEvalRun | null> {
  if (!/^report-[A-Za-z0-9_-]+$/u.test(runId)) {
    return null;
  }
  const cases = await getQuantEvalCases();
  let record;
  try {
    record = await prisma.evalRun.findUnique({ where: { id: runId } });
  } catch (error) {
    throw new EvalStorageError(`读取评测运行记录失败：${runId}。`, { cause: error });
  }
  const artifact = await readEvalReportArtifactIfPresent(runId, cases);
  if (!record && !artifact) return null;
  if (!artifact) {
    throw new EvalArtifactError(`评测运行 ${runId} 的报告 artifact 缺失。`);
  }
  if (record) {
    if (record.reportSha256 && record.reportSha256 !== artifact.sha256) {
      throw new EvalArtifactError(`评测运行 ${runId} 的报告 hash 与 PostgreSQL 元数据不一致。`);
    }
    if (record.passed !== artifact.run.passed || record.total !== artifact.run.total) {
      throw new EvalArtifactError(`评测运行 ${runId} 的报告内容与 PostgreSQL 状态不一致。`);
    }
    if (!record.reportSha256) await writeEvalRunToDatabase(artifact.run, artifact.sha256);
    return mapDbEvalRun(record);
  }
  await writeEvalRunToDatabase(artifact.run, artifact.sha256);
  return artifact.run;
}

export async function getQuantEvalDashboardData(): Promise<QuantEvalDashboardData> {
  const [cases, customEvalSets, runs, queue, repairTickets, schedule] = await Promise.all([
    getQuantEvalCases(),
    getQuantEvalSets(),
    getQuantEvalRuns(),
    getQuantEvalQueue(),
    readRepairTickets(),
    readScheduleConfig(),
  ]);
  const latestRun = runs[0] ?? null;
  const capabilities = new Set(cases.map((testCase) => testCase.capabilityId));
  const mutationDir = path.join(ROOT, 'tmp', 'quantpilot-eval-mutations');
  const mutationReport = await fs.readdir(mutationDir, { withFileTypes: true })
    .then(async (entries) => {
      const files = await Promise.all(entries
        .filter((entry) => entry.isFile() && /^mutation-report-\d+\.json$/u.test(entry.name))
        .map(async (entry) => {
          const filePath = path.join(mutationDir, entry.name);
          return { filePath, stat: await fs.stat(filePath) };
        }));
      const latest = files.sort((left, right) => right.stat.mtimeMs - left.stat.mtimeMs)[0];
      return latest ? readJson(latest.filePath).then((value) => ({ value, filePath: latest.filePath })) : null;
    })
    .catch(() => null);
  const datasetRegistry = await readJson(path.join(ROOT, 'benchmarks', 'quantpilot', 'datasets.json')).catch(() => null);
  const snapshotManifest = await readJson(path.join(ROOT, 'benchmarks', 'quantpilot', 'snapshot-manifest.json')).catch(() => null);
  const calibrationPath = path.resolve(
    process.env.WOLF_RESEARCH_EVAL_JUDGE_CALIBRATION_PATH ||
      'benchmarks/quantpilot/judge-calibration.contract.json',
  );
  const calibrationDataset = await readJson(calibrationPath).catch(() => null);
  const calibration = isRecord(calibrationDataset) && Array.isArray(calibrationDataset.samples)
    ? evaluateEvalJudgeCalibration({
        samples: calibrationDataset.samples as EvalJudgeCalibrationSample[],
        requireIndependent: calibrationDataset.datasetKind === 'human_blind_calibration',
      })
    : null;
  const mutation = mutationReport && isRecord(mutationReport.value) ? mutationReport.value : null;
  const registryRecord = isRecord(datasetRegistry) ? datasetRegistry : {};
  const snapshotRecord = isRecord(snapshotManifest) ? snapshotManifest : {};
  const datasetDefinitions = readRecordArray(registryRecord.datasets);
  const productionCaseCount = cases.filter((testCase) => testCase.productionSupported).length;

  return {
    generatedAt: new Date().toISOString(),
    reportsDir: path.relative(ROOT, REPORTS_DIR),
    casesPath: path.relative(ROOT, CASES_PATH),
    runtimeOptions: EVAL_RUNTIME_OPTIONS,
    cases,
    customEvalSets,
    runs,
    queue,
    repairTickets,
    schedule,
    latestRun,
    modelComparison: buildModelComparison(runs),
    skillVersionImpact: buildSkillVersionImpact(runs),
    assurance: {
      mutation: mutation
        ? {
            createdAt: stringValue(mutation.createdAt),
            baselinePassed: booleanValue(mutation.baselinePassed),
            total: numberValue(mutation.total),
            killed: numberValue(mutation.killed),
            survived: numberValue(mutation.survived),
            killRate: numberValue(mutation.killRate),
            reportPath: mutationReport ? path.relative(ROOT, mutationReport.filePath) : '',
          }
        : null,
      datasets: {
        publicCaseCount: cases.length,
        productionCaseCount,
        productionSnapshotCount: readRecordArray(snapshotRecord.snapshots)
          .filter((snapshot) => cases.some((testCase) => testCase.productionSupported && testCase.id === snapshot.caseId))
          .length,
        hiddenConfigured: datasetDefinitions.some((item) =>
          item.visibility === 'hidden' && Boolean(process.env[stringValue(item.pathEnv)])),
        productionReplayConfigured: datasetDefinitions.some((item) =>
          item.visibility === 'production_replay' && Boolean(process.env[stringValue(item.pathEnv)])),
      },
      judge: calibration && isRecord(calibrationDataset)
        ? {
            datasetKind: stringValue(calibrationDataset.datasetKind, 'unknown'),
            productionCalibration: calibrationDataset.datasetKind === 'human_blind_calibration',
            caseCount: calibration.summary.caseCount,
            agreementRate: calibration.summary.verdictAgreementRate,
            cohenKappa: calibration.summary.cohenKappa,
            scoreMeanAbsoluteError: calibration.summary.scoreMeanAbsoluteError,
            passed: calibration.passed,
          }
        : null,
    },
    summary: {
      caseCount: cases.length,
      reportCount: runs.length,
      capabilityCount: capabilities.size,
      latestPassRate: latestRun?.passRate ?? 0,
      latestAverageScore: latestRun?.averageScore ?? 0,
      latestPassedCount: latestRun?.passedCount ?? 0,
      latestFailedCount: latestRun?.failedCount ?? 0,
      latestTotal: latestRun?.total ?? 0,
    },
  };
}
