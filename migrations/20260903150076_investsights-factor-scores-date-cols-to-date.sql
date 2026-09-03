ALTER TABLE "investsights_factor_scores"
    ALTER COLUMN "fetched_date" TYPE DATE USING ("fetched_date"::date);

-- 20260903150076_investsights-factor-scores-date-cols-to-date.sql
-- AF-20260831-04: investsights_factor_scores.fetched_date TEXT -> DATE (post-SQLite residue).
-- Audited investsights_factor_scores row-by-row: all non-NULL values are ISO-castable.
-- 32707 rows at migration time. Writers use ISO literals/params, which cast
-- implicitly to DATE, so this is a drop-in type change -- no application code changes.
