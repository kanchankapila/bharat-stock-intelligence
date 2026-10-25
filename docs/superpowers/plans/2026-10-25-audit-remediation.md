# Audit remediation 2026-10-25 — implementation plan

Design/recipe only. The work queue is `docs/audit-findings.md`; each task names its ledger row.

**Spec:** the 2026-10-25 audit findings AF-20261025-02..09 in `docs/audit-findings.md`, plus the
binding domain rules in `CLAUDE.md` and `.claude/rules/` (`measurement.md`,
`scoring-authority.md`, `recurring-bugs.md` and its `bugs-*.md` area files).

**Out of scope (owned by a concurrent session — do not touch):** `src/components/v7/**`,
`src/components/CommandCenterDashboard.*`, `src/server/routers/edge.router.ts`,
`.github/workflows/ci.yml`, `package.json`, `scripts/*sharedBacklog*`, `AGENTS.md`,
`src/server/jobHeartbeat.ts` and its test (a follow-up fix is in flight there), the
shared-backlog section of `CLAUDE.md`, and ledger rows AF-20261025-20 and above.

## Global Constraints

- Work only in the worktree `D:\Github\bharat-wt-audit` (branch `audit-fixes-2026-10-25`).
  `src/components/v7` there is a junction to another session's live files: never `git add` it,
  never edit it. Commit by explicit path only; never `git add -A` / `git add .`.
- **No production database writes.** Postgres on :5433 IS production. Reads only, via
  `D:\Github\bharat-stock-intelligence\backend-python\venv\Scripts\python.exe scripts\sql.py "<SQL>"`
  (read-only transaction, server-side timeout). If a fix needs a backfill, write the script with a
  dry-run default and report the exact command; do not run it with `--apply`.
- Python interpreter: `D:\Github\bharat-stock-intelligence\backend-python\venv\Scripts\python.exe`
  (production, 3.11). Never bare `python`.
- TDD with a negative control: write the test, show it FAILS on unmodified code, then fix, then
  show it passes. Put the failing output in the report.
- **No change to any score, weight, threshold, classification boundary or blend.** Those are
  EVIDENCE-gated by `measurement.md` / `scoring-authority.md`. Measurement, reporting, coverage of
  a stored field, and monitoring are in scope; reweighting is not.
- Every new reported rate carries its null/base rate and its denominator beside it
  (`bugs-monitoring.md`, "A reported number with no null beside it"). A bucket named for an absence
  is split by cause.
- Do not add a fifth signal table. New study output goes into the existing `mover_study_results`
  table as a new `study_kind`.
- Gates to run before reporting: `npx tsc --noEmit` and the touched vitest files for any `.ts`;
  the touched pytest files plus `scripts/check_recurring_bugs.py` on touched `.py` for any `.py`.

## Task 1: Grade every factor against open-to-close as well as close-to-close (AF-20261025-08)

`src/server/reverse_engineering_study.py`, function `factor_ic`. Today the two
`EVENT_PREOPEN_FACTORS` are graded against `intraday_ret` (open-to-close) and every other factor
against `fwd_ret` (close-to-close, overnight gap included). On this platform close-to-close
decomposes into gap +0.515% and open-to-close -0.253% (AF-20261007-05/-06), so a close-to-close IC
can be measuring an unharvestable gap. `f_cost_of_carry` reads +0.1884 against `fwd_ret` and
nobody knows whether it survives against open-to-close.

Requirements:
1. For every factor NOT in `EVENT_PREOPEN_FACTORS`, also compute the same per-date Spearman IC
   against `intraday_ret`, when `intraday_ret` is available for that date's rows.
2. Persist it as a separate metric row in `mover_study_results` with `metric = 'spearman_ic_o2c'`,
   leaving the existing `spearman_ic` rows exactly as they are (same values, same metric name), so
   every existing consumer is unchanged. Follow the existing per-date persistence shape for
   `factor_ic` rows.
3. The two `EVENT_PREOPEN_FACTORS` keep their current single open-to-close grading and get no
   `spearman_ic_o2c` duplicate.
4. The study's printed report must show the two side by side for the non-pre-open factors
   (`ic_c2c` / `ic_o2c` or equivalent), so a reader sees the gap decomposition without querying.
5. Tests in `src/server/tests/test_reverse_engineering_study.py`: (a) a factor whose values predict
   the overnight gap but not the open-to-close move reads a high close-to-close IC and a near-zero
   open-to-close IC; (b) pre-open factors produce no `spearman_ic_o2c`; (c) the persisted rows
   include the new metric (extend or mirror the existing source-parity persistence test).

## Task 2: One confusion matrix for pre-open calls — Type I and Type II together (objective 3)

Same module. `canonical_signal_accuracy` starts from the day's movers, so it can only see misses
(Type II); false positives (Type I: called Buy/Sell, did not move that way) are graded elsewhere
(`unified_signal_outcomes`) and never meet it. Add a new function and `study_kind =
'call_confusion'` that, for each graded date, uses the SAME pre-open snapshot rule as
`canonical_signal_accuracy` (latest `unified_recommendations` row per symbol with
`generated_at` in `[cutoff - 7d, cutoff)`, cutoff = trade_date 03:45 UTC) and grades EVERY
directional call in the snapshot — not only movers — against that date's realised return for the
whole point-in-time universe the study already loads.

Per date, report at least:
- `long_calls`, `long_hits` (realised > 0), `long_precision`, and `universe_up_rate` (share of the
  graded universe with realised > 0) as its null;
- `short_calls`, `short_hits` (realised < 0), `short_precision`, and `universe_down_rate` as its null;
- `movers`, `movers_called_right`, `movers_called_wrong`, `movers_rated_hold`, `movers_no_row`
  (the Type II side, consistent with `canonical_signal_accuracy`'s new decomposition);
- `snapshot_symbols` and `graded_symbols` as denominators.

Both "Strong" tiers count as directional on their side (use one symmetric polarity mapping shared
with `canonical_signal_accuracy` — extract it to a module-level helper so the two cannot drift).
Use the same realised-return column `canonical_signal_accuracy` uses. Dates with no snapshot are
excluded and counted, exactly as `canonical_signal_accuracy` does. Persist one row per date
(`metric = 'long_precision'`, `value`, `n_obs = graded_symbols`, everything else in
`detail_json`), wire it into the study's main run and its printed report, and make the existing
persistence-parity test cover it. Tests: a hand-built snapshot + universe where long/short
precision, nulls and the Type II buckets are each known; a Strong Sell counted as a short call;
a pre-inception date excluded.

## Task 3: Why has `ai-signals` not run since 2026-08-08? (AF-20261025-07 follow-up)

Investigate with `superpowers:systematic-debugging` before changing anything. Facts: `ai-signals`
jobs are enqueued only by `enqueueAISignals` (`src/server/queues.ts`), called only from the tRPC
mutation `enqueueSignals` (`src/server/routers/signals.router.ts`, an `expensiveProcedure`), whose
only UI caller is `src/components/DashboardPage.tsx` (~lines 407-446) — the component rendered at
route `/`, the default home page. `job_heartbeat` shows `ai-signals` last_success 2026-08-08 with
109,485 historical runs and no retained `job_run_history` rows. The 2026-10-25 fix to
`getStaleJobs` assumes an event-driven job with no recent run is legitimately idle; that is only
true if nothing is supposed to trigger it.

Determine which of these holds, with evidence: the home page no longer calls the mutation (a
condition that never fires); the mutation is rejected (auth/rate-limit middleware on
`expensiveProcedure`); the queue/worker is not consuming; jobs run but stopped recording a
heartbeat; or the feature was deliberately retired. Read-only probes only (code reading,
`scripts/sql.py`, BullMQ state via a read-only script if needed — no enqueues, no Redis writes).

If it is a defect: fix the root cause with a failing-first regression test. If it is a deliberate
retirement: say where that decision is recorded and report it; **do not edit
`src/server/jobHeartbeat.ts`** — another session holds uncommitted changes to it right now, and its
follow-up fix already changes how event-driven jobs are reported. Either way,
correct the stale comment in `signals.router.ts` that names `V3Dashboard.tsx` (that file no longer
exists). Report the verdict with evidence.

## Task 4: Why is `signal_score` NULL on ~75% of graded outcomes? (AF-20261025-09)

Measured 2026-10-25: `unified_signal_outcomes.signal_score` is NULL on 76.7% of h=1, 75.5% of h=5
and 71.8% of h=15 rows with `signal_date >= 2026-07-01` (40,123 of 163,784 non-NULL at h=5), so the
score's calibration can only be read on a quarter of the population. `src/server/outcome_resolver.py`
writes it (see the comment near line 1125: `signal_score is round(confidence_score)` from
`unified_signals`). Investigate with `superpowers:systematic-debugging`: is
`unified_signals.confidence_score` itself NULL for those rows (and which `signal_source` values /
which writers / since when), or is the resolver dropping a present value (join, type, NaN
handling)? Break the NULL share down by `signal_source` and by month.

If the resolver drops a present value: fix with a failing-first test, and provide (do not run) a
dry-run-default backfill script for the affected history, reporting the row counts its dry run would
change. If the source writer never sets it: identify the writer(s); fix only if the value it should
write already exists in that writer's scope without any new scoring logic, otherwise report the
finding precisely as EVIDENCE for the ledger. Do not invent a confidence value.
