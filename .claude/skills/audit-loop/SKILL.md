---
name: audit-loop
description: The remediation loop that turns audit output into closed issues — scope the sweep across every feature, script, database table and job before triaging, triage findings into auto-fixable vs. evidence-required, fix and verify each against live production, carry the unfixed ones forward in docs/audit-findings.md with a stable ID, immunize the repo with a static check so the class cannot silently recur, and close only once the full check stack runs end-to-end with zero errors. Use after any audit or review produces findings, or when asked to fix / resolve / close out audit findings, or to sweep and close out everything pending across the system.
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

## 0. Scope the sweep — five inventories, not just the findings you were handed

Before triaging, confirm coverage against what actually exists, not what the input audit happened
to touch. Grep-derived, not remembered — this repo's history is full of "complete" reviews that
stopped at N instances when a static check immediately found N+4 more.

- **Features** — every dashboard shell (v1/v2/v3/v4/v5/v6) and every scoring/ranking-shaped tRPC
  procedure in `router.ts`/`routers/*.ts`. Run `canonical-read-audit` and `shell-parity-audit` if
  the input audit didn't already cover them.
- **Scripts** — every fetcher (`*_fetcher.py`), every engine/scorer/ranker (`*_engine.py`,
  `*_scorer.py`, `*_ranker.py`), every one-shot script under `scripts/`. `data-coverage-audit` and
  `fetcher-accuracy-review` cover fetchers; cross-check the rest against `git ls-files '*.py'` —
  nothing in this repo enumerates non-fetcher scripts automatically.
- **Database** — every table has a freshness check in `dataQualityChecks.ts`'s
  `TABLE_FRESHNESS_CHECKS` and the live schema matches `db/schema.postgres.sql`
  (`npm run schema:drift`). Cross-check `information_schema.tables` against the check list; an
  uncovered table is a blind spot, not evidence of health.
- **Score-column fidelity** — fresh is not the same as *usable for measurement*, and this class
  is invisible to every freshness/coverage check by construction. For any column a measurement
  might later be built on, ask two questions:
  1. **Does a missing value write NULL, or a sentinel like `0.0`?** Run
     `SELECT count(*) FILTER (WHERE col = 0)::float/count(*) FROM t WHERE <latest date>` per score
     column. A large round fraction on one value is not a real distribution. If a guard was added
     later, **the fix date is a population boundary** — rows before it are a different dataset and
     must be filtered out, not silently pooled. Live example: `ml_score = 0` on 36,400/72,223
     rows (AF-20260818-31); an ablation panel built on it reported a *negative* IC.
     Now standing: `ur-engine-score-zero-not-null`.
  2. **What SCALE is any threshold you apply calibrated for?** `ZERO_DISPERSION_MIN_SD = 5.0`
     is written for 0–100 scores; against raw probabilities (sd ≈ 0.07) every engine reads as
     collapsed. Now standing: `ur-engine-dispersion-collapse`, which also reports the genuine
     collapse rate (dl 39%, ml 34%, technical 18% of ranker dates).

  Both entries are in `recurring-bugs.md`. Confirm both checks are PASSing and read their
  `detail` — a rate that has drifted off its recorded baseline is a finding even while passing.
- **Jobs** — every BullMQ registration in `queues.ts`/`jobs/*.jobs.ts` and every cron mirror has a
  `job_heartbeat` row with `last_success_at` recent relative to its own cadence, and its skip path
  (if any) does not fall through to the same "completed" handler a real run uses
  (`recurring-bugs.md`'s skip-as-success class — recurred 6 times, once on the *shared*
  `registerJob.ts` handler a per-file static check structurally couldn't see).

- **Pending-work trackers** — "complete pending items" only means something if every existing
  backlog is actually read, not just the findings this run was handed. Pull open rows from
  `docs/audit-findings.md` itself (step 5's own ledger, reconciled first per that step), every
  `ponytail:` debt comment (`ponytail:ponytail-debt` skill), a repo-wide `TODO`/`FIXME` grep, and any
  named-file backlog called out in a plan doc (e.g. `docs/SQLITE_DECOMMISSION_PLAN.md`'s remaining
  files). Fold whatever's still open into this run's triage — a pending item nobody re-reads is
  indistinguishable from a closed one.

A gap in any of the five is itself a finding — give it its own ledger row rather than silently
narrowing the sweep to whatever the input audit happened to include.

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
- **If live verification shows regression, revert — don't leave it half-applied.** Undo the
  change, re-run this step's check stack to confirm the revert itself is clean, and reopen the
  ledger row as still-open with what was tried and why it made things worse. A fix that is
  committed but demonstrably wrong live is worse than the original finding: it reads as closed.

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

## 6. Run the core end-to-end, zero errors

"Tests pass" is not "done" — this repo's own gate criterion (`verify-gate.mjs` exists because a
green suite has merged unmeasured ranker changes before). Before closing the session, run the full
Definition-of-Done stack against the state after every FIX-lane item has landed, not per-commit:

```bash
npx tsc --noEmit
npx vitest run
backend-python/venv/Scripts/python.exe -m pytest src/server/__tests__/ src/server/tests/ tests/chatbot/
npm run schema:drift
```

All four must exit **0** — a skipped-Postgres-file warning counts as failure, not a pass
(`recurring-bugs.md`'s pytest exit-code fix: a run that skipped every DB-dependent test used to
print a loud warning and still exit 0; it no longer does, so a nonzero exit here is real). Then
confirm live, not just green locally, per step 3's third bullet: the affected pm2 process is
restarted (`deploy-and-verify`), any migration ran against the real `POSTGRES_URL`, and the
changed code path is queried back against production.

Code compiling and tests passing is not the same claim as the system running. Also check:

- **All four services are actually up.** `pm2 jlist` (or the platform equivalent) shows
  `bharat-server`, `ml-api`, `chatbot`, `alphaquant-api` all `online`, not `errored`/`stopped`, and
  `pm_uptime` postdates the fix commit — "committed ≠ deployed" from CLAUDE.md, checked mechanically
  rather than assumed.
- **A log sweep for the failure modes tests can't see.** `recurring-bugs.md`'s swallowed-exception
  and skip-as-success classes produce no red test — they show up only as `InFailedSqlTransaction`,
  a truncated stderr, or a "finished successfully with warnings" line in pm2/job logs. Grep recent
  logs for these signatures before calling the run clean; a green exit code on its own has missed
  this exact class before.
- **Declared vs. installed.** `package.json` vs `npm ls`, `requirements.txt` vs the
  `backend-python/venv` install — this repo's own "declared ≠ installed" class has silently broken
  a live job for days more than once. A quick diff here is cheap; a live outage from a missing
  package is not.

"Zero errors" describes the FIX lane, not the whole ledger — an EVIDENCE-gated item stays open
until its measurement lands, and that's correct, not incomplete. What must not happen is a FIX-lane
item left half-done while the session reports success; if step 5's ledger has an open FIX row, this
step isn't finished yet.

## 7. Close out

Per CLAUDE.md's "Closing a session": append `docs/session-log.md`, update the memory index, and
add the rule entry if a genuinely new class surfaced. The `session-close` skill runs that
checklist against the real diff.

Then report: counts per lane, what was fixed **and live-verified** (not merely committed), what
is deferred and why, which immunization rung each fix got, and every open ledger row with its
age. State plainly what you did not fix. Scaling the work down is the user's call — but a
finding left open without being written to the ledger is the one outcome this loop exists to
prevent.
