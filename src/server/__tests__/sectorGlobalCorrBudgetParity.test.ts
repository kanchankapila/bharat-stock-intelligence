import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

// sector_global_corr.py waits on technical_signals row locks held by other writers. 2026-11-03 raised
// the evening call to 10 min after it died at exactly 180s; the 08:00 dl-macro-fetch call kept 3 min
// and failed the same way on 11-02 and 11-04. Every call site must carry the same budget.
const SERVER = path.resolve(__dirname, '..');
const files = [path.join(SERVER, 'queues.ts'),
  ...readdirSync(path.join(SERVER, 'jobs')).filter(f => f.endsWith('.ts')).map(f => path.join(SERVER, 'jobs', f))];

function budgetsMs(): number[] {
  const out: number[] = [];
  const re = /runPython\(\s*'sector_global_corr\.py'\s*,\s*\[[^\]]*\]\s*,\s*([\d_]+)\s*\*\s*([\d_]+)\s*\)/g;
  for (const f of files) {
    for (const m of readFileSync(f, 'utf8').matchAll(re)) {
      out.push(Number(m[1].replace(/_/g, '')) * Number(m[2].replace(/_/g, '')));
    }
  }
  return out;
}

describe('sector_global_corr.py runPython budgets', () => {
  it('finds both call sites and gives them the same 10-minute budget', () => {
    const b = budgetsMs();
    expect(b.length).toBeGreaterThanOrEqual(2);
    expect(new Set(b)).toEqual(new Set([10 * 60_000]));
  });
});
