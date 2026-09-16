ALTER TABLE "technical_signals"
    ALTER COLUMN "date" TYPE DATE USING ("date"::date);

-- 20260825120000_technical-signals-date-to-date.sql
-- technical_signals.date: TEXT -> DATE.
--
-- WHY: the column holds pure ISO dates ('2026-08-25', audited 2026-08-25: 87,076 rows,
-- 0 NULLs, 0 non-ISO values) but is declared TEXT. TEXT dates break semantics that DATE
-- gives for free: range predicates compare by calendar, BETWEEN and window frames order
-- correctly, and any future join to stock_ohlcv.date (already a real DATE) stops being a
-- silent cross-type mismatch of the kind that zeroed the mover study's outcome merge on
-- 2026-08-25 (Timestamp vs str).
--
-- HOW: single-statement ALTER TABLE ... ALTER COLUMN ... TYPE DATE USING date::date.
-- Postgres rewrites the table under AccessExclusiveLock; at 87k rows this is fast and
-- runs inside node-pg-migrate's transaction. All btree indexes on `date`
-- (pkey(symbol,date), idx_tsig_date, idx_tsig_sym_date, idx_tsig_symbol_date) rebuild
-- automatically as part of the rewrite.
--
-- Writers are unaffected: ISO 'YYYY-MM-DD' literals and $1 params cast implicitly to
-- DATE, so every INSERT/UPDATE keeps working verbatim.
--
-- RUNNER NOTE (hit live): this repo's node-pg-migrate sql-file mode executed ONLY the
-- first statement of the initial version of this file -- which led with comment lines --
-- logged "success", and left the column TEXT. STATEMENT FIRST, COMMENTS AFTER is the
-- layout that actually applies. Verify after any rerun:
--   SELECT data_type FROM information_schema.columns
--   WHERE table_name='technical_signals' AND column_name='date';  -- expect 'date'
