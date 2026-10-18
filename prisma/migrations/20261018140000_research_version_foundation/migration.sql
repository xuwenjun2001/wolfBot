-- Additive only: legacy runs/sources/reports/events remain readable by old code.
BEGIN;
CREATE TABLE company_research_tasks (
  id TEXT PRIMARY KEY, actor_id TEXT NOT NULL, request_key TEXT NOT NULL, payload_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','queued','running','partial','completed','failed','cancelled')),
  request_revision INTEGER NOT NULL DEFAULT 1 CHECK (request_revision > 0),
  plan_revision INTEGER NOT NULL DEFAULT 0 CHECK (plan_revision >= 0),
  report_revision INTEGER NOT NULL DEFAULT 0 CHECK (report_revision >= 0),
  generation INTEGER NOT NULL DEFAULT 0 CHECK (generation >= 0), sequence INTEGER NOT NULL DEFAULT 0 CHECK (sequence >= 0),
  active_attempt_id TEXT, cancel_requested BOOLEAN NOT NULL DEFAULT false,
  tool_calls INTEGER NOT NULL DEFAULT 0 CHECK (tool_calls >= 0),
  input_tokens INTEGER CHECK (input_tokens >= 0), output_tokens INTEGER CHECK (output_tokens >= 0),
  unknown_model_requests INTEGER NOT NULL DEFAULT 0 CHECK (unknown_model_requests >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), started_at TIMESTAMPTZ, deadline TIMESTAMPTZ,
  UNIQUE(actor_id,request_key)
);
CREATE INDEX company_research_task_owner ON company_research_tasks(actor_id,created_at);
CREATE TABLE company_research_requests (
  task_id TEXT NOT NULL REFERENCES company_research_tasks(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL CHECK (revision > 0), payload_hash TEXT NOT NULL, spec JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), PRIMARY KEY(task_id,revision)
);
CREATE TABLE company_research_plans (
  task_id TEXT NOT NULL REFERENCES company_research_tasks(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL CHECK (revision > 0), request_revision INTEGER NOT NULL,
  request_key TEXT NOT NULL, payload_hash TEXT NOT NULL, plan JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), PRIMARY KEY(task_id,revision),
  UNIQUE(task_id,request_key), UNIQUE(task_id,revision,request_revision),
  FOREIGN KEY(task_id,request_revision) REFERENCES company_research_requests(task_id,revision) ON DELETE CASCADE
);
CREATE TABLE company_research_documents (
  task_id TEXT NOT NULL REFERENCES company_research_tasks(id) ON DELETE CASCADE,
  id TEXT NOT NULL, version INTEGER NOT NULL CHECK (version > 0), bytes_sha256 TEXT NOT NULL,
  original_key TEXT NOT NULL, parsed_key TEXT, state TEXT NOT NULL, metadata JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), PRIMARY KEY(task_id,id,version),
  CHECK (bytes_sha256 ~ '^[a-f0-9]{64}$' AND original_key=bytes_sha256)
);
CREATE INDEX company_research_document_hash ON company_research_documents(task_id,bytes_sha256);
CREATE TABLE company_research_attempts (
  id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES company_research_tasks(id) ON DELETE CASCADE,
  request_revision INTEGER NOT NULL, plan_revision INTEGER NOT NULL, generation INTEGER NOT NULL CHECK (generation > 0),
  worker TEXT NOT NULL, status TEXT NOT NULL CHECK (status IN ('running','completed','partial','failed','cancelled','superseded')),
  lease_until TIMESTAMPTZ NOT NULL, started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), finished_at TIMESTAMPTZ,
  UNIQUE(task_id,generation), UNIQUE(task_id,id,generation),
  FOREIGN KEY(task_id,plan_revision,request_revision) REFERENCES company_research_plans(task_id,revision,request_revision) ON DELETE CASCADE
);
CREATE UNIQUE INDEX company_research_one_active_attempt ON company_research_attempts(task_id) WHERE status='running';
CREATE TABLE company_research_report_versions (
  task_id TEXT NOT NULL REFERENCES company_research_tasks(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL CHECK (revision > 0), request_revision INTEGER NOT NULL, plan_revision INTEGER NOT NULL,
  attempt_id TEXT NOT NULL, generation INTEGER NOT NULL, report JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), PRIMARY KEY(task_id,revision),
  FOREIGN KEY(task_id,plan_revision,request_revision) REFERENCES company_research_plans(task_id,revision,request_revision) ON DELETE CASCADE,
  FOREIGN KEY(task_id,attempt_id,generation) REFERENCES company_research_attempts(task_id,id,generation) ON DELETE CASCADE
);
CREATE TABLE company_research_version_events (
  task_id TEXT NOT NULL REFERENCES company_research_tasks(id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL CHECK (sequence > 0), payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), PRIMARY KEY(task_id,sequence)
);
-- Snapshots are immutable even if an application bug tries to overwrite them.
-- Deleting an owned task may cascade; retention/deletion is a separate operation.
CREATE FUNCTION company_research_reject_version_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'RESEARCH_IMMUTABLE_VERSION'; END;
$$;
CREATE TRIGGER immutable_research_request BEFORE UPDATE ON company_research_requests FOR EACH ROW EXECUTE FUNCTION company_research_reject_version_update();
CREATE TRIGGER immutable_research_plan BEFORE UPDATE ON company_research_plans FOR EACH ROW EXECUTE FUNCTION company_research_reject_version_update();
CREATE TRIGGER immutable_research_document BEFORE UPDATE ON company_research_documents FOR EACH ROW EXECUTE FUNCTION company_research_reject_version_update();
CREATE TRIGGER immutable_research_report BEFORE UPDATE ON company_research_report_versions FOR EACH ROW EXECUTE FUNCTION company_research_reject_version_update();
CREATE TRIGGER immutable_research_event BEFORE UPDATE ON company_research_version_events FOR EACH ROW EXECUTE FUNCTION company_research_reject_version_update();
COMMIT;
