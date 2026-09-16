-- Up Migration
--
-- index_max_pain's PK was (index_name, date, expiry) with two independent writers --
-- mc_index_oi_fetcher.py (MoneyControl-derived max_pain/pcr_oi) and nt_oi_snapshot_fetcher.py
-- (NiftyTrader-derived) -- both covering NIFTY50/NIFTYBANK, confirmed colliding live: whichever
-- ran later in the day silently overwrote the other's numbers for the same key. Same class as
-- the composite-key-for-provider fixes already made to screener_master/screener_reliability/
-- screener_performance_v2/screener_performance_history/intraday_recommendation_outcomes -- see
-- .claude/rules/data-sources.md's composite-key rule.
--
-- Live-confirmed 2026-08-15: 377 rows total; NIFTY50 (104 rows: 93 MC-derived / 11 NT-derived)
-- and NIFTYBANK (99 rows: 91/8) are the only two indices both writers cover -- BANKEX, FOCIT,
-- NIFTYFINSRV, NIFTYMIDSELECT, SENSEX are NiftyTrader-only in the current index_provider_map,
-- no collision on those today, but the PK must not assume that stays true.
--
-- Existing rows are backfilled deterministically, not guessed: mc_index_oi_fetcher.py stamps
-- fetched_at via `datetime.utcnow().strftime('%Y-%m-%dT%H:%M:%SZ')` (always ends 'Z');
-- nt_oi_snapshot_fetcher.py stamps it from the NiftyTrader API's own per-record 'time' field
-- (never ends 'Z', confirmed on all 377 live rows). Same shape as signal_outcomes' migration
-- inferring signal_source from label_definition -- sound, not a guess, because the format
-- itself encodes which writer produced the row.
ALTER TABLE index_max_pain ADD COLUMN IF NOT EXISTS source TEXT;
UPDATE index_max_pain SET source = CASE WHEN fetched_at LIKE '%Z' THEN 'moneycontrol' ELSE 'niftytrader' END
  WHERE source IS NULL;
ALTER TABLE index_max_pain ALTER COLUMN source SET NOT NULL;
ALTER TABLE index_max_pain DROP CONSTRAINT IF EXISTS index_max_pain_pkey;
ALTER TABLE index_max_pain ADD PRIMARY KEY (source, index_name, date, expiry);

-- Down Migration
--
-- NOTE: will fail once both writers have produced rows for the same (index_name, date, expiry)
-- after the up migration ran (index_max_pain would then genuinely hold 2 rows per key, which
-- the old 3-column PK can't represent) -- same caveat as the screener_master/signal_outcomes
-- migrations this one mirrors.
ALTER TABLE index_max_pain DROP CONSTRAINT IF EXISTS index_max_pain_pkey;
ALTER TABLE index_max_pain ADD PRIMARY KEY (index_name, date, expiry);
ALTER TABLE index_max_pain DROP COLUMN IF EXISTS source;
