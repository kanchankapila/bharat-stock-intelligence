ALTER TABLE "trendlyne_adv_tech_daily"
    ALTER COLUMN "date" TYPE DATE USING ("date"::date);

-- 20260903150074_trendlyne-adv-tech-daily-date-cols-to-date.sql
-- AF-20260831-04: trendlyne_adv_tech_daily.date TEXT -> DATE (post-SQLite residue).
-- Audited trendlyne_adv_tech_daily row-by-row: all non-NULL values are ISO-castable.
-- 31805 rows at migration time. Writers use ISO literals/params, which cast
-- implicitly to DATE, so this is a drop-in type change -- no application code changes.
