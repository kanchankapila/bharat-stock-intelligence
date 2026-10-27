# Audit remediation program — 2026-10-24

## Completion contract

Track every unresolved ledger candidate and every newly discovered failure. A textual claim of closure is a reconciliation candidate until its code, regression guard and live result are checked. No promise of an error-free codebase or profitable trading is evidence. User authorization includes implementation, migrations, replay/backfills, commits and deployment; it does not supply missing credentials or create future market outcomes.

## Current status — 2026-10-27

**Incomplete.** The progress section below records completed October 24 work, not closure of this program. `docs/audit-findings.md` is the current shared backlog for every agent and model. Dependency-security and tRPC stack-trace repairs are in [draft PR #127](https://github.com/kanchankapila/bharat-stock-intelligence/pull/127) at `01422d8e`; the complete local Vitest gate and exact-head CI passed. The study-universe correction is in [draft PR #128](https://github.com/kanchankapila/bharat-stock-intelligence/pull/128) at code commit `dcc424e6`, with full local Python and Vitest validation, exact-head CI success, and a read-only 50-date production replay. Neither PR has been integrated or activated in production. The user owns the server restart, after which the API needs a live HTTP readback; the study also needs a persisted rerun. The October 26 ranker wrote 2,362 production rows, but its breakout-weight closure still needs exact stored-score and bucket reconciliation. Several model and trading-edge findings require future independent windows; host settings, off-host backup credentials, and new-source choices require user input. Do not mark the program complete from source tests or historical progress alone.

## Execution plan

1. Reconcile the complete ledger, debt comments, active route/API surfaces, scripts, tables and jobs. Preserve unrelated working-tree changes. Record owner, next action, evidence and unblock condition for every candidate.
2. Restore trustworthy inputs: fix slow-ratio delivery using observed-at/as-of source history, prove historical non-leakage and writer ordering, inspect zero-filled warm-up fields, canonical identities and corporate actions. Preserve a population boundary and replay before changing a served model.
3. Make probability publication depend on a matching target, horizon and independent calibration evidence. Show experimental rank/evidence state when probability is not validated. Keep the frozen forward cohort intact and the currently excluded ML contribution gated.
4. Preserve immutable consensus snapshots and derive revision breadth/dispersion, earnings surprise and post-result drift in shadow research. Measure screener novelty/tenure, delivery acceleration and confluence incrementally. Classify options, macro, ownership, pre-open and news by their economic role and decision timestamp.
5. Repair reliability: cold ROC query, partial-source health, endpoint validation, profile provider/status, backup/restore verification, dependency/environment consistency, process/job deployment drift. Reuse existing providers and runtime helpers.
6. Execute every presently feasible evidence experiment. Grade at executable next-open entries with costs, liquidity, turnover, date-level inference, negative controls and immutable protocol boundaries. Schedule calendar-bound cohorts without resetting them.
7. Run the complete repository gates on the final tree, commit explicit owned paths, deploy the affected services/migrations, inspect logs and query each changed result back. Close only supported rows. Carry credentials, destination choices and immature forward cohorts with concrete unblock conditions.

## Promotion and trading decision rules

- Treat rank percentile, expected return, probability, drawdown and execution cost as separate outputs.
- Require the calibration target and horizon to match the served prediction; beat a purged trailing base rate out of sample before publishing a probability.
- Promote factors/models only after the repository's effective-window, both-tail, cost-aware and independent holdout gates pass. An honest no-promotion result completes an experiment but does not validate profitability.
- Record point-in-time snapshots from their first actual observation; never manufacture historic revisions, filing times or fills.
- Preserve the canonical ranker and existing signal-table ceiling. Prefer a small ensemble with measured incremental information.

## Ledger coverage

`docs/audit-findings.md` owns every work item and its current state for all agents. The former
candidate/status matrix was reconciled against the ledger and retired as a duplicate queue;
no finding IDs were discarded. This document is an execution design and historical evidence,
not an independently maintained backlog. Follow the ledger, including AF-20261025-20.

## Additional backlog coverage

New findings after the original 116-row snapshot: AF-20261024-05 (history erasure, closed),
AF-20261024-06 (profile provenance deployed; provider credential missing), and AF-20261024-07
(heartbeat DDL/backup contention, closed after deployment 447b0343). They remain in the ledger.

- Source-derived `ponytail:`, TODO and FIXME inventory: rerun after source changes; functional debt is folded into the ledger, cosmetic/history comments are recorded as such.
- Plan documents: inspect active `docs/superpowers/plans/`, trader-analyst plans and master build prompt; superseded intent does not authorize resurrecting retired systems.
- Live checks: full DQ report, integrity sweeps, service status, job readiness and logs; all new failures become linked rows.
- Vendor contracts: bounded live probes and per-provider budgets; freshness alone does not establish data meaning or reader delivery.

## Progress

- Inventory captured before implementation. Prior audit artifacts are retained; code and HEAD have advanced since the audit and must be rechecked.
- Financial delivery replayed then applied only to the latest completed grid: 1,616 FCF / 1,582 interest coverage / 1,582 ROCE values of 2,151 rows. Generic yesterday-coverage selection missed today's family collapse. Existing predictions/frozen inputs were not recomputed; model promotion still needs a population-boundary comparison.
- Quarterly refresh no longer erases older genuinely observed financial values; actual-writer negative control and preservation regression pass.
- Immutable observations applied across earnings forecasts, estimate hit/miss, target forecasts and financial quality: 39,945 BASELINE rows with installation-time provenance. All four production triggers proved by real UPDATE controls rolled back atomically; no synthetic observations retained.
- Earnings revision/surprise shadow consumer and nightly step added. Initial snapshot deliberately reports no historical revisions/surprises; 5,243 baseline actuals have no pre-announcement estimate. No alpha promoted.
- ROC pre-aggregation/index measured 609ms versus 22,144ms before; exact production equality across 19,522 buckets / 141,562 outcomes. Fresh-process API verification remains required after restart. UI no longer calls mixed-target diagnostics out-of-sample calibration or profitable edge.
- Shared 75-minute ranker budget replaces divergent scheduled/API literals, with AST guard and a failing old-code negative control.
- Profile provenance added to both active detail panels. Credential remains absent; user asked to configure it in the environment. No fake successful refresh.
- Reconciled sustained Trendlyne midweek/crawl recovery, seven verified single-launch backup nights, and latest-universe alias exclusion. SHINDL is a real exchange listing and was not removed.
- Full source gates passed: Python 3,878 passed / 269 skipped; final TypeScript 2,111 passed / 46 skipped; type-check/build/schema 263/263/findings/recurring scan pass. Dependency repair and deployment verified; post-repair Python subset 65 passed. Repo-doctor full: 38 PASS / 4 WARN / 0 FAIL. Commits 8a3bb6f2 and 447b0343 are deployed to their affected services.

## Follow-up navigation

Current owners, next actions, evidence, blockers and closure states live only in
`docs/audit-findings.md`. Relevant topics include financial delivery (AF-20261024-02),
ROC tail latency (AF-20261024-03), PIT research (AF-20261024-04), provider readiness
(AF-20261024-06), warm-up integrity (AF-20261021-03), consumer direction contracts
(AF-20261021-01), corporate actions (AF-20261021-05), and the cross-agent tracking
repair (AF-20261025-20). Consult those rows rather than interpreting this historical
progress section as current state. No error-free or profitable-prediction claim is implied.
