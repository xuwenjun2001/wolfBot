-- Lifetime counters remain monotonic. Only a new evidence update opens a budget window.
ALTER TABLE company_research_tasks
  ADD COLUMN budget_revision INTEGER NOT NULL DEFAULT 1 CHECK (budget_revision > 0),
  ADD COLUMN budget_tool_base INTEGER NOT NULL DEFAULT 0 CHECK (budget_tool_base >= 0 AND budget_tool_base <= tool_calls);

CREATE TABLE company_research_budget_history (
  task_id TEXT NOT NULL REFERENCES company_research_tasks(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL CHECK (revision > 0),
  snapshot JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (task_id, revision)
);
CREATE TRIGGER immutable_research_budget_history BEFORE UPDATE ON company_research_budget_history
  FOR EACH ROW EXECUTE FUNCTION company_research_reject_version_update();

CREATE TABLE company_research_update_sources (
  task_id TEXT NOT NULL REFERENCES company_research_tasks(id) ON DELETE CASCADE,
  budget_revision INTEGER NOT NULL CHECK (budget_revision >= 0),
  source_hash TEXT NOT NULL CHECK (source_hash ~ '^[a-f0-9]{64}$'),
  read_at TIMESTAMPTZ,
  checked_at TIMESTAMPTZ,
  PRIMARY KEY (task_id, budget_revision, source_hash),
  CHECK (checked_at IS NULL OR read_at IS NOT NULL)
);
-- Legacy queue receipts prove no processing. Revision 0 has no independent update budget.
INSERT INTO company_research_update_sources(task_id, budget_revision, source_hash)
SELECT DISTINCT task_id, 0, jsonb_array_elements_text(payload->'event'->'sourceHashes')
FROM company_research_version_events WHERE payload->'event'->>'type' = 'report.update.queued';
