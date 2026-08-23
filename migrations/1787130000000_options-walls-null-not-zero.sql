-- Up Migration
--
-- technical_signals.call_wall_dist_pct / put_wall_dist_pct were declared REAL DEFAULT 0, so
-- EVERY row is born carrying a literal 0. iv_features.py only ever UPDATEs the ~154 names
-- that have a so_option_chain row, which means the other ~93% of the daily grid stores a
-- fabricated "the option wall is exactly at spot" reading rather than "this name has no
-- options". Measured live 2026-08-23 on the latest date: of 2,196 rows, the 154 with a
-- non-zero call_wall_dist_pct ALL have an option chain, while of the 2,042 sitting at 0 only
-- 25 have ever had one. All-time: 79,694 of 84,533 rows are zero on BOTH wall columns, and
-- only 162 of those had chain data for their own date. Zero NULLs anywhere -- the default
-- guaranteed it.
--
-- This is the zero-vs-NULL artifact class recurring-bugs.md already tracks (AF-20260818-31,
-- unified_ranker.py's reporting columns): a column that reads 100% populated while being
-- ~93% fabricated, which no NOT NULL constraint, freshness check or coverage check can see.
--
-- It is not cosmetic, because ml_ensemble.py consumes it (build_features, lines 243-250):
--
--     feat['call_wall_dist_pct'] = num('call_wall_dist_pct', 5.0).clip(0, 20)
--     feat['near_call_wall']     = (feat['call_wall_dist_pct'] < 2.0).astype(np.float32)
--
-- num()'s 5.0 default is the correct neutral fill for a MISSING value -- but it only fires on
-- NULL. A stored 0 sails straight past it, so near_call_wall / near_put_wall evaluate
-- (0 < 2.0) = TRUE on ~93% of the training matrix. Two binary features that are meant to flag
-- "spot is pinned against a heavy OI strike" instead flag "this name is not in the F&O
-- segment", and wall_x_score (1/clip(cw,0.5) * signal_score / 2) is inflated to its ceiling
-- for the same rows. Dropping the DEFAULT lets num()'s existing neutral fill do its job.
--
-- near_expiry_gamma is deliberately LEFT ALONE: 0.0 is its genuine semantic value ("not
-- within 7 days of expiry"), not a stand-in for missing, and 1,481 rows legitimately carry
-- 1.0. Only the two distance columns are being repaired.
--
-- The repair predicate is BOTH columns simultaneously zero. A real chain can put one wall
-- exactly at spot (35 rows are zero on exactly one column and are left untouched), but both
-- at once is the DEFAULT's signature, not a market state. The 162 both-zero rows that do have
-- chain data for their own date are re-derived correctly on iv_features.py's next run.

ALTER TABLE technical_signals ALTER COLUMN call_wall_dist_pct DROP DEFAULT;
ALTER TABLE technical_signals ALTER COLUMN put_wall_dist_pct  DROP DEFAULT;

UPDATE technical_signals
   SET call_wall_dist_pct = NULL,
       put_wall_dist_pct  = NULL
 WHERE call_wall_dist_pct = 0
   AND put_wall_dist_pct  = 0;

-- Down Migration
UPDATE technical_signals
   SET call_wall_dist_pct = 0,
       put_wall_dist_pct  = 0
 WHERE call_wall_dist_pct IS NULL
   AND put_wall_dist_pct  IS NULL;

ALTER TABLE technical_signals ALTER COLUMN call_wall_dist_pct SET DEFAULT 0;
ALTER TABLE technical_signals ALTER COLUMN put_wall_dist_pct  SET DEFAULT 0;
