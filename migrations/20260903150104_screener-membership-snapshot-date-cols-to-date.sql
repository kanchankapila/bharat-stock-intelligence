ALTER TABLE "screener_membership_snapshot"
    ALTER COLUMN "as_of_date" TYPE DATE USING ("as_of_date"::date);

-- 20260903150104_screener-membership-snapshot-date-cols-to-date.sql
-- AF-20260831-04: screener_membership_snapshot.as_of_date TEXT -> DATE (post-SQLite residue).
-- Audited screener_membership_snapshot row-by-row: all non-NULL values are ISO-castable.
-- 1032448 rows at migration time. Writers use ISO literals/params, which cast
-- implicitly to DATE, so this is a drop-in type change -- no application code changes.
