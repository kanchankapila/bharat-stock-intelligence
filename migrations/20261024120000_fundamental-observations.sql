-- Preserve actual observations before the vendor's mutable projection overwrites them.
-- Baseline rows become known now; fiscal periods and vendor fetched_at are not availability clocks.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

CREATE TABLE fundamental_observations (
  observation_id BIGSERIAL PRIMARY KEY,
  source_table TEXT NOT NULL,
  symbol TEXT NOT NULL,
  observed_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  observation_kind TEXT NOT NULL CHECK (observation_kind IN ('BASELINE', 'INSERT', 'UPDATE')),
  values_json JSONB NOT NULL
);
CREATE INDEX idx_fundamental_observations_source_symbol_time
  ON fundamental_observations(source_table, symbol, observed_at DESC, observation_id DESC);
CREATE INDEX idx_fundamental_observations_time ON fundamental_observations(observed_at DESC);

CREATE FUNCTION journal_fundamental_observation() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  -- Resolve beside the source table, including in private test schemas.
  EXECUTE format(
    'INSERT INTO %I.fundamental_observations (source_table, symbol, observation_kind, values_json) '
    'VALUES ($1, $2, $3, $4)', TG_TABLE_SCHEMA
  ) USING TG_TABLE_NAME, NEW.symbol, TG_OP, to_jsonb(NEW);
  RETURN NEW;
END;
$$;

CREATE TRIGGER mc_earnings_forecast_observation
  AFTER INSERT OR UPDATE ON mc_earnings_forecast
  FOR EACH ROW EXECUTE FUNCTION journal_fundamental_observation();
CREATE TRIGGER mc_estimates_hits_misses_observation
  AFTER INSERT OR UPDATE ON mc_estimates_hits_misses
  FOR EACH ROW EXECUTE FUNCTION journal_fundamental_observation();
CREATE TRIGGER mc_price_forecast_observation
  AFTER INSERT OR UPDATE ON mc_price_forecast
  FOR EACH ROW EXECUTE FUNCTION journal_fundamental_observation();
CREATE TRIGGER tl_financial_quality_observation
  AFTER INSERT OR UPDATE ON tl_financial_quality
  FOR EACH ROW EXECUTE FUNCTION journal_fundamental_observation();

INSERT INTO fundamental_observations (source_table, symbol, observation_kind, values_json)
SELECT 'mc_earnings_forecast', symbol, 'BASELINE', to_jsonb(t) FROM mc_earnings_forecast t
UNION ALL
SELECT 'mc_estimates_hits_misses', symbol, 'BASELINE', to_jsonb(t) FROM mc_estimates_hits_misses t
UNION ALL
SELECT 'mc_price_forecast', symbol, 'BASELINE', to_jsonb(t) FROM mc_price_forecast t
UNION ALL
SELECT 'tl_financial_quality', symbol, 'BASELINE', to_jsonb(t) FROM tl_financial_quality t;

CREATE FUNCTION reject_fundamental_observation_mutation() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'fundamental_observations is append-only';
END;
$$;
CREATE TRIGGER fundamental_observations_immutable
  BEFORE UPDATE OR DELETE ON fundamental_observations
  FOR EACH ROW EXECUTE FUNCTION reject_fundamental_observation_mutation();
