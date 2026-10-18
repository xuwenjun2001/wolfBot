-- Acquisition metadata only: retain all cached prices and immutable event evidence.
ALTER TABLE quant.tactic_windows ADD COLUMN IF NOT EXISTS last_full_trade_date date;
ALTER TABLE quant.tactic_windows ADD COLUMN IF NOT EXISTS acquisition_version text;
ALTER TABLE quant.tactic_run_items ADD COLUMN IF NOT EXISTS acquisition jsonb NOT NULL DEFAULT '{}';
-- Legacy Baostock windows were obtained as complete qfq windows by the old worker.
UPDATE quant.tactic_windows SET last_full_trade_date=trade_date,
 acquisition_version='baostock:qfq:v1'
 WHERE source='baostock' AND acquisition_version IS NULL;
