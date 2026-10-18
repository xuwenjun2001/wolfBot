-- Public tactics configuration, recoverable runs and immutable evaluation evidence.
CREATE TABLE IF NOT EXISTS quant.tactic_configs (
  id text PRIMARY KEY, version integer NOT NULL DEFAULT 1,
  parameters jsonb NOT NULL, updated_by text NOT NULL, updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO quant.tactic_configs(id, parameters, updated_by) VALUES
 ('ma55-breakout-pullback', '{"body_pct":3,"volume_ratio":1.5,"contraction_ratio":0.8,"distance_min_pct":-3,"distance_max_pct":1}', 'system')
ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS quant.tactic_runs (
  id text PRIMARY KEY, tactic_id text NOT NULL REFERENCES quant.tactic_configs(id),
  requested_date date NOT NULL, trade_date date, config_version integer NOT NULL,
  parameters jsonb NOT NULL, actor text NOT NULL,
  status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','waiting','completed','failed','cancelled')),
  phase text NOT NULL DEFAULT 'queued', total integer NOT NULL DEFAULT 0,
  processed integer NOT NULL DEFAULT 0, ready integer NOT NULL DEFAULT 0,
  excluded integer NOT NULL DEFAULT 0, gaps integer NOT NULL DEFAULT 0,
  context jsonb NOT NULL DEFAULT '{}', summary jsonb NOT NULL DEFAULT '{}', error text,
  lease_owner text, lease_until timestamptz, next_attempt_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS tactic_runs_one_active ON quant.tactic_runs(tactic_id)
 WHERE status IN ('queued','running','waiting');
CREATE INDEX IF NOT EXISTS tactic_runs_recent ON quant.tactic_runs(created_at DESC);
CREATE TABLE IF NOT EXISTS quant.tactic_run_items (
  run_id text NOT NULL REFERENCES quant.tactic_runs(id) ON DELETE CASCADE,
  symbol text NOT NULL, name text NOT NULL, status text NOT NULL,
  reason text, bars jsonb NOT NULL DEFAULT '[]', updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(run_id,symbol)
);
CREATE TABLE IF NOT EXISTS quant.tactic_windows (
  symbol text PRIMARY KEY, trade_date date NOT NULL, bars jsonb NOT NULL,
  source text NOT NULL DEFAULT 'baostock', updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS quant.tactic_events (
  id text PRIMARY KEY, tactic_id text NOT NULL REFERENCES quant.tactic_configs(id), symbol text NOT NULL,
  name text NOT NULL, breakout_date date NOT NULL, expires_date date NOT NULL,
  config_version integer NOT NULL, parameters jsonb NOT NULL,
  status text NOT NULL, signal text NOT NULL, last_evaluated date NOT NULL,
  evidence jsonb NOT NULL, run_id text NOT NULL REFERENCES quant.tactic_runs(id),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(tactic_id,symbol,breakout_date)
);
CREATE INDEX IF NOT EXISTS tactic_events_expiry ON quant.tactic_events(expires_date DESC);
CREATE TABLE IF NOT EXISTS quant.tactic_evaluations (
  run_id text NOT NULL REFERENCES quant.tactic_runs(id), event_id text NOT NULL REFERENCES quant.tactic_events(id),
  trade_date date NOT NULL, status text NOT NULL, signal text NOT NULL, evidence jsonb NOT NULL,
  PRIMARY KEY(run_id,event_id,trade_date)
);
CREATE TABLE IF NOT EXISTS quant.tactic_worker_heartbeats (
  id text PRIMARY KEY, heartbeat_at timestamptz NOT NULL DEFAULT now()
);
