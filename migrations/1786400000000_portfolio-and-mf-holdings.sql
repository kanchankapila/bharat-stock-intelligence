-- Up Migration
--
-- New user-scoped portfolio tracking: real holdings (quantity/buy price/buy date/sell
-- price/sell date), not the equal-weight scenario sandbox PortfolioDeskPage.tsx already has.
-- One row per lot -- a buy inserts a row, a sell fills sellPrice/sellDate on it (see
-- portfolio.router.ts for the partial-sell split logic). Mirrors watchlist's userId->users(id)
-- FK-cascade pattern.
CREATE TABLE IF NOT EXISTS "portfolio_holdings" (
  "id" SERIAL PRIMARY KEY,
  "userId" TEXT NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "symbol" TEXT NOT NULL,
  "quantity" DOUBLE PRECISION NOT NULL,
  "buyPrice" DOUBLE PRECISION NOT NULL,
  "buyDate" TEXT NOT NULL,
  "sellPrice" DOUBLE PRECISION,
  "sellDate" TEXT,
  "notes" TEXT,
  "createdAt" TIMESTAMPTZ DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS "idx_portfolio_holdings_user" ON "portfolio_holdings"("userId");

-- Mutual fund equivalent. currentNav is user-maintained (manually updated in the UI) since no
-- live AMFI NAV-fetch pipeline exists in this codebase yet -- a real fetcher would need its own
-- live_datasource test + dataQualityChecks.ts entry per this repo's mandate, deliberately not
-- attempted alongside this feature build.
CREATE TABLE IF NOT EXISTS "mf_portfolio_holdings" (
  "id" SERIAL PRIMARY KEY,
  "userId" TEXT NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "schemeName" TEXT NOT NULL,
  "folioNumber" TEXT,
  "category" TEXT,
  "units" DOUBLE PRECISION NOT NULL,
  "buyNav" DOUBLE PRECISION NOT NULL,
  "buyDate" TEXT NOT NULL,
  "currentNav" DOUBLE PRECISION,
  "sellNav" DOUBLE PRECISION,
  "sellDate" TEXT,
  "notes" TEXT,
  "createdAt" TIMESTAMPTZ DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS "idx_mf_portfolio_holdings_user" ON "mf_portfolio_holdings"("userId");

-- Down Migration
DROP TABLE IF EXISTS "mf_portfolio_holdings";
DROP TABLE IF EXISTS "portfolio_holdings";
