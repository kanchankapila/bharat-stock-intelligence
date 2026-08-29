// Negative-controlled tests for verify-gate.mjs, the Stop hook that blocks "done" claims
// when nothing was actually run. Picked up by `npx vitest run` like any other suite, so the
// gate is itself gated -- relying on someone remembering to run it by hand is the exact
// failure mode this hook exists to prevent.
import { describe, it, expect } from 'vitest';
import { decide, classify, verificationsPassed, sessionEditedFiles, filterToSessionEdits } from './verify-gate.mjs';

const line = o => JSON.stringify(o);
const use = (id, command, name = 'Bash') =>
  line({ message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input: { command } }] } });
const result = (id, is_error) =>
  line({ message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, is_error }] } });
const text = t => line({ message: { role: 'assistant', content: [{ type: 'text', text: t }] } });

const PY = ['src/server/some_fetcher.py'];
const TS = ['src/server/router.ts'];
const RANKER = ['unified_ranker.py'];

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

  // NEGATIVE CONTROL for the signal/scoring-surface requirement below: a green pytest
  // run on unified_ranker.py alone -- the exact shape that let two dead factors read as
  // alive for weeks (docs/measurement-history.md) -- must still block without evidence.
  it('NEGATIVE CONTROL: touching unified_ranker.py with only a passing pytest run still blocks', () => {
    const greenPytest = [use('i', 'python -m pytest src/server/tests/ -q'), result('i', false)].join('\n');
    expect(decide(RANKER, greenPytest)).toMatch(/factor_backtest\.py/);
  });

  it('a factor_backtest.py run satisfies the signal-surface requirement', () => {
    const both = [
      use('j', 'python -m pytest src/server/tests/ -q'), result('j', false),
      use('k', 'python src/server/factor_backtest.py --rebalance 21'), result('k', false),
    ].join('\n');
    expect(decide(RANKER, both)).toBeNull();
  });

  it('updating measurement.md/measurement-history.md also satisfies it, via allChanged', () => {
    const greenPytest = [use('l', 'python -m pytest src/server/tests/ -q'), result('l', false)].join('\n');
    const allChanged = [...RANKER, '.claude/rules/measurement.md'];
    expect(decide(RANKER, greenPytest, allChanged)).toBeNull();
    // the doc edit alone, not present in `changed`/`allChanged` at all, does not count
    expect(decide(RANKER, greenPytest, RANKER)).toMatch(/factor_backtest\.py/);
  });

  it('non-signal-surface .py files never trigger the backtest requirement', () => {
    const greenPytest = [use('m', 'python -m pytest src/server/tests/ -q'), result('m', false)].join('\n');
    expect(decide(PY, greenPytest)).toBeNull();
  });
});

// A concurrent session can leave the shared working tree dirty before this session's
// first tool call (recurring-bugs.md's "Concurrent Session Hazards"). `git diff` can't
// tell that apart from this session's own edits; sessionEditedFiles/filterToSessionEdits
// exist so main() can. See the 2026-08-28 comment at the top of verify-gate.mjs.
describe('session-scoped edits (concurrent dirty tree)', () => {
  const editUse = (id, path, name = 'Edit') =>
    line({ message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input: { file_path: path } }] } });

  it('sessionEditedFiles only counts Edit/Write calls whose tool_result is not an error', () => {
    const t = [
      editUse('a', 'D:\\repo\\src\\server\\foo.py'), result('a', false),
      editUse('b', 'D:\\repo\\src\\server\\bar.py'), result('b', true), // failed edit, e.g. old_string mismatch
    ].join('\n');
    const edited = sessionEditedFiles(t);
    expect(edited.has('D:\\repo\\src\\server\\foo.py')).toBe(true);
    expect(edited.has('D:\\repo\\src\\server\\bar.py')).toBe(false);
  });

  it('a non-edit tool_use (e.g. Read, Bash) is never counted as an edit', () => {
    const t = use('c', 'cat src/server/foo.py', 'Bash');
    expect(sessionEditedFiles(t).size).toBe(0);
  });

  it('filterToSessionEdits matches an absolute Windows path against a git-relative posix path', () => {
    const edited = new Set(['D:\\repo\\src\\server\\foo.py']);
    expect(filterToSessionEdits(['src/server/foo.py', 'src/server/other.py'], edited))
      .toEqual(['src/server/foo.py']);
  });

  it('NEGATIVE CONTROL: a file dirty in the working tree but never touched by this session does not match', () => {
    const edited = sessionEditedFiles(''); // this session edited nothing
    expect(filterToSessionEdits(['src/server/some_other_sessions_file.py'], edited)).toEqual([]);
  });

  it('end-to-end: decide() only sees files this session actually edited, not the whole dirty tree', () => {
    // Session read-only reviews the repo, runs no verification -- matches this
    // conversation's own false-positive block before the fix.
    const readOnlyTranscript = use('d', 'ls src/server', 'Bash');
    const edited = sessionEditedFiles(readOnlyTranscript);
    const preexistingDirty = ['src/server/unrelated_a.py', 'src/server/unrelated_b.ts'];
    const sessionTouched = filterToSessionEdits(preexistingDirty, edited);
    const changed = sessionTouched.filter(f => /\.(py|ts|tsx)$/.test(f));
    expect(changed).toEqual([]); // nothing for decide() to demand verification for
  });
});
