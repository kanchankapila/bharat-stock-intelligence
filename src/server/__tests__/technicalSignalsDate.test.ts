import { beforeEach, describe, expect, it } from 'vitest';

const { dbExec, dbRun } = await import('../dbAsync');
const { latestCompleteSignalDate } = await import('../technicalSignalsDate');

const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);

async function seed(date: string, rows: number) {
  // one statement: 20 round trips per seed exceeded the 5 s test timeout while pytest loaded the database
  await dbRun(
    `INSERT INTO technical_signals (symbol, date) SELECT 'S' || g, CAST(? AS date) FROM generate_series(0, ?) g ON CONFLICT DO NOTHING`,
    [date, rows - 1],
  );
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
