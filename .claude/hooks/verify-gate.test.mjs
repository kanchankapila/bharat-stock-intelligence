// Negative-controlled tests for verify-gate.mjs, the Stop hook that blocks "done" claims
// when nothing was actually run. Picked up by `npx vitest run` like any other suite, so the
// gate is itself gated -- relying on someone remembering to run it by hand is the exact
// failure mode this hook exists to prevent.
import { describe, it, expect } from 'vitest';
import { decide, classify, verificationsPassed } from './verify-gate.mjs';

const line = o => JSON.stringify(o);
const use = (id, command, name = 'Bash') =>
  line({ message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input: { command } }] } });
const result = (id, is_error) =>
  line({ message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, is_error }] } });
const text = t => line({ message: { role: 'assistant', content: [{ type: 'text', text: t }] } });

const PY = ['unified_ranker.py'];
const TS = ['src/server/router.ts'];

describe('verify-gate', () => {
  it('NEGATIVE CONTROL: prose claiming a test ran does not satisfy the gate', () => {
    // The implementation this replaced regexed the transcript for /pytest/ and passed this.
    expect(decide(PY, text('I ran pytest and npx tsc --noEmit, everything passes.')))
      .toMatch(/never ran to a passing exit/);
  });

  it('a real, passing run satisfies it', () => {
    expect(decide(PY, [use('a', 'python -m pytest src/server/tests/ -q'), result('a', false)].join('\n')))
      .toBeNull();
  });

  it('a run that exited non-zero does not', () => {
    expect(decide(PY, [use('b', 'python -m pytest -q'), result('b', true)].join('\n'))).toMatch(/pytest/);
  });

  it('a tool_use with no result yet does not count', () => {
    expect(decide(PY, use('c', 'python -m pytest -q'))).toMatch(/pytest/);
  });

  it('.ts changes need both tsc and vitest, and only the missing one is named', () => {
    const tscOnly = [use('d', 'npx tsc --noEmit'), result('d', false)].join('\n');
    const r = decide(TS, tscOnly);
    expect(r).toMatch(/vitest/);
    expect(r).not.toMatch(/tsc --noEmit/);
    expect(decide(TS, [tscOnly, use('e', 'npx vitest run'), result('e', false)].join('\n'))).toBeNull();
  });

  it('never blocks when no code changed', () => {
    expect(decide([], '')).toBeNull();
  });

  it('skips malformed transcript lines rather than throwing', () => {
    expect(decide(PY, ['not json', '', use('f', 'pytest'), result('f', false)].join('\n'))).toBeNull();
  });

  it('does not count --collect-only as a verification run', () => {
    expect(classify('pytest --collect-only -q')).toBeNull();
    expect(classify('npm run lint')).toBe('tsc');
  });

  it('counts PowerShell but not a non-shell tool whose input merely contains the word', () => {
    expect(verificationsPassed([use('g', 'python -m pytest -q', 'PowerShell'), result('g', false)].join('\n')).has('pytest')).toBe(true);
    expect(verificationsPassed([use('h', 'pytest', 'Read'), result('h', false)].join('\n')).size).toBe(0);
  });
});
