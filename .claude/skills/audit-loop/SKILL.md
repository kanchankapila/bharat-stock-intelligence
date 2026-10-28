---
name: audit-loop
description: The remediation loop that turns audit output into closed issues — scope the sweep across every feature, script, database table and job before triaging, triage findings into auto-fixable vs. evidence-required, fix and verify each against live production, carry the unfixed ones forward in docs/audit-findings.md with a stable ID, immunize the repo with a static check so the class cannot silently recur, and close only once the full check stack runs end-to-end with zero errors. Use after any audit or review produces findings, or when asked to fix / resolve / close out audit findings, or to sweep and close out everything pending across the system.
---

# Audit loop

Internal project skill. The contract and learner-replay sections below are the shared core
for the repository's audit/health skills; callers load the relevant section, not a copied rule set.
Product-file paths are relative to the repository root, not this skill's directory.

Operate within the current request's authority. A review, diagnosis or read-only verification
does not authorize fixes, production writes, migrations, restarts or deployment. In that mode,
trace and report findings with their missing evidence/authorization, then stop at the handoff.
The fix/deploy steps below apply when implementation is authorized; loading just a shared
checklist does not activate the whole remediation workflow or broaden that authorization.

An audit that produces a list nobody acts on is worse than no audit — it manufactures the feeling
of coverage. This skill is the second half: **triage → fix → verify → immunize → carry forward**.

Two hard constraints from this repo's own history govern everything below:

1. **Not every finding may be auto-fixed.** A change to `unified_ranker.py`, `scoring_engine.py`,
   or any factor/weight/classification formula needs backtest evidence *before* it lands —
   `verify-gate.mjs` enforces this, and the rule exists because prior sessions merged four
   unmeasured ranker changes on a green test suite that all had to be reverted later.
2. **A fix is not done when it is committed.** `tsc --noEmit` and a green suite do not tell you a
   fetcher wrote the right rows. Written ≠ applied, committed ≠ deployed, declared ≠ installed.

## 0. Scope the sweep — inventories, not just the findings you were handed

Before triaging, confirm coverage against what actually exists, not what the input audit happened
to touch. Grep-derived, not remembered — this repo's history is full of "complete" reviews that
stopped at N instances when a static check immediately found N+4 more.

- **Features** — derive the mounted frontend surfaces from `src/main.tsx` and follow its
  imported application/route trees, including nested routes; a component directory or a
  remembered shell name is not proof of reachability. Confirm each named audit target is
  reachable before browser verification. Separate live-data routes, explicitly simulated
  concepts, and working-tree routes not verified in the deployed build. Include every
  scoring/ranking-shaped tRPC procedure in `router.ts`/`routers/*.ts`; run
  `canonical-read-audit` if the input audit did not already cover it.
- **Scripts** — every fetcher (`*_fetcher.py`), every engine/scorer/ranker (`*_engine.py`,
  `*_scorer.py`, `*_ranker.py`), every one-shot script under `scripts/`. `data-coverage-audit` and
  `fetcher-accuracy-review` cover fetchers; cross-check the rest against `git ls-files '*.py'` —
  nothing in this repo enumerates non-fetcher scripts automatically.
- **Database** — every table has a freshness check in `dataQualityChecks.ts`'s
  `TABLE_FRESHNESS_CHECKS` and the live schema matches `db/schema.postgres.sql`
  (`npm run schema:drift`). The cross-check is now AUTOMATED:
  `npx vitest run src/server/__tests__/tableFreshnessCoverage.test.ts` fails on any schema
  table that is neither freshness-checked (directly, or read by the monitoring stack) nor
  present in that test's reason-tagged `EXCLUDED_TABLES` map — an uncovered table is a blind
  spot, not evidence of health, and a new table can no longer land without either a check or
  a documented exclusion. When the gate fails, add a real freshness check (calibrated against
  live `MAX(date)` data, per `measurement.md`) or an exclusion whose reason genuinely holds —
  do not add a placeholder exclusion to make the test green.
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

  Both entries are in `bugs-monitoring.md`. Confirm both checks are PASSing and read their
  `detail` — a rate that has drifted off its recorded baseline is a finding even while passing.
- **Jobs** — every BullMQ registration in `queues.ts`/`jobs/*.jobs.ts` and every cron mirror has a
  `job_heartbeat` row with `last_success_at` recent relative to its own cadence, and its skip path
  (if any) does not fall through to the same "completed" handler a real run uses
  (`bugs-data-layer.md`'s skip-as-success class — recurred 6 times, once on the *shared*
  `registerJob.ts` handler a per-file static check structurally couldn't see).

- **Pending-work trackers** — "complete pending items" only means something if every existing
  backlog is actually read, not just the findings this run was handed. Pull open rows from
  `docs/audit-findings.md` itself (step 5's own ledger, reconciled first per that step), every
  `ponytail:` debt comment (`ponytail:ponytail-debt` skill), a repo-wide `TODO`/`FIXME` grep, and any
  named-file backlog called out in a plan doc (e.g. `docs/SQLITE_DECOMMISSION_PLAN.md`'s remaining
  files). Fold whatever's still open into this run's triage — a pending item nobody re-reads is
  indistinguishable from a closed one.

- **The instruments themselves — before reading any verdict.** Audit the graders, scanners and scorers
  that produced the findings before you accept what they say. A defect in a grader is worse than the
  same defect in the thing it grades, because it also removes the means of noticing. Every liveness and
  freshness check stays green: the instrument runs fine and answers the wrong question. Four cheap
  checks:
  1. **Every value reaches a branch.** For any categorical input, enumerate the label's full domain and
     confirm each value maps somewhere. The tell is an asymmetric map where one pole handles more tiers
     than the other: `{"buy", "strong buy"}` vs only `"sell"` dropped 31.6% of directional calls
     (AF-20261025-02).
  2. **Buckets sum to the population.** Any bucket named for an absence ("not flagged", "unknown", "no
     opinion") must be split by cause before its size is read.
  3. **Re-derive one published number** from the raw tables and compare.
  4. **A repo-wide scan states what it believes the repo is.** Print the number of files scanned,
     exclude `.claude/worktrees/`, every virtualenv (`venv`, `.venv`, `backend-python/venv`) and vendored
     trees, and halt when the count is far above `git ls-files`. **An identical non-trivial count across
     many unrelated items means a duplicated tree, not a pattern.** Five stale worktrees once made
     ~30 tables read `writes=6`.

A gap in any inventory is itself a finding — give it its own ledger row rather than silently
narrowing the sweep to whatever the input audit happened to include.

## Contract checks — producer to public reader

Load this section when a change crosses an enum/filter/alias boundary, or when a populated
pipeline stage serves an unexpectedly empty result. This is a supplementary contract check:
the existing doctor and lifecycle commands do not automatically perform this census.

1. Enumerate the actual producer, its vocabulary/normalizer, and **every public reader** of
   that concept, including sibling APIs and cached/service paths. Compare producer domains
   with reader mappings on the same latest eligible batch and universe, not all historical
   rows. Record the batch, legitimate admission filters and expected-empty conditions.
2. Use a private Postgres schema and producer-shaped rows. Exercise the real writer or shared
   normalizer where practical, then call the actual public readers; do not reimplement their
   SQL in the test. Include a positive row for each supported value/alias, higher-scoring rows
   in other horizons (to catch LIMIT-before-filter), unknown/missing values, and an
   intentionally empty eligible batch. Assert the documented behavior for each, not that
   every reader must always return rows. Fixtures must never enter production tables.
   **Before seeding**, prove the existing isolation harness redirects the writer, all reader
   pools/connections and relevant cache state into that sandbox. Do not assume that one
   connection's search_path redirects schema-qualified SQL or another pool. If any access
   cannot be isolated, do not run that fixture path: repair the isolated harness when authorized
   or report the probe blocked. Check that no fixture marker reached production.
3. Prefer one shared normalizer **per concept**, not uppercasing at each reader. For example,
   a long-term UI alias may map to stored `POSITIONAL`; classification, conviction and signal
   direction are different concepts and must not be collapsed into one enum. Preserve
   intentional producer vocabularies and explicit reader mappings.
4. Negative-control the boundary: substitute an incompatible alias/filter in the isolated
   test and require the positive fixture to disappear or fail its assertion for that reason.
   A test that validates only each module's preferred spelling does not cover the contract.
5. Cross-check production read-only: compare source-domain counts and real API results with
   the same batch/filter parameters. An empty answer is a defect only when the positive
   evidence establishes an eligible row. Report reader coverage and any skipped probe; a
   green doctor/lifecycle command alone cannot certify this supplementary check.

Before closing a contract finding, verify every enumerated reader has a tested mapping or an
explicit, evidenced exclusion. Preserve source/output evidence and name the regression test
in the findings ledger. This procedure does not authorize rescoring or production fixture writes.

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

**An EVIDENCE verdict of "no edge" or "inconclusive" needs two checks before it is written down.**
(1) **Power:** state the number of *independent* observations (overlapping windows: about dates ÷
horizon). Below the harness's own floor, the reading is LOW-DATA, a fact about the experiment, not
"measured and found nothing". (2) **Substrate:** before calling it calendar-blocked, inventory the
depth of every table that could feed the same measurement, **per column, not per table**. Once, a
42-date scored table gave about 4 independent windows, while `feature_store` held 1,439 dates with
the labels already stored. A row is only calendar-blocked once that inventory comes back empty.

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
- **Silencing a failing datasource call is not a fix until capture is preserved.** Before removing
  or default-disabling a provider call that errors, run `data-sources.md`'s replacement sequence.
  Then prove one of two things: an equivalent current route is wired and writing rows, or the source
  is intentionally retired with its consumer impact recorded in the ledger. A lower log count is not
  the completion test; rows written by the repaired path are. Once, a quiet run collected less data
  while four equivalent routes existed on the vendor's current API.
- **Ask what the broken state has been enforcing.** Before a FIX restores a path, search the
  ledger, `session-log.md` and commit messages for a deliberate retirement or restriction of that
  feature. When a bug has lived long enough, it is the system's real policy. A 71-day-broken button
  had been the only thing blocking an anonymous fan-out to a costly API that the owner had closed on
  purpose. Restore the function without restoring the exposure (an auth gate, a cap), and say so in
  the row.
- **If live verification shows regression, revert — don't leave it half-applied.** Undo the
  change, re-run this step's check stack to confirm the revert itself is clean, and reopen the
  ledger row as still-open with what was tried and why it made things worse. A fix that is
  committed but demonstrably wrong live is worse than the original finding: it reads as closed.

### Learner replay — conditional evidence gate

Load this section and `.claude/rules/measurement.md` before evaluating a learner change,
including feature-history/input repairs. Unit tests and a live plumbing PASS are not edge evidence.

- Replay baseline and candidate on the same representative, point-in-time panel before
  promotion. Respect information availability, label horizon and the next tradable entry;
  preserve frozen publication inputs. If changed history affects scaling or model inputs,
  pair the repair with train/serve parity checks and the required retraining/replay, not a
  silent rewrite under an existing model.
- For a directional claim, compare winners and losers **within the same decision date**;
  then infer across dates (or a justified predeclared cluster), not correlated stock rows.
  Distinguish movement/volatility prediction from direction. Report independent date/period
  counts and handle overlapping horizons per measurement.md; do not penalize already
  non-overlapping periods twice. Underpowered evidence remains LOW-DATA.
- Inspect the **actual produced ranking** by date: score range/quantiles, dispersion, number
  of distinct values, zero/missing shares, gate prevalence, and feature contributions for
  representative names. Compare both versions; investigate near-identical or collapsed output
  instead of treating a successful backfill as validation. No new numeric acceptance bar is
  implied by this diagnostic checklist.
- **Zero-control the benchmark first:** compute the same excess statistic for a group that
  should score zero (the neutral bucket, or an equal-size random sample) before reading any other.
  If it is not near zero, the benchmark is broken, not the strategy. Match the benchmark on
  liquidity tier and compare mean to mean. A neutral 68% Hold bucket once "beat" a same-decile
  median on 40 of 41 days at t 11.8, because skewed returns put any group's mean above the median.
- Grade executable returns net of turnover-dependent costs/slippage against the declared
  benchmark using the predeclared primary metric and untouched holdout. Keep a candidate
  shadow-only when that evidence does not support promotion; do not tune a gate to pass it.

Before declaring the learner repair verified, attach the paired replay, date/period counts,
ranking/contribution diagnostics and cost-aware verdict (or state which evidence is missing).
Use this alongside, never instead of, the existing measurement/promotion rules and live query-back.

Commit **by explicit path**, never `git add -A` — multiple sessions edit this repo concurrently.
Re-check `git status` immediately before committing.

## 4. Immunize — the step that makes it not recur

This is the whole point, and it is the step most often skipped. `recurring-bugs.md` says it
plainly: every recurrence count in that file was recorded **after** the class was documented in
prose, so **prose alone does not hold.**

For each fixed finding, pick the strongest applicable rung:

1. **A static check in `./scripts/check_recurring_bugs.py`** — best; it runs in CI and looks
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

**Every FIX-lane item needs a regression test, not only an immunization rung (user,
2026-09-30).** Write it first, show it FAILS against the unfixed code, fix, show it passes, and
name it (file or `TestClass`/`test_fn`/`check_*`) in the row's `Immunized` cell. Rung 1-4 can
be that test; rung 5 alone never closes a FIX row. `npm run findings:check` rejects a closed FIX
row whose `Immunized` cell names nothing that exists.

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
- **Validate before finishing: `npm run findings:check` must exit 0** for every row this run
  added or closed (it also catches a table that no longer renders — a stray `|`, a row outside a
  table, a control character). Rows another concurrent session is still writing may fail it;
  leave those to that session, but never your own.

## 6. Run the core end-to-end, zero errors

"Tests pass" is not "done" — this repo's own gate criterion (`verify-gate.mjs` exists because a
green suite has merged unmeasured ranker changes before). Before closing the session, run the full
Definition-of-Done stack against the state after every FIX-lane item has landed, not per-commit:

```bash
npx tsc --noEmit
npx vitest run
backend-python/venv/Scripts/python.exe -m pytest src/server/__tests__/ src/server/tests/ tests/chatbot/
npm run schema:drift
npm run findings:check
```

**Attribute every failure before owning or dismissing it.** Read the summary line, not only the exit
code: a runner can exit 0 while printing `6 failed`. Other sessions edit this repo live, so a suite
result describes a tree at an instant, and neither is exclusively yours. Cheapest first:
`git status` the failing files (yours?); compare their mtime with the run's start (edited
mid-run?); re-run each failing file alone (passes alone = contention, the classic
timeout-not-assertion signature). Only failures that survive isolation, in files you touched, are
yours. For a small change, a targeted run over the edited module's dependents is the primary
evidence and the full suite is the sweep.

All five must exit **0** — a skipped-Postgres-file warning counts as failure, not a pass
(`recurring-bugs.md`'s pytest exit-code fix: a run that skipped every DB-dependent test used to
print a loud warning and still exit 0; it no longer does, so a nonzero exit here is real). Then
confirm live, not just green locally, per step 3's third bullet: the affected pm2 process is
restarted (`deploy-and-verify`), any migration ran against the real `POSTGRES_URL`, and the
changed code path is queried back against production.

Code compiling and tests passing is not the same claim as the system running. Also check:

- **All required long-lived services are actually up.** Derive them from the current operating
  manual and `ecosystem.config.cjs`, rather than assuming the historical four-service list is
  complete. `pm2 jlist` (or the platform equivalent) must show those services online and the
  relevant uptime must postdate deployment. Scheduled one-shots may correctly be stopped between
  runs. Uptime is a deployment clue, not proof of the exact served artifact: verify the affected
  build/revision and real output through `deploy-and-verify` before claiming the fix is live.
- **A log sweep for the failure modes tests can't see.** `bugs-data-layer.md`'s swallowed-exception
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
