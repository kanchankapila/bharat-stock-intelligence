import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * AF-20261120-06: screener_appearances is keyed (screener_id, symbol, appeared_date) with no source,
 * and ETnow and MoneyControl issue overlapping screener ids (20 shared on 2026-11-20). An exit UPDATE
 * matched on screener_id alone closes the OTHER provider's open episode for the same symbol.
 * Every writer's exit must name its own source.
 */
const dir = join(__dirname, '..');
const sites = readdirSync(dir)
  .filter(f => f.endsWith('.ts'))
  .flatMap(f => readFileSync(join(dir, f), 'utf8').split('\n')
    .filter(l => /UPDATE screener_appearances SET exited_date/.test(l))
    .map(line => ({ f, line })));
const snapshots = readdirSync(dir)
  .filter(f => f.endsWith('.ts'))
  .flatMap(f => readFileSync(join(dir, f), 'utf8').split('\n')
    .filter(l => /SELECT symbol FROM screener_appearances WHERE/.test(l))
    .map(line => ({ f, line })));

describe('screener_appearances exits are scoped to the writing provider (AF-20261120-06)', () => {
  it('finds the four provider writers (non-vacuity)', () => {
    expect(sites.map(s => s.f).sort()).toEqual(
      ['etMarketstatsSync.ts', 'etnowScreenerSync.ts', 'moneycontrolScreener.ts', 'trendlyneScreener.ts']);
  });

  it.each(sites)('$f closes only its own episodes', ({ line }) => {
    expect(line).toMatch(/AND source = '[a-z_]+'/);
  });

  it('finds the four provider snapshots (non-vacuity)', () => {
    expect(snapshots.map(s => s.f).sort()).toEqual(
      ['etMarketstatsSync.ts', 'etnowScreenerSync.ts', 'moneycontrolScreener.ts', 'trendlyneScreener.ts']);
  });

  it.each(snapshots)('$f compares only its own active episodes', ({ line }) => {
    expect(line).toMatch(/AND source = '[a-z_]+'/);
  });
});
