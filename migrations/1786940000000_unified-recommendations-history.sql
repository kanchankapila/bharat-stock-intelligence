-- Up Migration
--
-- unified_recommendations is keyed UNIQUE (symbol, computed_at) where computed_at is a bare DATE
-- string, so a same-day re-run REPLACES that morning's row. That is correct for the live table --
-- the row should describe the latest ranking -- but it means the earlier ranking is destroyed,
-- and with it the only evidence of what the platform actually said before the market opened.
--
-- Consequence, measured 2026-08-12: unified_recommendations holds 37 distinct computed_at dates,
-- and exactly ONE of them (2026-08-12, generated 03:00 UTC) is provably pre-market. generated_at
-- was only populated from 2026-08-10, and the 08-10 (18:23 UTC) and 08-11 (20:02 UTC) batches
-- were both generated after that day's close. The canonical ranker therefore cannot be graded
-- against forward returns at all -- not because the data is wrong, but because each run overwrote
-- the last.
--
-- This table is append-only: one row per (symbol, generated_at), so every run of the ranker is
-- preserved as its own point-in-time snapshot and a re-run can never destroy its predecessor.
-- Grading joins on generated_at < the session open, which is the whole point.
--
-- Mirrors the existing intraday_recommendations_history pattern (db.ts) rather than inventing a
-- new one: same append-only shape, same ON CONFLICT DO NOTHING discipline at the writer.
--
-- Deliberately NOT every column of unified_recommendations. This carries the ranking decision and
-- its component inputs -- enough to grade direction, conviction and geometry, and to ask which
-- engine drove a call -- not the reasoning prose or the screener name blob, which are large and
-- have no bearing on measurement.

CREATE TABLE IF NOT EXISTS unified_recommendations_history (
  symbol                TEXT        NOT NULL,
  computed_at           TEXT        NOT NULL,   -- session date, matches unified_recommendations
  generated_at          TIMESTAMPTZ NOT NULL,   -- when THIS run produced the row
  regime                TEXT,
  unified_score         DOUBLE PRECISION,
  conviction_level      TEXT,
  classification        TEXT,
  screener_stock_score  DOUBLE PRECISION,
  ml_score              DOUBLE PRECISION,
  confluence_score      DOUBLE PRECISION,
  technical_score       DOUBLE PRECISION,
  cs_score              DOUBLE PRECISION,
  breakout_score        DOUBLE PRECISION,
  smart_money_score     DOUBLE PRECISION,
  fundamental_score     DOUBLE PRECISION,
  engine_coverage_count INTEGER,
  entry_zone_low        DOUBLE PRECISION,
  stop_loss             DOUBLE PRECISION,
  target_1              DOUBLE PRECISION,
  position_size_pct     DOUBLE PRECISION,
  sector                TEXT,
  PRIMARY KEY (symbol, generated_at)
);

-- Grading always sweeps a date range and filters on generation time within it.
CREATE INDEX IF NOT EXISTS idx_urh_computed_generated
  ON unified_recommendations_history (computed_at, generated_at);

-- Seed the one genuinely pre-market batch that already exists, so the history does not start
-- empty and the first gradeable date is not lost to this migration's own timing. Restricted to
-- rows whose generated_at is populated -- everything before 2026-08-10 has no generation stamp
-- and must not be backfilled with a guess.
INSERT INTO unified_recommendations_history
  (symbol, computed_at, generated_at, regime, unified_score, conviction_level, classification,
   screener_stock_score, ml_score, confluence_score, technical_score, cs_score, breakout_score,
   smart_money_score, fundamental_score, engine_coverage_count, entry_zone_low, stop_loss,
   target_1, position_size_pct, sector)
SELECT symbol, computed_at, generated_at, regime, unified_score, conviction_level, classification,
       screener_stock_score, ml_score, confluence_score, technical_score, cs_score, breakout_score,
       smart_money_score, fundamental_score, engine_coverage_count, entry_zone_low, stop_loss,
       target_1, position_size_pct, sector
FROM unified_recommendations
WHERE generated_at IS NOT NULL
ON CONFLICT (symbol, generated_at) DO NOTHING;

-- Down Migration
DROP TABLE IF EXISTS unified_recommendations_history;
