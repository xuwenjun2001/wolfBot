CREATE TABLE "company_research_runs" (
  "id" TEXT PRIMARY KEY, "actor_id" TEXT NOT NULL, "request_key" TEXT NOT NULL,
  "payload_hash" TEXT NOT NULL, "status" TEXT NOT NULL DEFAULT 'queued',
  "state" JSONB NOT NULL, "steps" JSONB NOT NULL DEFAULT '[]',
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(), "started_at" TIMESTAMPTZ,
  "finished_at" TIMESTAMPTZ, "lease_owner" TEXT, "lease_until" TIMESTAMPTZ,
  "generation" INTEGER NOT NULL DEFAULT 0, "sequence" INTEGER NOT NULL DEFAULT 0,
  "cancel_requested" BOOLEAN NOT NULL DEFAULT false, "error" TEXT,
  UNIQUE ("actor_id", "request_key")
);
CREATE INDEX "company_research_claim" ON "company_research_runs" ("status", "lease_until", "created_at");
CREATE INDEX "company_research_owner" ON "company_research_runs" ("actor_id", "created_at");
CREATE TABLE "company_research_sources" (
  "run_id" TEXT NOT NULL REFERENCES "company_research_runs"("id") ON DELETE CASCADE,
  "id" TEXT NOT NULL, "document" JSONB NOT NULL, PRIMARY KEY ("run_id", "id")
);
CREATE TABLE "company_research_reports" (
  "run_id" TEXT PRIMARY KEY REFERENCES "company_research_runs"("id") ON DELETE CASCADE,
  "report" JSONB NOT NULL, "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE "company_research_events" (
  "run_id" TEXT NOT NULL REFERENCES "company_research_runs"("id") ON DELETE CASCADE,
  "sequence" INTEGER NOT NULL, "payload" JSONB NOT NULL,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(), PRIMARY KEY ("run_id", "sequence")
);
