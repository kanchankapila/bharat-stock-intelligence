ALTER TABLE "intraday_breadth_snapshots"
    ALTER COLUMN "date" TYPE DATE USING ("date"::date);

-- 20260903150032_intraday-breadth-snapshots-date-cols-to-date.sql
-- AF-20260831-04: intraday_breadth_snapshots.date TEXT -> DATE (post-SQLite residue).
-- Audited intraday_breadth_snapshots row-by-row: all non-NULL values are ISO-castable.
-- 923 rows at migration time. Writers use ISO literals/params, which cast
-- implicitly to DATE, so this is a drop-in type change -- no application code changes.
