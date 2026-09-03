ALTER TABLE "fii_dii_flow"
    ALTER COLUMN "date" TYPE DATE USING ("date"::date);

-- 20260903150042_fii-dii-flow-date-cols-to-date.sql
-- AF-20260831-04: fii_dii_flow.date TEXT -> DATE (post-SQLite residue).
-- Audited fii_dii_flow row-by-row: all non-NULL values are ISO-castable.
-- 2615 rows at migration time. Writers use ISO literals/params, which cast
-- implicitly to DATE, so this is a drop-in type change -- no application code changes.
