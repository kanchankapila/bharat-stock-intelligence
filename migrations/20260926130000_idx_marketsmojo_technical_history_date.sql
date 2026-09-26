-- Up Migration
--
-- AF-20260917-23: Freshness probes on marketsmojo_technical_history (17.3M rows)
-- run `SELECT MAX(date) FROM marketsmojo_technical_history`.
-- Without an index on date, this query took 57+ seconds and scanned 7.27M index pages,
-- causing live database lock/IPC contention during daily DQ sweeps.
CREATE INDEX IF NOT EXISTS idx_marketsmojo_tech_hist_date ON marketsmojo_technical_history (date DESC);

-- Down Migration
DROP INDEX IF EXISTS idx_marketsmojo_tech_hist_date;
