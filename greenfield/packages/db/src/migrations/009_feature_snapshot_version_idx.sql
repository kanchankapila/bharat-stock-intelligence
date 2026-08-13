-- Up Migration
-- feature_snapshot's only index is its PK (symbol, as_of_session,
-- feature_set_version) -- by the leftmost-prefix rule, that index is
-- useless for any query filtering on feature_set_version alone (every
-- Stage 4 dq_check query in stage4-repo.ts does exactly this, and so does
-- every test's cleanup). Measured live 2026-08-13: a bare
-- `WHERE feature_set_version = 'zztest'` against the ~3.27M real 'v1' rows
-- took 10-60+s per call (a sequential scan across up to 7 yearly
-- partitions), degrading further under repeated test runs. This index
-- makes that the leading predicate.
CREATE INDEX feature_snapshot_version_idx ON feature_snapshot (feature_set_version, as_of_session);

-- CREATE INDEX does not itself update planner statistics -- on a table this
-- size the planner kept choosing a sequential scan over the new index until
-- ANALYZE ran (measured: 30s+ before, 0.21s after, same query). Baked into
-- the migration so a fresh replay never hits the same stale-statistics
-- window a manual follow-up would.
ANALYZE feature_snapshot;

-- Down Migration
DROP INDEX IF EXISTS feature_snapshot_version_idx;
