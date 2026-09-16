ALTER TABLE "eco_calendar"
    ALTER COLUMN "event_date" TYPE DATE USING ("event_date"::date);

-- 20260903150034_eco-calendar-date-cols-to-date.sql
-- AF-20260831-04: eco_calendar.event_date TEXT -> DATE (post-SQLite residue).
-- Audited eco_calendar row-by-row: all non-NULL values are ISO-castable.
-- 1183 rows at migration time. Writers use ISO literals/params, which cast
-- implicitly to DATE, so this is a drop-in type change -- no application code changes.
