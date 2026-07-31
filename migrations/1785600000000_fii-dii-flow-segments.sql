-- Up Migration
--
-- Endpoint-corpus audit (docs/audit-2026-07-31/ENDPOINT_DATA_REVIEW_AND_QUANT_VALUE.md §4.1/§5-1)
-- ranked investsights' FII/DII history the highest value-per-effort item in the 919-URL corpus:
-- 2,584 daily rows back to 2016-01-01 in a single call, against the 682 rows from 2023-11-01
-- that fii_dii_flow held. That directly attacks the "only 55 distinct dates" constraint the
-- 2026-07-30 data/bias audit identified as capping every macro-flow conclusion.
--
-- The source carries a segment breakdown the existing 6 columns cannot hold, and -- verified
-- live against 2,584 rows plus the 589 overlapping tradebrains rows -- its `fii_net` means
-- TWO different things by era:
--   * recent rows (fii_buy/fii_sell present): cash equity net, == buy - sell
--   * historical rows: ALL-SEGMENT net == fii_equity + fii_debt + fii_derivatives, dominated
--     by derivatives notional (2024-09-26: 132,159 Cr vs a true cash-equity 8,538 Cr, 15x)
-- The cash-equity series in the historical era is `fii_equity`, which matches the existing
-- tradebrains rows exactly (506/506 within 1 Cr, median diff 0.03 Cr).
--
-- fii_net_all_segments therefore exists so the all-segment figure is preserved as its OWN
-- series instead of being conflated with cash equity in fii_net.
--
-- The mf_* columns exist for the same reason on the domestic side: this source's "dii_net"
-- IS mf_total (mutual funds only), while fii_dii_flow.dii_net means NSE's DII aggregate
-- (banks + insurers + MFs + others). Measured on the overlap the two disagree by a median of
-- 3,786 Cr and agree within 1 Cr on 0 of 576 rows -- different populations, not a rounding
-- difference. Keeping them in separate columns is what stops MF flow being read as DII flow.
ALTER TABLE "fii_dii_flow" ADD COLUMN IF NOT EXISTS "fii_equity" DOUBLE PRECISION;
ALTER TABLE "fii_dii_flow" ADD COLUMN IF NOT EXISTS "fii_debt" DOUBLE PRECISION;
ALTER TABLE "fii_dii_flow" ADD COLUMN IF NOT EXISTS "fii_derivatives" DOUBLE PRECISION;
ALTER TABLE "fii_dii_flow" ADD COLUMN IF NOT EXISTS "fii_net_all_segments" DOUBLE PRECISION;
ALTER TABLE "fii_dii_flow" ADD COLUMN IF NOT EXISTS "mf_equity" DOUBLE PRECISION;
ALTER TABLE "fii_dii_flow" ADD COLUMN IF NOT EXISTS "mf_debt" DOUBLE PRECISION;
ALTER TABLE "fii_dii_flow" ADD COLUMN IF NOT EXISTS "mf_derivatives" DOUBLE PRECISION;
ALTER TABLE "fii_dii_flow" ADD COLUMN IF NOT EXISTS "mf_total" DOUBLE PRECISION;

COMMENT ON COLUMN "fii_dii_flow"."fii_net" IS
  'FII CASH EQUITY net (Cr). Not the all-segment figure -- see fii_net_all_segments.';
COMMENT ON COLUMN "fii_dii_flow"."fii_net_all_segments" IS
  'FII net across equity+debt+derivatives (Cr). Dominated by derivatives notional; NOT comparable to fii_net.';
COMMENT ON COLUMN "fii_dii_flow"."dii_net" IS
  'NSE DII aggregate net (Cr) -- banks, insurers, MFs and others. Mutual funds alone are mf_total.';
COMMENT ON COLUMN "fii_dii_flow"."mf_total" IS
  'SEBI mutual-fund net (Cr) == mf_equity + mf_debt + mf_derivatives. A SUBSET of dii_net, not a substitute for it.';

-- Down Migration
ALTER TABLE "fii_dii_flow" DROP COLUMN IF EXISTS "fii_equity";
ALTER TABLE "fii_dii_flow" DROP COLUMN IF EXISTS "fii_debt";
ALTER TABLE "fii_dii_flow" DROP COLUMN IF EXISTS "fii_derivatives";
ALTER TABLE "fii_dii_flow" DROP COLUMN IF EXISTS "fii_net_all_segments";
ALTER TABLE "fii_dii_flow" DROP COLUMN IF EXISTS "mf_equity";
ALTER TABLE "fii_dii_flow" DROP COLUMN IF EXISTS "mf_debt";
ALTER TABLE "fii_dii_flow" DROP COLUMN IF EXISTS "mf_derivatives";
ALTER TABLE "fii_dii_flow" DROP COLUMN IF EXISTS "mf_total";
