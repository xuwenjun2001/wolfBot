-- Research-only market data schema.
--
-- This migration intentionally uses PostgreSQL primitives only. A TimescaleDB
-- deployment may convert stock_bars and stock_factors to hypertables after the
-- migration, but the target must remain runnable on a plain local PostgreSQL.

CREATE SCHEMA IF NOT EXISTS quant;

CREATE TABLE IF NOT EXISTS quant.securities (
  symbol TEXT PRIMARY KEY,
  code TEXT NOT NULL,
  name TEXT,
  exchange TEXT NOT NULL DEFAULT 'UNKNOWN',
  asset_type TEXT NOT NULL DEFAULT 'stock',
  currency TEXT NOT NULL DEFAULT 'CNY',
  timezone TEXT NOT NULL DEFAULT 'Asia/Shanghai',
  secid TEXT,
  provider TEXT NOT NULL DEFAULT 'eastmoney',
  listed_at DATE,
  status TEXT NOT NULL DEFAULT 'active',
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS quant_securities_provider_secid_idx
  ON quant.securities (provider, secid)
  WHERE secid IS NOT NULL;

CREATE TABLE IF NOT EXISTS quant.security_universes (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  source TEXT NOT NULL DEFAULT 'manual',
  tags JSONB NOT NULL DEFAULT '[]'::jsonb,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS quant.security_universe_members (
  universe_id TEXT NOT NULL REFERENCES quant.security_universes(id) ON DELETE CASCADE,
  symbol TEXT NOT NULL REFERENCES quant.securities(symbol) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'member',
  weight NUMERIC(12, 8),
  active BOOLEAN NOT NULL DEFAULT true,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  added_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (universe_id, symbol)
);

CREATE INDEX IF NOT EXISTS quant_security_universe_members_symbol_idx
  ON quant.security_universe_members (symbol);

CREATE TABLE IF NOT EXISTS quant.stock_bars (
  symbol TEXT NOT NULL,
  ts TIMESTAMPTZ NOT NULL,
  timeframe TEXT NOT NULL DEFAULT 'daily',
  adjustment TEXT NOT NULL DEFAULT 'qfq',
  open NUMERIC(20, 8),
  high NUMERIC(20, 8),
  low NUMERIC(20, 8),
  close NUMERIC(20, 8),
  previous_close NUMERIC(20, 8),
  volume NUMERIC(24, 4) NOT NULL DEFAULT 0,
  amount NUMERIC(24, 4),
  amplitude NUMERIC(20, 8),
  change_percent NUMERIC(20, 8),
  change_amount NUMERIC(20, 8),
  turnover NUMERIC(20, 8),
  trade_status TEXT,
  is_st BOOLEAN,
  limit_up BOOLEAN,
  limit_down BOOLEAN,
  provider TEXT NOT NULL DEFAULT 'unknown',
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (symbol, timeframe, adjustment, ts, provider)
);

CREATE INDEX IF NOT EXISTS quant_stock_bars_symbol_timeframe_adjustment_ts_idx
  ON quant.stock_bars (symbol, timeframe, adjustment, ts DESC);

CREATE TABLE IF NOT EXISTS quant.stock_factors (
  symbol TEXT NOT NULL,
  ts TIMESTAMPTZ NOT NULL,
  factor_key TEXT NOT NULL,
  factor_value DOUBLE PRECISION NOT NULL,
  provider TEXT NOT NULL DEFAULT 'unknown',
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (symbol, factor_key, ts, provider)
);

CREATE INDEX IF NOT EXISTS quant_stock_factors_symbol_factor_ts_idx
  ON quant.stock_factors (symbol, factor_key, ts DESC);

CREATE TABLE IF NOT EXISTS quant.market_data_sync_state (
  symbol TEXT NOT NULL REFERENCES quant.securities(symbol) ON DELETE CASCADE,
  timeframe TEXT NOT NULL DEFAULT 'daily',
  adjustment TEXT NOT NULL DEFAULT 'qfq',
  provider TEXT NOT NULL DEFAULT 'eastmoney',
  first_ts TIMESTAMPTZ,
  last_ts TIMESTAMPTZ,
  row_count INTEGER NOT NULL DEFAULT 0,
  last_success_at TIMESTAMPTZ,
  last_error TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (symbol, timeframe, adjustment, provider)
);

CREATE INDEX IF NOT EXISTS quant_market_data_sync_state_last_ts_idx
  ON quant.market_data_sync_state (last_ts DESC);

CREATE OR REPLACE VIEW quant.canonical_stock_bars AS
SELECT
  bars.symbol,
  COALESCE(securities.code, split_part(bars.symbol, '.', 1)) AS code,
  securities.name,
  COALESCE(securities.exchange, 'UNKNOWN') AS exchange,
  COALESCE(securities.asset_type, 'stock') AS asset_type,
  securities.secid,
  bars.provider,
  bars.timeframe,
  bars.adjustment,
  bars.ts,
  bars.open,
  bars.high,
  bars.low,
  bars.close,
  bars.previous_close,
  bars.volume,
  bars.amount,
  bars.amplitude,
  bars.change_percent,
  bars.change_amount,
  bars.turnover,
  bars.trade_status,
  bars.is_st,
  bars.limit_up,
  bars.limit_down,
  bars.metadata
FROM quant.stock_bars AS bars
LEFT JOIN quant.securities AS securities ON securities.symbol = bars.symbol;

INSERT INTO quant.securities (symbol, code, name, exchange, asset_type, secid, provider, metadata)
VALUES
  ('600519', '600519', '贵州茅台', 'SH', 'stock', '1.600519', 'seed', '{"sector_hint":"liquor"}'::jsonb),
  ('000300', '000300', '沪深300', 'SH', 'index', '1.000300', 'seed', '{"sector_hint":"index"}'::jsonb),
  ('510300', '510300', '沪深300ETF华泰柏瑞', 'SH', 'etf', '1.510300', 'seed', '{"sector_hint":"etf"}'::jsonb),
  ('000001', '000001', '平安银行', 'SZ', 'stock', '0.000001', 'seed', '{"sector_hint":"bank"}'::jsonb),
  ('300750', '300750', '宁德时代', 'SZ', 'stock', '0.300750', 'seed', '{"sector_hint":"battery"}'::jsonb),
  ('600126', '600126', '杭钢股份', 'SH', 'stock', '1.600126', 'seed', '{"sector_hint":"steel"}'::jsonb),
  ('601816', '601816', '京沪高铁', 'SH', 'stock', '1.601816', 'seed', '{"sector_hint":"railway"}'::jsonb),
  ('002555', '002555', '三七互娱', 'SZ', 'stock', '0.002555', 'seed', '{"sector_hint":"gaming"}'::jsonb),
  ('600916', '600916', '中国黄金', 'SH', 'stock', '1.600916', 'seed', '{"sector_hint":"gold-retail"}'::jsonb),
  ('002624', '002624', '完美世界', 'SZ', 'stock', '0.002624', 'seed', '{"sector_hint":"gaming"}'::jsonb),
  ('600030', '600030', '中信证券', 'SH', 'stock', '1.600030', 'seed', '{"sector_hint":"brokerage"}'::jsonb)
ON CONFLICT (symbol) DO UPDATE SET
  code = EXCLUDED.code,
  name = EXCLUDED.name,
  exchange = EXCLUDED.exchange,
  asset_type = EXCLUDED.asset_type,
  secid = EXCLUDED.secid,
  metadata = quant.securities.metadata || EXCLUDED.metadata,
  updated_at = now();

INSERT INTO quant.security_universes (id, name, description, status, source, tags, metadata)
VALUES
  (
    'a-share-sample-research-pool',
    'A 股股票池',
    'Wolf Research 首版研究用股票池；完整覆盖由显式数据导入任务提供。',
    'active',
    'seed',
    '["A股","股票"]'::jsonb,
    '{"default_timeframe":"daily","default_adjustment":"qfq","universe_type":"stock"}'::jsonb
  ),
  (
    'etf-index-pool',
    'ETF/指数池',
    '用于指数和 ETF 对比研究的独立池。',
    'active',
    'seed',
    '["ETF","指数"]'::jsonb,
    '{"default_timeframe":"daily","default_adjustment":"qfq","universe_type":"etf-index"}'::jsonb
  )
ON CONFLICT (id) DO UPDATE SET
  name = EXCLUDED.name,
  description = EXCLUDED.description,
  status = EXCLUDED.status,
  tags = EXCLUDED.tags,
  metadata = quant.security_universes.metadata || EXCLUDED.metadata,
  updated_at = now();

INSERT INTO quant.security_universe_members (universe_id, symbol, role, weight, metadata)
SELECT
  CASE WHEN securities.asset_type = 'stock' THEN 'a-share-sample-research-pool' ELSE 'etf-index-pool' END,
  securities.symbol,
  'member',
  NULL,
  jsonb_build_object('seed', true)
FROM quant.securities AS securities
WHERE securities.symbol IN (
  '600519', '000001', '300750', '600126', '601816', '002555',
  '600916', '002624', '600030', '000300', '510300'
)
ON CONFLICT (universe_id, symbol) DO UPDATE SET
  active = true,
  metadata = quant.security_universe_members.metadata || EXCLUDED.metadata;
