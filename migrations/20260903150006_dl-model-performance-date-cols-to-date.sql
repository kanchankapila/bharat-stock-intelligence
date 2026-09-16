ALTER TABLE "dl_model_performance"
    ALTER COLUMN "eval_date" TYPE DATE USING ("eval_date"::date);

-- 20260903150006_dl-model-performance-date-cols-to-date.sql
-- AF-20260831-04: dl_model_performance.eval_date TEXT -> DATE (post-SQLite residue).
-- Audited dl_model_performance row-by-row: all non-NULL values are ISO-castable.
-- 45 rows at migration time. Writers use ISO literals/params, which cast
-- implicitly to DATE, so this is a drop-in type change -- no application code changes.
