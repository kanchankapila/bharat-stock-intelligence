import { describe, it, expect } from 'vitest';
import { describeExitCode, isHostTeardownExit, buildFailureReason } from '../pythonRunner';

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

  it('keeps the memory-ceiling diagnosis ahead of the stream tails', () => {
    const r = buildFailureReason({
      code: 1, stdout: 'boom', peakMemMb: 19500, memLimitMb: 20480,
    });
    expect(r).toMatch(/^MEMORY CEILING/);
    expect(r).toContain('19500MB');
  });
});
