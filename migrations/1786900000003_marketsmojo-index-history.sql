-- Up Migration
--
-- MarketsMojo's market_marketoverview/getGraphData (period=1M/1Y/3Y, NOT 1D/1w which are
-- intraday minute-ticks) returns real daily-granularity index price history -- confirmed live
-- 2026-08-11: 743 days (~3 years) for indice=1 (SENSEX), unauthenticated. macro_asset_prices
-- (81 assets) already covers NIFTY50 and its derivatives (OI/PCR/GEX/basis) but has no SENSEX,
-- no BSE-family index (BSE100/200/500/sectoral), no NSE sectoral index (Bank Nifty, Nifty
-- Auto/IT/Pharma/...), and no global benchmark (S&P 500, Nikkei 225, FTSE 100, DAX, ...) --
-- all resolved via apiv1/markets/indices?index_ids=... to real index_id->name pairs, 81 of them.
--
-- index_id is MarketsMojo's own id space, scoped to this dedicated table (no other writer),
-- so a bare index_id PK is fine here -- the multi-provider-collision rule in
-- .claude/rules/data-sources.md applies to tables shared across providers, not this one.
CREATE TABLE IF NOT EXISTS "marketsmojo_index_history" (
  "index_id" INTEGER NOT NULL,
  "name" TEXT NOT NULL,
  "date" DATE NOT NULL,
  "price" NUMERIC,
  "fetched_at" TEXT NOT NULL,
  PRIMARY KEY ("index_id", "date")
);
CREATE INDEX IF NOT EXISTS "idx_marketsmojo_index_history_index_id" ON "marketsmojo_index_history"("index_id");

-- Down Migration
DROP TABLE IF EXISTS "marketsmojo_index_history";
