import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseKayalResponse } from './kayal.js';

const FIXTURE = readFileSync(fileURLToPath(new URL('./__fixtures__/kayal_sample.json', import.meta.url)), 'utf8');

describe('parseKayalResponse', () => {
  it('extracts real NSE symbols from the live-captured fixture (screenpk=15, 64 rows, 27 BSE-only with blank NSEcode)', () => {
    const result = parseKayalResponse(FIXTURE);
    expect(result.screenId).toBe(15);
    expect(result.title).toContain('High Revenue and Profit Growth');
    // 64 total rows; 27 are BSE-only listings with an empty NSEcode field --
    // correctly excluded (NSE is the platform's sole canonical identifier),
    // not silently mis-parsed. rejectedRows accounts for exactly that gap.
    expect(result.members).toHaveLength(37);
    expect(result.members[0]).toEqual({ symbol: 'RADHIKAJWE', rank: 1 });
    expect(result.rejectedRows).toBe(27);
  });

  it('every extracted symbol is upper-case and non-empty', () => {
    const result = parseKayalResponse(FIXTURE);
    for (const m of result.members) {
      expect(m.symbol).toBe(m.symbol.toUpperCase());
      expect(m.symbol.length).toBeGreaterThan(0);
    }
  });

  it('negative control: a response whose header only carries `field`/`key` (not `unique_name`) yields zero accepted rows -- this is the exact predecessor bug (2.1M rows corrupted) this parser must not repeat', () => {
    const bogus = JSON.stringify({
      head: { status: '0' },
      body: {
        tableHeaders: [{ field: 'NSEcode', key: 'NSEcode' }],
        tableData: [['RELIANCE']],
        screenObj: { screenId: 1, title: 'x' },
      },
    });
    const result = parseKayalResponse(bogus);
    expect(result.members).toHaveLength(0);
    expect(result.rejectReason).toContain('unique_name');
  });

  it('negative control: head.status != "0" is treated as failure, not parsed as success', () => {
    const bogus = JSON.stringify({ head: { status: '1', statusDescription: 'Error' }, body: {} });
    const result = parseKayalResponse(bogus);
    expect(result.members).toHaveLength(0);
    expect(result.rejectReason).toContain("status != '0'");
  });

  it('negative control: non-JSON body does not throw', () => {
    const result = parseKayalResponse('not json');
    expect(result.members).toHaveLength(0);
    expect(result.rejectReason).toContain('not valid JSON');
  });

  it('rows with a non-array shape or blank symbol are counted as rejected, not silently skipped', () => {
    const mixed = JSON.stringify({
      head: { status: '0' },
      body: {
        tableHeaders: [{ unique_name: 'NSEcode' }],
        tableData: [['RELIANCE'], 'not-an-array', ['']],
        screenObj: { screenId: 2, title: 'y' },
      },
    });
    const result = parseKayalResponse(mixed);
    expect(result.members).toHaveLength(1);
    expect(result.rejectedRows).toBe(2);
  });
});
