import { describe, it, expect, beforeEach } from 'vitest';

// Isolates this test from the host environment's USE_POSTGRES -- see createSignal.test.ts
// for the full explanation of why a dynamic import is required here, not a plain top-level
// statement before a static `import { dbRun } from '../dbAsync'`.
process.env.USE_POSTGRES = 'false';
const { dbRun } = await import('../dbAsync');
const { getTrendlyneScreenerList } = await import('../trendlyneScreener');

describe('getTrendlyneScreenerList', () => {
  beforeEach(async () => {
    await dbRun(`DELETE FROM trendlyne_screeners WHERE screener_id = ?`, ['TESTXID99']);
    await dbRun(`DELETE FROM moneycontrol_screeners WHERE scan_id = ?`, ['TESTXID99']);
    await dbRun(`DELETE FROM etnow_screeners WHERE screener_id = ?`, ['TESTXID99']);
  });

  it('namespaces ids per source so a raw numeric id colliding across Trendlyne/MoneyControl/ETnow never produces a duplicate React key', async () => {
    // Real live bug (2026-08-04): each source hands out its own independent numeric id
    // sequence with no cross-source namespace, and getTrendlyneScreenerList used to push the
    // raw id straight through as `id` -- confirmed via a live "Encountered two children with
    // the same key" React warning on TrendlyneScreenerPanel.tsx's Quick Directory grid.
    await dbRun(
      `INSERT INTO trendlyne_screeners (screener_id, screener_name, screenpk, description, sentiment, category, timeframe)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ['TESTXID99', 'TL Test Screener', 'tlpk430', 'desc', 'bullish', 'technical', 'intraday'],
    );
    await dbRun(
      `INSERT INTO moneycontrol_screeners (scan_id, cat_id, screener_name, type, is_positive)
       VALUES (?, ?, ?, ?, ?)`,
      ['TESTXID99', 'test-cat', 'MC Test Screener', 'pro', 1],
    );
    await dbRun(
      `INSERT INTO etnow_screeners (screener_id, screener_name, query_condition)
       VALUES (?, ?, ?)`,
      ['TESTXID99', 'ET Test Screener', '{}'],
    );

    const list = await getTrendlyneScreenerList();
    const tl = list.find((s: any) => s.name === 'TL Test Screener');
    const mc = list.find((s: any) => s.name === 'MC Test Screener');
    const et = list.find((s: any) => s.name === 'ET Test Screener');

    expect(tl).toBeTruthy();
    expect(mc).toBeTruthy();
    expect(et).toBeTruthy();
    expect(tl!.id).toBe('tl-TESTXID99');
    expect(mc!.id).toBe('mc-TESTXID99');
    expect(et!.id).toBe('et-TESTXID99');

    // The whole point: no two entries in the returned list share an id.
    const ids = list.map((s: any) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
