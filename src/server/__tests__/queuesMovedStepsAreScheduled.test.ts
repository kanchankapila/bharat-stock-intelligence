import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Guard: a comment saying a step "moved to" another job must correspond to a real invocation.
 *
 * AF-20260910-16. On 2026-08-13 `insider_transactions_fetcher.py` was taken off the nightly
 * chain because it cost 14m47 of the critical path. queues.ts recorded that as
 * "insider_transactions_fetcher.py moved to the weekly retrain (processMlWeeklyRetrain)" --
 * but it was never added there. The result: the fetcher ran NOWHERE for 28 days, with no
 * job_heartbeat row and no job_run_history entry to notice, and `insider_transactions`
 * froze at 2026-05-02 (~131 days stale, up from the 75.3d recorded when it was flagged).
 *
 * What made it invisible is worth keeping in mind: `insider-trades-recency` is deliberately
 * warn-only, on the correct reasoning that SEBI PIT filings are event-driven and sparse. A
 * warn-only freshness check cannot distinguish "sparse" from "the writer is gone" -- so the
 * sparse-by-nature exemption is exactly the cover a dead fetcher needs.
 *
 * The list is derived from queues.ts's own comments rather than hand-enumerated, per
 * recurring-bugs.md: "a guard test built on a hand-enumerated allowlist only guards what
 * someone remembered to list."
 */
describe('queues.ts: steps documented as "moved" are actually scheduled', () => {
  // The scheduler surface is NOT just queues.ts: CLAUDE.md records that job registrations are
  // decomposed into jobs/*.jobs.ts. Scanning queues.ts alone produced two false positives on the
  // first run of this test (trendlyne_adv_tech_fetcher.py and financial_ratios_fetcher.py are
  // both scheduled in jobs/trendlyneWeekly.jobs.ts, the latter with a live succeeding
  // `trendlyne-ratios-monthly` heartbeat). A guard that cries wolf stops being read, so the
  // comment is sourced from queues.ts but the invocation is looked for across every scheduler file.
  const src = readFileSync(join(__dirname, '..', 'queues.ts'), 'utf8');
  const schedulerDir = join(__dirname, '..', 'jobs');
  const schedulerSrc =
    src +
    readdirSync(schedulerDir)
      .filter((f) => f.endsWith('.ts'))
      .map((f) => readFileSync(join(schedulerDir, f), 'utf8'))
      .join('\n');

  const movedScripts = [
    ...new Set(
      [...src.matchAll(/([a-z0-9_]+\.py)[^\n]{0,80}?moved (?:to|off)/gi)].map((m) => m[1]),
    ),
  ];

  it('finds the "moved" comments it is supposed to guard (non-vacuous)', () => {
    // A regex guard that silently matches nothing passes forever and protects nothing.
    expect(movedScripts.length).toBeGreaterThan(0);
  });

  it.each(movedScripts)('%s has a real runPython invocation, not just a comment', (script) => {
    // Plain substring match across every quote style runPython() is called with.
    // A RegExp built in a template literal loses its backslashes here and silently
    // matches nothing, which reads exactly like a real failure.
    const invoked = ["'", '"', '`'].some((q) =>
      schedulerSrc.includes(`runPython(${q}${script}${q}`),
    );
    expect(
      invoked,
      `queues.ts says ${script} was moved to another job, but nothing in queues.ts or jobs/*.ts ` +
      `actually invokes it. A step that is documented as relocated but never re-registered runs nowhere, ` +
      `and leaves no heartbeat to notice (AF-20260910-16).`,
    ).toBe(true);
  });
});
