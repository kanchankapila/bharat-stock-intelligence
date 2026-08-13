import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseMarketsMojoPeriodKey, parseMarketsMojoResponse } from './marketsmojo-financials.js';

const FIXTURE = readFileSync(fileURLToPath(new URL('./__fixtures__/marketsmojo_financials_page1.json', import.meta.url)), 'utf8');

describe('parseMarketsMojoPeriodKey', () => {
  it('maps a real quarter-end slug to an ISO date', () => {
    expect(parseMarketsMojoPeriodKey('jun26')).toBe('2026-06-30');
    expect(parseMarketsMojoPeriodKey('mar26')).toBe('2026-03-31');
    expect(parseMarketsMojoPeriodKey('dec24')).toBe('2024-12-31');
    expect(parseMarketsMojoPeriodKey('sep25')).toBe('2025-09-30');
  });

  it('negative control: unrecognized slug returns null, never guesses', () => {
    expect(parseMarketsMojoPeriodKey('consolidate')).toBeNull();
    expect(parseMarketsMojoPeriodKey('standalone')).toBeNull();
    expect(parseMarketsMojoPeriodKey('foo99')).toBeNull();
  });
});

describe('parseMarketsMojoResponse', () => {
  it('parses the real page-1 fixture (HDFCBANK, sid=592009) and recursively flattens nested items', () => {
    const result = parseMarketsMojoResponse(FIXTURE);
    expect(result.rejectReason).toBeUndefined();
    expect(result.accepted.length).toBeGreaterThan(0);
    const interestEarned = result.accepted.find((f) => f.metric === 'mm_consolidate_interest_earned' && f.periodEnd === '2026-06-30');
    expect(interestEarned?.value).toBeCloseTo(90575.33);
    // nested "items" row -- proves recursion, not just top-level rows
    const nested = result.accepted.find((f) => f.metric.includes('income_on_investments') && f.periodEnd === '2026-06-30');
    expect(nested?.value).toBeCloseTo(20753.16);
  });

  it('strips thousands separators before parsing numerics', () => {
    const result = parseMarketsMojoResponse(FIXTURE);
    // "90,575.33" in the raw fixture -- comma must not survive into the value
    const v = result.accepted.find((f) => f.metric === 'mm_consolidate_interest_earned' && f.periodEnd === '2026-06-30')?.value;
    expect(v).toBe(90575.33);
  });

  it('negative control: code != "200" is treated as empty, not parsed', () => {
    const result = parseMarketsMojoResponse(JSON.stringify({ code: 500 }));
    expect(result.accepted).toHaveLength(0);
    expect(result.isEmpty).toBe(true);
    expect(result.rejectReason).toContain("code != '200'");
  });

  it('negative control: missing data.snapshot is rejected, not thrown', () => {
    const result = parseMarketsMojoResponse(JSON.stringify({ code: 200, data: {} }));
    expect(result.accepted).toHaveLength(0);
    expect(result.rejectReason).toContain('data.snapshot');
  });

  it('an empty snapshot (page beyond real data) is treated as empty, no rejectReason -- this is the loop-stop signal, not an error', () => {
    const result = parseMarketsMojoResponse(JSON.stringify({ code: 200, data: { snapshot: {} } }));
    expect(result.accepted).toHaveLength(0);
    expect(result.isEmpty).toBe(true);
    expect(result.rejectReason).toBeUndefined();
  });

  it('non-JSON body does not throw', () => {
    const result = parseMarketsMojoResponse('not json');
    expect(result.rejectReason).toContain('not valid JSON');
  });
});
