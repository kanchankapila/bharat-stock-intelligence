-- Up Migration
--
-- screener_master's PK was scan_id alone, but scan_id is only unique WITHIN a provider --
-- MoneyControl and ETnow each hand out their own small sequential integers with no
-- cross-provider coordination, and 7 currently collide (e.g. scan_id 173 is MC's "Double
-- Dhamaka" AND ETnow's "Warren Buffet Screener"). Under the old single-column PK this was a
-- first-writer-wins table (every sync used ON CONFLICT(scan_id) DO NOTHING/UPDATE): whichever
-- provider synced first for a given scan_id owned that row forever, and the other provider's
-- screener of the same number silently got the wrong inferred_sentiment/inferred_category
-- applied wherever confluenceEngine.ts/scoring_engine.py/screener_features_fetcher.py joined or
-- looked up screener_master by bare scan_id -- including screener_momentum_score, the largest
-- single engine weight in most unified_ranker REGIME_WEIGHTS regimes. See the 2026-08-04
-- screener_master memory for the full investigation and the list of every consumer updated
-- alongside this migration to pass source through the lookup.
--
-- source is already NOT NULL on every existing row (confirmed live 2026-08-04, all 1649 rows),
-- so no backfill/default is needed before widening the key, unlike signal_outcomes' migration.
ALTER TABLE screener_master DROP CONSTRAINT IF EXISTS screener_master_pkey;
ALTER TABLE screener_master ADD PRIMARY KEY (source, scan_id);

-- Down Migration
--
-- NOTE: this will fail once any provider has synced a colliding scan_id after the up migration
-- ran (screener_master would then genuinely hold 2+ rows sharing one scan_id, which a scan_id-
-- only PK cannot represent) -- same caveat as signal_outcomes' own source-widening migration.
ALTER TABLE screener_master DROP CONSTRAINT IF EXISTS screener_master_pkey;
ALTER TABLE screener_master ADD PRIMARY KEY (scan_id);
