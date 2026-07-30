-- Up Migration
--
-- Finding #41 (docs/audit-2026-07-28/FULL_STACK_AUDIT.md): ml.router.ts's getModelRocDiagnostics
-- joins signal_outcomes to technical_signals on (symbol, signal_date). Postgres was falling back to
-- a Nested Loop + Memoize over the two single-column indexes (idx_sout_sym, idx_sout_date) -- Round 4
-- live-measured this at 1,436ms execution time against the live 237,816-row table. A composite index
-- matching the actual join predicate lets Postgres use a direct index scan instead.
CREATE INDEX IF NOT EXISTS idx_sout_symbol_date ON signal_outcomes(symbol, signal_date);

-- Down Migration
DROP INDEX IF EXISTS idx_sout_symbol_date;
