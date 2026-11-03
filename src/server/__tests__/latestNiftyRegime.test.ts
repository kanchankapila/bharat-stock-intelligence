import { beforeEach, describe, expect, it } from 'vitest';

const { dbExec, dbRun } = await import('../dbAsync');
const { getLatestNiftyRegime } = await import('../strategySignalsService');

beforeEach(async () => {
  await dbExec('DELETE FROM technical_signals');
});

async function seed(symbol: string, date: string, regime: string, computedAt: string) {
  await dbRun(
    `INSERT INTO technical_signals (symbol, date, nifty_regime, computed_at) VALUES (?, ?, ?, ?)`,
    [symbol, date, regime, computedAt],
  );
}

describe('getLatestNiftyRegime', () => {
  it('takes the newest date, then the newest computed_at on a split date', async () => {
    await seed('OLD', '2026-10-29', 'BULL', '2026-10-29T18:50:00Z');
    await seed('SCAN', '2026-10-30', 'BEAR', '2026-10-30T05:00:00Z');
    await seed('GRID', '2026-10-30', 'HIGH_VOL', '2026-10-30T18:50:00Z');
    for (let i = 0; i < 20; i++) expect(await getLatestNiftyRegime()).toBe('HIGH_VOL');
  });

  it('breaks an equal computed_at by nifty_regime, whatever the insert order', async () => {
    await seed('B', '2026-10-30', 'HIGH_VOL', '2026-10-30T18:50:00Z');
    await seed('A', '2026-10-30', 'BEAR', '2026-10-30T18:50:00Z');
    for (let i = 0; i < 20; i++) expect(await getLatestNiftyRegime()).toBe('BEAR');
  });

  it('ignores NULL regimes and falls back to SIDEWAYS when there are none', async () => {
    expect(await getLatestNiftyRegime()).toBe('SIDEWAYS');
    await dbRun(`INSERT INTO technical_signals (symbol, date, computed_at) VALUES (?, ?, ?)`,
      ['N', '2026-10-31', '2026-10-31T18:50:00Z']);
    await seed('X', '2026-10-30', 'BULL', '2026-10-30T18:50:00Z');
    expect(await getLatestNiftyRegime()).toBe('BULL');
  });
});
