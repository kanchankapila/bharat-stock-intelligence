ALTER TABLE "trendlyne_analyst_targets"
    ALTER COLUMN "reco_date" TYPE DATE USING ("reco_date"::date);

-- 20260903150021_trendlyne-analyst-targets-date-cols-to-date.sql
-- AF-20260831-04: trendlyne_analyst_targets.reco_date TEXT -> DATE (post-SQLite residue).
-- Audited trendlyne_analyst_targets row-by-row: all non-NULL values are ISO-castable.
-- 512 rows at migration time. Writers use ISO literals/params, which cast
-- implicitly to DATE, so this is a drop-in type change -- no application code changes.
