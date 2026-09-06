-- Restore PI Agent runtime invariants omitted from the target baseline.

ALTER TABLE "agent_runs"
  ALTER COLUMN "workspace_key" DROP DEFAULT;

ALTER TABLE "agent_runs"
  ADD CONSTRAINT "agent_runs_workspace_key_sha256_check"
  CHECK ("workspace_key" ~ '^sha256:[0-9a-f]{64}$');

CREATE UNIQUE INDEX "agent_generation_jobs_one_running_per_project_idx"
  ON "agent_generation_jobs"("project_id")
  WHERE "status" = 'running';
