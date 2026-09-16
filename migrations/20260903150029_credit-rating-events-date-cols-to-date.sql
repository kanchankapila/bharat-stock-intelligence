ALTER TABLE "credit_rating_events"
    ALTER COLUMN "announcement_date" TYPE DATE USING ("announcement_date"::date);

-- 20260903150029_credit-rating-events-date-cols-to-date.sql
-- AF-20260831-04: credit_rating_events.announcement_date TEXT -> DATE (post-SQLite residue).
-- Audited credit_rating_events row-by-row: all non-NULL values are ISO-castable.
-- 853 rows at migration time. Writers use ISO literals/params, which cast
-- implicitly to DATE, so this is a drop-in type change -- no application code changes.
