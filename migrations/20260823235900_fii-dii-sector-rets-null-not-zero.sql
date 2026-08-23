-- Up Migration
--
-- technical_signals.fii_10d_net / dii_3d_net / sector_ret_5d / sector_ret_21d were declared
-- DOUBLE PRECISION DEFAULT 0, so every row born from an INSERT that omits them carries a
-- literal 0 -- a fabricated "net FII flow was exactly zero for ten days" / "the sector moved
-- exactly 0%" reading instead of "this writer had no such data". Two writers omitted all four
-- columns from their column lists: backfill_technical_features.py's grid ensurer
-- (run_full_universe_today, ~1,800 rows/session covering ~82% of the liquid universe) and its
-- outcome-driven BACKFILL path, plus the pre-signal_type legacy era. Only technicalSignalsService.ts's
-- scanner (~397 names/day) computes real values, and its rows are visibly different: they hold
-- non-zero flows and dispersed sector returns.
--
-- Measured live 2026-08-23 (all-time, 84,533 rows): 76,525 rows (90.5%) are zero on ALL FOUR
-- columns simultaneously and NOT ONE row in the whole table is zero on some-but-not-all four --
-- zero "mixed" states exist. That makes all-four-zero the DEFAULT's signature rather than a
-- market state (a genuine zero net-flow day or a flat 5-day sector return would show up as a
-- partial pattern on scanner-written rows). Split: 61,394 GRID + 7,638 legacy-untyped +
-- 7,493 BACKFILL. On 2026-08-21 every one of the 1,799 GRID rows was fabricated
-- (sector_ret_5d count(DISTINCT)=1 for a whole trading day -- zero cross-sectional dispersion,
-- which cannot rank anything).
--
-- This is the same zero-vs-NULL artifact class as AF-20260823-77 (walls, migration
-- 1787130000000), found by re-running that sweep query after the walls landed.
--
-- It is not cosmetic, because ml_ensemble.py consumes all four (build_features):
--
--     feat['fii_10d_net'] = num('fii_10d_net', 0) / 10000.0
--     feat['sector_ret_5d']  = num('sector_ret_5d', 0)
--
-- num()'s neutral fill only fires on NULL; a stored 0 sails straight past it, so ~90% of the
-- training matrix carried "institutions were exactly flat" and "sectors went nowhere" into
-- every flow/momentum factor. Dropping the DEFAULT lets the existing neutral fill do its job.
--
-- densify_feature_matrix.NEVER_FILL already covers these four (added with this fix): after the
-- repair their coverage collapses under SPARSE_COVERAGE_THRESHOLD=0.50 and they become
-- forward-fill candidates for the first time -- carrying a stale daily flow reading or a dead
-- sector return across MAX_FILL_AGE_DAYS=120 would resurrect through the back door the exact
-- fabrication this migration removes (the second-order trap AF-77 caught for the walls).
--
-- Genuine zeros are PRESERVED: any row where at least one column is non-zero is left untouched,
-- and scanner-era rows that genuinely recorded a zero flow inside a non-zero row keep it.

ALTER TABLE technical_signals ALTER COLUMN fii_10d_net   DROP DEFAULT;
ALTER TABLE technical_signals ALTER COLUMN dii_3d_net    DROP DEFAULT;
ALTER TABLE technical_signals ALTER COLUMN sector_ret_5d  DROP DEFAULT;
ALTER TABLE technical_signals ALTER COLUMN sector_ret_21d DROP DEFAULT;

UPDATE technical_signals
   SET fii_10d_net   = NULL,
       dii_3d_net    = NULL,
       sector_ret_5d  = NULL,
       sector_ret_21d = NULL
 WHERE fii_10d_net = 0
   AND dii_3d_net = 0
   AND sector_ret_5d = 0
   AND sector_ret_21d = 0;

-- Down Migration
UPDATE technical_signals
   SET fii_10d_net   = 0,
       dii_3d_net    = 0,
       sector_ret_5d  = 0,
       sector_ret_21d = 0
 WHERE fii_10d_net IS NULL
   AND dii_3d_net IS NULL
   AND sector_ret_5d IS NULL
   AND sector_ret_21d IS NULL;

ALTER TABLE technical_signals ALTER COLUMN fii_10d_net   SET DEFAULT 0;
ALTER TABLE technical_signals ALTER COLUMN dii_3d_net    SET DEFAULT 0;
ALTER TABLE technical_signals ALTER COLUMN sector_ret_5d  SET DEFAULT 0;
ALTER TABLE technical_signals ALTER COLUMN sector_ret_21d SET DEFAULT 0;
