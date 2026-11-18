import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// AF-20260927-12: omitting runPython's third argument silently gives the step a 5 minute budget, a
// number nobody chose, and the step stays green until its input grows past exactly 300 s (the
// ml-weekly-retrain performance_tracker.py failure). Every non-test call must state its budget.
// ALLOWED lists the only intentional default: the interactive MCP engine runner, where an ad hoc
// tool call should not run longer than a chat tool is willing to wait.
const ROOT = join(__dirname, '..');
const ALLOWED = new Set(['mcpServer.ts::runPython(scriptFilename, args)']);

function walk(dir: string, out: string[] = []): string[] {
  for (const f of readdirSync(dir)) {
    if (f === 'node_modules' || f === '__tests__' || f === 'tests') continue;
    const p = join(dir, f);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.ts$/.test(f) && !/\.test\./.test(f)) out.push(p);
  }
  return out;
}

/** Blank out comments (keeping offsets) so prose that mentions runPython( is not counted. */
export function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[ \t])\/\/[^\n]*/gm, (m, lead) => lead + ' '.repeat(m.length - lead.length));
}

/** Number of top-level arguments of the call whose '(' is at openIdx. */
export function argCount(src: string, openIdx: number): number {
  let depth = 0, args = 0, cur = '', inStr: string | null = null;
  for (let i = openIdx; i < src.length; i++) {
    const ch = src[i];
    if (inStr) { if (ch === '\\') { i++; continue; } if (ch === inStr) inStr = null; continue; }
    if (ch === '"' || ch === "'" || ch === '`') { inStr = ch; cur += 'x'; continue; }
    if ('([{'.includes(ch)) { depth++; if (depth === 1) continue; }
    if (')]}'.includes(ch)) { depth--; if (depth === 0) return cur.trim() ? args + 1 : args; }
    if (ch === ',' && depth === 1) { args++; cur = ''; continue; }
    cur += ch;
  }
  return args;
}

export function shortRunPythonCalls(src: string): string[] {
  const code = stripComments(src);
  const out: string[] = [];
  for (const m of code.matchAll(/(?<![A-Za-z_.])runPython\(/g)) {
    if (/function\s+$/.test(code.slice(Math.max(0, m.index! - 20), m.index!))) continue;
    if (argCount(code, m.index! + m[0].length - 1) < 3) {
      out.push(code.slice(m.index!, code.indexOf(')', m.index!) + 1).replace(/\s+/g, ' '));
    }
  }
  return out;
}

describe('runPython calls state their timeout', () => {
  it('no non-test call relies on the implicit 5 minute default (except the interactive MCP runner)', () => {
    const files = walk(ROOT);
    let calls = 0;
    const offenders: string[] = [];
    for (const f of files) {
      const src = readFileSync(f, 'utf8');
      calls += [...stripComments(src).matchAll(/(?<![A-Za-z_.])runPython\(/g)].length;
      for (const c of shortRunPythonCalls(src)) {
        const key = `${f.slice(ROOT.length + 1).replace(/\\/g, '/')}::${c}`;
        if (!ALLOWED.has(key)) offenders.push(key);
      }
    }
    expect(calls, 'census is vacuous: too few runPython calls found').toBeGreaterThan(150);
    expect(offenders).toEqual([]);
  });

  it('the scan itself flags a call with two arguments, ignores comments, and accepts three', () => {
    expect(shortRunPythonCalls("await runPython('a.py');")).toHaveLength(1);
    expect(shortRunPythonCalls("await runPython('a.py', ['--x']);")).toHaveLength(1);
    expect(shortRunPythonCalls("await runPython('a.py', [], 60_000);")).toHaveLength(0);
    expect(shortRunPythonCalls("// the old runPython('a.py') default\nawait runPython('b.py', [], 1);")).toHaveLength(0);
    expect(shortRunPythonCalls("await runPython(`x-${n}.py`, [1, 2], 5 * 60_000).catch(e => e);")).toHaveLength(0);
  });
});
