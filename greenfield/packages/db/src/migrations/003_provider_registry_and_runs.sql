-- Up Migration
CREATE TABLE provider (
  provider        text PRIMARY KEY,
  display_name    text NOT NULL,
  base_hosts      text[] NOT NULL,
  auth_mode       text NOT NULL,             -- 'none'|'session'|'jwt'|'api_key'
  terms_url       text,
  terms_version   text,
  redistribution  text NOT NULL,             -- 'prohibited'|'attributed'|'delayed'|'permitted'
  max_rps         double precision NOT NULL DEFAULT 1,
  enabled         boolean NOT NULL DEFAULT true
);

CREATE TABLE provider_endpoint (
  endpoint_key       text PRIMARY KEY,
  provider           text NOT NULL REFERENCES provider(provider),
  integration_class  integration_class NOT NULL,
  method             text NOT NULL DEFAULT 'GET',
  url_template       text NOT NULL,
  body_template      jsonb,
  required_ids       text[] NOT NULL DEFAULT '{}',
  parser_version     text NOT NULL,
  target_table       text,
  publication_lag_min integer NOT NULL DEFAULT 0,
  retain_raw         boolean NOT NULL DEFAULT true,
  enabled            boolean NOT NULL DEFAULT false,   -- promotion is explicit
  notes              text
);

CREATE TABLE job_definition (
  job_id        text PRIMARY KEY,
  description   text NOT NULL,
  cron          text,
  timezone      text NOT NULL DEFAULT 'Asia/Kolkata',
  calendar      text,
  depends_on    text[] NOT NULL DEFAULT '{}',
  sla_minutes   integer,
  critical      boolean NOT NULL DEFAULT false,
  postconditions jsonb NOT NULL DEFAULT '{}'::jsonb,
  enabled       boolean NOT NULL DEFAULT true,
  catalog_version text NOT NULL
);

CREATE TABLE ingestion_run (
  run_id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id          text NOT NULL REFERENCES job_definition(job_id),
  endpoint_key    text REFERENCES provider_endpoint(endpoint_key),
  started_at      timestamptz NOT NULL DEFAULT now(),
  finished_at     timestamptz,
  status          run_status NOT NULL DEFAULT 'running',
  skip_reason     text,
  input_watermark text,
  output_watermark text,
  rows_seen       bigint NOT NULL DEFAULT 0,
  rows_accepted   bigint NOT NULL DEFAULT 0,
  rows_rejected   bigint NOT NULL DEFAULT 0,
  rows_written    bigint NOT NULL DEFAULT 0,
  symbols_covered integer NOT NULL DEFAULT 0,
  code_commit     text NOT NULL,
  parser_version  text,
  error_summary   text,
  CHECK (status <> 'skipped' OR skip_reason IS NOT NULL)
);
CREATE INDEX ingestion_run_job_started_idx ON ingestion_run (job_id, started_at DESC);

CREATE TABLE raw_object (
  object_id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id           uuid NOT NULL REFERENCES ingestion_run(run_id),
  endpoint_key     text NOT NULL REFERENCES provider_endpoint(endpoint_key),
  request_hash     text NOT NULL,          -- identity for POST-defined screeners
  symbol           text REFERENCES security(symbol),
  fetched_at       timestamptz NOT NULL DEFAULT now(),
  provider_timestamp timestamptz,
  http_status      integer NOT NULL,
  content_type     text,
  content_hash     text NOT NULL,
  byte_size        bigint NOT NULL,
  storage_uri      text NOT NULL,
  parse_status     text NOT NULL DEFAULT 'pending'
);
CREATE INDEX raw_object_endpoint_time_idx ON raw_object (endpoint_key, fetched_at DESC);
CREATE INDEX raw_object_hash_idx          ON raw_object (content_hash);

-- Down Migration
DROP TABLE IF EXISTS raw_object;
DROP TABLE IF EXISTS ingestion_run;
DROP TABLE IF EXISTS job_definition;
DROP TABLE IF EXISTS provider_endpoint;
DROP TABLE IF EXISTS provider;
