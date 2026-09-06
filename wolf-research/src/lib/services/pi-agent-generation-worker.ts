import os from "node:os";
import { randomUUID } from "node:crypto";

import { Prisma, type AgentGenerationJob } from "@prisma/client";

import type { DataAgentGenerationJobInput } from "@/lib/data-agent";
import { assertManagedWorkspaceExists } from "@/lib/data-agent";
import {
  assertPiAgentSchemaReady,
  PiAgentSchemaNotReadyError,
} from "@/lib/db/pi-agent-schema-readiness";
import { prisma } from "@/lib/db/client";
import { createApplicationGenerationRuntime } from "@/lib/quant/generation-runtime";
import { readQuantGenerationQueue } from "@/lib/quant/generation-queue";
import {
  finishPiAgentGenerationJob,
  listClaimablePiAgentGenerationJobs,
  PiAgentGenerationDispatchError,
  reconcileExpiredPiAgentGenerationJobs,
} from "@/lib/services/pi-agent-generation-dispatch-store";
import {
  PiAgentGenerationDispatchSession,
  type PiAgentGenerationDispatchSessionOptions,
} from "@/lib/services/pi-agent-generation-dispatch-session";
import {
  failPiAgentMission,
  readPiAgentMission,
} from "@/lib/services/pi-agent-mission-store";
import { markUserRequestAsFailed } from "@/lib/services/user-requests";

const MAX_DURATION_MS = 24 * 60 * 60 * 1_000;
const MAX_CONCURRENCY = 32;
const MAX_CLAIM_BATCH_SIZE = 200;
const DEFAULT_DISPATCH_LEASE_TTL_MS = 120_000;
const DEFAULT_DISPATCH_HEARTBEAT_INTERVAL_MS = 30_000;
const DEFAULT_WORKER_POLL_INTERVAL_MS = 1_000;
const DEFAULT_WORKER_SHUTDOWN_GRACE_MS = 30_000;
const DEFAULT_WORKER_POOL_KEY = "generation";

export type GenerationWorkerErrorCode =
  | "GENERATION_WORKER_CONFIGURATION_INVALID"
  | "GENERATION_WORKER_DATABASE_UNAVAILABLE"
  | "GENERATION_WORKER_SCHEMA_NOT_READY"
  | "GENERATION_WORKER_SLOT_BUSY"
  | "GENERATION_WORKER_LEASE_LOST";

export class GenerationWorkerError extends Error {
  constructor(
    readonly code: GenerationWorkerErrorCode,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "GenerationWorkerError";
  }
}

export interface GenerationWorkerConfig {
  databaseUrl: string;
  poolKey: string;
  concurrency: number;
  globalConcurrency: number;
  pollIntervalMs: number;
  claimBatchSize: number;
  workerLeaseTtlMs: number;
  workerHeartbeatIntervalMs: number;
  dispatchLeaseTtlMs: number;
  dispatchHeartbeatIntervalMs: number;
  shutdownGraceMs: number;
  instanceId: string | null;
}

export interface GenerationWorkerRegistration {
  instanceId: string;
  workerOwner: string;
  poolKey: string;
  slotNumbers: readonly number[];
  processConcurrency: number;
  globalConcurrency: number;
  leaseTtlMs: number;
}

export interface GenerationWorkerLeaseStore {
  assertSchemaReady(): Promise<void>;
  register(input: GenerationWorkerRegistration): Promise<readonly number[] | void>;
  heartbeat(input: GenerationWorkerRegistration): Promise<void>;
  assignJob(
    input: GenerationWorkerRegistration,
    slotNumber: number,
    jobId: string,
  ): Promise<void>;
  releaseJob(
    input: GenerationWorkerRegistration,
    slotNumber: number,
    jobId: string,
  ): Promise<void>;
  shutdown(input: GenerationWorkerRegistration): Promise<void>;
}

export interface GenerationWorkerDispatchSession {
  readonly fence: {
    jobId: string;
    projectId: string;
    requestId: string;
    leaseOwner: string;
    fencingToken: number;
  };
  run<T>(task: () => Promise<T>): Promise<T>;
  assertHealthy(): void;
  markTerminal(): void;
  dispose(): void;
}

export interface GenerationWorkerLogger {
  info(message: string, details?: Record<string, unknown>): void;
  warn(message: string, details?: Record<string, unknown>): void;
  error(message: string, details?: Record<string, unknown>): void;
}

export interface GenerationWorkerDependencies {
  store: GenerationWorkerLeaseStore;
  listClaimable(limit: number): Promise<AgentGenerationJob[]>;
  reconcile(): Promise<AgentGenerationJob[]>;
  claimExisting(input: {
    projectId: string;
    requestId: string;
    leaseOwner: string;
    leaseTtlMs: number;
    heartbeatIntervalMs: number;
  }): Promise<GenerationWorkerDispatchSession>;
  execute(input: DataAgentGenerationJobInput): Promise<void>;
  onExecutionFailure?(job: AgentGenerationJob, message: string): Promise<void>;
  finish(input: {
    job: AgentGenerationJob;
    session: GenerationWorkerDispatchSession;
    status: "completed" | "failed";
    errorMessage?: string;
  }): Promise<void>;
}

const defaultLogger: GenerationWorkerLogger = {
  info(message, details) {
    console.info("[GenerationWorker]", message, details ?? "");
  },
  warn(message, details) {
    console.warn("[GenerationWorker]", message, details ?? "");
  },
  error(message, details) {
    console.error("[GenerationWorker]", message, details ?? "");
  },
};

function envValue(
  environment: Readonly<Record<string, string | undefined>>,
  name: string,
): string | undefined {
  const value = environment[name]?.trim();
  return value ? value : undefined;
}

function configurationError(message: string): GenerationWorkerError {
  return new GenerationWorkerError(
    "GENERATION_WORKER_CONFIGURATION_INVALID",
    message,
  );
}

function positiveInteger(
  environment: Readonly<Record<string, string | undefined>>,
  name: string,
  fallback: number,
  max: number,
): number {
  const raw = envValue(environment, name);
  if (raw === undefined) return fallback;
  if (!/^\d+$/u.test(raw)) {
    throw configurationError(`${name} must be a positive integer.`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0 || value > max) {
    throw configurationError(`${name} must be between 1 and ${max}.`);
  }
  return value;
}

function boundedIdentifier(
  environment: Readonly<Record<string, string | undefined>>,
  name: string,
  fallback: string,
): string {
  const value = envValue(environment, name) ?? fallback;
  if (!/^[A-Za-z][A-Za-z0-9._:-]{0,127}$/u.test(value)) {
    throw configurationError(
      `${name} must be a bounded single-line worker identifier.`,
    );
  }
  return value;
}

function optionalInstanceId(
  environment: Readonly<Record<string, string | undefined>>,
): string | null {
  const value = envValue(environment, "PI_AGENT_INSTANCE_ID");
  if (value === undefined) return null;
  if (!/^[A-Za-z][A-Za-z0-9._:-]{0,95}$/u.test(value)) {
    throw configurationError(
      "PI_AGENT_INSTANCE_ID must be a bounded single-line worker identifier.",
    );
  }
  return value;
}

function databaseUrl(
  environment: Readonly<Record<string, string | undefined>>,
): string {
  const value = envValue(environment, "DATABASE_URL");
  if (!value) throw configurationError("DATABASE_URL is required by the generation worker.");
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw configurationError("DATABASE_URL must be a valid PostgreSQL URL.");
  }
  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    throw configurationError("DATABASE_URL must use the postgres or postgresql protocol.");
  }
  return value;
}

export function parseGenerationWorkerConfig(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): GenerationWorkerConfig {
  const mode = envValue(environment, "PI_AGENT_DISPATCH_MODE");
  if (mode !== "worker") {
    throw configurationError(
      "PI_AGENT_DISPATCH_MODE must be set to worker before starting the durable generation worker; the web process remains inline by default.",
    );
  }

  const dispatchLeaseTtlMs = positiveInteger(
    environment,
    "PI_AGENT_DISPATCH_LEASE_TTL_MS",
    DEFAULT_DISPATCH_LEASE_TTL_MS,
    MAX_DURATION_MS,
  );
  const dispatchHeartbeatIntervalMs = positiveInteger(
    environment,
    "PI_AGENT_DISPATCH_HEARTBEAT_INTERVAL_MS",
    DEFAULT_DISPATCH_HEARTBEAT_INTERVAL_MS,
    MAX_DURATION_MS,
  );
  if (dispatchHeartbeatIntervalMs >= dispatchLeaseTtlMs) {
    throw configurationError(
      "PI_AGENT_DISPATCH_HEARTBEAT_INTERVAL_MS must be smaller than PI_AGENT_DISPATCH_LEASE_TTL_MS.",
    );
  }

  const workerLeaseTtlMs = positiveInteger(
    environment,
    "PI_AGENT_WORKER_LEASE_TTL_MS",
    dispatchLeaseTtlMs,
    MAX_DURATION_MS,
  );
  const workerHeartbeatIntervalMs = positiveInteger(
    environment,
    "PI_AGENT_WORKER_HEARTBEAT_INTERVAL_MS",
    dispatchHeartbeatIntervalMs,
    MAX_DURATION_MS,
  );
  if (workerHeartbeatIntervalMs >= workerLeaseTtlMs) {
    throw configurationError(
      "PI_AGENT_WORKER_HEARTBEAT_INTERVAL_MS must be smaller than PI_AGENT_WORKER_LEASE_TTL_MS.",
    );
  }

  const concurrency = positiveInteger(
    environment,
    "PI_AGENT_WORKER_CONCURRENCY",
    1,
    MAX_CONCURRENCY,
  );
  const globalConcurrency = positiveInteger(
    environment,
    "PI_AGENT_WORKER_GLOBAL_CONCURRENCY",
    concurrency,
    MAX_CONCURRENCY,
  );
  if (concurrency > globalConcurrency) {
    throw configurationError(
      "PI_AGENT_WORKER_CONCURRENCY must not exceed PI_AGENT_WORKER_GLOBAL_CONCURRENCY.",
    );
  }
  const claimBatchSize = positiveInteger(
    environment,
    "PI_AGENT_WORKER_CLAIM_BATCH_SIZE",
    Math.min(MAX_CLAIM_BATCH_SIZE, Math.max(concurrency, concurrency * 2)),
    MAX_CLAIM_BATCH_SIZE,
  );
  const pollIntervalMs = positiveInteger(
    environment,
    "PI_AGENT_WORKER_POLL_INTERVAL_MS",
    DEFAULT_WORKER_POLL_INTERVAL_MS,
    60_000,
  );
  const shutdownGraceMs = positiveInteger(
    environment,
    "PI_AGENT_WORKER_SHUTDOWN_GRACE_MS",
    DEFAULT_WORKER_SHUTDOWN_GRACE_MS,
    5 * 60 * 1_000,
  );

  return {
    databaseUrl: databaseUrl(environment),
    poolKey: boundedIdentifier(environment, "PI_AGENT_WORKER_POOL_KEY", DEFAULT_WORKER_POOL_KEY),
    concurrency,
    globalConcurrency,
    pollIntervalMs,
    claimBatchSize,
    workerLeaseTtlMs,
    workerHeartbeatIntervalMs,
    dispatchLeaseTtlMs,
    dispatchHeartbeatIntervalMs,
    shutdownGraceMs,
    instanceId: optionalInstanceId(environment),
  };
}

async function databaseNow(
  client: Prisma.TransactionClient,
): Promise<Date> {
  const rows = await client.$queryRaw<Array<{ databaseNow: Date }>>(Prisma.sql`
    SELECT clock_timestamp() AS "databaseNow"
  `);
  const value = rows[0]?.databaseNow;
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new GenerationWorkerError(
      "GENERATION_WORKER_DATABASE_UNAVAILABLE",
      "Database clock is unavailable while registering the generation worker.",
    );
  }
  return value;
}

function workerSchemaError(error: unknown): GenerationWorkerError {
  if (error instanceof PiAgentSchemaNotReadyError) {
    return new GenerationWorkerError(
      "GENERATION_WORKER_SCHEMA_NOT_READY",
      error.message,
      {
        contractVersion: error.contractVersion,
        issues: error.issues,
      },
    );
  }
  return new GenerationWorkerError(
    "GENERATION_WORKER_DATABASE_UNAVAILABLE",
    `Generation worker could not inspect the PostgreSQL schema: ${
      error instanceof Error ? error.message : String(error)
    }`,
  );
}

class PrismaGenerationWorkerLeaseStore implements GenerationWorkerLeaseStore {
  async assertSchemaReady(): Promise<void> {
    try {
      await assertPiAgentSchemaReady(prisma);
    } catch (error) {
      throw workerSchemaError(error);
    }
  }

  async register(input: GenerationWorkerRegistration): Promise<readonly number[]> {
    try {
      return await prisma.$transaction(async (tx) => {
        const databaseTime = await databaseNow(tx);
        const expiresAt = new Date(databaseTime.getTime() + input.leaseTtlMs);
        await tx.$executeRaw(Prisma.sql`
          INSERT INTO agent_worker_slots (
            pool_key,
            slot_number,
            status,
            fencing_token,
            version,
            created_at,
            updated_at
          )
          SELECT
            ${input.poolKey},
            generated.slot_number,
            'free',
            0,
            0,
            ${databaseTime},
            ${databaseTime}
          FROM generate_series(0, ${input.globalConcurrency - 1}) AS generated(slot_number)
          ON CONFLICT (pool_key, slot_number) DO NOTHING
        `);
        const candidates = await tx.$queryRaw<Array<{ slotNumber: number }>>(Prisma.sql`
          SELECT slot_number AS "slotNumber"
          FROM agent_worker_slots
          WHERE pool_key = ${input.poolKey}
            AND slot_number >= 0
            AND slot_number < ${input.globalConcurrency}
            AND (
              status <> 'running'
              OR (
                lease_expires_at IS NOT NULL
                AND lease_expires_at <= ${databaseTime}
              )
            )
          ORDER BY slot_number ASC
          FOR UPDATE SKIP LOCKED
          LIMIT ${input.processConcurrency}
        `);
        if (candidates.length !== input.processConcurrency) {
          throw new GenerationWorkerError(
            "GENERATION_WORKER_SLOT_BUSY",
            `Generation worker pool ${input.poolKey} has no ${input.processConcurrency} free slot(s).`,
          );
        }
        for (const { slotNumber } of candidates) {
          await tx.agentWorkerSlot.update({
            where: {
              poolKey_slotNumber: {
                poolKey: input.poolKey,
                slotNumber,
              },
            },
            data: {
              status: "running",
              activeJobId: null,
              leaseOwner: input.workerOwner,
              leaseExpiresAt: expiresAt,
              lastHeartbeatAt: databaseTime,
              fencingToken: { increment: 1 },
              version: { increment: 1 },
              acquiredAt: databaseTime,
              releasedAt: null,
            },
          });
        }
        await tx.agentWorkerInstance.create({
          data: {
            id: input.instanceId,
            poolKey: input.poolKey,
            hostname: os.hostname(),
            processId: process.pid,
            processConcurrency: input.processConcurrency,
            globalConcurrency: input.globalConcurrency,
            status: "running",
            leaseExpiresAt: expiresAt,
            lastHeartbeatAt: databaseTime,
            startedAt: databaseTime,
          },
        });
        return candidates.map(({ slotNumber }) => slotNumber);
      });
    } catch (error) {
      if (error instanceof GenerationWorkerError) throw error;
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002"
      ) {
        throw new GenerationWorkerError(
          "GENERATION_WORKER_SLOT_BUSY",
          `Generation worker slot registration conflicted in pool ${input.poolKey}.`,
        );
      }
      throw new GenerationWorkerError(
        "GENERATION_WORKER_DATABASE_UNAVAILABLE",
        `Generation worker registration failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async heartbeat(input: GenerationWorkerRegistration): Promise<void> {
    try {
      await prisma.$transaction(async (tx) => {
        const now = await databaseNow(tx);
        const expiresAt = new Date(now.getTime() + input.leaseTtlMs);
        const instance = await tx.agentWorkerInstance.updateMany({
          where: {
            id: input.instanceId,
            status: "running",
            leaseExpiresAt: { gt: now },
          },
          data: {
            leaseExpiresAt: expiresAt,
            lastHeartbeatAt: now,
          },
        });
        if (instance.count !== 1) {
          throw new GenerationWorkerError(
            "GENERATION_WORKER_LEASE_LOST",
            "Generation worker instance heartbeat lost its lease.",
          );
        }
        for (const slotNumber of input.slotNumbers) {
          const slot = await tx.agentWorkerSlot.updateMany({
            where: {
              poolKey: input.poolKey,
              slotNumber,
              status: "running",
              leaseOwner: input.workerOwner,
              leaseExpiresAt: { gt: now },
            },
            data: {
              leaseExpiresAt: expiresAt,
              lastHeartbeatAt: now,
            },
          });
          if (slot.count !== 1) {
            throw new GenerationWorkerError(
              "GENERATION_WORKER_LEASE_LOST",
              `Generation worker slot ${input.poolKey}/${slotNumber} heartbeat lost its lease.`,
            );
          }
        }
      });
    } catch (error) {
      if (error instanceof GenerationWorkerError) throw error;
      throw new GenerationWorkerError(
        "GENERATION_WORKER_DATABASE_UNAVAILABLE",
        `Generation worker heartbeat failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async assignJob(
    input: GenerationWorkerRegistration,
    slotNumber: number,
    jobId: string,
  ): Promise<void> {
    const result = await prisma.$transaction(async (tx) => {
      const now = await databaseNow(tx);
      return tx.agentWorkerSlot.updateMany({
        where: {
          poolKey: input.poolKey,
          slotNumber,
          status: "running",
          leaseOwner: input.workerOwner,
          leaseExpiresAt: { gt: now },
          activeJobId: null,
        },
        data: { activeJobId: jobId },
      });
    });
    if (result.count !== 1) {
      throw new GenerationWorkerError(
        "GENERATION_WORKER_LEASE_LOST",
        `Generation worker slot ${input.poolKey}/${slotNumber} is not available for a job.`,
      );
    }
  }

  async releaseJob(
    input: GenerationWorkerRegistration,
    slotNumber: number,
    jobId: string,
  ): Promise<void> {
    await prisma.agentWorkerSlot.updateMany({
      where: {
        poolKey: input.poolKey,
        slotNumber,
        leaseOwner: input.workerOwner,
        activeJobId: jobId,
      },
      data: { activeJobId: null },
    });
  }

  async shutdown(input: GenerationWorkerRegistration): Promise<void> {
    try {
      await prisma.$transaction(async (tx) => {
        const now = new Date();
        await tx.agentWorkerSlot.updateMany({
          where: {
            poolKey: input.poolKey,
            leaseOwner: input.workerOwner,
          },
          data: {
            status: "free",
            activeJobId: null,
            leaseOwner: null,
            leaseExpiresAt: null,
            lastHeartbeatAt: null,
            releasedAt: now,
            version: { increment: 1 },
          },
        });
        await tx.agentWorkerInstance.updateMany({
          where: {
            id: input.instanceId,
            status: "running",
          },
          data: {
            status: "stopped",
            leaseExpiresAt: null,
            stoppedAt: now,
          },
        });
      });
    } catch (error) {
      throw new GenerationWorkerError(
        "GENERATION_WORKER_DATABASE_UNAVAILABLE",
        `Generation worker shutdown cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

function toGenerationJobInput(job: AgentGenerationJob): DataAgentGenerationJobInput {
  return {
    jobId: job.id,
    projectId: job.projectId,
    requestId: job.requestId,
    selectedModel: job.selectedModel,
    cliPreference: job.cliPreference,
    executionEnvelope: job.executionEnvelope,
  };
}

function isExpectedClaimRace(error: unknown): boolean {
  return (
    error instanceof PiAgentGenerationDispatchError &&
    [
      "GENERATION_DISPATCH_BUSY",
      "GENERATION_DISPATCH_CANCELLED",
      "GENERATION_DISPATCH_NOT_AVAILABLE",
      "GENERATION_DISPATCH_REPLAN_REQUIRED",
      "GENERATION_DISPATCH_TERMINAL",
      "GENERATION_PROJECT_BUSY",
      "GENERATION_PROJECT_REPLAN_REQUIRED",
      "GENERATION_DISPATCH_ATTEMPTS_EXHAUSTED",
    ].includes(error.code)
  );
}

async function finishGenerationJob(input: {
  job: AgentGenerationJob;
  session: GenerationWorkerDispatchSession;
  status: "completed" | "failed";
  errorMessage?: string;
}): Promise<void> {
  await input.session.run(() =>
    finishPiAgentGenerationJob({
      projectId: input.job.projectId,
      requestId: input.job.requestId,
      status: input.status,
      errorCode: input.status === "failed" ? "GENERATION_FAILED" : null,
      errorMessage: input.errorMessage,
      fence: input.session.fence,
    }),
  );
  input.session.markTerminal();

  // The database ledger is authoritative. The workspace projection is best
  // effort so a missing workspace cannot strand a completed dispatch row.
  try {
    const projectPath = await assertManagedWorkspaceExists(input.job.projectId);
    await readQuantGenerationQueue(projectPath, input.job.projectId);
  } catch (error) {
    console.warn(
      "[GenerationWorker] Failed to refresh the disposable queue projection:",
      error,
    );
  }
}

async function persistExecutionFailure(
  job: AgentGenerationJob,
  message: string,
): Promise<void> {
  await markUserRequestAsFailed(job.projectId, job.requestId, message);
  const mission = await readPiAgentMission(job.projectId, job.requestId);
  if (mission && !["completed", "failed", "cancelled"].includes(mission.status)) {
    await failPiAgentMission({
      missionId: mission.id,
      projectId: job.projectId,
      requestId: job.requestId,
      code: "GENERATION_WORKER_FAILED",
      message,
    });
  }
}

function defaultDependencies(config: GenerationWorkerConfig): GenerationWorkerDependencies {
  const runtime = createApplicationGenerationRuntime();
  return {
    store: new PrismaGenerationWorkerLeaseStore(),
    listClaimable: listClaimablePiAgentGenerationJobs,
    reconcile: () => reconcileExpiredPiAgentGenerationJobs(),
    claimExisting: (input) => {
      const options: PiAgentGenerationDispatchSessionOptions = {
        leaseOwner: input.leaseOwner,
        leaseTtlMs: input.leaseTtlMs,
        heartbeatIntervalMs: input.heartbeatIntervalMs,
      };
      return PiAgentGenerationDispatchSession.claimExisting(
        {
          projectId: input.projectId,
          requestId: input.requestId,
        },
        options,
      );
    },
    execute: (input) => runtime.execute(input),
    onExecutionFailure: persistExecutionFailure,
    finish: finishGenerationJob,
  };
}

export class GenerationWorker {
  private readonly registration: GenerationWorkerRegistration;
  private readonly dependencies: GenerationWorkerDependencies;
  private readonly logger: GenerationWorkerLogger;
  private readonly activeJobs = new Map<string, Promise<void>>();
  private readonly activeSessions = new Map<string, GenerationWorkerDispatchSession>();
  private readonly activeSlots = new Map<number, string>();
  private readonly stopSignal: Promise<void>;
  private resolveStopSignal!: () => void;
  private heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  private heartbeatInFlight: Promise<void> | undefined;
  private stopPromise: Promise<void> | undefined;
  private fatalError: Error | null = null;
  private started = false;
  private stopping = false;

  constructor(
    readonly config: GenerationWorkerConfig,
    dependencies: GenerationWorkerDependencies = defaultDependencies(config),
    logger: GenerationWorkerLogger = defaultLogger,
  ) {
    this.dependencies = dependencies;
    this.logger = logger;
    const instanceId = randomUUID();
    const configuredIdentity = (
      config.instanceId ?? `${os.hostname()}:${process.pid}`
    )
      .replace(/[^A-Za-z0-9._:-]/gu, "_")
      .slice(0, 96) || "host";
    const workerOwner = `generation-worker:${configuredIdentity}:${instanceId}`;
    this.registration = {
      instanceId,
      workerOwner,
      poolKey: config.poolKey,
      slotNumbers: Array.from({ length: config.concurrency }, (_, index) => index),
      processConcurrency: config.concurrency,
      globalConcurrency: config.globalConcurrency,
      leaseTtlMs: config.workerLeaseTtlMs,
    };
    this.stopSignal = new Promise<void>((resolve) => {
      this.resolveStopSignal = resolve;
    });
  }

  get workerId(): string {
    return this.registration.workerOwner;
  }

  get instanceId(): string {
    return this.registration.instanceId;
  }

  get isStopping(): boolean {
    return this.stopping;
  }

  async start(): Promise<void> {
    if (this.started) return;
    if (this.stopping) throw new Error("Generation worker is stopping.");
    await this.dependencies.store.assertSchemaReady();
    const assignedSlots = await this.dependencies.store.register(this.registration);
    if (assignedSlots !== undefined) {
      this.registration.slotNumbers = [...assignedSlots];
    }
    if (this.registration.slotNumbers.length !== this.config.concurrency) {
      throw new GenerationWorkerError(
        "GENERATION_WORKER_SLOT_BUSY",
        `Generation worker received ${this.registration.slotNumbers.length} slot(s), expected ${this.config.concurrency}.`,
      );
    }
    this.started = true;
    this.heartbeatTimer = setInterval(() => {
      if (this.stopping || this.heartbeatInFlight) return;
      const heartbeat = this.dependencies.store.heartbeat(this.registration);
      this.heartbeatInFlight = heartbeat;
      void heartbeat
        .catch((error: unknown) => {
          this.fatalError = error instanceof Error ? error : new Error(String(error));
          this.logger.error("Worker heartbeat failed; stopping the worker.", {
            error: this.fatalError.message,
          });
          this.requestStop();
        })
        .finally(() => {
          if (this.heartbeatInFlight === heartbeat) this.heartbeatInFlight = undefined;
        });
    }, this.config.workerHeartbeatIntervalMs);
    this.logger.info("Generation worker registered.", {
      instanceId: this.registration.instanceId,
      poolKey: this.registration.poolKey,
      concurrency: this.registration.processConcurrency,
    });
  }

  async run(): Promise<void> {
    await this.start();
    try {
      while (!this.stopping) {
        try {
          await this.pollOnce();
        } catch (error) {
          if (!this.stopping) {
            this.logger.error("Generation worker poll failed; retrying.", {
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
        if (!this.stopping) {
          await Promise.race([
            new Promise<void>((resolve) => {
              const timer = setTimeout(resolve, this.config.pollIntervalMs);
              timer.unref?.();
            }),
            this.stopSignal,
          ]);
        }
      }
    } finally {
      await this.stop();
    }
    if (this.fatalError) throw this.fatalError;
  }

  async pollOnce(): Promise<number> {
    if (!this.started) throw new Error("Generation worker has not started.");
    if (this.stopping) return 0;
    await this.dependencies.reconcile();
    const capacity = this.config.concurrency - this.activeJobs.size;
    if (capacity <= 0) return 0;
    const candidates = await this.dependencies.listClaimable(
      Math.max(capacity, this.config.claimBatchSize),
    );
    let claimed = 0;
    for (const job of candidates) {
      if (this.stopping || this.activeJobs.size >= this.config.concurrency) break;
      const slotNumber = this.registration.slotNumbers.find(
        (slot) => !this.activeSlots.has(slot),
      );
      if (slotNumber === undefined) break;
      try {
        await this.dependencies.store.assignJob(
          this.registration,
          slotNumber,
          job.id,
        );
      } catch (error) {
        this.fatalError = error instanceof Error ? error : new Error(String(error));
        this.requestStop();
        throw error;
      }
      let session: GenerationWorkerDispatchSession;
      try {
        session = await this.dependencies.claimExisting({
          projectId: job.projectId,
          requestId: job.requestId,
          leaseOwner: `${this.registration.workerOwner}:slot:${slotNumber}:job:${job.id}`,
          leaseTtlMs: this.config.dispatchLeaseTtlMs,
          heartbeatIntervalMs: this.config.dispatchHeartbeatIntervalMs,
        });
      } catch (error) {
        await this.dependencies.store.releaseJob(
          this.registration,
          slotNumber,
          job.id,
        );
        if (!isExpectedClaimRace(error)) {
          this.logger.error("Generation job claim failed.", {
            jobId: job.id,
            projectId: job.projectId,
            requestId: job.requestId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
        continue;
      }
      this.activeSessions.set(job.id, session);
      this.activeSlots.set(slotNumber, job.id);
      const task = this.executeClaimedJob(slotNumber, job, session)
        .catch((error: unknown) => {
          this.logger.error("Generation job execution failed.", {
            jobId: job.id,
            projectId: job.projectId,
            requestId: job.requestId,
            error: error instanceof Error ? error.message : String(error),
          });
        })
        .finally(() => {
          this.activeJobs.delete(job.id);
          this.activeSessions.delete(job.id);
          this.activeSlots.delete(slotNumber);
        });
      this.activeJobs.set(job.id, task);
      claimed += 1;
    }
    return claimed;
  }

  async waitForIdle(): Promise<void> {
    await Promise.all([...this.activeJobs.values()]);
  }

  async stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.requestStop();
    this.stopPromise = (async () => {
      if (this.heartbeatTimer) {
        clearInterval(this.heartbeatTimer);
        this.heartbeatTimer = undefined;
      }
      if (this.heartbeatInFlight) {
        await this.heartbeatInFlight.catch(() => undefined);
      }
      if (this.activeJobs.size > 0) {
        const active = Promise.all([...this.activeJobs.values()]);
        await Promise.race([
          active,
          new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, this.config.shutdownGraceMs);
            timer.unref?.();
          }),
        ]);
        if (this.activeJobs.size > 0) {
          this.logger.warn("Worker shutdown grace elapsed with active jobs.", {
            activeJobs: this.activeJobs.size,
          });
          for (const session of this.activeSessions.values()) session.dispose();
        }
      }
      if (this.started) {
        try {
          await this.dependencies.store.shutdown(this.registration);
        } catch (error) {
          this.logger.error("Worker durable cleanup failed.", {
            error: error instanceof Error ? error.message : String(error),
          });
          if (!this.fatalError) {
            this.fatalError = error instanceof Error ? error : new Error(String(error));
          }
        }
      }
      this.started = false;
    })();
    return this.stopPromise;
  }

  private requestStop(): void {
    if (this.stopping) return;
    this.stopping = true;
    this.resolveStopSignal();
  }

  private async executeClaimedJob(
    slotNumber: number,
    job: AgentGenerationJob,
    session: GenerationWorkerDispatchSession,
  ): Promise<void> {
    try {
      await session.run(() => this.dependencies.execute(toGenerationJobInput(job)));
      session.assertHealthy();
      await this.dependencies.finish({ job, session, status: "completed" });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      try {
        await this.dependencies.onExecutionFailure?.(job, message);
      } catch (statusError) {
        this.logger.error("Failed to persist failed request or Mission status.", {
          jobId: job.id,
          error: statusError instanceof Error ? statusError.message : String(statusError),
        });
      }
      try {
        await this.dependencies.finish({
          job,
          session,
          status: "failed",
          errorMessage: message,
        });
      } finally {
        session.dispose();
      }
      throw error;
    } finally {
      session.dispose();
      await this.dependencies.store.releaseJob(
        this.registration,
        slotNumber,
        job.id,
      ).catch((releaseError) => {
        this.logger.error("Failed to release worker slot job ownership.", {
          jobId: job.id,
          error: releaseError instanceof Error ? releaseError.message : String(releaseError),
        });
      });
    }
  }
}

export function createGenerationWorker(
  config: GenerationWorkerConfig,
  dependencies?: GenerationWorkerDependencies,
  logger?: GenerationWorkerLogger,
): GenerationWorker {
  return new GenerationWorker(config, dependencies, logger);
}
