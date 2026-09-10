import { describe, it, expect } from 'vitest';
import { describeExitCode, isHostTeardownExit } from '../pythonRunner';

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
});
