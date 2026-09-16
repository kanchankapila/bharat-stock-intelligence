ALTER TABLE "screener_sector_rotation"
    ALTER COLUMN "date" TYPE DATE USING ("date"::date);

-- 20260903150025_screener-sector-rotation-date-cols-to-date.sql
-- AF-20260831-04: screener_sector_rotation.date TEXT -> DATE (post-SQLite residue).
-- Audited screener_sector_rotation row-by-row: all non-NULL values are ISO-castable.
-- 645 rows at migration time. Writers use ISO literals/params, which cast
-- implicitly to DATE, so this is a drop-in type change -- no application code changes.
