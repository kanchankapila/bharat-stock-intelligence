-- AF-20261015-25: technical_signals is a deliberately retained compatibility projection.
-- Journal every mutation atomically so point-in-time lineage and writer collisions are
-- reconstructable without a flag-day rewrite of the ~60 producers and all model readers.

SET lock_timeout = '10s';

CREATE TABLE IF NOT EXISTS technical_signal_observations (
  observation_id BIGSERIAL PRIMARY KEY,
  symbol TEXT NOT NULL,
  signal_date DATE NOT NULL,
  operation TEXT NOT NULL CHECK (operation IN ('INSERT', 'UPDATE', 'DELETE')),
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  transaction_id BIGINT NOT NULL DEFAULT txid_current(),
  writer_hint TEXT NOT NULL,
  changed_columns TEXT[] NOT NULL,
  values_json JSONB NOT NULL,
  previous_values_json JSONB
);

CREATE INDEX IF NOT EXISTS idx_technical_signal_observations_symbol_date
  ON technical_signal_observations(symbol, signal_date, recorded_at DESC);
CREATE INDEX IF NOT EXISTS idx_technical_signal_observations_recorded_at
  ON technical_signal_observations(recorded_at DESC);
CREATE INDEX IF NOT EXISTS idx_technical_signal_observations_changed_columns
  ON technical_signal_observations USING GIN(changed_columns);

CREATE OR REPLACE FUNCTION journal_technical_signal_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  new_row JSONB := CASE WHEN TG_OP = 'DELETE' THEN '{}'::jsonb ELSE to_jsonb(NEW) END;
  old_row JSONB := CASE WHEN TG_OP = 'INSERT' THEN '{}'::jsonb ELSE to_jsonb(OLD) END;
  changed JSONB := '{}'::jsonb;
  previous JSONB := '{}'::jsonb;
  column_name TEXT;
  column_value JSONB;
  signal_symbol TEXT := CASE WHEN TG_OP = 'DELETE' THEN OLD.symbol ELSE NEW.symbol END;
  signal_day DATE := CASE WHEN TG_OP = 'DELETE' THEN OLD.date ELSE NEW.date END;
  writer TEXT := COALESCE(
    NULLIF(current_setting('bsi.writer', true), ''),
    NULLIF(current_setting('application_name', true), ''),
    'unknown'
  );
BEGIN
  IF TG_OP = 'INSERT' THEN
    FOR column_name, column_value IN
      SELECT key, value FROM jsonb_each(new_row - ARRAY['symbol', 'date'])
      WHERE value <> 'null'::jsonb
    LOOP
      changed := changed || jsonb_build_object(column_name, column_value);
    END LOOP;
  ELSIF TG_OP = 'UPDATE' THEN
    FOR column_name, column_value IN
      SELECT key, value FROM jsonb_each(new_row - ARRAY['symbol', 'date'])
    LOOP
      IF (old_row -> column_name) IS DISTINCT FROM column_value THEN
        changed := changed || jsonb_build_object(column_name, column_value);
        previous := previous || jsonb_build_object(column_name, old_row -> column_name);
      END IF;
    END LOOP;
    IF changed = '{}'::jsonb THEN
      RETURN NEW;
    END IF;
  ELSE
    changed := old_row - ARRAY['symbol', 'date'];
  END IF;

  INSERT INTO technical_signal_observations
    (symbol, signal_date, operation, writer_hint, changed_columns, values_json,
     previous_values_json)
  VALUES
    (signal_symbol, signal_day, TG_OP, writer,
     ARRAY(SELECT key FROM jsonb_object_keys(changed) AS key ORDER BY key),
     changed, CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE previous END);

  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

DROP TRIGGER IF EXISTS technical_signals_observation_journal ON technical_signals;
CREATE TRIGGER technical_signals_observation_journal
AFTER INSERT OR UPDATE OR DELETE ON technical_signals
FOR EACH ROW EXECUTE FUNCTION journal_technical_signal_mutation();

CREATE OR REPLACE FUNCTION reject_technical_signal_observation_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'technical_signal_observations is append-only';
END;
$$;

DROP TRIGGER IF EXISTS technical_signal_observations_immutable
  ON technical_signal_observations;
CREATE TRIGGER technical_signal_observations_immutable
BEFORE UPDATE OR DELETE ON technical_signal_observations
FOR EACH ROW EXECUTE FUNCTION reject_technical_signal_observation_mutation();

CREATE OR REPLACE VIEW v_technical_signals_current AS
SELECT * FROM technical_signals;

CREATE OR REPLACE VIEW v_technical_signal_write_activity AS
SELECT
  o.symbol,
  o.signal_date,
  changed.column_name,
  date_trunc('hour', o.recorded_at) AS write_hour,
  COUNT(*) AS write_count,
  COUNT(DISTINCT o.writer_hint) AS writer_count,
  ARRAY_AGG(DISTINCT o.writer_hint ORDER BY o.writer_hint) AS writers,
  MIN(o.recorded_at) AS first_write_at,
  MAX(o.recorded_at) AS last_write_at
FROM technical_signal_observations o
CROSS JOIN LATERAL unnest(o.changed_columns) AS changed(column_name)
GROUP BY o.symbol, o.signal_date, changed.column_name, date_trunc('hour', o.recorded_at);
