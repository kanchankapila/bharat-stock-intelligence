ALTER TABLE "corporate_actions"
    ALTER COLUMN "ex_date" TYPE DATE USING ("ex_date"::date);

-- 20260903150072_corporate-actions-date-cols-to-date.sql
-- AF-20260831-04: corporate_actions.ex_date TEXT -> DATE (post-SQLite residue).
-- Audited corporate_actions row-by-row: all non-NULL values are ISO-castable.
-- 25729 rows at migration time. Writers use ISO literals/params, which cast
-- implicitly to DATE, so this is a drop-in type change -- no application code changes.
