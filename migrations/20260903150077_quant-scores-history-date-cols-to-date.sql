ALTER TABLE "quant_scores_history"
    ALTER COLUMN "snapshot_date" TYPE DATE USING ("snapshot_date"::date);

-- 20260903150077_quant-scores-history-date-cols-to-date.sql
-- AF-20260831-04: quant_scores_history.snapshot_date TEXT -> DATE (post-SQLite residue).
-- Audited quant_scores_history row-by-row: all non-NULL values are ISO-castable.
-- 38784 rows at migration time. Writers use ISO literals/params, which cast
-- implicitly to DATE, so this is a drop-in type change -- no application code changes.
