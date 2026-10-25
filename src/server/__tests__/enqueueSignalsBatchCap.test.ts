import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const { createCallerFactory } = await import('../trpc');
const { appRouter } = await import('../router');
const { buildSignalBatch, MAX_SIGNAL_BATCH } = await import('../../lib/signalBatch');

const caller = createCallerFactory(appRouter)({} as any);

// AF-20261025-07 follow-up. The AI Signals REFRESH button on the home page (DashboardPage) is the
// ONLY caller of enqueueSignals. It sent the whole live universe (2,376 symbols live on 2026-10-25)
// but the router caps one call at .max(200) (b810692a, 2026-08-15, comment claimed "tens of
// symbols"). Zod rejected every click with BAD_REQUEST and the component's bare `catch {}` hid it.
const universe = Array.from({ length: 2376 }, (_, i) => ({
  symbol: `SYM${i}`, name: `Sym ${i}`, price: 100, change: 0, changePct: ((i * 37) % 200) / 10 - 10,
  volume: '1M', high: 1, low: 1, open: 1, prevClose: 1,
}));

describe('enqueueSignals batch cap vs the REFRESH button payload', () => {
  it('the payload built from the full live universe is accepted by the router', async () => {
    const payload = buildSignalBatch(universe);
    await expect(caller.enqueueSignals(payload)).resolves.toMatchObject({ queueAvailable: expect.any(Boolean) });
  });

  it('the payload is bounded by the shared cap and keeps the largest movers', () => {
    const payload = buildSignalBatch(universe);
    expect(payload.length).toBeLessThanOrEqual(MAX_SIGNAL_BATCH);
    const kept = Math.min(...payload.map(p => Math.abs((p.stockData as any).changePct)));
    const dropped = Math.max(...universe.filter(u => !payload.some(p => p.symbol === u.symbol)).map(u => Math.abs(u.changePct)));
    expect(kept).toBeGreaterThanOrEqual(dropped);
  });

  it('the router cap is exactly MAX_SIGNAL_BATCH: cap accepted, cap+1 rejected', async () => {
    const batch = (n: number) => Array.from({ length: n }, (_, i) => ({ symbol: `S${i}`, stockData: {} }));
    await expect(caller.enqueueSignals(batch(MAX_SIGNAL_BATCH))).resolves.toBeDefined();
    await expect(caller.enqueueSignals(batch(MAX_SIGNAL_BATCH + 1))).rejects.toThrow(/too_big|<=s*${MAX_SIGNAL_BATCH}/);
  });

  it('DashboardPage builds its payload through buildSignalBatch', () => {
    const src = readFileSync('src/components/DashboardPage.tsx', 'utf8');
    expect(src).toMatch(/buildSignalBatch\(stocks\)/);
    expect(src).not.toMatch(/stocks\.map\(s => \(\{ symbol: s\.symbol, stockData/);
  });
});
