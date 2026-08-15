import { describe, it, expect } from 'vitest';
import { DASH, formatNumber, formatINR, formatINRSigned, formatCr, formatPct } from './format';

/**
 * The null/NaN cases are the point of this suite, not the digit formatting. This platform's
 * dominant bug class is missing data rendered as a real value (getInstitutionalFlows coercing
 * NULL to "0.00"; `float(x or 0)` turning NaN into a real score) -- these tests exist so a
 * future "simplification" of format.ts cannot quietly reintroduce a zero where a dash belongs.
 */
describe('missing/invalid values never render as a number', () => {
  const missing = [null, undefined, NaN, Infinity, -Infinity, ''] as const;

  for (const v of missing) {
    it(`renders ${String(v)} as a dash in every formatter`, () => {
      expect(formatNumber(v)).toBe(DASH);
      expect(formatINR(v)).toBe(DASH);
      expect(formatINRSigned(v)).toBe(DASH);
      expect(formatCr(v)).toBe(DASH);
      expect(formatPct(v)).toBe(DASH);
    });
  }

  it('does NOT treat a real zero as missing — 0 is a claim, dash is an admission', () => {
    expect(formatINR(0)).toBe('₹0');
    expect(formatCr(0)).toBe('₹0');
    expect(formatPct(0)).toBe('0.00%');
    expect(formatNumber(0)).toBe('0.00');
  });
});

describe('Indian digit grouping and magnitudes', () => {
  it('groups in the Indian system, not the Western one', () => {
    // 1,23,456 — the whole reason for the en-IN locale. A Western grouping (123,456) here
    // would be the tell that a call site hardcoded en-US, as one site did.
    expect(formatNumber(123456, 0)).toBe('1,23,456');
  });

  it('uses crore above 1e7 and lakh above 1e5', () => {
    expect(formatCr(25_000_000)).toBe('₹2.50 Cr');
    expect(formatCr(500_000)).toBe('₹5.00 L');
  });

  it('falls back to plain rupees below a lakh rather than inventing a unit', () => {
    expect(formatCr(4_500)).toBe('₹4,500');
  });

  it('carries the sign on negative magnitudes', () => {
    expect(formatCr(-25_000_000)).toBe('−₹2.50 Cr');
  });
});

describe('signed formatting for direction-bearing figures', () => {
  it('always shows an explicit + or − for P&L', () => {
    expect(formatINRSigned(1234)).toBe('+₹1,234');
    expect(formatINRSigned(-1234)).toBe('−₹1,234');
  });

  it('formatPct only signs when asked', () => {
    expect(formatPct(2.5)).toBe('2.50%');
    expect(formatPct(2.5, 2, true)).toBe('+2.50%');
    expect(formatPct(-2.5)).toBe('−2.50%');
  });
});

describe('numeric strings from the DB are accepted', () => {
  // Postgres NUMERIC comes back as a string through pg (infra_gotchas: "NUMERIC-as-string"),
  // so every one of these formatters is handed strings in production, not just numbers.
  it('formats a NUMERIC-as-string the same as a number', () => {
    expect(formatINR('1234')).toBe(formatINR(1234));
    expect(formatCr('25000000')).toBe('₹2.50 Cr');
  });

  it('renders a non-numeric string as a dash, not NaN', () => {
    expect(formatINR('N/A')).toBe(DASH);
    expect(formatCr('-')).toBe(DASH);
  });
});
