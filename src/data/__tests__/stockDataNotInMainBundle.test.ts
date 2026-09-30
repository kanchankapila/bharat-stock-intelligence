import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

// AF-20260930-22: nseStocks.ts + stocklist.ts (~1MB of source) were statically reachable from
// App.tsx, so the whole stock master shipped in the main chunk (418KB -> 252KB gzip once lazy).
// Walks the real STATIC import graph from the entry (dynamic `import()` and `import type` are
// not followed -- neither pulls a module into the entry chunk), so a new eager importer
// anywhere on the startup path fails here, not only the files someone remembered to list.
const ROOT = resolve(__dirname, '../../..');
const ENTRY = resolve(ROOT, 'src/App.tsx');
const HEAVY = ['src/data/stocklist.ts', 'src/data/nseStocks.ts'].map(p => resolve(ROOT, p));

const STATIC_IMPORT = /^\s*(?:import|export)\s+(?!type\b)(?:[^'"]*?\bfrom\s+)?['"](\.{1,2}\/[^'"]+)['"]/gm;

function resolveLocal(from: string, spec: string): string | null {
  const base = resolve(dirname(from), spec);
  for (const cand of [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`]) {
    if (existsSync(cand) && /\.tsx?$/.test(cand)) return cand;
  }
  return null;
}

function staticClosure(entry: string): Map<string, string> {
  const parent = new Map<string, string>([[entry, '']]);
  const queue = [entry];
  while (queue.length) {
    const file = queue.shift()!;
    for (const m of readFileSync(file, 'utf8').matchAll(STATIC_IMPORT)) {
      const dep = resolveLocal(file, m[1]);
      if (dep && !parent.has(dep)) {
        parent.set(dep, file);
        queue.push(dep);
      }
    }
  }
  return parent;
}

function chain(parent: Map<string, string>, file: string): string {
  const out: string[] = [];
  for (let f = file; f; f = parent.get(f)!) out.unshift(f.replace(ROOT, '').replace(/\\/g, '/'));
  return out.join(' -> ');
}

describe('stock master stays out of the main bundle', () => {
  const closure = staticClosure(ENTRY);

  it('walks a real graph (non-vacuity): reaches every file that used to import the data eagerly', () => {
    const files = [...closure.keys()].map(f => f.replace(/\\/g, '/'));
    for (const f of ['AppShell.tsx', 'CommandPalette.tsx', 'SlideOutDrawer.tsx', 'MCStockInfoPanel.tsx']) {
      expect(files.some(p => p.endsWith(`/components/${f}`)), f).toBe(true);
    }
  });

  it.each(HEAVY)('%s is not statically reachable from App.tsx', heavy => {
    const hit = closure.has(heavy) ? chain(closure, heavy) : null;
    expect(hit, `eager import chain: ${hit}`).toBeNull();
  });
});
