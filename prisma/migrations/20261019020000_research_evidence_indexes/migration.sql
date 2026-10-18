BEGIN;
CREATE TABLE company_research_evidence_indexes (
  task_id TEXT NOT NULL,
  document_id TEXT NOT NULL,
  document_version INTEGER NOT NULL CHECK (document_version > 0),
  index_version TEXT NOT NULL,
  parsed_sha256 TEXT NOT NULL CHECK (parsed_sha256 ~ '^[a-f0-9]{64}$'),
  artifact_key TEXT NOT NULL CHECK (artifact_key ~ '^[a-f0-9]{64}$'),
  byte_length INTEGER NOT NULL CHECK (byte_length BETWEEN 1 AND 50000000),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY(task_id,document_id,document_version,index_version),
  FOREIGN KEY(task_id,document_id,document_version) REFERENCES company_research_documents(task_id,id,version) ON DELETE CASCADE
);
CREATE TRIGGER immutable_research_evidence_index BEFORE UPDATE ON company_research_evidence_indexes
  FOR EACH ROW EXECUTE FUNCTION company_research_reject_version_update();
COMMIT;
