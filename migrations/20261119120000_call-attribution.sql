-- AF-20261119-learning: call_attribution.py grades every published Buy after its window closes and gives each
-- miss ONE primary cause (UNFILLABLE / EVENT / STOP_TOO_TIGHT / COST / TOO_SLOW / SECTOR_DRAG / WRONG_PICK).
-- Analysis table (not a signal table): derived nightly from unified_recommendations_history + stock_ohlcv,
-- re-derivable at any time. New table, so no lock on any existing one.
CREATE TABLE IF NOT EXISTS call_attribution (
  symbol            TEXT NOT NULL,
  call_session      DATE NOT NULL,
  horizon           INTEGER NOT NULL,
  classification    TEXT,
  unified_score     DOUBLE PRECISION,
  sector            TEXT,
  regime            TEXT,
  adt               DOUBLE PRECISION,
  entry_open        DOUBLE PRECISION,
  fwd               DOUBLE PRECISION,
  excess            DOUBLE PRECISION,
  gross_excess      DOUBLE PRECISION,
  excess_2h         DOUBLE PRECISION,
  sector_rel        DOUBLE PRECISION,
  idio              DOUBLE PRECISION,
  mae               DOUBLE PRECISION,
  mfe               DOUBLE PRECISION,
  stop_dist         DOUBLE PRECISION,
  stop_hit          BOOLEAN,
  target_hit        BOOLEAN,
  target_after_stop BOOLEAN,
  unfillable        BOOLEAN,
  has_exdate        BOOLEAN,
  cause             TEXT NOT NULL,
  computed_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (symbol, call_session, horizon)
);
CREATE INDEX IF NOT EXISTS idx_call_attribution_session ON call_attribution (call_session DESC, cause);
