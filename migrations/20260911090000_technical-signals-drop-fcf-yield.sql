ALTER TABLE "technical_signals"
    DROP COLUMN IF EXISTS "fcf_yield";

-- 20260911090000_technical-signals-drop-fcf-yield.sql
-- technical_signals.fcf_yield had ZERO rows ever written (measurement.md 2026-09-10
-- live re-count; readers alias fcf_yield_approx AS fcf_yield — ml_ensemble.py:1173,
-- exit_policy.py:405 — so nothing reads the dead column either). Superseded by
-- fcf_yield_approx (migration 066 / pgClient.ts comment). Additive-safe drop.
-- ONE statement per file: node-pg-migrate's sql-file runner has a documented history
-- of silently executing only a file's first statement (measurement.md, 2026-08-25).