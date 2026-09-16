ALTER TABLE "nse_filed_corporate_actions"
    ALTER COLUMN "ex_date" TYPE DATE USING ("ex_date"::date),
    ALTER COLUMN "filing_date" TYPE DATE USING ("filing_date"::date),
    ALTER COLUMN "record_date" TYPE DATE USING ("record_date"::date);

-- 20260903150008_nse-filed-corporate-actions-date-cols-to-date.sql
-- AF-20260831-04: nse_filed_corporate_actions.ex_date/filing_date/record_date TEXT -> DATE (post-SQLite residue).
-- Audited nse_filed_corporate_actions row-by-row: all non-NULL values are ISO-castable.
-- 57 rows at migration time. Writers use ISO literals/params, which cast
-- implicitly to DATE, so this is a drop-in type change -- no application code changes.
