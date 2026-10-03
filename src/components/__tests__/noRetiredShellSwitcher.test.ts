import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

// AF-20260930-46: AppShell's header kept V1/V2/V3 PRO/WORKBENCH/V5 buttons a month after the
// 2026-09-01 consolidation. V2/V3/Workbench wrote dashboardVersion and reloaded, then App.tsx
// migrated it straight back to v1; /v5 fell through to the catch-all route. Every click was a
// full reload that changed nothing. Only App.tsx's one-time migration may write the key.
const SRC = resolve(__dirname, '../..');

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return ['node_modules', '__tests__', 'server'].includes(e.name) ? [] : files(p);
    return /\.tsx?$/.test(e.name) ? [p] : [];
  });
}

describe('retired shell switcher', () => {
  it('nothing but App.tsx writes dashboardVersion, and nothing links to /v5', () => {
    const all = files(SRC);
    expect(all.length).toBeGreaterThan(100);
    const migration = resolve(SRC, 'App.tsx');
    const offenders = all.filter(f => resolve(f) !== migration)
      .filter(f => {
        const s = readFileSync(f, 'utf8');
        return /localStorage\.setItem\(\s*['"]dashboardVersion['"]/.test(s) || /location\.href\s*=\s*['"]\/v5['"]/.test(s);
      })
      .map(f => f.slice(SRC.length));
    expect(offenders).toEqual([]);
  });
});
