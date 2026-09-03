ALTER TABLE "trendlyne_stock_profile"
    ALTER COLUMN "date" TYPE DATE USING ("date"::date),
    ALTER COLUMN "last_ex_date" TYPE DATE USING ("last_ex_date"::date);

-- 20260903150031_trendlyne-stock-profile-date-cols-to-date.sql
-- AF-20260831-04: trendlyne_stock_profile.date/last_ex_date TEXT -> DATE (post-SQLite residue).
-- Audited trendlyne_stock_profile row-by-row: all non-NULL values are ISO-castable.
-- 889 rows at migration time. Writers use ISO literals/params, which cast
-- implicitly to DATE, so this is a drop-in type change -- no application code changes.
