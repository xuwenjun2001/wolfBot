-- Additive MA55 close reviews, versioned prompts and local report knowledge.
CREATE TABLE IF NOT EXISTS quant.tactic_review_settings (
 tactic_id text PRIMARY KEY REFERENCES quant.tactic_configs(id),
 enabled boolean NOT NULL DEFAULT true, start_time text NOT NULL DEFAULT '18:00',
 version integer NOT NULL DEFAULT 1, updated_by text NOT NULL DEFAULT 'system',
 updated_at timestamptz NOT NULL DEFAULT now(),
 CHECK (start_time ~ '^(1[5-9]|2[01]):[0-5][0-9]$')
);
INSERT INTO quant.tactic_review_settings(tactic_id) VALUES ('ma55-breakout-pullback') ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS quant.tactic_report_prompts (
 tactic_id text NOT NULL REFERENCES quant.tactic_configs(id), version integer NOT NULL,
 content text NOT NULL CHECK(char_length(btrim(content)) BETWEEN 1 AND 20000),
 actor text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(tactic_id,version)
);
INSERT INTO quant.tactic_report_prompts(tactic_id,version,content,actor) VALUES
 ('ma55-breakout-pullback',1,'你是55线战法复盘研究员。分析当日B池每只股票的突破、缩量回踩、趋势失效及B+1/B+2表现。结合累计统计和历史日报，寻找成功与失败案例的共同特征。引用具体证据，检查历史建议是否得到新样本支持或出现反例。建议说明候选调整、预期影响和验证办法；样本不足时明确暂不支持调整。不得把选股上涨比例当成实际交易胜率，不得把重复引用当成新增证据，不得修改策略参数。用简洁中文输出。','system') ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS quant.tactic_review_jobs (
 id text PRIMARY KEY, kind text NOT NULL CHECK(kind IN ('review','report')),
 trade_date date NOT NULL, actor text NOT NULL, status text NOT NULL DEFAULT 'queued'
 CHECK(status IN ('queued','running','waiting','completed','failed')),
 input jsonb NOT NULL DEFAULT '{}', result jsonb NOT NULL DEFAULT '{}', error text,
 attempts integer NOT NULL DEFAULT 0, lease_owner text, lease_until timestamptz,
 next_attempt_at timestamptz NOT NULL DEFAULT now(), created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS tactic_review_active ON quant.tactic_review_jobs(kind,trade_date)
 WHERE status IN ('queued','running','waiting');
CREATE TABLE IF NOT EXISTS quant.tactic_performances (
 event_id text NOT NULL REFERENCES quant.tactic_events(id), trade_date date NOT NULL,
 horizon integer NOT NULL CHECK(horizon IN (1,2)), data jsonb NOT NULL,
 updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(event_id,trade_date)
);
CREATE TABLE IF NOT EXISTS quant.tactic_review_snapshots (
 id text PRIMARY KEY, trade_date date NOT NULL, digest text NOT NULL,
 data jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(trade_date,digest)
);
CREATE TABLE IF NOT EXISTS quant.tactic_reports (
 id text PRIMARY KEY, trade_date date NOT NULL, revision integer NOT NULL,
 job_id text NOT NULL UNIQUE REFERENCES quant.tactic_review_jobs(id),
 snapshot_id text NOT NULL REFERENCES quant.tactic_review_snapshots(id),
 prompt_version integer NOT NULL, model text NOT NULL, response_model text,
 effort text NOT NULL, summary text NOT NULL, content jsonb NOT NULL, input jsonb NOT NULL,
 usage jsonb NOT NULL DEFAULT '{}', duration_seconds double precision NOT NULL DEFAULT 0,
 knowledge_enabled boolean NOT NULL DEFAULT true, knowledge_updated_by text,
 knowledge_updated_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(trade_date,revision)
);
CREATE TABLE IF NOT EXISTS quant.tactic_report_chunks (
 id text PRIMARY KEY, report_id text NOT NULL REFERENCES quant.tactic_reports(id),
 title text NOT NULL, content text NOT NULL, event_ids jsonb NOT NULL DEFAULT '[]',
 symbols jsonb NOT NULL DEFAULT '[]', rule_tags jsonb NOT NULL DEFAULT '[]',
 config_versions jsonb NOT NULL DEFAULT '[]'
);
CREATE INDEX IF NOT EXISTS tactic_reports_date ON quant.tactic_reports(trade_date DESC,revision DESC);
CREATE INDEX IF NOT EXISTS tactic_chunks_report ON quant.tactic_report_chunks(report_id);
