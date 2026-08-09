-- Up Migration
--
-- screener_reliability had the same bare-scan_id PK gap already flagged (but deliberately left
-- open) in the 2026-08-04 screener_master (source, scan_id) migration note. Same mechanism:
-- MoneyControl/ETnow hand out colliding small-integer scan_ids with no cross-provider
-- coordination, and this table's writers (confluence_outcome_tracker.py's
-- recompute_screener_reliability(), monitoringService.ts, screener_performance.py's phase_d
-- win_rate_* sync) all upserted on bare scan_id -- whichever provider's screener synced first
-- for a given number silently owned the row (and its screener_name/reliability_score) forever.
-- confluence.router.ts serves this table straight to the frontend leaderboard, so a collision
-- there is user-visible, not just an internal scoring distortion.
--
-- No NULL source/scan_id rows exist (confirmed live 2026-08-04, 1441 rows: 905 trendlyne /
-- 410 etnow / 126 moneycontrol), so no backfill is needed before widening the key. No existing
-- (source, scan_id) duplicates are possible under the old scan_id-only PK (at most one row per
-- scan_id already), so this ADD PRIMARY KEY cannot fail on a pre-existing collision.
ALTER TABLE screener_reliability DROP CONSTRAINT IF EXISTS screener_reliability_pkey;
ALTER TABLE screener_reliability ADD PRIMARY KEY (source, scan_id);

-- Down Migration
--
-- NOTE: will fail once any provider has synced a colliding scan_id after the up migration ran
-- (the table would then genuinely hold 2+ rows sharing one scan_id under different sources) --
-- same caveat as the screener_master and signal_outcomes source-widening migrations.
ALTER TABLE screener_reliability DROP CONSTRAINT IF EXISTS screener_reliability_pkey;
ALTER TABLE screener_reliability ADD PRIMARY KEY (scan_id);
