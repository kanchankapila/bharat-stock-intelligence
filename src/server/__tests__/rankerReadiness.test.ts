import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pendingUpstream, todaysSlotMs } from '../rankerReadiness';

/**
 * 2026-11-12 audit: the 22:30 IST unified-ranker ran on a cron offset, not a dependency. In 24
 * days, ml-daily-ops (technical grid, post-close scan, bhavcopy reconcile, ML scoring) finished
 * AFTER the ranker started on 2026-10-28 (23:02) and with one minute to spare on 11-06 (22:29);
 * quant-eod-sync (quality/crowding inputs) finished 22:22-22:27, 3-8 minutes ahead. A slow night
 * silently ranked on the previous session's inputs.
 */
describe('ranker waits for the inputs it reads', () => {
  const wed2230 = new Date('2026-11-11T17:00:00Z');
  const mlSlot = Date.UTC(2026, 10, 11, 13, 20);   // ml-daily-ops '20 13 * * 1-5'
  const qSlot = Date.UTC(2026, 10, 11, 16, 30);    // quant-eod-sync '30 16 * * 1-5'

  it('reads the slot from the cron pattern, UTC', () => {
    expect(todaysSlotMs('20 13 * * 1-5', wed2230)).toBe(mlSlot);
    expect(todaysSlotMs('30 16 * * 1-5', new Date('2026-11-14T17:00:00Z'))).toBeNull(); // Saturday
  });

  it('nothing pending when both finished after today\'s slot', () => {
    expect(pendingUpstream({ 'ml-daily-ops': mlSlot + 174 * 60_000, 'quant-eod-sync': qSlot + 23 * 60_000 }, wed2230)).toEqual([]);
  });

  it('a chain still running (last finish was yesterday) is pending', () => {
    const yesterday = mlSlot - 86_400_000 + 174 * 60_000;
    expect(pendingUpstream({ 'ml-daily-ops': yesterday, 'quant-eod-sync': qSlot + 23 * 60_000 }, wed2230)).toEqual(['ml-daily-ops']);
    expect(pendingUpstream({ 'ml-daily-ops': mlSlot + 1, 'quant-eod-sync': null }, wed2230)).toEqual(['quant-eod-sync']);
  });

  it('a job not yet due today is not waited on', () => {
    expect(pendingUpstream({ 'ml-daily-ops': null, 'quant-eod-sync': null }, new Date('2026-11-11T09:00:00Z'))).toEqual([]);
  });

  it('the scheduled evening ranker run waits before running unified_ranker.py', () => {
    const src = readFileSync(join(__dirname, '..', 'queues.ts'), 'utf8');
    const start = src.indexOf("console.log('[QUEUE] unified-ranker starting...')");
    const run = src.indexOf("await runPython('unified_ranker.py'", start);
    const wait = src.indexOf('waitForRankerInputsLogged(', start);
    expect(wait).toBeGreaterThan(start);
    expect(wait).toBeLessThan(run);
  });
});
