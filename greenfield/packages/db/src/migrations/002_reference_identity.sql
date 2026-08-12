-- Up Migration
CREATE TABLE security (
  symbol          text PRIMARY KEY CHECK (symbol ~ '^[A-Z0-9&$-]{1,20}$'),
  isin            char(12),
  name            text NOT NULL,
  exchange        exchange_code NOT NULL DEFAULT 'NSE',
  series          text,
  sector          text,
  industry        text,
  status          security_status NOT NULL DEFAULT 'listed',
  listed_from     date,
  listed_to       date,
  face_value      numeric(12,4),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX security_isin_idx   ON security (isin);
CREATE INDEX security_status_idx ON security (status);
CREATE INDEX security_name_trgm  ON security USING gin (name gin_trgm_ops);

-- Bitemporal provider mapping. Provider is ALWAYS part of the key.
CREATE TABLE provider_security_id (
  provider        text NOT NULL,
  provider_id     text NOT NULL,
  symbol          text NOT NULL REFERENCES security(symbol),
  valid_from      timestamptz NOT NULL DEFAULT now(),
  valid_to        timestamptz,
  verified_at     timestamptz,
  provenance      text NOT NULL,          -- 'seed' | 'autocomplete' | 'manual'
  confidence      double precision NOT NULL DEFAULT 1.0,
  PRIMARY KEY (provider, provider_id, valid_from)
);
CREATE UNIQUE INDEX provider_security_active_idx
  ON provider_security_id (provider, symbol) WHERE valid_to IS NULL;
CREATE INDEX provider_security_symbol_idx ON provider_security_id (symbol);

-- Explicit, queryable coverage gaps. Never guess an ID; record the gap.
CREATE TABLE provider_mapping_gap (
  provider     text NOT NULL,
  symbol       text NOT NULL REFERENCES security(symbol),
  endpoint_key text NOT NULL,
  first_seen   timestamptz NOT NULL DEFAULT now(),
  last_seen    timestamptz NOT NULL DEFAULT now(),
  attempts     integer NOT NULL DEFAULT 1,
  PRIMARY KEY (provider, symbol, endpoint_key)
);

CREATE TABLE trading_session (
  exchange     exchange_code NOT NULL,
  session_date date NOT NULL,
  open_at      timestamptz NOT NULL,
  close_at     timestamptz NOT NULL,
  is_holiday   boolean NOT NULL DEFAULT false,
  note         text,
  PRIMARY KEY (exchange, session_date)
);

CREATE TABLE index_definition (
  index_code  text PRIMARY KEY,
  name        text NOT NULL,
  provider_ids jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE index_membership (
  index_code   text NOT NULL REFERENCES index_definition(index_code),
  symbol       text NOT NULL REFERENCES security(symbol),
  valid_from   date NOT NULL,
  valid_to     date,
  weight       double precision,
  PRIMARY KEY (index_code, symbol, valid_from)
);

-- Down Migration
DROP TABLE IF EXISTS index_membership;
DROP TABLE IF EXISTS index_definition;
DROP TABLE IF EXISTS trading_session;
DROP TABLE IF EXISTS provider_mapping_gap;
DROP TABLE IF EXISTS provider_security_id;
DROP TABLE IF EXISTS security;
