-- AF-20260912-11. `bulk_block_deals` is about to gain a SECOND writer: NSE's
-- /api/bulk-deals route is retired (404, verified live 2026-09-12 with warm cookies), so
-- delivery_trend_fetcher.py falls back to MoneyControl's deals/list, which reports the same
-- deals independently.
--
-- data-sources.md's composite-key rule applies: the old PK (symbol, deal_date, client_name,
-- deal_type) is a NATURAL key two providers can each produce a row for. Both normalise
-- client_name with .strip().upper(), so NSE's "JUMP TRADING FINANCIAL INDIA PRIVATE LIMITED"
-- and MC's "jump trading financial india private limited" collapse to the SAME key -- and
-- whichever fetcher ran later would silently overwrite the other's quantity/price. That is
-- exactly the index_max_pain failure (migration 1787010000000) which took a 12-audit sweep to
-- find, so the provider goes into the key BEFORE the second writer lands, not after.

ALTER TABLE bulk_block_deals ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'nse';

-- Every existing row came from the NSE fetcher, so the DEFAULT backfills them correctly and
-- deterministically -- no inference needed (contrast index_max_pain, which had to be split on
-- a fetched_at format quirk).
ALTER TABLE bulk_block_deals DROP CONSTRAINT IF EXISTS bulk_block_deals_pkey;
ALTER TABLE bulk_block_deals
  ADD CONSTRAINT bulk_block_deals_pkey
  PRIMARY KEY (source, symbol, deal_date, client_name, deal_type);
