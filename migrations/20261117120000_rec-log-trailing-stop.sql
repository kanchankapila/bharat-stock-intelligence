-- AF-20261117: trailingStopUpdater.ts overwrote recommendation_log.stop_loss in place, so the
-- resolver graded with the final ratcheted stop as the initial stop from the first bar (look-ahead)
-- and booked trailed winners STOP_LOSS -> LOSS. The trail now lives in its own column.
--
-- Restore the published stop for scoring_engine rows. scoring_engine computes stop and target_1 from
-- one ATR fraction (technical_analysis_engine.compute_atr_barriers, stop/target multiplier ratio 0.6,
-- clamps stop 2-8% and target 3-15%), so the stop is a pure function of the never-mutated target_1:
-- stop = round(entry * (1 - clamp(0.6 * (target_1/entry - 1), 0.02, 0.08)), 2). Verified 2026-11-17 on
-- the never-trailed STRONG_BUY rows: 17,366 of 17,366 within 0.01. A row is restored only when its
-- stored stop sits above that value (only a ratchet raises it); 6,239 BUY rows matched on 2026-11-17.
-- technical_scan rows use a different stop formula and are left alone.
SET LOCAL lock_timeout = '5s';

ALTER TABLE recommendation_log ADD COLUMN IF NOT EXISTS trailing_stop DOUBLE PRECISION;

WITH k AS (
  SELECT id, stop_loss AS ratcheted,
         round((entry_price * (1 - LEAST(GREATEST(0.6 * (target_1 / entry_price - 1), 0.02), 0.08)))::numeric, 2)::float8 AS published
    FROM recommendation_log
   WHERE source = 'scoring_engine' AND entry_price > 0 AND target_1 > 0 AND stop_loss > 0
)
UPDATE recommendation_log r
   SET trailing_stop = GREATEST(COALESCE(r.trailing_stop, k.ratcheted), k.ratcheted),
       stop_loss = k.published
  FROM k
 WHERE r.id = k.id AND k.ratcheted > k.published + 0.011;
