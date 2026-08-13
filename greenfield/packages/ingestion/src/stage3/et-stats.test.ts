import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseEtStatsResponse } from './et-stats.js';

function fixture(name: string): string {
  return readFileSync(fileURLToPath(new URL(`./__fixtures__/${name}`, import.meta.url)), 'utf8');
}

describe('parseEtStatsResponse', () => {
  it('parses the real Ratio fixture (5 annual rows, HDFCBANK)', () => {
    const result = parseEtStatsResponse(fixture('etstats_ratio.json'), 'Ratio');
    expect(result.rejectReason).toBeUndefined();
    expect(result.rejectedRows).toBe(0);
    const years = new Set(result.accepted.map((f) => f.periodEnd));
    expect(years).toEqual(new Set(['2026-03-31', '2025-03-31', '2024-03-31', '2023-03-31', '2022-03-31']));
    expect(result.accepted.every((f) => f.periodType === 'FY')).toBe(true);
    const eps = result.accepted.find((f) => f.periodEnd === '2026-03-31' && f.metric.endsWith('_basicEPS'));
    expect(eps?.value).toBe(48.62);
  });

  it('parses the real Balance fixture with periodType FY', () => {
    const result = parseEtStatsResponse(fixture('etstats_balance.json'), 'Balance');
    expect(result.accepted.length).toBeGreaterThan(0);
    expect(result.accepted.every((f) => f.periodType === 'FY')).toBe(true);
  });

  it('parses the real CashFlow fixture', () => {
    const result = parseEtStatsResponse(fixture('etstats_cashflow.json'), 'CashFlow');
    expect(result.accepted.length).toBeGreaterThan(0);
    const cfo = result.accepted.find((f) => f.metric.includes('netCashFlowFromOperatingActivities'));
    expect(cfo?.value).toBeCloseTo(123616.99);
  });

  it('parses the real Quarterly fixture with periodType Q', () => {
    const result = parseEtStatsResponse(fixture('etstats_quarterly.json'), 'Quarterly');
    expect(result.accepted.length).toBeGreaterThan(0);
    expect(result.accepted.every((f) => f.periodType === 'Q')).toBe(true);
  });

  it('never emits a row for a meta field (yearEnding, bType, id, ...)', () => {
    const result = parseEtStatsResponse(fixture('etstats_ratio.json'), 'Ratio');
    expect(result.accepted.some((f) => f.metric.endsWith('_yearEnding'))).toBe(false);
    expect(result.accepted.some((f) => f.metric.endsWith('_bType'))).toBe(false);
    expect(result.accepted.some((f) => f.metric.endsWith('_id'))).toBe(false);
  });

  it('skips null-valued metrics rather than fabricating a zero', () => {
    const result = parseEtStatsResponse(fixture('etstats_ratio.json'), 'Ratio');
    // ronw was null in the live fixture for this bank-type row -- must not appear at all.
    expect(result.accepted.some((f) => f.metric.endsWith('_ronw') && f.periodEnd === '2026-03-31')).toBe(false);
  });

  it('negative control: missing envelope key is rejected wholesale, not thrown', () => {
    const result = parseEtStatsResponse(JSON.stringify({ someOtherKey: {} }), 'Ratio');
    expect(result.accepted).toHaveLength(0);
    expect(result.rejectReason).toContain('resultRatiosStatement.list');
  });

  it('negative control: a row with unparseable yearEnding is counted as rejected, not accepted with a guessed date', () => {
    const body = JSON.stringify({ resultRatiosStatement: { list: [{ yearEnding: 'not-a-date', basicEPS: '1.0' }] } });
    const result = parseEtStatsResponse(body, 'Ratio');
    expect(result.accepted).toHaveLength(0);
    expect(result.rejectedRows).toBe(1);
  });

  it('negative control: non-JSON body does not throw', () => {
    const result = parseEtStatsResponse('not json', 'Ratio');
    expect(result.rejectReason).toContain('not valid JSON');
  });
});
