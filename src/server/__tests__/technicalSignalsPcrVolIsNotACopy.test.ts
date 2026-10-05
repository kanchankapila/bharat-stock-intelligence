import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// AF-20261005-07: technical_signals.pcr_vol was filled from stock_options_oi.market_pcr, which equals
// `pcr` (open-interest PCR) on every row (3,620/3,620 in the last 30 days; pcr_fetcher.py documents that
// the stock-option source has no separate volume ratio). 35,887 of 35,887 recent technical_signals rows
// had pcr_vol == pcr_oi, so every model reading both counted one signal twice under a name that claims
// to be something else. There is no volume PCR in stock_options_oi, so the honest value is NULL.
const SRC = readFileSync(join(__dirname, '..', 'technicalSignalsService.ts'), 'utf8');

describe('technical_signals.pcr_vol', () => {
  it('is not populated from market_pcr (a copy of the OI PCR)', () => {
    expect(SRC).not.toMatch(/market_pcr\s+AS\s+pcr_vol/i);
  });
  it('still reads the real OI PCR (non-vacuity)', () => {
    expect(SRC).toMatch(/pcr\s+AS\s+pcr_oi/i);
  });
});
