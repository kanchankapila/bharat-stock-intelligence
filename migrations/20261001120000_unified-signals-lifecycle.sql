-- AF-20261001-37: a published signal carries its validity window and, once closed, when, at what
-- price and why. Written by signal_lifecycle.py (scheduled in the outcome-resolver job).
--
-- Before this, unified_signals had no horizon/expiry/closure columns and no live closer at all:
-- updateSignalAccuracy (signals.ts) had zero callers, so 90,755 technical and 2,443 intraday
-- screener signals sat ACTIVE back to June (measured 2026-10-01).
--
-- Nullable and additive: no default, no rewrite, metadata-only on Postgres 16. unified_signals is
-- a plain table (not a hypertable). Inert until signal_lifecycle.py runs; that step FAILS LOUDLY
-- (T.fail in the outcome-resolver job) if it is deployed before this migration is applied.

ALTER TABLE unified_signals ADD COLUMN IF NOT EXISTS horizon_sessions SMALLINT;
ALTER TABLE unified_signals ADD COLUMN IF NOT EXISTS closed_at DATE;
ALTER TABLE unified_signals ADD COLUMN IF NOT EXISTS exit_price DOUBLE PRECISION;
ALTER TABLE unified_signals ADD COLUMN IF NOT EXISTS exit_reason TEXT;

COMMENT ON COLUMN unified_signals.horizon_sessions IS
  'Validity window in trading sessions after the signal (0 = intraday: closes in its own session). '
  'Set by signal_lifecycle.py from the signal source.';
COMMENT ON COLUMN unified_signals.closed_at IS
  'Session date the signal left ACTIVE: COMPLETED (target), FAILED (stop) or EXPIRED (window end).';
COMMENT ON COLUMN unified_signals.exit_price IS
  'Level/price at closure: target or stop (open if gapped through), else the window''s last close.';
COMMENT ON COLUMN unified_signals.exit_reason IS
  'TARGET | STOP | TIME_EXIT | TIME_EXIT_DAILY (intraday, no 15m bars) | NO_BARS.';
