ALTER TABLE "investsights_fundamentals_history"
    ALTER COLUMN "fetched_date" TYPE DATE USING ("fetched_date"::date),
    ALTER COLUMN "period_end_date" TYPE DATE USING ("period_end_date"::date);

-- 20260903150052_investsights-fundamentals-history-date-cols-to-date.sql
-- AF-20260831-04: investsights_fundamentals_history.fetched_date/period_end_date TEXT -> DATE (post-SQLite residue).
-- Audited investsights_fundamentals_history row-by-row: all non-NULL values are ISO-castable.
-- 4201 rows at migration time. Writers use ISO literals/params, which cast
-- implicitly to DATE, so this is a drop-in type change -- no application code changes.
