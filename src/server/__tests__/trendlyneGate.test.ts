import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { trendlynePending, withTrendlyneSlot } from '../trendlyneGate';

// AF-20261117-18: three schedules hit trendlyne.com in the same minute (2026-11-17 20:00 IST) and
// the refusal failed ml-daily-ops. One Trendlyne script at a time; the catch-up yields.
describe('trendlyne gate', () => {
  it('runs one holder at a time, in arrival order, and counts holders plus waiters', async () => {
    const log: string[] = [];
    let open = 0;
    let maxOpen = 0;
    const job = (name: string, ms: number) => withTrendlyneSlot(async () => {
      open += 1; maxOpen = Math.max(maxOpen, open); log.push(`start ${name}`);
      await new Promise(r => setTimeout(r, ms));
      log.push(`end ${name}`); open -= 1;
      return name;
    });
    const all = Promise.all([job('a', 20), job('b', 5), job('c', 1)]);
    expect(trendlynePending()).toBe(3);
    expect(await all).toEqual(['a', 'b', 'c']);
    expect(maxOpen).toBe(1);
    expect(log).toEqual(['start a', 'end a', 'start b', 'end b', 'start c', 'end c']);
    expect(trendlynePending()).toBe(0);
  });

  it('releases the slot when a holder throws', async () => {
    await expect(withTrendlyneSlot(async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(await withTrendlyneSlot(async () => 'next')).toBe('next');
    expect(trendlynePending()).toBe(0);
  });

  it('every scheduled Python step that talks to Trendlyne goes through the gate', () => {
    const dir = resolve(__dirname, '..');
    const files = ['queues.ts', ...readdirSync(resolve(dir, 'jobs')).filter(f => f.endsWith('.ts')).map(f => `jobs/${f}`)];
    const tl = /runPython\('((?:trendlyne_|tl_|so_option_chain_fetcher|sync_tl_index_map|extra_endpoints_fetcher)[a-z_]*\.py)'/g;
    let found = 0;
    const bare: string[] = [];
    for (const f of files) {
      for (const line of readFileSync(resolve(dir, f), 'utf-8').split(/\r?\n/)) {
        for (const m of line.matchAll(tl)) {
          found += 1;
          if (!line.includes('withTrendlyneSlot(')) bare.push(`${f}: ${m[1]}`);
        }
      }
    }
    expect(found).toBeGreaterThanOrEqual(10);
    expect(bare).toEqual([]);
  });

  it('the catch-up slice skips instead of queueing behind another Trendlyne step', () => {
    const src = readFileSync(resolve(__dirname, '..', 'jobs', 'trendlyneWeekly.jobs.ts'), 'utf-8');
    const body = src.slice(src.indexOf('export async function processTrendlyneCatchup'));
    expect(body.indexOf('trendlynePending() > 0')).toBeGreaterThan(0);
    expect(body.indexOf('trendlynePending() > 0')).toBeLessThan(body.indexOf('withTrendlyneSlot('));
    expect(body).toContain('skipped: true');
  });
});
