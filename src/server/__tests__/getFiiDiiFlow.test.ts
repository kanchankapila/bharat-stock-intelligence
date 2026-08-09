import { beforeEach, describe, expect, it } from 'vitest';

process.env.DATABASE_URL = ':memory:';
// Isolates this test from the host environment's USE_POSTGRES -- see backtestRunner.test.ts
// for the full explanation of why this must be set before any dbAsync.ts import.
process.env.USE_POSTGRES = 'false';
const { default: db } = await import('../db');

import { createCallerFactory } from '../trpc';

const { appRouter } = await import('../router');
const createCaller = createCallerFactory(appRouter);
const caller = createCaller({} as any);

beforeEach(() => {
  db.exec('DELETE FROM fii_dii_flow');
});

describe('getFiiDiiFlow', () => {
  it('accepts a long-range days value covering the deep-backfilled history (2016 onward)', async () => {
    const insert = db.prepare(`
      INSERT INTO fii_dii_flow (date, fii_buy, fii_sell, fii_net, dii_buy, dii_sell, dii_net, fii_net_all_segments, mf_total, source)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    insert.run('2016-01-04', 1000, 900, 100, 800, 700, 100, 500, 50, 'investsights');
    insert.run('2026-07-30', 2000, 1800, 200, 1500, 1400, 100, 3000, 80, 'NSE');

    const rows = await caller.getFiiDiiFlow({ days: 4000 });
    expect(rows.length).toBe(2);
    // Includes the newly-exposed segment columns needed for the Money Flow page.
    const recent = rows.find((r: any) => r.date === '2026-07-30');
    expect(recent.fii_net_all_segments).toBe(3000);
    expect(recent.mf_total).toBe(80);
  });

  it('rejects a days value beyond the raised cap', async () => {
    await expect(caller.getFiiDiiFlow({ days: 5000 })).rejects.toThrow();
  });

  it('defaults to 30 days when no input is given', async () => {
    const insert = db.prepare(`
      INSERT INTO fii_dii_flow (date, fii_buy, fii_sell, fii_net, dii_buy, dii_sell, dii_net)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    insert.run('2026-07-30', 100, 90, 10, 80, 70, 10);

    const rows = await caller.getFiiDiiFlow();
    expect(rows.length).toBe(1);
  });
});
