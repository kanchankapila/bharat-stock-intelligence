-- Up Migration
--
-- Endpoint-corpus audit §4.2/§5-2: bulk/block deals with a named counterparty and, crucially,
-- Tickertape's `pctTransacted` -- the deal size as a percentage of the company's float.
--
-- That field is the reason this is worth ingesting. The existing block_deals table stores
-- qty/price/value_cr, all of which are ABSOLUTE and therefore not comparable across the
-- cross-section: a Rs 12 cr deal is a control transaction in a microcap and a rounding error
-- in Reliance. pctTransacted is already cross-sectionally normalized at source, which makes
-- it directly usable as an ML feature rather than something that has to be scaled against a
-- float figure this platform does not reliably hold.
--
-- client_name/trade_type/category are stored alongside because "who" and "which side" is the
-- other half of the signal -- a promoter-group buy and an exiting-PE sell are opposite events
-- that look identical once reduced to a net quantity.
ALTER TABLE "block_deals" ADD COLUMN IF NOT EXISTS "pct_transacted" DOUBLE PRECISION;
ALTER TABLE "block_deals" ADD COLUMN IF NOT EXISTS "client_name" TEXT;
ALTER TABLE "block_deals" ADD COLUMN IF NOT EXISTS "trade_type" TEXT;
ALTER TABLE "block_deals" ADD COLUMN IF NOT EXISTS "category" TEXT;
ALTER TABLE "block_deals" ADD COLUMN IF NOT EXISTS "source" TEXT DEFAULT 'nse';

COMMENT ON COLUMN "block_deals"."pct_transacted" IS
  'Deal size as % of float. Cross-sectionally comparable, unlike qty/value_cr.';
COMMENT ON COLUMN "block_deals"."trade_type" IS
  'buy | sell -- the side taken by client_name, not the market.';

CREATE INDEX IF NOT EXISTS idx_bd_pct ON block_deals(symbol, date DESC, pct_transacted);

-- Down Migration
DROP INDEX IF EXISTS idx_bd_pct;
ALTER TABLE "block_deals" DROP COLUMN IF EXISTS "pct_transacted";
ALTER TABLE "block_deals" DROP COLUMN IF EXISTS "client_name";
ALTER TABLE "block_deals" DROP COLUMN IF EXISTS "trade_type";
ALTER TABLE "block_deals" DROP COLUMN IF EXISTS "category";
ALTER TABLE "block_deals" DROP COLUMN IF EXISTS "source";
