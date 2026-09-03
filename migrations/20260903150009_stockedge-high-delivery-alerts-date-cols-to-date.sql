ALTER TABLE "stockedge_high_delivery_alerts"
    ALTER COLUMN "alert_date" TYPE DATE USING ("alert_date"::date);

-- 20260903150009_stockedge-high-delivery-alerts-date-cols-to-date.sql
-- AF-20260831-04: stockedge_high_delivery_alerts.alert_date TEXT -> DATE (post-SQLite residue).
-- Audited stockedge_high_delivery_alerts row-by-row: all non-NULL values are ISO-castable.
-- 59 rows at migration time. Writers use ISO literals/params, which cast
-- implicitly to DATE, so this is a drop-in type change -- no application code changes.
