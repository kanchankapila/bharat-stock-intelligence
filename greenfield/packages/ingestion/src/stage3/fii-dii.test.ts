import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseFiiDiiResponse, parseNseFlowDate } from './fii-dii.js';

const FIXTURE = readFileSync(fileURLToPath(new URL('./__fixtures__/fiidii_sample.json', import.meta.url)), 'utf8');

describe('parseNseFlowDate', () => {
  it('parses the real NSE date format', () => {
    expect(parseNseFlowDate('12-Aug-2026')).toBe('2026-08-12');
    expect(parseNseFlowDate('1-Jan-2016')).toBe('2016-01-01');
  });

  it('negative control: unrecognized format returns null, never guesses', () => {
    expect(parseNseFlowDate('2026-08-12')).toBeNull();
    expect(parseNseFlowDate('not a date')).toBeNull();
    expect(parseNseFlowDate('')).toBeNull();
  });
});

describe('parseFiiDiiResponse', () => {
  it('pivots the real live fixture (DII + FII/FPI rows for one date) into a single FlowDay', () => {
    const result = parseFiiDiiResponse(FIXTURE);
    expect(result.accepted).toHaveLength(1);
    expect(result.accepted[0]).toEqual({ flowDate: '2026-08-12', fiiNet: -1002.5, diiNet: 5841.66 });
    expect(result.rejected).toHaveLength(0);
  });

  it('pivots multiple dates independently', () => {
    const body = JSON.stringify([
      { date: '10-Aug-2026', category: 'DII', netValue: '100.5' },
      { date: '10-Aug-2026', category: 'FII/FPI', netValue: '-50.25' },
      { date: '11-Aug-2026', category: 'DII', netValue: '200' },
      { date: '11-Aug-2026', category: 'FII/FPI', netValue: '-75' },
    ]);
    const result = parseFiiDiiResponse(body);
    expect(result.accepted).toHaveLength(2);
    const byDate = Object.fromEntries(result.accepted.map((r) => [r.flowDate, r]));
    expect(byDate['2026-08-10']).toEqual({ flowDate: '2026-08-10', fiiNet: -50.25, diiNet: 100.5 });
    expect(byDate['2026-08-11']).toEqual({ flowDate: '2026-08-11', fiiNet: -75, diiNet: 200 });
  });

  it('negative control: response is not a JSON array', () => {
    const result = parseFiiDiiResponse(JSON.stringify({ error: 'not found' }));
    expect(result.accepted).toHaveLength(0);
    expect(result.rejected[0]?.reason).toContain('not a JSON array');
  });

  it('negative control: unrecognized category is rejected, not silently merged', () => {
    const body = JSON.stringify([{ date: '12-Aug-2026', category: 'MF', netValue: '10' }]);
    const result = parseFiiDiiResponse(body);
    expect(result.accepted).toHaveLength(0);
    expect(result.rejected[0]?.reason).toContain("category 'MF'");
  });

  it('negative control: non-finite netValue is rejected', () => {
    const body = JSON.stringify([{ date: '12-Aug-2026', category: 'DII', netValue: 'not-a-number' }]);
    const result = parseFiiDiiResponse(body);
    expect(result.accepted).toHaveLength(0);
    expect(result.rejected[0]?.reason).toContain('non-finite');
  });

  it('a date with only one of DII/FII present still produces a row with the other net as null', () => {
    const body = JSON.stringify([{ date: '12-Aug-2026', category: 'DII', netValue: '10' }]);
    const result = parseFiiDiiResponse(body);
    expect(result.accepted[0]).toEqual({ flowDate: '2026-08-12', diiNet: 10, fiiNet: null });
  });

  it('non-JSON body does not throw', () => {
    const result = parseFiiDiiResponse('<html>');
    expect(result.accepted).toHaveLength(0);
    expect(result.rejected[0]?.reason).toContain('not valid JSON');
  });
});
