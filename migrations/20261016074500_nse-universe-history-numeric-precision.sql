-- AF-20261015-13. Live preflight on 2026-10-16 found 3,417,167 rows / 464 MB,
-- not the stale 19M-row compressed-hypertable estimate. All three count columns had
-- zero fractional values; their maxima (8.45B volume, 4.56B delivery) cannot be stored
-- exactly in REAL. One ALTER rewrites the table once rather than eleven times.
SET lock_timeout = '10s';
SET statement_timeout = '20min';

ALTER TABLE nse_universe_history
  ALTER COLUMN prev_close TYPE DOUBLE PRECISION USING prev_close::double precision,
  ALTER COLUMN open TYPE DOUBLE PRECISION USING open::double precision,
  ALTER COLUMN high TYPE DOUBLE PRECISION USING high::double precision,
  ALTER COLUMN low TYPE DOUBLE PRECISION USING low::double precision,
  ALTER COLUMN close TYPE DOUBLE PRECISION USING close::double precision,
  ALTER COLUMN avg_price TYPE DOUBLE PRECISION USING avg_price::double precision,
  ALTER COLUMN volume TYPE BIGINT USING round(volume)::bigint,
  ALTER COLUMN turnover_lacs TYPE DOUBLE PRECISION USING turnover_lacs::double precision,
  ALTER COLUMN num_trades TYPE BIGINT USING round(num_trades)::bigint,
  ALTER COLUMN deliv_qty TYPE BIGINT USING round(deliv_qty)::bigint,
  ALTER COLUMN deliv_pct TYPE DOUBLE PRECISION USING deliv_pct::double precision;

