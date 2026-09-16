-- factor_edge_history could not record WHY a verdict was trustworthy: it stored the raw date
-- count only. Measured 2026-09-12, all 24 USABLE verdicts in the table failed a panel
-- precondition the harness never checked -- 7 on a cross-section under 50 symbols (pledge_*
-- read AUC 0.605 on 26 names), and every one of the 24 on overlapping forward windows counted
-- as independent dates (mf_big_fund_flow cleared a 20-observation bar on 33/21 = 1.6).
--
-- Existing rows keep NULL in both columns: they were graded under the old counting and are NOT
-- comparable to rows written after this migration. Do not backfill -- a computed eff_dates on a
-- historical row would fabricate a precondition that was never actually applied to its verdict.
ALTER TABLE factor_edge_history ADD COLUMN IF NOT EXISTS eff_dates REAL;
ALTER TABLE factor_edge_history ADD COLUMN IF NOT EXISTS symbols   INTEGER;
