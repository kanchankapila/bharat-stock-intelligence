import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { UNIFIED_RANKER_TIMEOUT_MS } from '../jobBudgets';
import { JOB_REGISTRY } from '../jobRegistry';

describe('unified ranker runtime budget', () => {
  it('uses the shared budget at every real invocation, including the API', () => {
    const root = join(__dirname, '..');
    let calls = 0;
    for (const name of readdirSync(root, { recursive: true }).map(String)) {
      if (!name.endsWith('.ts') || name.includes('__tests__')) continue;
      const code = readFileSync(join(root, name), 'utf8');
      if (!code.includes('unified_ranker.py')) continue;
      const file = ts.createSourceFile(name, code, ts.ScriptTarget.Latest, true);
      const visit = (node: ts.Node) => {
        if (ts.isCallExpression(node) && node.expression.getText(file) === 'runPython'
            && node.arguments[0] && ts.isStringLiteral(node.arguments[0])
            && node.arguments[0].text === 'unified_ranker.py') {
          calls++;
          expect(node.arguments[2]?.getText(file), name).toBe('UNIFIED_RANKER_TIMEOUT_MS');
        }
        ts.forEachChild(node, visit);
      };
      visit(file);
    }
    expect(calls).toBeGreaterThanOrEqual(2);
    const definition = JOB_REGISTRY.find(job => job.jobName === 'unified-ranker');
    expect(definition!.graceMinutes * 60_000).toBeGreaterThan(UNIFIED_RANKER_TIMEOUT_MS);
  });
});
