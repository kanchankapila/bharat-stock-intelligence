ALTER TABLE "deep_learning_predictions"
    ALTER COLUMN "prediction_date" TYPE DATE USING ("prediction_date"::date);

-- 20260903150092_deep-learning-predictions-date-cols-to-date.sql
-- AF-20260831-04: deep_learning_predictions.prediction_date TEXT -> DATE (post-SQLite residue).
-- Audited deep_learning_predictions row-by-row: all non-NULL values are ISO-castable.
-- 116679 rows at migration time. Writers use ISO literals/params, which cast
-- implicitly to DATE, so this is a drop-in type change -- no application code changes.
