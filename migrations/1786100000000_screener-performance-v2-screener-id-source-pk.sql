-- Up Migration
--
-- screener_performance_v2 had the same bare-scan_id-equivalent PK gap as screener_master
-- (2026-08-04 migration) and screener_reliability (this same session) -- PRIMARY KEY
-- (screener_id) alone, with no source column. MoneyControl/ETnow hand out colliding
-- small-integer scan_ids with no cross-provider coordination; confirmed live 2026-08-04, 20
-- screener_master (source, scan_id) pairs currently collide on scan_id alone (up from 7 at the
-- screener_master migration, since 24 new MoneyControl scanners were onboarded the same day).
--
-- This table is the highest-blast-radius instance of the bug found so far: it is what
-- screener_features_fetcher.py reads bayesian_score from to build screener_momentum_score,
-- the largest single engine weight in most of unified_ranker.py's REGIME_WEIGHTS regimes, and
-- what screeners.router.ts's getScreenerLeaderboard/getScreenerDetail serve to the frontend.
-- Under the bare-screener_id PK, phase_c_bayesian's ON CONFLICT(screener_id) upsert meant
-- whichever provider's screener synced/scored LAST for a colliding scan_id silently overwrote
-- the other provider's bayesian_score/tier/win-rates -- both the ranker weight and the
-- leaderboard could already be showing/using the wrong provider's screener's performance for
-- any of these 20 pairs.
--
-- No NULL screener_id/source rows exist (confirmed live, 1649 rows: 1003 Trendlyne / 425
-- ETnow / 126 MoneyControl / 95 et_marketstats), so no backfill is needed. No existing
-- (screener_id, source) duplicates are possible under the old screener_id-only PK (at most one
-- row per screener_id already), so this ADD PRIMARY KEY cannot fail on a pre-existing
-- collision -- the collision was always silently resolved to one row, never stored as two.
ALTER TABLE screener_performance_v2 DROP CONSTRAINT IF EXISTS screener_performance_v2_pkey;
ALTER TABLE screener_performance_v2 ADD PRIMARY KEY (screener_id, source);

-- Down Migration
--
-- NOTE: will fail once any provider has scored a colliding scan_id after the up migration ran
-- (the table would then genuinely hold 2+ rows sharing one screener_id under different
-- sources) -- same caveat as every other source-widening migration in this series.
ALTER TABLE screener_performance_v2 DROP CONSTRAINT IF EXISTS screener_performance_v2_pkey;
ALTER TABLE screener_performance_v2 ADD PRIMARY KEY (screener_id);
