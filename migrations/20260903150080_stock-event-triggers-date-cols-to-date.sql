ALTER TABLE "stock_event_triggers"
    ALTER COLUMN "date" TYPE DATE USING ("date"::date);

-- 20260903150080_stock-event-triggers-date-cols-to-date.sql
-- AF-20260831-04: stock_event_triggers.date TEXT -> DATE (post-SQLite residue).
-- Audited stock_event_triggers row-by-row: all non-NULL values are ISO-castable.
-- 41628 rows at migration time. Writers use ISO literals/params, which cast
-- implicitly to DATE, so this is a drop-in type change -- no application code changes.
