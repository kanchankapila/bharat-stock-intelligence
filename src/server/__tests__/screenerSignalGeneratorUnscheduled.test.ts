import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

// AF-20261001-18: screener_signal_generator.py wrote nothing after 2026-08-13 (32 of 33 qualifying
// screeners are Unranked, so its track-record gate correctly refuses). The live screener signals come
// from the intraday scan. A step that cannot emit only adds a 3-minute budget and a fail path to two
// chains, so it must stay unscheduled until a ranked-tier gate is chosen on evidence.
const SERVER = join(__dirname, '..');
const scheduler = [
  join(SERVER, 'queues.ts'),
  ...readdirSync(join(SERVER, 'jobs')).filter(f => f.endsWith('.ts')).map(f => join(SERVER, 'jobs', f)),
];

describe('screener_signal_generator stays unscheduled', () => {
  it('scans real scheduler sources (non-vacuity)', () => {
    const all = scheduler.map(f => readFileSync(f, 'utf8')).join('\n');
    expect(all).toContain("runPython('screener_sector_rotation.py'");
  });
  it('no scheduler source runs it', () => {
    const offenders = scheduler.filter(f => /runPython\(\s*['"]screener_signal_generator\.py['"]/.test(readFileSync(f, 'utf8')));
    expect(offenders).toEqual([]);
  });
});
