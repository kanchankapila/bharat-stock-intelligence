-- AF-20261015-11/12: make the NSE exchange masters, rather than a hand-maintained
-- TypeScript seed, authoritative for universe admission and instrument classification.
SET lock_timeout = '10s';

ALTER TABLE nse_stocks
  ADD COLUMN IF NOT EXISTS instrument_type TEXT NOT NULL DEFAULT 'equity',
  ADD COLUMN IF NOT EXISTS exchange_master_updated_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS admission_sessions BIGINT,
  ADD COLUMN IF NOT EXISTS admission_reason TEXT;

CREATE INDEX IF NOT EXISTS idx_nse_stocks_active_instrument
  ON nse_stocks(status, instrument_type);

-- Immediate cleanup for fresh deploys. The scheduled exchange-master reconciliation
-- generalises this to every future rename/delisting and only runs after validating that
-- both NSE catalogues are complete.
UPDATE nse_stocks
SET status = 'INACTIVE',
    admission_reason = 'absent_from_official_nse_equity_master',
    last_updated = CURRENT_TIMESTAMP
WHERE symbol IN (
  'AURIGROW','BAJAJINSUR','CCAVENUE','CENTRALBANK','CHOLAFINSV','CLCIND',
  'GFSTEELS','HEG','INDUSIND','JIOFINANCIAL','KOTAK','LARSEN','LASA','LTFH',
  'LTIM','LYPSAGEMS','MAHINDRA','MCDOWELL','NESTLE','OBEROI','POLICYBAZAAR',
  'SANGINITA','SELMC','SILLYMONKS','SRTRANSFIN','TATAMOTORS','UNIVAFOODS',
  'VODAFONE'
);

UPDATE nse_stocks
SET status = 'INACTIVE',
    instrument_type = 'etf',
    admission_reason = 'official_nse_etf_excluded_from_equity_ranker',
    last_updated = CURRENT_TIMESTAMP
WHERE symbol = 'NIFTYBEES';

