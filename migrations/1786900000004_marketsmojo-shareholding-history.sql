-- Up Migration
--
-- MarketsMojo's Stocks_Shareholding/get_results includes shareholding_graphs.data: real
-- per-quarter ownership-percentage history (Promoter/FII/MF/Insurance/Other-DII/NII holding %,
-- plus Promoter pledged %) -- confirmed live 2026-08-11 against sid=229993 (Neuland
-- Laboratories): 5 quarters so far (Jun'25 through Jun'26), unauthenticated, growing every
-- quarter. .claude/rules/measurement.md flags ownership as currently untestable platform-wide
-- ("every one of those tables has ~30 distinct dates, all starting 2026-06-30") -- this is the
-- first source on the platform with real historical depth for this category.
--
-- category is derived from the response's own block titles (e.g. "Shareholding - FII
-- Holdings" -> fii_holdings_pct), not hardcoded per statement, so a stock with a different
-- block set (e.g. no Insurance holders) doesn't silently lose data -- see the fetcher's
-- _slugify_title().
CREATE TABLE IF NOT EXISTS "marketsmojo_shareholding_history" (
  "symbol" TEXT NOT NULL,
  "category" TEXT NOT NULL,
  "period_date" DATE NOT NULL,
  "value" NUMERIC,
  "fetched_at" TEXT NOT NULL,
  PRIMARY KEY ("symbol", "category", "period_date")
);
CREATE INDEX IF NOT EXISTS "idx_marketsmojo_shareholding_history_symbol" ON "marketsmojo_shareholding_history"("symbol");

-- Down Migration
DROP TABLE IF EXISTS "marketsmojo_shareholding_history";
