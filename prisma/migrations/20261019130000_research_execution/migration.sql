ALTER TABLE company_research_tasks ADD COLUMN checkpoint JSONB;
CREATE TABLE company_research_claim_reviews (
  task_id TEXT NOT NULL REFERENCES company_research_tasks(id) ON DELETE CASCADE,
  claim_hash TEXT NOT NULL,
  review JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(task_id, claim_hash)
);
CREATE INDEX company_research_tasks_dispatch ON company_research_tasks(status, created_at);
CREATE TRIGGER immutable_research_claim_review BEFORE UPDATE ON company_research_claim_reviews FOR EACH ROW EXECUTE FUNCTION company_research_reject_version_update();
CREATE TABLE company_research_report_acceptances (
  task_id TEXT NOT NULL REFERENCES company_research_tasks(id) ON DELETE CASCADE,
  report_revision INTEGER NOT NULL,
  report_hash TEXT NOT NULL,
  reviewed_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(task_id, report_revision),
  FOREIGN KEY(task_id, report_revision) REFERENCES company_research_report_versions(task_id, revision) ON DELETE CASCADE
);
CREATE TRIGGER immutable_research_report_acceptance BEFORE UPDATE ON company_research_report_acceptances FOR EACH ROW EXECUTE FUNCTION company_research_reject_version_update();
