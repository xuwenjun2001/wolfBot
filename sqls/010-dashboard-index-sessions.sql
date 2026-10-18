-- Durable dashboard-only index minutes. Safe to apply more than once.
CREATE SCHEMA IF NOT EXISTS quant;
CREATE TABLE IF NOT EXISTS quant.dashboard_index_sessions (
  index_key TEXT NOT NULL,
  trade_date DATE NOT NULL,
  payload JSONB NOT NULL,
  fetched_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (index_key, trade_date)
);
ALTER TABLE quant.dashboard_index_sessions
  DROP CONSTRAINT IF EXISTS dashboard_index_sessions_index_key_check;
ALTER TABLE quant.dashboard_index_sessions
  ADD CONSTRAINT dashboard_index_sessions_index_key_check
  CHECK (index_key IN ('sh', 'sz', 'cy', 'kc'));
COMMENT ON TABLE quant.dashboard_index_sessions IS
  'Dashboard index minutes: current session and its five preceding trading days; amounts CNY, volume lots; includes STAR Market index.';
