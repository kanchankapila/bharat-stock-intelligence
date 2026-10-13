import { describe, expect, it } from 'vitest';
import { DEFAULT_RISK_FREE_ANNUAL, getRiskFreeAnnual, normalizeRiskFreeRate } from '../riskFreeRate';

/**
 * The risk-free rate is the single input shared by every Sharpe/Sortino/Treynor producer on
 * the platform. Before 2026-10-11 four modules hard-coded it four different ways (4.0%,
 * 6.5%, 7.0%, 7.0%) into the SAME columns, so a `sharpe_ratio` in quant_scores meant
 * different things depending on which writer touched the row -- invisible because each
 * writer looked healthy on its own.
 */

describe('normalizeRiskFreeRate', () => {
  it('accepts a percent-scaled macro value', () => {
    expect(normalizeRiskFreeRate(6.5)).toBeCloseTo(0.065, 12);
    expect(normalizeRiskFreeRate(5.15)).toBeCloseTo(0.0515, 12);
  });

  it('accepts an already-decimal value without re-scaling', () => {
    expect(normalizeRiskFreeRate(0.065)).toBeCloseTo(0.065, 12);
  });

  it('treats 1.0 as percent-scale (100% annual repo is not a credible input)', () => {
    expect(normalizeRiskFreeRate(1.0)).toBeCloseTo(0.01, 12);
  });

  it('rejects null/undefined/garbage/zero/negative rather than silently defaulting', () => {
    for (const bad of [null, undefined, '', 'NA', NaN, 0, -1, -0.065]) {
      expect(normalizeRiskFreeRate(bad)).toBeNull();
    }
  });

  it('parses a numeric string from a TEXT macro column', () => {
    expect(normalizeRiskFreeRate('6.5')).toBeCloseTo(0.065, 12);
  });
});

describe('getRiskFreeAnnual', () => {
  it('returns the latest RBI repo rate when the macro row exists', async () => {
    let seen = '';
    const rate = await getRiskFreeAnnual(async (sql) => {
      seen = sql;
      return { close: 5.15 };
    });
    expect(rate).toBeCloseTo(0.0515, 12);
    // Must order by date DESC so a late/backfilled row can never win.
    expect(seen).toContain("symbol = 'RBI_REPO_RATE'");
    expect(seen).toContain('ORDER BY date DESC');
  });

  it('falls back to the documented 6.5% when the table is unavailable', async () => {
    const rate = await getRiskFreeAnnual(async () => {
      throw new Error('relation "macro_asset_prices" does not exist');
    });
    expect(rate).toBe(DEFAULT_RISK_FREE_ANNUAL);
    expect(DEFAULT_RISK_FREE_ANNUAL).toBeCloseTo(0.065, 12);
  });

  it('falls back when the row is present but NULL/zero', async () => {
    expect(await getRiskFreeAnnual(async () => ({ close: null }))).toBe(DEFAULT_RISK_FREE_ANNUAL);
    expect(await getRiskFreeAnnual(async () => undefined)).toBe(DEFAULT_RISK_FREE_ANNUAL);
    expect(await getRiskFreeAnnual(async () => ({ close: 0 }))).toBe(DEFAULT_RISK_FREE_ANNUAL);
  });
});
