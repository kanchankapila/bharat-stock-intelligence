-- Up Migration
CREATE TABLE dq_check (
  check_id    text PRIMARY KEY,
  label       text NOT NULL,
  category    text NOT NULL,
  target_table text,
  severity    dq_severity NOT NULL DEFAULT 'warn',
  trading_day_aware boolean NOT NULL DEFAULT true,
  warn_days   integer,
  fail_days   integer,
  spec        jsonb NOT NULL DEFAULT '{}'::jsonb,
  enabled     boolean NOT NULL DEFAULT true
);

CREATE TABLE dq_result (
  check_id    text NOT NULL REFERENCES dq_check(check_id),
  evaluated_at timestamptz NOT NULL DEFAULT now(),
  status      dq_severity NOT NULL,
  detail      text,
  observed    jsonb NOT NULL DEFAULT '{}'::jsonb,
  run_id      uuid REFERENCES ingestion_run(run_id),
  PRIMARY KEY (check_id, evaluated_at)
);

CREATE TABLE audit_metric (
  run_id        uuid NOT NULL REFERENCES ingestion_run(run_id),
  metric_name   text NOT NULL,
  metric_version text NOT NULL,
  dimensions    jsonb NOT NULL DEFAULT '{}'::jsonb,
  value         double precision,
  n_observations bigint,
  data_watermark text NOT NULL,
  params_hash   text NOT NULL,
  code_commit   text NOT NULL,
  generated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id, metric_name, dimensions)
);

-- Down Migration
DROP TABLE IF EXISTS audit_metric;
DROP TABLE IF EXISTS dq_result;
DROP TABLE IF EXISTS dq_check;
