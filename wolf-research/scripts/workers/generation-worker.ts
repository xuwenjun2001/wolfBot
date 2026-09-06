import { loadEnvConfig } from "@next/env";

loadEnvConfig(process.cwd(), process.env.NODE_ENV !== "production");

async function main(): Promise<void> {
  // Prisma reads DATABASE_URL during client initialization, so load the
  // project environment before importing the worker and its database client.
  const [{ prisma }, workerModule] = await Promise.all([
    import("../../src/lib/db/client"),
    import("../../src/lib/services/pi-agent-generation-worker"),
  ]);
  const {
    createGenerationWorker,
    GenerationWorkerError,
    parseGenerationWorkerConfig,
  } = workerModule;
  let worker: ReturnType<typeof createGenerationWorker> | null = null;
  try {
    const config = parseGenerationWorkerConfig();
    worker = createGenerationWorker(config);
    const stop = () => {
      if (worker) void worker.stop();
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    try {
      await worker.run();
    } finally {
      process.removeListener("SIGINT", stop);
      process.removeListener("SIGTERM", stop);
    }
  } catch (error) {
    if (error instanceof GenerationWorkerError) {
      const details = error.details ? ` ${JSON.stringify(error.details)}` : "";
      console.error(`[GenerationWorker:${error.code}] ${error.message}${details}`);
      process.exitCode = 1;
      return;
    }
    throw error;
  } finally {
    await worker?.stop();
    await prisma.$disconnect();
  }
}

void main().catch((error: unknown) => {
  console.error(
    `[GenerationWorker:STARTUP_FAILED] ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
});
