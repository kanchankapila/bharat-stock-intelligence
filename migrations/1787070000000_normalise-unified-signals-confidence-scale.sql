-- Up Migration
--
-- unified_signals.confidence_score carried TWO INCOMPATIBLE SCALES in one column. db.ts has
-- always documented it as "confidence_score REAL, -- 0-100, from any source", but four of the
-- five writers emitted a 0-1 fraction. Measured live 2026-08-16 over the full history:
--
--   signal_source       rows    scored   min     max     scale
--   AI                  28187   28187    0.000   98.000  0-100  (correct)
--   technical           24442       0    -       -       never writes one at all
--   technical_scan       6253    6253    0.100    1.000  0-1    (wrong)
--   SCREENER_SURFACING   1243    1243    0.650    0.737  0-1    (wrong)
--   screener              951     951    0.800    1.000  0-1    (wrong)
--   platform                2       1    0.800    0.800  0-1    (wrong)
--
-- Consequences, both measured rather than theorised:
--
--   1. Any threshold filter was meaningless for whichever half it was not written for. The
--      chatbot's get_buy_signals used `confidence_score >= 0.65`, which every 0-100 row cleared
--      unconditionally (49 >= 0.65) while genuinely filtering the 0-1 rows. Fixed separately in
--      commit 001a75f.
--   2. outcome_resolver.py writes `signal_score = round(confidence_score)` into
--      unified_signal_outcomes. On the 0-1 scale that rounds to 0 or 1: measured 903 zeros +
--      10 ones for technical_scan, 354 all-1 for SCREENER_SURFACING, 144 all-1 for screener --
--      1,411 rows of collapsed values sitting beside AI's genuine 0-84.
--
-- Scoped by signal_source, NOT by a `WHERE confidence_score <= 1` value predicate. AI's own
-- minimum is 0.000, so a value-based rule would silently rescale legitimate 0-100 rows that
-- happen to sit near zero. The four wrong-scale sources are enumerated explicitly, which also
-- means re-running this migration cannot compound (see the guard below).
--
-- The producing writers were fixed in the same change, so new rows arrive on 0-100:
--   technicalSignalsService.ts   r.signalScore / 10.0   -> * 10.0
--   trendlyneScreener.ts         confidence / 100       -> confidence
--   screener_signal_generator.py 0.70 + mom*0.01, 0.92  -> 70.0 + mom, 92.0   (and 0.65 -> 65.0)
--
-- unified_signals is a PLAIN table, not a hypertable (checked against
-- timescaledb_information.hypertables 2026-08-16 -- only confluence_signals is), so a
-- predicate-wide UPDATE is safe here and does not risk decompression.

UPDATE unified_signals
   SET confidence_score = confidence_score * 100
 WHERE signal_source IN ('technical_scan', 'SCREENER_SURFACING', 'screener', 'platform')
   AND confidence_score IS NOT NULL
   -- Idempotence guard: every one of these sources measured <= 1.0 before this ran, so a row
   -- already above 1 has been converted and must not be multiplied twice.
   AND confidence_score <= 1.0;

-- Down Migration
UPDATE unified_signals
   SET confidence_score = confidence_score / 100
 WHERE signal_source IN ('technical_scan', 'SCREENER_SURFACING', 'screener', 'platform')
   AND confidence_score IS NOT NULL
   AND confidence_score > 1.0;
