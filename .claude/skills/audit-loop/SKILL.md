---
name: audit-loop
description: The remediation loop that turns audit output into closed issues — triage findings into auto-fixable vs. evidence-required, fix and verify each against live production, carry the unfixed ones forward in docs/audit-findings.md with a stable ID, and immunize the repo with a static check so the class cannot silently recur. Use after any audit or review produces findings, or when asked to fix / resolve / close out audit findings.
---

# Audit loop

An audit that produces a list nobody acts on is worse than no audit — it manufactures the feeling
of coverage. This skill is the second half: **triage → fix → verify → immunize → carry forward**.

Two hard constraints from this repo's own history govern everything below:

1. **Not every finding may be auto-fixed.** A change to `unified_ranker.py`, `scoring_engine.py`,
   or any factor/weight/classification formula needs backtest evidence *before* it lands —
   `verify-gate.mjs` enforces this, and the rule exists because prior sessions merged four
   unmeasured ranker changes on a green test suite that all had to be reverted later.
2. **A fix is not done when it is committed.** `tsc --noEmit` and a green suite do not tell you a
   fetcher wrote the right rows. Written ≠ applied, committed ≠ deployed, declared ≠ installed.

## 1. Normalize the findings

Whatever produced them (`/weekend-audit`, one of the 15 audit commands, a live incident), restate
each finding as one row with a **stable ID** so the same issue is recognisable next week:

`AF-<YYYYMMDD>-<nn>` · file:line · class · one-sentence defect · blast radius · evidence

**Blast radius is the ranking key, not count.** A 100%-NULL column feeding `unified_ranker.py`
outranks fifty style nits. A monitor reading a constant that multiplies a live score outranks the
wrong log line that revealed it.

**Evidence means traced, not inferred.** A plausible lead from code-reading is a hypothesis until
it is traced end to end against live data — a prior session's first-pass "market_cap is NULL,
that's probably it" turned out entirely wrong once actually traced. Findings without evidence go
to step 2's INVESTIGATE lane, not the fix lane.

## 2. Triage into four lanes

| Lane | What qualifies | Action this session |
|---|---|---|
| **FIX** | Mechanically safe and locally verifiable: a wrong column name, a missing `live_datasource` test, a missing freshness check, a `daysStale`→`tradingDaysStale` swap, a date anchor, a missing purge, an ungated live test, a test that reimplements its subject | Fix now, verify per step 3 |
| **EVIDENCE** | Touches a score, weight, threshold, classification, gate or model artifact | Do **not** fix. Produce the measurement first (`factor_backtest.py`, a null replay, a live grading pass), then decide |
| **INVESTIGATE** | Real symptom, unproven cause | Trace against live data until it becomes FIX or EVIDENCE, or is disproven |
| **ACCEPT** | Known, bounded, not worth the risk (e.g. the Trendlyne pk-churn upsert — no data loss, mitigation is "look up by name") | Record the reasoning in the ledger so it isn't re-discovered every quarter |

Say out loud how many landed in each lane. A run where everything is FIX means the triage wasn't
applied.

## 3. Fix, one finding at a time

For each FIX-lane item, in this order — none of these steps is optional:

```bash
npx tsc --noEmit                                          # any .ts change
npx vitest run                                            # any .ts logic change
backend-python/venv/Scripts/python.exe -m pytest src/server/__tests__/ src/server/tests/   # any .py change
npm run schema:drift                                      # any migration
```

Then the three this repo added because the above were not enough:

- **Root cause, not the reported path.** Grep every caller of the function before editing. One
  guard in the shared function is a smaller diff than a guard in every caller — and patching only
  the path the finding names leaves every sibling still broken. The skip-path-stamped-as-success
  class was found 5 times in one file after the first "complete" review stopped at 3.
- **Negative-control the test.** Revert the fix, confirm the new test *fails*, restore. A green
  suite that never failed against the bug protects nothing. Call the real function — a test that
  reimplements the logic passes against unfixed source.
- **Run it against live production and query the result back.** Use the `deploy-and-verify` skill.
  Restart the right pm2 process, apply the migration against the real `POSTGRES_URL`, re-run the
  code path, then `SELECT` the rows and confirm they are what you claimed. The 2026-08-13
  `recommendation_log` fix is only known to have worked because the count went 0/1,584 →
  1,492/1,584 in a live query.

Commit **by explicit path**, never `git add -A` — multiple sessions edit this repo concurrently.
Re-check `git status` immediately before committing.

## 4. Immunize — the step that makes it not recur

This is the whole point, and it is the step most often skipped. `recurring-bugs.md` says it
plainly: every recurrence count in that file was recorded **after** the class was documented in
prose, so **prose alone does not hold.**

For each fixed finding, pick the strongest applicable rung:

1. **A static check in `scripts/check_recurring_bugs.py`** — best; it runs in CI and looks
   everywhere the class can hide, including files nobody touched. Writing the check for the
   skip-path class immediately found 4 more live instances the manual pass had missed.
2. **A gate in `verify-gate.mjs`** — for "this kind of change requires this kind of evidence".
3. **A data-quality check** in `dataQualityChecks.ts` — for a defect that recurs in *data* rather
   than code. One-line `TABLE_FRESHNESS_CHECKS` entry via `makeFreshnessCheck()` unless it needs
   real logic.
4. **A derived-from-source test** — assert a scan of the source tree equals the allowlist, so the
   next writer added fails the test instead of silently writing NULLs.
5. **A `recurring-bugs.md` entry** — last resort, and only with a grep-able signature. If the class
   already has an entry, **extend it in place** with the new recurrence rather than duplicating;
   that file's entries show the pattern (one entry, "recurred 5 times").

Record which rung you took. "Documented it" is rung 5 and should be the exception.

## 5. Ledger — `docs/audit-findings.md`

One row per finding, carried across runs. Create the file if absent.

```markdown
| ID | Found | Class | Finding | Lane | Status | Immunized | Closed |
|---|---|---|---|---|---|---|---|
| AF-20260815-01 | 2026-08-15 | temporal | `x.py:44` CASE guard anchored to date.today() | FIX | fixed+live-verified | check_recurring_bugs.py #7 | 2026-08-15 |
| AF-20260815-02 | 2026-08-15 | threshold | `y.py` PSI bar below measured null | EVIDENCE | awaiting null replay | — | open |
```

Rules that make the ledger worth keeping:

- **Never delete a row.** Close it with a date. A finding that reappears after being closed is a
  much stronger signal than a fresh one, and only the ledger can show that.
- **An open row surviving 3 runs is itself a finding** — either it is harder than triaged, or the
  lane was wrong. Escalate it in the report rather than letting it roll silently.
- Reconcile at the start of every run: re-check each open row before hunting new ones. Closing a
  known issue beats discovering a new one.

## 6. Close out

Per CLAUDE.md's "Closing a session": append `docs/session-log.md`, update the memory index, and
add the rule entry if a genuinely new class surfaced. The `session-close` skill runs that
checklist against the real diff.

Then report: counts per lane, what was fixed **and live-verified** (not merely committed), what
is deferred and why, which immunization rung each fix got, and every open ledger row with its
age. State plainly what you did not fix. Scaling the work down is the user's call — but a
finding left open without being written to the ledger is the one outcome this loop exists to
prevent.
