import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { describeExitCode, isHostTeardownExit, buildFailureReason, completedBeforeExit, COMPLETION_SENTINEL } from '../pythonRunner';

/**
 * AF-20260910-05. A Windows Update restart (2026-09-10 02:06 IST) killed the in-flight
 * ml-weekly-retrain children; because an OS-killed process writes nothing to either stream,
 * the only record was "Command failed with exit code 1073807364" — indistinguishable from a
 * Python crash, and it cost a session's investigation to establish it was not one.
 *
 * The two codes actually observed live are pinned by name below, so a future reader gets the
 * cause from the log line instead of having to decode NTSTATUS by hand.
 */
describe('describeExitCode', () => {
  it('decodes the two codes observed live during the 2026-09-10 Windows Update restart', () => {
    expect(describeExitCode(1073807364)).toContain('DBG_TERMINATE_PROCESS');
    expect(describeExitCode(1073807364)).toContain('0x40010004');
    expect(describeExitCode(1073807364)).toMatch(/shutdown or restart/i);

    expect(describeExitCode(3221225794)).toContain('STATUS_DLL_INIT_FAILED');
    expect(describeExitCode(3221225794)).toContain('0xC0000142');
  });

  it('classifies host/OS teardown separately from a native crash', () => {
    // Teardown: the host killed it, the script did not fail.
    expect(isHostTeardownExit(1073807364)).toBe(true);
    expect(isHostTeardownExit(3221225794)).toBe(true);
    expect(isHostTeardownExit(3221225786)).toBe(true);

    // A real native crash is abnormal but is NOT a host teardown — it must stay attributable
    // to the script, or this decoding would launder genuine crashes into "the host did it".
    expect(describeExitCode(3221225477)).toContain('ACCESS_VIOLATION');
    expect(isHostTeardownExit(3221225477)).toBe(false);
    expect(isHostTeardownExit(137)).toBe(false);
  });

  it('keys every NTSTATUS entry by the code its own description names', async () => {
    // 0xC0000409 was keyed 3221266689 (the real value is 3221226505), so both 2026-11-06
    // ml_ensemble crashes were reported as "not a code this runner has seen before".
    const src = (await import('node:fs')).readFileSync(
      new URL('../pythonRunner.ts', import.meta.url), 'utf8');
    const hexes = [...src.matchAll(/\((0x[0-9A-F]{8})\)/g)].map(m => m[1]);
    expect(hexes.length).toBeGreaterThanOrEqual(8);
    for (const hex of hexes) expect(describeExitCode(Number(hex))).toContain(hex);
  });

  it('returns empty for ordinary exit codes so the normal failure message is unchanged', () => {
    // Negative control: the overwhelmingly common path is a script sys.exit(1) that already
    // printed a real reason. Decoding must contribute nothing there, or every ordinary failure
    // message would grow a misleading "ABNORMAL EXIT" preamble.
    expect(describeExitCode(1)).toBe('');
    expect(describeExitCode(2)).toBe('');
    expect(describeExitCode(0)).toBe('');
    expect(describeExitCode(null)).toBe('');
    expect(describeExitCode(undefined)).toBe('');
    expect(isHostTeardownExit(1)).toBe(false);
    expect(isHostTeardownExit(null)).toBe(false);
  });

  /**
   * AF-20260911-14. Node on Windows can surface an NTSTATUS exit as a SIGNED 32-bit int
   * (-1073741819) where the table above is keyed on the unsigned form (3221225477). An
   * unmatched code decodes to '' and is then dropped from the message entirely by the
   * `.filter(Boolean)` in buildFailureReason — so a native crash reads as a plain failure
   * with no code at all. Same family as this repo's `err || out` defect: a failure with no
   * recoverable reason.
   */
  it('decodes the SIGNED 32-bit form of an NTSTATUS code identically to the unsigned form', () => {
    expect(describeExitCode(-1073741819)).toContain('ACCESS_VIOLATION');   // 0xC0000005
    expect(describeExitCode(-1073741502)).toContain('DLL_INIT_FAILED');    // 0xC0000142
    expect(isHostTeardownExit(-1073741502)).toBe(true);
    expect(isHostTeardownExit(-1073741819)).toBe(false);                   // a real crash
  });
});

// AF-20261107-06: ml_ensemble.py trained, registered a model, scored and printed Done, then exited
// 0xC0000409 at teardown, five times (2026-09-10, 09-11, 11-06 x2, 11-15), and each time the job read
// as failed. A script opts in by printing the sentinel as its LAST line once all work is committed.
describe('completedBeforeExit', () => {
  const done = `[Ensemble] Done.\n${COMPLETION_SENTINEL}\n`;
  it('is true only for an abnormal native exit whose output ends with the completion sentinel', () => {
    expect(completedBeforeExit(3221226505, done)).toBe(true);
    expect(completedBeforeExit(-1073741819, done)).toBe(true);                       // signed twin of 0xC0000005
    expect(completedBeforeExit(3221226505, 'work\n')).toBe(false);                   // no sentinel: a real crash
    expect(completedBeforeExit(3221226505, `${COMPLETION_SENTINEL}\nmore work\n`)).toBe(false);   // work after it
    expect(completedBeforeExit(1, done)).toBe(false);                                // an ordinary failure stays one
    expect(completedBeforeExit(0, done)).toBe(false);
    expect(completedBeforeExit(null, done)).toBe(false);
    expect(completedBeforeExit(3221226505, undefined)).toBe(false);
  });
  it('ml_ensemble.py prints exactly the sentinel the runner looks for, as the last thing after run() returns', () => {
    const src = readFileSync(join(__dirname, '..', 'ml_ensemble.py'), 'utf8');
    const tail = src.slice(src.lastIndexOf('run(do_train=do_train'));
    expect(tail).toContain(`print("${COMPLETION_SENTINEL}", flush=True)`);
  });
  it('is named at the head of the failure message so the log says what happened', () => {
    expect(buildFailureReason({ code: 3221226505, stdout: done })).toMatch(/^COMPLETED BEFORE EXIT/);
    expect(buildFailureReason({ code: 3221226505, stdout: 'work' })).not.toMatch(/COMPLETED BEFORE EXIT/);
  });
});

describe('buildFailureReason', () => {
  /**
   * AF-20260911-14. ml-ensemble-train was recorded 'failed' on 2026-09-10 and 2026-09-11 with
   * an "error" consisting ONLY of a stdout tail ending '[Ensemble] Done.' — the script had
   * trained, registered model_id=327 and scored 326 signals. Because the code was unlisted,
   * `decoded` was '' and the raw number never reached the message, so the crash could not be
   * identified at all. The code must survive whenever it is not an ordinary one.
   */
  it('always reports an abnormal exit code, even when stdout carries the tail', () => {
    const r = buildFailureReason({ code: 3221225477, stdout: '[Ensemble] Done.' });
    expect(r).toContain('3221225477');
    expect(r).toContain('stdout: [Ensemble] Done.');
  });

  it('reports an UNLISTED abnormal code as a raw number rather than dropping it', () => {
    const r = buildFailureReason({ code: 3221226505, stdout: 'work finished' });
    expect(r).toMatch(/exit code 3221226505/);
  });

  it('normalizes a signed code in the message so it is greppable as the unsigned NTSTATUS', () => {
    const r = buildFailureReason({ code: -1073741819, stdout: 'done' });
    expect(r).toContain('3221225477');
    expect(r).toContain('ACCESS_VIOLATION');
  });

  // Negative control: the dominant path is a deliberate sys.exit(1) that already printed a
  // reason. Adding an exit-code line there would change every ordinary failure message and
  // break the log-signature grouping that repo-doctor and jobSweep rely on.
  it('leaves an ordinary exit-1 failure message byte-identical', () => {
    expect(buildFailureReason({ code: 1, stderr: 'Traceback...', stdout: 'x' }))
      .toBe('stderr: Traceback...\nstdout: x');
    expect(buildFailureReason({ code: 2, stdout: 'guard tripped' }))
      .toBe('stdout: guard tripped');
  });

  it('still falls back to the bare sentence when both streams are empty', () => {
    expect(buildFailureReason({ code: 1 })).toBe('Command failed with exit code 1');
  });

  // 2026-11-15: exit-policy-train, ml-ensemble-train and strategy-optimizer all failed with a bare
  // "Command failed with exit code 1" or a stdout tail. Another project's `taskkill /f /im python.exe`
  // had killed every python.exe (the pm2 Python services restarted 3 s later). A process that exits
  // non-zero WITHOUT its peak-memory report never reached its atexit hooks, so it was terminated.
  it('names an outside kill when a ceilinged run exits with an ordinary code and no peak report', () => {
    const r = buildFailureReason({ code: 1, stdout: '[Optimizer] Baseline', memLimitMb: 20480 });
    expect(r).toMatch(/^KILLED FROM OUTSIDE/);
    expect(r).toContain('stdout: [Optimizer] Baseline');
    expect(buildFailureReason({ code: 1, memLimitMb: 20480 })).toMatch(/^KILLED FROM OUTSIDE/);
  });

  it('does not claim an outside kill for a deliberate exit, a run without a ceiling, or a native crash', () => {
    expect(buildFailureReason({ code: 1, stdout: 'guard', peakMemMb: 900, memLimitMb: 20480 })).toBe('stdout: guard');
    expect(buildFailureReason({ code: 1, stdout: 'guard' })).toBe('stdout: guard');
    expect(buildFailureReason({ code: 3221225477, memLimitMb: 20480 })).not.toMatch(/KILLED FROM OUTSIDE/);
  });

  it('keeps the memory-ceiling diagnosis ahead of the stream tails', () => {
    const r = buildFailureReason({
      code: 1, stdout: 'boom', peakMemMb: 19500, memLimitMb: 20480,
    });
    expect(r).toMatch(/^MEMORY CEILING/);
    expect(r).toContain('19500MB');
  });
});
