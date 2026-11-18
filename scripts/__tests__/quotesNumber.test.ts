import { describe, it, expect } from 'vitest';
// @ts-expect-error plain .mjs helper
import { quotesNumber } from '../quotesNumber.mjs';

describe('quotesNumber (docNumbers --check digit boundary)', () => {
  it('matches a correct figure at the end of a sentence or before a comma', () => {
    expect(quotesNumber('There are 89 fetchers.', '89')).toBe(true);
    expect(quotesNumber('the count is 89.', '89')).toBe(true);
    expect(quotesNumber('89 fetchers, 320 modules', '89')).toBe(true);
    expect(quotesNumber('fetchers: 89, modules: 320', '89')).toBe(true);
  });
  it('still rejects a figure that is part of a longer number', () => {
    expect(quotesNumber('891 fetchers', '89')).toBe(false);
    expect(quotesNumber('about 1,890 rows', '89')).toBe(false);
    expect(quotesNumber('about 89.5 rows', '89')).toBe(false);
    expect(quotesNumber('about 89,000 rows', '89')).toBe(false);
    expect(quotesNumber('v1.89 build', '89')).toBe(false);
  });
  it('matches a grouped figure', () => {
    expect(quotesNumber('3,408 endpoints', '3,408')).toBe(true);
    expect(quotesNumber('13,408 endpoints', '3,408')).toBe(false);
  });
});

// @ts-expect-error plain .mjs helper
import { driftedCounts } from '../quotesNumber.mjs';

describe('driftedCounts (url_endpoints/registry figures quoted outside the ledger rule)', () => {
  const re = /url_endpoints|find-alternates/;
  it('flags a stale figure on an anchored line and reports its line number', () => {
    const doc = 'intro\nCheck `url_endpoints` (830 templates) via --find-alternates\n';
    expect(driftedCounts(doc, re, 'templates', 834)).toEqual([{ line: 2, found: '830' }]);
  });
  it('accepts the current figure, grouped or not, and ignores unanchored lines', () => {
    expect(driftedCounts('`url_endpoints` (834 templates)', re, 'templates', 834)).toEqual([]);
    expect(driftedCounts('a sample of 250 templates', re, 'templates', 834)).toEqual([]);
    expect(driftedCounts('market_endpoint_registry: 3,408 live working endpoints', /market_endpoint_registry/,
      '(?:live )?(?:working )?endpoints', 3408)).toEqual([]);
  });
});
