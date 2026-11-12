import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { anchorPrice } from '../confluenceEngine';

/**
 * 2026-11-12 (AF-20261112-01): confluence trade levels were built on technical_signals.cmp, which
 * for ~20% of names was a PRIOR session's close (the scan dated rows by the wall clock). The
 * 2026-11-12 watch-list's AUROPHARMA entry zone was centred on the 11-09 close 1855.30 while the
 * stock had closed at 1827.50. Levels must anchor on the latest stored close: the same bars the
 * ATR is computed from.
 */
describe('confluence trade-level anchor', () => {
  it('uses the latest bar close, not the technical row', () => {
    expect(anchorPrice([{ close: 1800 }, { close: 1855.3 }, { close: 1827.5 }], 1855.3)).toBe(1827.5);
  });

  it('falls back only when there is no usable bar', () => {
    expect(anchorPrice([], 1855.3)).toBe(1855.3);
    expect(anchorPrice([{ close: 0 }], null)).toBeNull();
  });

  it('computeConfluence builds the setup from anchorPrice', () => {
    const src = readFileSync(join(__dirname, '..', 'confluenceEngine.ts'), 'utf8');
    expect(src).toMatch(/const price = anchorPrice\(bars, tech\?\.cmp \?\? null\)/);
    expect(src).not.toMatch(/const price = tech\?\.cmp \?\? null/);
  });
});
