import { beforeEach, describe, expect, it } from 'vitest';

const { dbExec, dbRun } = await import('../dbAsync');
const { latestCompleteSignalDate } = await import('../technicalSignalsDate');

const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);

async function seed(date: string, rows: number) {
  for (let i = 0; i < rows; i++) {
    await dbRun(`INSERT INTO technical_signals (symbol, date) VALUES (?, ?) ON CONFLICT DO NOTHING`, [`S${i}`, date]);
  }
}

// Live 2026-10-08: the day's first partial scan wrote 392 rows (all with NULL win_probability)
// against ~2,165 on a complete day, and MAX(date) pointed every reader at the partial day.
describe('latestCompleteSignalDate', () => {
  beforeEach(async () => { await dbExec('DELETE FROM technical_signals'); });

  it('skips a newer partial day and returns the latest complete one', async () => {
    await seed(daysAgo(2), 20);
    await seed(daysAgo(1), 20);
    await seed(daysAgo(0), 4);
    expect(await latestCompleteSignalDate()).toBe(daysAgo(1));
  });

  it('returns the newest day once it is complete', async () => {
    await seed(daysAgo(1), 20);
    await seed(daysAgo(0), 15);
    expect(await latestCompleteSignalDate()).toBe(daysAgo(0));
  });

  it('is null when there are no rows in the window', async () => {
    expect(await latestCompleteSignalDate()).toBeNull();
  });
});
