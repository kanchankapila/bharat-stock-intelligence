-- Up Migration
--
-- AF-20261003-06 follow-through: tick_data was a Timescale placeholder with zero rows, no
-- writer, and no reader. Keeping it in the schema advertised nonexistent tick/order-book
-- coverage to models and reviewers. Refuse the drop if any writer has appeared since the
-- live audit; the guard makes this migration non-destructive under changed circumstances.
DO $$
DECLARE n bigint;
BEGIN
  IF to_regclass('public.tick_data') IS NOT NULL THEN
    EXECUTE 'SELECT count(*) FROM public.tick_data' INTO n;
    IF n > 0 THEN RAISE EXCEPTION 'tick_data has % rows; refusing to drop', n; END IF;
  END IF;
END $$;

DROP TABLE IF EXISTS tick_data;

-- Down Migration
-- Recreate the original empty Timescale table and its policies.
CREATE TABLE IF NOT EXISTS tick_data (
  symbol TEXT NOT NULL,
  tick_time TIMESTAMPTZ NOT NULL,
  price DOUBLE PRECISION NOT NULL,
  bid DOUBLE PRECISION,
  ask DOUBLE PRECISION,
  volume BIGINT,
  volume_cum BIGINT,
  PRIMARY KEY (symbol, tick_time)
);
CREATE INDEX IF NOT EXISTS idx_tick_date ON tick_data USING btree (tick_time DESC);
CREATE INDEX IF NOT EXISTS idx_tick_symbol ON tick_data USING btree (symbol, tick_time DESC);
SELECT create_hypertable('tick_data', 'tick_time', chunk_time_interval => INTERVAL '1 day', if_not_exists => TRUE, migrate_data => TRUE);
ALTER TABLE tick_data SET (timescaledb.compress, timescaledb.compress_segmentby = 'symbol');
SELECT add_compression_policy('tick_data', INTERVAL '7 days', if_not_exists => TRUE);
SELECT add_retention_policy('tick_data', INTERVAL '30 days', if_not_exists => TRUE);
