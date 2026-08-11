-- Up Migration
--
-- MarketsMojo's stocks/finTrendGraph returns the HISTORY of the "financial trend" score --
-- confirmed live 2026-08-11 against sid=592009 (HDFCBANK): 20 quarterly-cadence points,
-- 2021-10-16 through 2026-07-18 (~5 years), unauthenticated. Everything else on the platform
-- (marketsmojo_header_info's ext_mojo_financial_pts, endpoint_registry.py) only ever captures
-- this score's LATEST value, overwritten each run -- this is its history.
CREATE TABLE IF NOT EXISTS "marketsmojo_fintrend_history" (
  "symbol" TEXT NOT NULL,
  "date" DATE NOT NULL,
  "score" NUMERIC,
  "fin_trend_dir" INTEGER,
  "fin_txt" TEXT,
  "fetched_at" TEXT NOT NULL,
  PRIMARY KEY ("symbol", "date")
);
CREATE INDEX IF NOT EXISTS "idx_marketsmojo_fintrend_history_symbol" ON "marketsmojo_fintrend_history"("symbol");

-- Down Migration
DROP TABLE IF EXISTS "marketsmojo_fintrend_history";
