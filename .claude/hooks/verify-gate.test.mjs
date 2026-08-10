// Negative-controlled self-check for verify-gate.mjs. Run: node .claude/hooks/verify-gate.test.mjs
// The first case is the whole point: the gate this replaced passed it.
import assert from 'node:assert/strict';
import { decide, classify, verificationsPassed } from './verify-gate.mjs';

const line = o => JSON.stringify(o);
const use = (id, command, name = 'Bash') =>
  line({ message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input: { command } }] } });
const result = (id, is_error) =>
  line({ message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, is_error }] } });
const text = t => line({ message: { role: 'assistant', content: [{ type: 'text', text: t }] } });

const PY = ['unified_ranker.py'];
const TS = ['src/server/router.ts'];

// 1. NEGATIVE CONTROL — prose only. The old regex-the-transcript gate passed this.
assert.match(
  decide(PY, text('I ran pytest and npx tsc --noEmit, everything passes.')),
  /never ran to a passing exit/,
  'prose claiming a test ran must not satisfy the gate',
);

// 2. A real, passing run satisfies it.
assert.equal(decide(PY, [use('a', 'python -m pytest src/server/tests/ -q'), result('a', false)].join('\n')), null);

// 3. A run that exited non-zero does not.
assert.match(decide(PY, [use('b', 'python -m pytest -q'), result('b', true)].join('\n')), /pytest/);

// 4. A tool_use with no result yet (still running / interrupted) does not count.
assert.match(decide(PY, use('c', 'python -m pytest -q')), /pytest/);

// 5. .ts changes need both tsc and vitest; one alone still blocks, naming only what's missing.
const tscOnly = [use('d', 'npx tsc --noEmit'), result('d', false)].join('\n');
const r = decide(TS, tscOnly);
assert.match(r, /vitest/);
assert.doesNotMatch(r, /tsc --noEmit/);
assert.equal(decide(TS, [tscOnly, use('e', 'npx vitest run'), result('e', false)].join('\n')), null);

// 6. No code changed -> never block, whatever the transcript says.
assert.equal(decide([], ''), null);

// 7. Malformed lines are skipped, not fatal.
assert.equal(decide(PY, ['not json', '', use('f', 'pytest'), result('f', false)].join('\n')), null);

// 8. --collect-only is not a verification run.
assert.equal(classify('pytest --collect-only -q'), null);
assert.equal(classify('npm run lint'), 'tsc');

// 9. PowerShell counts too; a non-shell tool whose input happens to contain "pytest" does not.
assert.ok(verificationsPassed([use('g', 'python -m pytest -q', 'PowerShell'), result('g', false)].join('\n')).has('pytest'));
assert.equal(verificationsPassed([use('h', 'pytest', 'Read'), result('h', false)].join('\n')).size, 0);

console.log('verify-gate: 9 cases passed');
