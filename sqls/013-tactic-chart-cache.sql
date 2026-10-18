CREATE TABLE IF NOT EXISTS quant.tactic_chart_cache (
  symbol text NOT NULL,
  mode text NOT NULL CHECK(mode IN ('daily','session')),
  parameters text NOT NULL,
  payload jsonb NOT NULL,
  fetched_at timestamptz NOT NULL,
  PRIMARY KEY(symbol,mode,parameters)
);
