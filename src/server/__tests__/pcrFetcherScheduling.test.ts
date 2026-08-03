import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Regression test for the 2026-08-03 fix: every scheduled call to pcr_fetcher.py had drifted
 * onto `--gex` (index-level dealer GEX only, writes macro_asset_prices) -- the default per-symbol
 * path, the ONLY thing that writes historical_fno_sentiment (and refreshes stock_options_oi's
 * ATM IV for the DEFAULT_SYMBOLS large-cap set), had silently lost its scheduled call. Found via
 * the new dataQualityChecks.ts sweep: historical_fno_sentiment was 11+ days stale while its
 * sibling stock_options_oi stayed fresh via a completely different fetcher, masking the gap in
 * every dashboard that only checks stock_options_oi.
 *
 * This is a source-inspection test (mirrors jobPipelineOrdering.test.ts's own convention) rather
 * than an integration test, since the actual bug was "the call site doesn't exist", which a unit
 * test of pcr_fetcher.py itself can never catch -- the script's logic was always correct.
 */
describe('pcr_fetcher.py scheduling', () => {
  it('queues.ts calls pcr_fetcher.py at least once WITHOUT --gex (the only path that writes historical_fno_sentiment)', () => {
    const src = readFileSync(join(__dirname, '..', 'queues.ts'), 'utf8');
    const calls = [...src.matchAll(/runPython\('pcr_fetcher\.py',\s*(\[[^\]]*\])/g)].map(m => m[1]);
    expect(calls.length).toBeGreaterThan(0);
    const nonGexCalls = calls.filter(argsLiteral => !argsLiteral.includes('--gex'));
    expect(nonGexCalls.length).toBeGreaterThan(0);
  });

  it('still calls pcr_fetcher.py --gex somewhere (index-level dealer GEX must not regress)', () => {
    const src = readFileSync(join(__dirname, '..', 'queues.ts'), 'utf8');
    expect(src).toMatch(/runPython\('pcr_fetcher\.py',\s*\['--gex'\]/);
  });
});
