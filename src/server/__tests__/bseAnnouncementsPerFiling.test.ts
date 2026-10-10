/**
 * AF-20261008-36: BSE announcements were keyed on NSURL (the company's stock page), so a company
 * kept ONE news_sentiment_items row forever and every later filing only re-stamped fetched_at
 * (title/published_at frozen at the first sighting). Each filing must be its own row, keyed on
 * BSE's per-filing NEWSID. Fixture is a real AnnSubCategoryGetData/w response (2026-10-09),
 * trimmed to two companies with two filings each.
 */
import { vi, describe, test, expect, beforeEach, afterEach } from 'vitest';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

const fixture = JSON.parse(fs.readFileSync(
  path.join(__dirname, 'fixtures', 'bse_announcements_20261009.json'), 'utf8',
)) as { Table: Array<Record<string, any>> };

vi.mock('../dbAsync', () => ({
  dbGet: vi.fn(),
  dbAll: vi.fn(async () => [
    { symbol: 'TECHM', name: 'Tech Mahindra Limited' },
    { symbol: 'PTCIL', name: 'PTC Industries Limited' },
  ]),
  dbRun: vi.fn(),
  dbTransaction: vi.fn(async (fn: any) => fn({})),
}));

const upserts: unknown[][][] = [];
vi.mock('../dbBulk', () => ({
  rowGroups: () => '',
  bulkUpsert: vi.fn(async (_tx: unknown, rows: unknown[][], cols: number) => {
    if (cols === 13) upserts.push(rows);
  }),
}));

const { runBseAnnouncementsCycle } = await import('../newsSentimentService');

// sentiment row layout: id, title, summary, source, source_type, url, published_at, ..., symbols_json (11)
type Row = unknown[];
const runOnce = async (): Promise<Row[]> => {
  upserts.length = 0;
  await runBseAnnouncementsCycle();
  return upserts.flat();
};

describe('runBseAnnouncementsCycle row identity', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => ({
      ok: true,
      json: async () => ({ Table: url.includes('pageno=1&') ? fixture.Table : [] }),
    })));
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  test('two filings from one company produce two rows, each with its own title time', async () => {
    const rows = await runOnce();
    expect(rows).toHaveLength(4);
    expect(new Set(rows.map(r => r[0])).size).toBe(4);

    const techm = rows.filter(r => JSON.parse(r[11] as string).includes('TECHM'));
    expect(techm).toHaveLength(2);
    const expected = fixture.Table.filter(a => a.SCRIP_CD === 532755)
      .map(a => new Date(a.NEWS_DT).toISOString()).sort();
    expect(techm.map(r => r[6]).sort()).toEqual(expected);
    // stored url is filing-specific, not the shared stock page
    expect(new Set(techm.map(r => r[5])).size).toBe(2);
    for (const r of techm) expect(r[5]).not.toMatch(/stock-share-price/);
  });

  test('re-fetching the same filings yields the same ids (no duplicate rows)', async () => {
    const a = (await runOnce()).map(r => r[0]).sort();
    const b = (await runOnce()).map(r => r[0]).sort();
    expect(b).toEqual(a);
  });

  test('new ids never collide with the legacy one-row-per-company ids', async () => {
    const legacy = new Set(fixture.Table.map(a =>
      crypto.createHash('sha1').update(`BSE Announcements:${a.NSURL}`).digest('hex')));
    for (const r of await runOnce()) expect(legacy.has(r[0] as string)).toBe(false);
  });
});
