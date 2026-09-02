-- Up Migration
-- Task 4.5's `model-artifact-hash` check originally only reported whether an
-- active model_version row existed, never verifying anything -- its own spec
-- table entry (BUILD_STAGE_3_4_SPEC.md) always said "active model artifact's
-- stored hash matches [its source]". The check now recomputes the hash from
-- the row's own persisted spec (metrics.variant/metrics.factors + version)
-- and fails on a mismatch, so severity must be raised from 'info' to 'fail'
-- to match every other Stage 4/5 check's convention that the registered
-- severity is the ceiling the check function is allowed to emit (see
-- migration 012's shadow-rank-variance/dual-run-divergence-sane, and
-- migration 008's feature-suspect-exclusion).
UPDATE dq_check
SET severity = 'fail',
    label = 'Active model artifact''s stored hash matches a recomputation from its own persisted spec (version + variant + factors)'
WHERE check_id = 'model-artifact-hash';

-- Down Migration
UPDATE dq_check
SET severity = 'info',
    label = 'Active model artifact stored hash is present (Stage 5 populates; Stage 4 reports honestly if none yet)'
WHERE check_id = 'model-artifact-hash';
