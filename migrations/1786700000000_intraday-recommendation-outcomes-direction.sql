-- Up Migration
--
-- intraday_recommendation_outcomes had no direction column, so intraday_ranker.py's Sell/
-- Strong-Sell classifications were never quality-gated on realised outcomes at all -- unlike
-- Buy/Strong-Buy, which the emission gate has protected since 2026-07-31. Extending the gate to
-- the short side needs its own outcome rows, resolved independently (a long-side edge existing
-- says nothing about the short side -- the 2026-07-31 intraday audit measured fading intraday
-- strength at +0.838%/day gross on the full universe collapsing to +0.017%/day, alpha -0.031%
-- t=-0.27, once restricted to the F&O universe -- the only realistically shortable set most
-- brokers actually offer).
--
-- All existing rows are LONG (Sell was never resolved before this), so the DEFAULT backfills
-- them correctly with no separate backfill step. No existing (symbol, computed_at) duplicates
-- are possible under the old PK, so this ADD PRIMARY KEY cannot fail on a pre-existing collision.
ALTER TABLE intraday_recommendation_outcomes ADD COLUMN IF NOT EXISTS direction TEXT NOT NULL DEFAULT 'LONG';
ALTER TABLE intraday_recommendation_outcomes DROP CONSTRAINT IF EXISTS intraday_recommendation_outcomes_pkey;
ALTER TABLE intraday_recommendation_outcomes ADD PRIMARY KEY (symbol, computed_at, direction);

-- Down Migration
--
-- NOTE: will fail once any symbol/day has both a LONG and a SHORT row (the table would then
-- genuinely hold 2+ rows sharing one (symbol, computed_at) pair) -- same caveat as every other
-- source/direction-widening migration in this repo (screener_master, signal_outcomes, etc.).
ALTER TABLE intraday_recommendation_outcomes DROP CONSTRAINT IF EXISTS intraday_recommendation_outcomes_pkey;
ALTER TABLE intraday_recommendation_outcomes ADD PRIMARY KEY (symbol, computed_at);
ALTER TABLE intraday_recommendation_outcomes DROP COLUMN IF EXISTS direction;
