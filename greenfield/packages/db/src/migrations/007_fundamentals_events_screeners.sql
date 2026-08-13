-- Up Migration
-- Stage 3 (BUILD_STAGE_3_4_SPEC.md): Class Q transfer tables, deferred from
-- Stage 0's Part C. provenance_quality is added here for the same reason
-- migration 004 added it to market_bar/delivery_stat/index_bar/corporate_action
-- -- Stage 3 rows are always 'inferred' (vendor point-in-time data that
-- cannot be re-fetched from a provider archive the way Stage 2's bhavcopy
-- can), but the column is absent from GREENFIELD_BUILD_SPEC.md's Part C
-- listing for these tables. The Stage 3 spec's own acceptance gate requires
-- reading this value back, so it must exist.

CREATE TABLE fundamental_fact (
  symbol       text NOT NULL REFERENCES security(symbol),
  metric       text NOT NULL,
  period_end   date NOT NULL,
  period_type  text NOT NULL CHECK (period_type IN ('Q','H','FY','TTM')),
  source       text NOT NULL,
  value        numeric(24,6),
  unit         text,
  availability value_availability NOT NULL DEFAULT 'available',
  announced_at timestamptz,
  available_at timestamptz NOT NULL,
  fact_id      bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  restated_of  bigint REFERENCES fundamental_fact(fact_id),
  provenance_quality text NOT NULL DEFAULT 'recorded'
    CHECK (provenance_quality IN ('recorded','inferred')),
  run_id       uuid NOT NULL REFERENCES ingestion_run(run_id),
  PRIMARY KEY (symbol, metric, period_end, period_type, source, available_at)
);
CREATE INDEX fundamental_pit_idx ON fundamental_fact (symbol, metric, available_at DESC);

CREATE TABLE ownership_fact (
  symbol       text NOT NULL REFERENCES security(symbol),
  holder_class text NOT NULL,
  period_end   date NOT NULL,
  source       text NOT NULL,
  pct          double precision CHECK (pct BETWEEN 0 AND 100),
  available_at timestamptz NOT NULL,
  provenance_quality text NOT NULL DEFAULT 'recorded'
    CHECK (provenance_quality IN ('recorded','inferred')),
  run_id       uuid NOT NULL REFERENCES ingestion_run(run_id),
  PRIMARY KEY (symbol, holder_class, period_end, source, available_at)
);

CREATE TABLE analyst_estimate (
  symbol       text NOT NULL REFERENCES security(symbol),
  metric       text NOT NULL,
  period_end   date NOT NULL,
  source       text NOT NULL,
  consensus    numeric(24,6),
  high numeric(24,6), low numeric(24,6), analysts integer,
  available_at timestamptz NOT NULL,
  provenance_quality text NOT NULL DEFAULT 'recorded'
    CHECK (provenance_quality IN ('recorded','inferred')),
  run_id       uuid NOT NULL REFERENCES ingestion_run(run_id),
  PRIMARY KEY (symbol, metric, period_end, source, available_at)
);

CREATE TABLE market_flow (
  scope        text NOT NULL,
  segment      text NOT NULL,
  flow_date    date NOT NULL,
  source       text NOT NULL,
  fii_net numeric(20,2), dii_net numeric(20,2),
  available_at timestamptz NOT NULL,
  provenance_quality text NOT NULL DEFAULT 'recorded'
    CHECK (provenance_quality IN ('recorded','inferred')),
  run_id       uuid NOT NULL REFERENCES ingestion_run(run_id),
  PRIMARY KEY (scope, segment, flow_date, source)
);

CREATE TABLE event_fact (
  source          text NOT NULL,
  source_event_id text NOT NULL,
  symbol          text REFERENCES security(symbol),
  kind            event_type NOT NULL,
  effective_at    timestamptz,
  available_at    timestamptz NOT NULL,
  headline        text,
  payload         jsonb NOT NULL DEFAULT '{}'::jsonb,
  provenance_quality text NOT NULL DEFAULT 'recorded'
    CHECK (provenance_quality IN ('recorded','inferred')),
  run_id          uuid NOT NULL REFERENCES ingestion_run(run_id),
  PRIMARY KEY (source, source_event_id)
);
CREATE INDEX event_fact_symbol_time_idx ON event_fact (symbol, kind, available_at DESC);

CREATE TABLE screener_definition (
  provider      text NOT NULL REFERENCES provider(provider),
  provider_id   text NOT NULL,
  version       integer NOT NULL DEFAULT 1,
  name          text NOT NULL,
  request_hash  text NOT NULL,
  request_body  jsonb,
  category      text,
  enabled       boolean NOT NULL DEFAULT false,
  first_seen    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, provider_id, version)
);
CREATE UNIQUE INDEX screener_request_idx ON screener_definition (provider, request_hash, version);

-- Partitioned 2025-2028: old-DB screener_appearances spans only ~2 days at
-- transfer time and the fresh kayal fetch writes "now"; a wide range like
-- market_bar's 2021-2027 would be needless. Keep it narrow but pad both ends
-- -- Stage 2 hit the "no partition for row" error twice from cutting this
-- too close.
CREATE TABLE screener_membership (
  provider     text NOT NULL,
  provider_id  text NOT NULL,
  version      integer NOT NULL,
  symbol       text NOT NULL REFERENCES security(symbol),
  observed_at  timestamptz NOT NULL,
  rank         integer,
  run_id       uuid NOT NULL REFERENCES ingestion_run(run_id),
  PRIMARY KEY (provider, provider_id, version, symbol, observed_at),
  FOREIGN KEY (provider, provider_id, version)
    REFERENCES screener_definition(provider, provider_id, version)
) PARTITION BY RANGE (observed_at);

CREATE TABLE screener_membership_2025 PARTITION OF screener_membership FOR VALUES FROM ('2025-01-01') TO ('2026-01-01');
CREATE TABLE screener_membership_2026 PARTITION OF screener_membership FOR VALUES FROM ('2026-01-01') TO ('2027-01-01');
CREATE TABLE screener_membership_2027 PARTITION OF screener_membership FOR VALUES FROM ('2027-01-01') TO ('2028-01-01');

-- Task 3.1: every row a Stage 3 transfer rejects goes here, with a reason.
-- Never silently drop -- rows_read = rows_accepted + rows_rejected must
-- balance per source table.
CREATE TABLE transfer_reject (
  reject_id     bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source_table  text NOT NULL,
  source_pk     text NOT NULL,
  reason        text NOT NULL,
  raw_snippet   jsonb,
  rejected_at   timestamptz NOT NULL DEFAULT now()
);

-- Task 3.7: dq_check registry rows for the Stage 3 tables. Same pattern as
-- migration 006 -- the dq_check/dq_result tables already exist (005), this
-- registers what Stage 3 needs checked.
INSERT INTO dq_check (check_id, label, category, target_table, severity, trading_day_aware, warn_days, fail_days, spec) VALUES
  ('corporate-actions-freshness', 'Latest event_fact announcement is current', 'freshness', 'event_fact', 'warn', true, 5, 10, '{}'::jsonb),
  ('fundamentals-coverage', 'fundamental_fact has at least one row per listed symbol', 'coverage', 'fundamental_fact', 'warn', false, NULL, NULL, '{"minCoveragePct": 95}'::jsonb),
  ('fundamentals-lag-floor', 'No fundamental_fact row violates the publication-lag floor', 'plausibility', 'fundamental_fact', 'fail', false, NULL, NULL, '{"lagFloorDays": 89}'::jsonb),
  ('fii-dii-freshness', 'Latest market_flow session is current', 'freshness', 'market_flow', 'fail', true, 1, 2, '{}'::jsonb),
  ('screener-membership-freshness', 'Latest screener_membership observation is current', 'freshness', 'screener_membership', 'warn', true, 3, 6, '{}'::jsonb);

-- Down Migration
DELETE FROM dq_check WHERE check_id IN (
  'corporate-actions-freshness', 'fundamentals-coverage', 'fundamentals-lag-floor',
  'fii-dii-freshness', 'screener-membership-freshness'
);
DROP TABLE IF EXISTS transfer_reject;
DROP TABLE IF EXISTS screener_membership_2027;
DROP TABLE IF EXISTS screener_membership_2026;
DROP TABLE IF EXISTS screener_membership_2025;
DROP TABLE IF EXISTS screener_membership;
DROP TABLE IF EXISTS screener_definition;
DROP TABLE IF EXISTS event_fact;
DROP TABLE IF EXISTS market_flow;
DROP TABLE IF EXISTS analyst_estimate;
DROP TABLE IF EXISTS ownership_fact;
DROP TABLE IF EXISTS fundamental_fact;
