-- Up Migration
--
-- Extends nse_stocks (the DB-side stock master, already carrying symbol/isin/mcsymbol/tlid/
-- tlname) with the remaining provider-ID fields that today only live in the TypeScript-only
-- src/data/stocklist.ts (StockMapping). This makes nse_stocks the queryable symbol_mapping
-- table Python engines can join against directly, instead of each fetcher re-implementing
-- provider-ID resolution. All nullable -- additive only, no existing data touched.
ALTER TABLE nse_stocks ADD COLUMN IF NOT EXISTS stockid TEXT;
ALTER TABLE nse_stocks ADD COLUMN IF NOT EXISTS companyid TEXT;
ALTER TABLE nse_stocks ADD COLUMN IF NOT EXISTS tickertape_sid TEXT;
ALTER TABLE nse_stocks ADD COLUMN IF NOT EXISTS fincode TEXT;
ALTER TABLE nse_stocks ADD COLUMN IF NOT EXISTS scripcode TEXT;

-- Down Migration
ALTER TABLE nse_stocks DROP COLUMN IF EXISTS stockid;
ALTER TABLE nse_stocks DROP COLUMN IF EXISTS companyid;
ALTER TABLE nse_stocks DROP COLUMN IF EXISTS tickertape_sid;
ALTER TABLE nse_stocks DROP COLUMN IF EXISTS fincode;
ALTER TABLE nse_stocks DROP COLUMN IF EXISTS scripcode;