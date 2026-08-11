-- Up Migration
--
-- MarketsMojo technical_card getCardInfo returns a full dated series (not just the current
-- value) for weekly/monthly-period MACD, RSI, Bollinger Bands, KST, moving averages, Dow-trend,
-- OBV, and the composite IndiGraph score -- confirmed live 2026-08-11 (742 daily-dated rows,
-- ~3 years back, unauthenticated) against sid=592009 (HDFCBANK). Nothing on the platform
-- currently stores historical values for these indicators; technical_signals/unified_signals
-- only ever hold the latest computed signal, overwritten each run.
--
-- indicator/period identify which series a row belongs to ('macd'/'rsi'/'bb'/'kst'/'ma'/'dow'/
-- 'obv'/'indigraph', period 'w'/'m'/'d'). details holds the indicator-specific fields (macd's
-- macd/signal, rsi's rsi/lband/uband, etc.) as a JSON string -- the shape differs per indicator,
-- and this project's tables otherwise use plain TEXT/NUMERIC columns rather than Postgres-only
-- JSONB (see .claude/rules/recurring-bugs.md "SQL dialect" -- the SQLite fallback in db.ts has
-- no native JSON operators, so a TEXT column readable on both sides is the safe choice).
CREATE TABLE IF NOT EXISTS "marketsmojo_technical_history" (
  "symbol" TEXT NOT NULL,
  "indicator" TEXT NOT NULL,
  "period" TEXT NOT NULL,
  "date" DATE NOT NULL,
  "price" NUMERIC,
  "grade" TEXT,
  "flag" INTEGER,
  "details" TEXT,
  "fetched_at" TEXT NOT NULL,
  PRIMARY KEY ("symbol", "indicator", "period", "date")
);
CREATE INDEX IF NOT EXISTS "idx_marketsmojo_technical_history_symbol" ON "marketsmojo_technical_history"("symbol");

-- Down Migration
DROP TABLE IF EXISTS "marketsmojo_technical_history";
