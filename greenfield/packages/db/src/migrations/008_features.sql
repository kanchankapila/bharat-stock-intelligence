-- Up Migration
-- Stage 4 (BUILD_STAGE_3_4_SPEC.md Task 4.1/4.2): feature_set + feature_snapshot,
-- plus model_version (Part C6) so the Task 4.5 model-artifact-hash check has a
-- real target table to read, even though nothing in Stage 4's own task list
-- trains a model -- that is Stage 5's job. The check reports "no active
-- model yet" honestly rather than this table not existing at all.

CREATE TABLE feature_set (
  feature_set_version text PRIMARY KEY,
  spec        jsonb NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  code_commit text NOT NULL
);

CREATE TABLE feature_snapshot (
  symbol              text NOT NULL REFERENCES security(symbol),
  as_of_session       date NOT NULL,
  feature_set_version text NOT NULL REFERENCES feature_set(feature_set_version),
  facts_cutoff        timestamptz NOT NULL,
  values              jsonb NOT NULL,
  coverage            double precision NOT NULL CHECK (coverage BETWEEN 0 AND 1),
  generated_at        timestamptz NOT NULL DEFAULT now(),
  run_id              uuid NOT NULL REFERENCES ingestion_run(run_id),
  PRIMARY KEY (symbol, as_of_session, feature_set_version)
) PARTITION BY RANGE (as_of_session);

CREATE TABLE feature_snapshot_2021 PARTITION OF feature_snapshot FOR VALUES FROM ('2021-01-01') TO ('2022-01-01');
CREATE TABLE feature_snapshot_2022 PARTITION OF feature_snapshot FOR VALUES FROM ('2022-01-01') TO ('2023-01-01');
CREATE TABLE feature_snapshot_2023 PARTITION OF feature_snapshot FOR VALUES FROM ('2023-01-01') TO ('2024-01-01');
CREATE TABLE feature_snapshot_2024 PARTITION OF feature_snapshot FOR VALUES FROM ('2024-01-01') TO ('2025-01-01');
CREATE TABLE feature_snapshot_2025 PARTITION OF feature_snapshot FOR VALUES FROM ('2025-01-01') TO ('2026-01-01');
CREATE TABLE feature_snapshot_2026 PARTITION OF feature_snapshot FOR VALUES FROM ('2026-01-01') TO ('2027-01-01');
CREATE TABLE feature_snapshot_2027 PARTITION OF feature_snapshot FOR VALUES FROM ('2027-01-01') TO ('2028-01-01');

CREATE TABLE model_version (
  model        text NOT NULL,
  version      text NOT NULL,
  state        model_state NOT NULL DEFAULT 'candidate',
  artifact_uri text NOT NULL,
  artifact_hash text NOT NULL,
  trained_at   timestamptz NOT NULL,
  train_window daterange NOT NULL,
  embargo_days integer NOT NULL,
  metrics      jsonb NOT NULL DEFAULT '{}'::jsonb,
  promoted_at  timestamptz,
  retired_at   timestamptz,
  code_commit  text NOT NULL,
  PRIMARY KEY (model, version)
);
CREATE UNIQUE INDEX model_single_active_idx ON model_version (model) WHERE state = 'active';

-- Task 4.5: dq_check registry rows for the Stage 4 derived tables.
INSERT INTO dq_check (check_id, label, category, target_table, severity, trading_day_aware, warn_days, fail_days, spec) VALUES
  ('feature-snapshot-coverage', 'Median feature_snapshot.coverage on the latest session >= threshold', 'coverage', 'feature_snapshot', 'warn', true, NULL, NULL, '{"minMedianCoverage": 0.8}'::jsonb),
  ('feature-snapshot-freshness', 'Latest feature_snapshot session is current', 'freshness', 'feature_snapshot', 'fail', true, 1, 3, '{}'::jsonb),
  ('feature-suspect-exclusion', 'Zero feature_snapshot rows built from a market_bar row with is_suspect=true', 'plausibility', 'feature_snapshot', 'fail', false, NULL, NULL, '{}'::jsonb),
  ('model-artifact-hash', 'Active model artifact stored hash is present (Stage 5 populates; Stage 4 reports honestly if none yet)', 'plausibility', 'model_version', 'info', false, NULL, NULL, '{}'::jsonb);

-- Down Migration
DELETE FROM dq_check WHERE check_id IN (
  'feature-snapshot-coverage', 'feature-snapshot-freshness', 'feature-suspect-exclusion', 'model-artifact-hash'
);
DROP TABLE IF EXISTS model_version;
DROP TABLE IF EXISTS feature_snapshot_2027;
DROP TABLE IF EXISTS feature_snapshot_2026;
DROP TABLE IF EXISTS feature_snapshot_2025;
DROP TABLE IF EXISTS feature_snapshot_2024;
DROP TABLE IF EXISTS feature_snapshot_2023;
DROP TABLE IF EXISTS feature_snapshot_2022;
DROP TABLE IF EXISTS feature_snapshot_2021;
DROP TABLE IF EXISTS feature_snapshot;
DROP TABLE IF EXISTS feature_set;
