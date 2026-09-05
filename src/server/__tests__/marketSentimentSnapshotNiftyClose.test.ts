import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Regression test for the 2026-08-07 dead-column fix: market_sentiment_snapshots.
 * nifty_last_close/nifty_support/nifty_resistance had zero real values (confirmed live,
 * 669/669 rows null) despite the write path looking fully wired -- the root cause was a
 * .find(d => symbol/country includes 'nifty'/'india') against fetchGlobalMarketData(), whose
 * real live response (www.niftytrader.in/api/niftytrader/usstock/global-market) is a global-EX-INDIA
 * feed by design (SHANGHAI/HANG SENG/NIKKEI/CAC 40/DAX/FTSE 100/DOW JONES/NASDAQ FUTURES/
 * S&P 500 FUTURES -- confirmed live, zero India/Nifty entries ever). Fixed by reading NIFTY50's
 * own close from stock_ohlcv (this platform's canonical, already-collected source) instead.
 */
const SOURCE = readFileSync(join(__dirname, '..', 'newsSentimentService.ts'), 'utf8');

describe('market sentiment snapshot nifty_last_close source', () => {
  it('reads NIFTY50 close from stock_ohlcv, not a .find() over the global-market feed', () => {
    expect(SOURCE).toMatch(/SELECT close FROM stock_ohlcv WHERE symbol = 'NIFTY50'/);
  });

  it('no longer searches fetchGlobalMarketData for a nifty/india entry (the broken pattern)', () => {
    // The broken pattern specifically: .find(d => ... includes('nifty') ... includes('india'))
    expect(SOURCE).not.toMatch(/globalData\.find\(d\s*=>\s*\n?\s*d\.symbol\?\.toLowerCase\(\)\.includes\('nifty'\)/);
  });

  it('fetchGlobalMarketData is still used for the global cue (US/Japan/HK/Europe), not removed entirely', () => {
    // The global-cue block (a genuinely correct use of this endpoint) must still exist.
    expect(SOURCE).toMatch(/globalIndices\.length > 0/);
    expect(SOURCE).toMatch(/await fetchGlobalMarketData\(\)/);
  });
});
