import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
// @ts-expect-error -- plain .mjs module, no type declarations
import { validate, validateDetailed } from '../checkFindingsLedger.mjs';

const HDR = '| ID | Found | Class | Finding | Lane | Status | Immunized | Closed |\n|---|---|---|---|---|---|---|---|';
const table = (...rows: string[]) => [HDR, ...rows].join('\n');

// The first lookup walks every test directory; on a loaded host that exceeded the 5s default.
describe('checkFindingsLedger.validate', { timeout: 60_000 }, () => {
  it('accepts a closed FIX row that cites an existing test file', () => {
    const t = table('| AF-20260930-90 | 2026-09-30 | x | bug | FIX | fixed | `test_nt_change_oi_fetcher.py` | 2026-09-30 |');
    expect(validate(t)).toEqual([]);
  });

  it('accepts an existing TSX render regression by path or basename', () => {
    for (const name of ['src/components/CommandCenterDashboard.test.tsx', 'CommandCenterDashboard.test.tsx']) {
      expect(validate(table(`| AF-20261025-99 | 2026-10-25 | x | UI bug | FIX | fixed | ${name} | 2026-10-25 |`))).toEqual([]);
    }
  });

  it('does not accept an existing filename merely as a prefix of a nonexistent artifact', () => {
    expect(validate(table('| AF-20261025-99 | 2026-10-25 | x | UI bug | FIX | fixed | src/components/CommandCenterDashboard.test.tsx.nonexistent | 2026-10-25 |')).join()).toMatch(/cites no existing regression test/);
  });

  it('accepts a closed FIX row that cites an existing named test class', () => {
    const t = table('| AF-20260930-90 | 2026-09-30 | x | bug | FIX | fixed | `TestFetchRetriesTransient405` | 2026-09-30 |');
    expect(validate(t)).toEqual([]);
  });

  it('rejects a closed FIX row with no regression test', () => {
    const t = table('| AF-20260930-91 | 2026-09-30 | x | bug | FIX | fixed | — | 2026-09-30 |');
    expect(validate(t).join()).toMatch(/cites no existing regression test/);
  });

  it('rejects a closed FIX row citing a test that does not exist', () => {
    const t = table('| AF-20260930-92 | 2026-09-30 | x | bug | FIX | fixed | `TestNoSuchThingAnywhere` and `test_made_up_file.py` | 2026-09-30 |');
    expect(validate(t).join()).toMatch(/cites no existing regression test/);
  });

  it('rejects an open row with no stated reason, accepts one with a reason', () => {
    expect(validate(table('| AF-20260930-93 | 2026-09-30 | x | bug | FIX | will do later | — | — |')).join())
      .toMatch(/none of the four reasons/);
    expect(validate(table('| AF-20260930-94 | 2026-09-30 | x | bug | EVIDENCE | measuring first | — | — |'))).toEqual([]);
  });

  describe('FIX rows cannot stay open on EVIDENCE', () => {
    const row = (found: string, lane: string, status: string) => table(`| AF-20261103-90 | ${found} | x | bug | ${lane} | ${status} | — | — |`);

    it('rejects a post-FIX_RULE_START open FIX row whose only reason is EVIDENCE', () => {
      expect(validate(row('2026-11-04', 'FIX', 'EVIDENCE: the local fix passes')).join()).toMatch(/AF-20261103-90.*FIX row.*EVIDENCE/);
      expect(validate(row('2026-11-04', 'fix', 'EVIDENCE: the local fix passes')).join()).toMatch(/FIX row.*EVIDENCE/);
      expect(validate(row('2026-11-04', '**FIX**', 'EVIDENCE: the local fix passes')).join()).toMatch(/FIX row.*EVIDENCE/);
    });

    it('accepts DEPLOY-PENDING and a user decision on a FIX row', () => {
      expect(validate(row('2026-11-04', 'FIX', 'DEPLOY-PENDING: needs pm2 restart'))).toEqual([]);
      expect(validate(row('2026-11-04', 'FIX', 'needs a user decision: which vendor'))).toEqual([]);
    });

    it('matches DEPLOY-PENDING as a case-sensitive token, not prose', () => {
      expect(validate(row('2026-11-04', 'FIX', 'deploy pending, EVIDENCE only')).join()).toMatch(/FIX row.*EVIDENCE/);
    });

    it('still accepts EVIDENCE on an EVIDENCE-lane row', () => {
      expect(validate(row('2026-11-04', 'EVIDENCE', 'Open - EVIDENCE: measure first'))).toEqual([]);
    });

    it('only warns for FIX rows found between RULE_START and FIX_RULE_START', () => {
      const r = validateDetailed(row('2026-10-20', 'FIX', 'EVIDENCE: the local fix passes'));
      expect(r.problems).toEqual([]);
      expect(r.warnings.join()).toMatch(/AF-20261103-90/);
    });

    it('only warns for a FIX row found on 2026-11-03', () => {
      const r = validateDetailed(row('2026-11-03', 'FIX', 'EVIDENCE: the local fix passes'));
      expect(r.problems).toEqual([]);
      expect(r.warnings.join()).toMatch(/AF-20261103-90/);
    });

    it('does not warn about a closed FIX row', () => {
      const r = validateDetailed(table('| AF-20261103-91 | 2026-11-03 | x | bug | FIX | EVIDENCE noted | `test_nt_change_oi_fetcher.py` | 2026-11-03 |'));
      expect(r).toEqual({ problems: [], warnings: [] });
    });
  });

  it('does not re-judge rows found before the rule started', () => {
    expect(validate(table('| AF-20260801-01 | 2026-08-01 | x | bug | FIX | fixed | — | 2026-08-01 |'))).toEqual([]);
  });

  it('flags structural breakage: headerless rows, stray pipes, control chars, duplicate ids', () => {
    const out = validate([
      'prose',
      '| AF-20260930-95 | 2026-09-30 | x | bug | FIX | fixed | `test_nt_change_oi_fetcher.py` | 2026-09-30 |',
      HDR,
      '| AF-20260930-96 | 2026-09-30 | x | a | b | c | FIX | fixed | x | 2026-09-30 |',
      '| AF-20260930-97 | 2026-09-30 | x | bug | EVIDENCE | open\x0b | — | — |',
      '| AF-20260930-97 | 2026-09-30 | x | bug | EVIDENCE | open | — | — |',
    ].join('\n')).join('\n');
    // pre-rule duplicates warn, never fail
    const old = validateDetailed(table(
      '| AF-20260801-02 | 2026-08-01 | x | a | EVIDENCE | open | — | — |',
      '| AF-20260801-02 | 2026-08-01 | x | a | EVIDENCE | restated | — | — |'));
    expect(old.problems).toEqual([]);
    expect(old.warnings.join()).toMatch(/duplicate ID/);
    expect(out).toMatch(/outside any table/);
    expect(out).toMatch(/10 cells in a 8-column table/);
    expect(out).toMatch(/vertical-tab/);
    expect(out).toMatch(/duplicate ID/);
  });

  // The live ledger is checked for STRUCTURE here (structure is never legitimately "in
  // progress"). The per-row policy checks run via `npm run findings:check` in the audit-loop /
  // weekend-audit / session-close skills: a concurrent session's half-written row must not turn
  // every other session's suite red.
  //
  // AF-20260930-03 left AF-20260823-79/-80/-81 and AF-20260824-82 here as a known-blocked list --
  // headerless rows after prose, blank lines between them, -79/-80 missing four columns entirely,
  // and -82 split across seven physical lines. REPAIRED 2026-10-01 (user-authorised): the four
  // missing columns filled in from each row's own prose, -82 joined into one line and closed
  // against the non-NULL held-out AUC rows it was waiting on, and the table header + separator
  // restored above the block. The list is therefore EMPTY, which is the stronger end state -- it
  // now guards the whole ledger rather than four known holes. `npm run findings:check` is green.
  const KNOWN_BLOCKED: string[] = [];

  it('the real ledger has no structural problems beyond the known-blocked rows', () => {
    const real = readFileSync(resolve(__dirname, '../../docs/audit-findings.md'), 'utf8');
    const structural = (validate(real) as string[]).filter(p => !/cites no existing|none of the four reasons|FIX row/.test(p));
    const unexpected = structural.filter(p => !KNOWN_BLOCKED.some(id => p.includes(id)));
    expect(unexpected).toEqual([]);
    const stillBroken = KNOWN_BLOCKED.filter(id => structural.some(p => p.includes(id)));
    expect(stillBroken, 'repaired -- remove these from KNOWN_BLOCKED').toEqual(KNOWN_BLOCKED);
  });
});
