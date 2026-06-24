-- Run this against the live Postgres DB once.
-- All statements are idempotent (IF NOT EXISTS / DO NOTHING patterns).

-- Enable trigram extension (needed for GIN on TEXT LIKE queries)
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Composite index for GROUP BY symbol queries on stock_ohlcv
CREATE INDEX IF NOT EXISTS idx_stock_ohlcv_sym_date
    ON stock_ohlcv(symbol, date DESC);

-- GIN index for fast leading-wildcard LIKE on signals_json TEXT column
CREATE INDEX IF NOT EXISTS idx_tsig_signals_json_gin
    ON technical_signals USING GIN (signals_json gin_trgm_ops);

-- Remove duplicate symbol index on technical_signals (idx_tsig_sym already exists)
DROP INDEX IF EXISTS idx_technical_signals_symbol;
