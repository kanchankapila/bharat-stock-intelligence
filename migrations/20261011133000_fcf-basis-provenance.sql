-- 2026-10-11 quant audit: fcf_ttm_approx held TWO different definitions in one
-- column.  financial_ratios_fetcher.py wrote CFO + CFI, which is not free cash
-- flow: CFI also nets asset sales, acquisitions, subsidiary disposals and
-- securities-book movement.  Measured live against finstack_cashflow_history's
-- real CFO/CapEx quarterly lines, the proxy disagreed on the SIGN for ~499
-- names (395 with CFO > 0 but proxy <= 0; 104 the other way), so fcf_positive
-- and the FCF > 3% badge were wrong on a large slice of the universe.
--
-- The fetcher now prefers true TTM FCF = sum of 4 quarters of (CFO - CapEx)
-- when vendor history exists, and keeps the proxy only as a fallback.  Because
-- the two bases are NOT interchangeable, every row now records which one it
-- used -- otherwise a consumer sorting/filtering on fcf_ttm_approx would be
-- comparing capex-based numbers against proxy numbers in one ranking.
ALTER TABLE technical_signals
  ADD COLUMN IF NOT EXISTS fcf_basis     TEXT,
  ADD COLUMN IF NOT EXISTS fcf_ttm_as_of TEXT;

ALTER TABLE tl_financial_quality
  ADD COLUMN IF NOT EXISTS fcf_basis     TEXT,
  ADD COLUMN IF NOT EXISTS fcf_ttm_as_of TEXT;

COMMENT ON COLUMN technical_signals.fcf_basis IS
  'Which definition fcf_ttm_approx used: ''capex'' = sum of 4 quarters (CFO-CapEx) from finstack_cashflow_history; ''cfo_cfi_proxy'' = CFO+CFI fallback; NULL = no FCF computed. Never mix the two in one ranking.';
COMMENT ON COLUMN technical_signals.fcf_ttm_as_of IS
  'Period end of the latest quarter in the TTM window when fcf_basis=''capex'' (NULL for the proxy).';
