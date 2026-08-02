-- Up Migration
--
-- Perf audit 2026-08-02 (live tRPC request path).
--
-- (1) screeners.router.ts's getScreenerAppearanceHistory filters `sa.symbol = ?` whenever the
-- caller doesn't supply screener_id (a valid, common call shape per its zod .refine). Only
-- idx_sa_date(appeared_date) and idx_sa_screener(screener_id) exist -- no index covers symbol,
-- so a per-stock appearance-history lookup on a stock-detail page is a full table scan.
CREATE INDEX IF NOT EXISTS idx_scap_symbol ON screener_appearances(symbol, appeared_date DESC);

-- (2) fno.router.ts's getOptionsIntelligence does `WHERE date = (SELECT MAX(date) FROM
-- stock_options_oi)`. Only idx_options_sym_date(symbol, date DESC) exists -- date isn't the
-- leading column, so the inner MAX(date) can't be answered by an index-only scan.
CREATE INDEX IF NOT EXISTS idx_soo_date ON stock_options_oi(date DESC);

-- (3) technical_signals only had two redundant single-column indexes on `symbol`
-- (idx_tsig_sym, idx_technical_signals_symbol) and one on `date` -- no composite covering the
-- "latest row for symbol X" point lookup that commandCenter.router.ts's getUnifiedScoreForSymbol
-- (rewritten 2026-08-02 to do exactly this instead of joining the whole day's cross-section) and
-- several other per-symbol "ORDER BY date DESC LIMIT 1" queries perform on every stock-detail
-- page load.
CREATE INDEX IF NOT EXISTS idx_tsig_symbol_date ON technical_signals(symbol, date DESC);

-- Down Migration
DROP INDEX IF EXISTS idx_scap_symbol;
DROP INDEX IF EXISTS idx_soo_date;
DROP INDEX IF EXISTS idx_tsig_symbol_date;
