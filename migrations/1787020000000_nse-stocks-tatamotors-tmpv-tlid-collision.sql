-- Up Migration
--
-- migrations/1786970000000 (the tlid-repair migration) disclosed 5 pre-existing ticker-reuse
-- tlid ambiguities it deliberately left untouched (LTM, TCC, UEL, RMC, BI), but repairing TMPV
-- to numeric tlid '1362' created a 6th, undisclosed one: TATAMOTORS already held tlid='1362'
-- (migration-safety-review, 2026-08-14). Confirmed live 2026-08-15:
--   TATAMOTORS: status=ACTIVE, tlid=1362, isin=INE155A01022, 0 rows ever in stock_ohlcv
--   TMPV:       status=ACTIVE, tlid=1362, isin=INE155A01022, 1397 days of real OHLCV through today
--   TMCV:       tlid=3327757 (already correct, no collision), isin=INE1TAE01010 (different ISIN)
--
-- TATAMOTORS and TMPV share the SAME ISIN -- they are the same underlying security. TMPV is
-- the real, continuously-traded entity (Tata Motors' passenger-vehicle business, which kept
-- the original listing after the 2025 demerger that spun off TMCV as a new listing with its
-- own ISIN); TATAMOTORS is stale pre-rename seed data that was never actually fetched
-- (0 OHLCV rows, 0 rows in technical_signals/unified_recommendations/trendlyne_stock_profile
-- ever) despite still being flagged status=ACTIVE. tlid=1362 is correctly TMPV's -- confirmed
-- both by the shared ISIN and by TMPV being the row with real trading history -- so this is
-- not a "which one gets the id" ambiguity like the 5 disclosed ones; it's a stale row
-- incorrectly claiming an id that belongs to the symbol it was renamed into.
--
-- Deliberately NOT touching nse_stocks.status here -- flipping ACTIVE->INACTIVE is a larger,
-- separately-reviewable decision (other tables still hold 2 stale stock_scores rows for
-- TATAMOTORS) than this migration's scope. Clearing the colliding tlid/tlname is sufficient to
-- close the collision: nothing currently resolves real data through TATAMOTORS' tlid (it was
-- never successfully fetched), so no real coverage is lost, and any future Trendlyne fetcher
-- can no longer silently resolve to the wrong company for either symbol.
UPDATE nse_stocks SET tlid = NULL, tlname = NULL
WHERE symbol = 'TATAMOTORS' AND tlid = '1362';

-- Down Migration
--
-- Restores the pre-migration (colliding) state.
UPDATE nse_stocks SET tlid = '1362', tlname = 'tata-motors-ltd'
WHERE symbol = 'TATAMOTORS' AND tlid IS NULL;
