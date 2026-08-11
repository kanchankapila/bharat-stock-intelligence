-- Up Migration
--
-- MarketsMojo's get-financials (qtype=qoq, card=1) returns ~6 consecutive quarters per page
-- and keeps paginating back to real history -- confirmed live 2026-08-11 against sid=592009
-- (HDFCBANK): Dec'17 through Jun'26, ~34 quarters (~8.5 years), unauthenticated, both
-- consolidated and standalone statements. This is the fundamentals-history depth
-- .claude/rules/measurement.md flags as currently missing platform-wide (every fundamentals/
-- analyst/earnings table stuck at ~30 dates, all starting 2026-06-30 -- a calendar gap, not an
-- engineering one). ET's equivalent (ET_Stats Balance/CashFlow/Quarterly/Ratio, already wired
-- via financial_ratios_fetcher.py/working_capital_fetcher.py) tops out at 5-8 years/8 quarters;
-- this adds an independent second source with different depth and statement-line granularity.
--
-- One row per (symbol, statement, period_label, line_item): the API nests sub-line-items
-- (e.g. "Total Expenditure" -> items: [Employee Cost, Other Operating Expenses, ...]) and the
-- fetcher flattens all levels into this same grain rather than a fixed column per line item,
-- since the statement shape differs by industry (bank P&L vs manufacturer P&L have different
-- line items entirely) and hardcoding columns would silently drop whatever a given industry's
-- card doesn't share with HDFCBANK's.
CREATE TABLE IF NOT EXISTS "marketsmojo_financials_history" (
  "symbol" TEXT NOT NULL,
  "statement" TEXT NOT NULL,
  "period_label" TEXT NOT NULL,
  "line_item" TEXT NOT NULL,
  "value" NUMERIC,
  "fetched_at" TEXT NOT NULL,
  PRIMARY KEY ("symbol", "statement", "period_label", "line_item")
);
CREATE INDEX IF NOT EXISTS "idx_marketsmojo_financials_history_symbol" ON "marketsmojo_financials_history"("symbol");

-- Down Migration
DROP TABLE IF EXISTS "marketsmojo_financials_history";
