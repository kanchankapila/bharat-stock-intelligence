-- Up Migration
-- provenance_quality: Stage 2 (rebuild from provider archives) always writes 'recorded'.
-- 'inferred' is reserved for later Class-Q transfer stages copying vendor point-in-time
-- data that cannot be re-fetched. See BUILD_STAGE_0_2_SPEC.md Task 0.3 /
-- MIGRATION_AND_CUTOVER_PLAN.md Class Q.

CREATE TABLE market_bar (
  symbol        text NOT NULL REFERENCES security(symbol),
  session_date  date NOT NULL,
  interval      bar_interval NOT NULL,
  source        text NOT NULL,
  open          numeric(18,4), high numeric(18,4),
  low           numeric(18,4), close numeric(18,4),
  prev_close    numeric(18,4),
  volume        bigint,
  trades        bigint,
  turnover      numeric(20,2),
  vwap          numeric(18,4),
  is_suspect    boolean NOT NULL DEFAULT false,
  suspect_reason text,
  available_at  timestamptz NOT NULL,
  provenance_quality text NOT NULL DEFAULT 'recorded'
    CHECK (provenance_quality IN ('recorded','inferred')),
  run_id        uuid NOT NULL REFERENCES ingestion_run(run_id),
  PRIMARY KEY (symbol, session_date, interval, source),
  CHECK (high IS NULL OR low IS NULL OR high >= low),
  CHECK (volume IS NULL OR volume >= 0)
) PARTITION BY RANGE (session_date);

-- Yearly partitions 2021 (archive horizon floor, see BUILD_STAGE_0_2_SPEC.md §2.2)
-- through the current year plus one. Convert to a Timescale hypertable only if
-- measured volume proves it necessary -- not a Stage 0 prerequisite.
CREATE TABLE market_bar_2021 PARTITION OF market_bar FOR VALUES FROM ('2021-01-01') TO ('2022-01-01');
CREATE TABLE market_bar_2022 PARTITION OF market_bar FOR VALUES FROM ('2022-01-01') TO ('2023-01-01');
CREATE TABLE market_bar_2023 PARTITION OF market_bar FOR VALUES FROM ('2023-01-01') TO ('2024-01-01');
CREATE TABLE market_bar_2024 PARTITION OF market_bar FOR VALUES FROM ('2024-01-01') TO ('2025-01-01');
CREATE TABLE market_bar_2025 PARTITION OF market_bar FOR VALUES FROM ('2025-01-01') TO ('2026-01-01');
CREATE TABLE market_bar_2026 PARTITION OF market_bar FOR VALUES FROM ('2026-01-01') TO ('2027-01-01');
CREATE TABLE market_bar_2027 PARTITION OF market_bar FOR VALUES FROM ('2027-01-01') TO ('2028-01-01');

CREATE TABLE delivery_stat (
  symbol       text NOT NULL REFERENCES security(symbol),
  session_date date NOT NULL,
  source       text NOT NULL,
  delivery_qty bigint,
  delivery_pct double precision CHECK (delivery_pct BETWEEN 0 AND 100),
  available_at timestamptz NOT NULL,
  provenance_quality text NOT NULL DEFAULT 'recorded'
    CHECK (provenance_quality IN ('recorded','inferred')),
  run_id       uuid NOT NULL REFERENCES ingestion_run(run_id),
  PRIMARY KEY (symbol, session_date, source)
);

CREATE TABLE index_bar (
  index_code   text NOT NULL REFERENCES index_definition(index_code),
  session_date date NOT NULL,
  source       text NOT NULL,
  open numeric(18,4), high numeric(18,4), low numeric(18,4), close numeric(18,4),
  pe numeric(12,4), pb numeric(12,4), div_yield numeric(12,4),
  available_at timestamptz NOT NULL,
  provenance_quality text NOT NULL DEFAULT 'recorded'
    CHECK (provenance_quality IN ('recorded','inferred')),
  run_id       uuid NOT NULL REFERENCES ingestion_run(run_id),
  PRIMARY KEY (index_code, session_date, source)
);

CREATE TABLE corporate_action (
  source          text NOT NULL,
  source_event_id text NOT NULL,
  symbol          text NOT NULL REFERENCES security(symbol),
  action          action_type NOT NULL,
  ex_date         date,
  record_date     date,
  ratio_from      numeric(18,6),
  ratio_to        numeric(18,6),
  amount          numeric(18,4),
  announced_at    timestamptz,
  available_at    timestamptz NOT NULL,
  provenance_quality text NOT NULL DEFAULT 'recorded'
    CHECK (provenance_quality IN ('recorded','inferred')),
  run_id          uuid NOT NULL REFERENCES ingestion_run(run_id),
  PRIMARY KEY (source, source_event_id)
);
CREATE INDEX corporate_action_symbol_ex_idx ON corporate_action (symbol, ex_date);

-- Derived, rebuildable adjustment factors. Never mutate raw bars.
CREATE TABLE price_adjustment (
  symbol       text NOT NULL REFERENCES security(symbol),
  effective_from date NOT NULL,
  factor       numeric(18,10) NOT NULL CHECK (factor > 0),
  reason       action_type NOT NULL,
  generation_id uuid NOT NULL,
  PRIMARY KEY (symbol, effective_from, generation_id)
);

-- Down Migration
DROP TABLE IF EXISTS price_adjustment;
DROP TABLE IF EXISTS corporate_action;
DROP TABLE IF EXISTS index_bar;
DROP TABLE IF EXISTS delivery_stat;
DROP TABLE IF EXISTS market_bar_2027;
DROP TABLE IF EXISTS market_bar_2026;
DROP TABLE IF EXISTS market_bar_2025;
DROP TABLE IF EXISTS market_bar_2024;
DROP TABLE IF EXISTS market_bar_2023;
DROP TABLE IF EXISTS market_bar_2022;
DROP TABLE IF EXISTS market_bar_2021;
DROP TABLE IF EXISTS market_bar;
