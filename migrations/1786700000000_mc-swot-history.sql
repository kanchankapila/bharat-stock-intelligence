-- Up Migration
--
-- MoneyControl's per-stock SWOT text (strengths/weaknesses/opportunities/threats), persisted
-- alongside mc_general_metrics' quantitative counts of the same data (see
-- persistMcConsolidatedMetrics() in mcApiService.ts) -- previously fetched and rendered by
-- MCStockInfoPanel on every panel open but never written anywhere, closing the last of the
-- "not persisted" scope note from the earlier mc_general_metrics migration. One row per item
-- so the full text is preserved for qualitative review, not just the aggregate counts.
CREATE TABLE IF NOT EXISTS "mc_swot_history" (
  "symbol" TEXT NOT NULL,
  "category" TEXT NOT NULL,
  "item_text" TEXT NOT NULL,
  "fetched_at" TEXT NOT NULL,
  PRIMARY KEY ("symbol", "category", "item_text", "fetched_at")
);
CREATE INDEX IF NOT EXISTS "idx_mc_swot_history_symbol" ON "mc_swot_history"("symbol");

-- Down Migration
DROP TABLE IF EXISTS "mc_swot_history";
