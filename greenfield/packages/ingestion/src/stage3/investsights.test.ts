import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { deriveEventKind, parseInvestSightsResponse } from './investsights.js';

const FIXTURE = readFileSync(fileURLToPath(new URL('./__fixtures__/investsights_sample.json', import.meta.url)), 'utf8');

describe('parseInvestSightsResponse', () => {
  it('parses all 7 real actions from the live-captured fixture, zero rejected at the JSON layer', () => {
    const result = parseInvestSightsResponse(FIXTURE);
    expect(result.accepted).toHaveLength(7);
    expect(result.rejected).toHaveLength(0);
  });

  it('includes the real BSE-only row (symbol=509470) -- validation against `security` happens downstream, not here', () => {
    const result = parseInvestSightsResponse(FIXTURE);
    const bseRow = result.accepted.find((a) => a.symbol === '509470');
    expect(bseRow).toBeDefined();
    expect(bseRow?.sourceUrl).toContain('bseindia.com');
  });

  it('preserves a null ex_date alongside a populated record_date without rejecting the row', () => {
    const result = parseInvestSightsResponse(FIXTURE);
    const matrimony = result.accepted.find((a) => a.symbol === 'MATRIMONY');
    expect(matrimony).toBeDefined();
    expect(matrimony?.exDate).toBeNull();
    expect(matrimony?.recordDate).toBe('2026-08-05');
  });

  it('negative control: rejects an envelope missing success=true', () => {
    const result = parseInvestSightsResponse(JSON.stringify({ actions: [{ symbol: 'X', source_url: 'https://x' }] }));
    expect(result.accepted).toHaveLength(0);
    expect(result.rejected).toHaveLength(1);
  });

  it('negative control: rejects a row missing source_url (the natural dedup key)', () => {
    const result = parseInvestSightsResponse(JSON.stringify({ success: true, actions: [{ symbol: 'ABC' }] }));
    expect(result.accepted).toHaveLength(0);
    expect(result.rejected[0]?.reason).toContain('source_url');
  });

  it('negative control: rejects a row missing symbol', () => {
    const result = parseInvestSightsResponse(JSON.stringify({ success: true, actions: [{ source_url: 'https://x' }] }));
    expect(result.accepted).toHaveLength(0);
    expect(result.rejected[0]?.reason).toContain('symbol');
  });

  it('negative control: non-JSON body is rejected wholesale, not thrown', () => {
    const result = parseInvestSightsResponse('<html>not json</html>');
    expect(result.accepted).toHaveLength(0);
    expect(result.rejected).toHaveLength(1);
  });
});

describe('deriveEventKind', () => {
  it('maps the real fixture categories to a sensible event_type', () => {
    expect(deriveEventKind('board_meeting|dividend|results')).toBe('board_meeting');
    expect(deriveEventKind('results|dividend|fundraise')).toBe('earnings');
    expect(deriveEventKind('other')).toBe('announcement');
  });

  it('falls back to announcement for null/unrecognized category, never throws', () => {
    expect(deriveEventKind(null)).toBe('announcement');
    expect(deriveEventKind('some_unknown_label')).toBe('announcement');
  });
});
