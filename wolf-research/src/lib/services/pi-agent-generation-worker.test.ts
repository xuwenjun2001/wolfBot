import { describe, expect, it, vi } from "vitest";

import type { AgentGenerationJob } from "@prisma/client";

import {
  GenerationWorker,
  GenerationWorkerError,
  parseGenerationWorkerConfig,
  type GenerationWorkerDependencies,
  type GenerationWorkerDispatchSession,
  type GenerationWorkerLeaseStore,
} from "./pi-agent-generation-worker";

const baseEnvironment = {
  DATABASE_URL: "postgresql://user:password@127.0.0.1:5432/wolf_research",
  PI_AGENT_DISPATCH_MODE: "worker",
};

function job(): AgentGenerationJob {
  return {
    id: "00000000-0000-0000-0000-000000000001",
    projectId: "project-1",
    requestId: "request-1",
    status: "pending",
    stage: "agent_execution",
    executionEnvelope: { schemaVersion: 3 },
    instructionHash: "sha256:test",
    instructionPreview: "test",
    cliPreference: "pi",
    selectedModel: "qwen-local",
    attemptCount: 0,
    maxAttempts: 3,
    availableAt: new Date(),
    leaseOwner: null,
    leaseExpiresAt: null,
    lastHeartbeatAt: null,
    fencingToken: 0,
    version: 0,
    eventSequence: 1,
    errorCode: null,
    errorMessage: null,
    queuedAt: new Date(),
    startedAt: null,
    completedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  } as AgentGenerationJob;
}

function session(): GenerationWorkerDispatchSession {
  const run = async <T>(task: () => Promise<T>): Promise<T> => task();
  return {
    fence: {
      jobId: "00000000-0000-0000-0000-000000000001",
      projectId: "project-1",
      requestId: "request-1",
      leaseOwner: "worker-1",
      fencingToken: 1,
    },
    run,
    assertHealthy: vi.fn(),
    markTerminal: vi.fn(),
    dispose: vi.fn(),
  };
}

function makeDependencies(overrides: Partial<GenerationWorkerDependencies> = {}) {
  const leaseStore: GenerationWorkerLeaseStore = {
    assertSchemaReady: vi.fn(async () => undefined),
    register: vi.fn(async () => undefined),
    heartbeat: vi.fn(async () => undefined),
    assignJob: vi.fn(async () => undefined),
    releaseJob: vi.fn(async () => undefined),
    shutdown: vi.fn(async () => undefined),
  };
  const defaults: GenerationWorkerDependencies = {
    store: leaseStore,
    listClaimable: vi.fn(async () => [job()]),
    reconcile: vi.fn(async () => []),
    claimExisting: vi.fn(async () => session()),
    execute: vi.fn(async () => undefined),
    onExecutionFailure: vi.fn(async () => undefined),
    finish: vi.fn(async () => undefined),
  };
  return {
    dependencies: { ...defaults, ...overrides },
    leaseStore,
  };
}

describe("generation worker configuration", () => {
  it("requires explicit worker mode and keeps inline as the default web behavior", () => {
    expect(() =>
      parseGenerationWorkerConfig({
        DATABASE_URL: baseEnvironment.DATABASE_URL,
      }),
    ).toThrow(/PI_AGENT_DISPATCH_MODE.*worker/iu);
    expect(() =>
      parseGenerationWorkerConfig({
        ...baseEnvironment,
        PI_AGENT_DISPATCH_MODE: "inline",
      }),
    ).toThrow(/PI_AGENT_DISPATCH_MODE.*worker/iu);
  });

  it("fails clearly for missing database configuration and invalid heartbeats", () => {
    expect(() =>
      parseGenerationWorkerConfig({ PI_AGENT_DISPATCH_MODE: "worker" }),
    ).toThrow(/DATABASE_URL/iu);
    expect(() =>
      parseGenerationWorkerConfig({
        ...baseEnvironment,
        PI_AGENT_DISPATCH_LEASE_TTL_MS: "1000",
        PI_AGENT_DISPATCH_HEARTBEAT_INTERVAL_MS: "1000",
      }),
    ).toThrow(/heartbeat.*smaller/iu);
    expect(() =>
      parseGenerationWorkerConfig({
        ...baseEnvironment,
        PI_AGENT_WORKER_CONCURRENCY: "2",
        PI_AGENT_WORKER_GLOBAL_CONCURRENCY: "1",
      }),
    ).toThrow(/must not exceed/iu);
  });

  it("parses durable worker defaults without changing application mode", () => {
    expect(parseGenerationWorkerConfig(baseEnvironment)).toMatchObject({
      poolKey: "generation",
      concurrency: 1,
      pollIntervalMs: 1_000,
      dispatchLeaseTtlMs: 120_000,
      dispatchHeartbeatIntervalMs: 30_000,
    });
  });
});

describe("generation worker lifecycle", () => {
  it("registers, claims, executes, fences completion, and releases its slot", async () => {
    const { dependencies, leaseStore } = makeDependencies();
    const worker = new GenerationWorker(
      parseGenerationWorkerConfig({
        ...baseEnvironment,
        PI_AGENT_WORKER_POLL_INTERVAL_MS: "1",
      }),
      dependencies,
    );

    await worker.start();
    expect(leaseStore.register).toHaveBeenCalledOnce();
    expect(await worker.pollOnce()).toBe(1);
    await worker.waitForIdle();

    expect(dependencies.reconcile).toHaveBeenCalledOnce();
    expect(dependencies.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "project-1",
        requestId: "request-1",
      }),
    );
    expect(dependencies.finish).toHaveBeenCalledWith(
      expect.objectContaining({ status: "completed" }),
    );
    expect(leaseStore.releaseJob).toHaveBeenCalledOnce();
    await worker.stop();
    expect(leaseStore.shutdown).toHaveBeenCalledOnce();
  });

  it("uses the slots assigned by the shared global pool", async () => {
    const { dependencies, leaseStore } = makeDependencies();
    leaseStore.register = vi.fn(async () => [3]);
    const worker = new GenerationWorker(
      parseGenerationWorkerConfig({
        ...baseEnvironment,
        PI_AGENT_WORKER_GLOBAL_CONCURRENCY: "4",
      }),
      dependencies,
    );

    await worker.start();
    await worker.pollOnce();
    await worker.waitForIdle();

    expect(leaseStore.assignJob).toHaveBeenCalledWith(
      expect.anything(),
      3,
      job().id,
    );
    await worker.stop();
  });

  it("marks execution failures terminal without retrying malformed work in memory", async () => {
    const { dependencies, leaseStore } = makeDependencies({
      execute: vi.fn(async () => {
        throw new Error("invalid durable envelope");
      }),
    });
    const worker = new GenerationWorker(
      parseGenerationWorkerConfig(baseEnvironment),
      dependencies,
    );

    await worker.start();
    await worker.pollOnce();
    await worker.waitForIdle();

    expect(dependencies.finish).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "failed",
        errorMessage: "invalid durable envelope",
      }),
    );
    expect(leaseStore.releaseJob).toHaveBeenCalledOnce();
    await worker.stop();
  });

  it("does not treat a concurrent claim as an execution failure", async () => {
    const { dependencies, leaseStore } = makeDependencies({
      claimExisting: vi.fn(async () => {
        throw new Error("claim race");
      }),
    });
    const worker = new GenerationWorker(
      parseGenerationWorkerConfig(baseEnvironment),
      dependencies,
    );

    await worker.start();
    expect(await worker.pollOnce()).toBe(0);
    expect(dependencies.execute).not.toHaveBeenCalled();
    expect(dependencies.finish).not.toHaveBeenCalled();
    expect(leaseStore.releaseJob).toHaveBeenCalledOnce();
    await worker.stop();
  });

  it("does not register a worker when schema readiness fails", async () => {
    const base = makeDependencies();
    const { dependencies } = makeDependencies({
      store: {
        ...base.leaseStore,
        assertSchemaReady: vi.fn(async () => {
          throw new GenerationWorkerError(
            "GENERATION_WORKER_SCHEMA_NOT_READY",
            "schema is missing agent_worker_slots",
          );
        }),
      },
    });
    const worker = new GenerationWorker(parseGenerationWorkerConfig(baseEnvironment), dependencies);

    await expect(worker.start()).rejects.toMatchObject({
      code: "GENERATION_WORKER_SCHEMA_NOT_READY",
    });
    expect(base.leaseStore.register).not.toHaveBeenCalled();
  });
});
