# Data pipeline audit — 2026-09-17

## Verdict and scope

**Audit status: CLOSED — investigation and reporting complete; remediation remains open under AF-20260917-01 through AF-20260917-08. Verification gate: FAIL.** Closure of this audit is not certification of the pipeline or closure of its findings.

**NOT certified complete, timely, or failure-free.** Broad ingestion is functioning, but fresh landing tables do not establish timely decision consumption. This is an evidence-backed architecture/health audit, not an exhaustive live probe of every endpoint or a completed remediation.

Live read-only PostgreSQL observations: approximately 00:52–01:15 IST on 17 September (UTC 16 September 19:22 onward), database `bharat_intel`, host port 5433 (server reports container port 5432). Queries enforced read-only transactions, 15s statement and 2s lock timeouts. Independently captured statements are not one atomic snapshot. Working tree had extensive inherited application changes; their deployed state was not comprehensively established.

Coverage: 3,408 registry entries grouped across 18 provider labels; 834 URL templates; 85 job names with records in the prior seven days; 113 successful configured table/timestamp freshness queries (not 113 distinct providers); focused core-table counts, coverage, quality, and consumer inspection. Two freshness queries and two large counts timed out. No blanket endpoint health or wiring percentage is justified. No external endpoint sweep, production repair, model change or service restart was performed.

## Architecture observed

1. Provider APIs feed TypeScript services and Python fetchers using canonical NSE symbols and provider mappings.
2. BullMQ/Redis schedules `queues.ts` and decomposed `jobs/*.jobs.ts`. PM2 supervises application services and a nightly backup.
3. `pythonRunner.ts` caps subprocess concurrency at five and serialises measured heavy jobs against one another. It does **not** enforce an aggregate host memory budget despite an earlier contradictory comment in that file.
4. Raw/normalised tables feed `technical_signals`, `fundamentals_history`, `feature_store`, component scores and model inference.
5. `unified_ranker.py` produces positional/cross-source `unified_recommendations`; `intraday_ranker.py` independently produces `intraday_recommendations` and cycle history. These are intentionally separate.
6. UI/API/broadcast/report consumers use these and some legacy component-score surfaces. Complete per-route lineage is not established in this pass.

Evidence paths below are relative to the repository root `d:/Github/bharat-stock-intelligence`.


## Priority findings

### P1 — Opening decision availability is not established

On 16 September `intraday_recommendations_history` contains 22 distinct cycles, first **05:26:33 UTC = 10:56:33 IST**, last 15:30:20 IST. No earlier cycle was returned. On 15 September there were 25 cycles starting 09:30 IST. Investigate retained runtime logs and any history deletion before assigning a precise missed-job count. Causation of the late first cycle is not proven.

In contrast, 16 September intraday bars cover 2,347 symbols / 60,035 bars through 15:30 IST. Retrospectively complete bars do not establish signal-time availability. Recorded intraday-fetcher seven-day p95 duration is 519.2s, 1 failure in 94 records; that is not an end-to-end latency metric.

### P1 — Feature refresh predates material nightly arrivals

16 September `feature_store`: 2,379 rows, latest computation 11:53:45 UTC (17:23 IST). Earnings forecasts/estimates and several options/enrichment tables have later arrivals around 14:13–14:55 UTC. This snapshot cannot contain those later-fetched rows. `feature_engineering.py` contains fundamental, analyst, earnings, flow, delivery, option and market-context merges: the risk is readiness/order, not absent imports. Some consumers read enrichment tables directly; not every score necessarily misses the later data.

### P1 — Recovered service availability is not recovered pipeline state

Latest `stock_scores.last_updated`: 15 September 15:00:23 UTC, 9,588 rows including older retained rows. Its 16 September job failed (`fetch failed`). ML ensemble scoring failed with `ECONNREFUSED 127.0.0.1:8000`, also failing ml-daily-ops. Another session's log records service restart and successful pending-probability rescoring; this audit later verified port 8000 accepts TCP. **Do not diagnose an ongoing outage from the historical error.** Stock-score refresh and heartbeat reconciliation still need proof.

## 2026-09-18 update — root cause of the 17 September decision-table miss, remediation deployed

Continuation sessions (17–18 September) traced the evening-of-17 failure chain to a single shared
cause and deployed remediation. Filed as **AF-20260917-20 through AF-20260917-24** in
`docs/audit-findings.md`; this section summarises the outcome against this report's verdict.

**Root cause (all evidence live, read-only).** The post-close job cluster (21:30–01:30 IST)
exhausts the Postgres connection pool, and `ml-daily-ops` burns its entire budget under that
contention. Evidence: 3,863 `timeout exceeded when trying to connect` events in
`logs/pm2-out.log` with **545 inside the single hour 23:37 IST on 17 September** (~25× the
neighbouring hours); four unrelated jobs from different queues recorded completion at the
identical second `2026-09-17 23:37:56` and three more at `2026-09-18 01:34:20` (process-kill
signature); `ml-daily-ops` ran 21:35:09→01:05:09 IST = exactly its full 3.5 h `withJobTimeout`
before reporting 13 failed steps; and the failure was consequential at the source —
`fno_rollover` max(date) stayed at 16 September while every sibling table reached 17 September,
so the ranker consumed a one-day-stale rollover, and `unified_recommendations` held zero rows
labelled for 17 September's own run. Distinct BullMQ queues with `concurrency: 1` serialise per
queue and provide no cross-queue resource ceiling; the cluster's Python children contend for one
connection pool inside one Node process.

**Remediation deployed 18 September (08:39–08:45 IST restart window; pid 49784).**
1. `unified-ranker` budget 30→45 min (lock 35→55) plus one bounded 15-min make-up run on a
   failed scheduled run (AF-20); `recommendations-digest` guards against consuming a stale
   ranker table.
2. All 13 failed `ml-daily-ops` steps re-budgeted to the codebase's documented once-daily batch
   floor (60s/120s/2–3 min ceilings → 5–6 min; 5/15/30 min → 10/25/40 min). Parent
   3.5 h/4 h-lock/270 min-grace deliberately unchanged; the re-derivation decision rule is
   recorded in-code at each site.
3. Peak de-confliction: `trendlyne-catchup` `*/20 * * * *` → `*/15 0-15,20-23 * * *` (the
   21:30–01:29 IST window excluded entirely; net throughput still rises 72→80 slices/day because
   the off-peak cadence is denser), and `data-quality-daily` `30 17 * * *` → `30 21 * * *`
   (23:00 → 03:00 IST — after the cluster's observed end and before the 04:00 IST logical-session
   cutoff, so the report still labels the same trading day). Registry cron-patterns updated in
   lockstep.

**Post-deploy verification.** `tsc --noEmit` exit 0; vitest 360/360 across the four affected
suites; Redis holds exactly one repeatable per touched queue with the new patterns and no stale
keys. A manually triggered `unified-ranker` run completed in **11.4 min** and wrote **1,890 rows
with `computed_at = 2026-09-18`** — session 18 September had no ranking before it. Observation
recorded at `~/.claude/skill-observations/observation-log/0004-identical-completion-seconds-are-a-kill-signature.md`.

**Not closed by this work.** The P1s above (opening-decision availability; feature-refresh
ordering vs late arrivals; `stock_scores` refresh proof) remain open, as do AF-21..23 and
`market_holidays` having no future rows (NSE's holiday API returns HTTP 200 with an empty body
even when warmed; no working alternate in the discovery registry). The first contested night
after deployment (18 September, 21:30 IST onward) is the real test: `ml-daily-ops` inside 210
minutes with zero failed steps, `fno_rollover` landing same-day, and the 03:00 integrity report
posting.

Quant scores independently reached 16 September 15:21 UTC (2,424 rows). Unified recommendations have 1,893 rows for logical date 17 September; a DATE field does not measure arrival latency.

### P1 — Closed-day data and post-reference-exit residue

Live SQL reproduces 25 post-reference-exit bars across 17 symbols. Their writer provenance and each symbol's actual exchange status were not established. `liveStockData.ts:729–746` caches the post-exit set for 12h and fails open on DB errors; this is a risk, not proof of the historical writer responsible.

14 September has 804 daily bars satisfying the >=95% flat/zero-volume closed-session detector, only 1 flagged. Project memory identifies 14 September as a HOLIDAY. Its reduced intraday population is **not evidence of a missed trading session**. Investigate closed-day contamination and reconcile an authoritative calendar, including derived features. ALPSINDUS/14 September is already suspect, has no corresponding intraday bars, and was left untouched. No repair was performed.

### P1/P2 — Success and MAX(timestamp) can mask incomplete work

`queues.ts:2824–2828` records success when regime/ranker skips outside market hours. `StepTracker` continues after failures, so dependent ranking can proceed on older/default inputs. `fetch_utils.py:186–196` permits allowance-exhausted zero-progress runs to exit normally, relying on table freshness. `dataQualityChecks.ts:145–156` tests table-wide MAX(timestamp), not per-symbol completion. These are confirmed mechanisms; their total affected population was not measured.

Use explicit SKIPPED/PARTIAL/FAILED/SUCCEEDED states, eligible/attempted/committed counts and completion watermarks. Legitimate empty-event responses must remain distinct from failed requests.

### P1 — Backup failed, although a prior verified backup exists

Latest pg-backup failed 16 September 17:45 UTC; last success 15 September 18:08 UTC. Error includes transient test-schema table names. DQ confirms a previous verified backup, not total backup loss. Isolate test database/schema churn from backup enumeration; establish a successful backup and restore test before closing.

### P2 — Fundamental field coverage is uneven

`stock_fundamentals`: 2,474 rows, latest underlying update 12 September, PE populated for 2,032 rows, ROE for **151 (6.1%)**. Daily `fundamentals_history` has 2,474 rows on 16 September: recent snapshot dates are not fresh vendor acquisition. Other providers/columns may supply ROE, so this is a table-specific gap, not platform-wide absence. Verify consumer coalescing and eligibility denominators before changing scoring.

## Verification gate — failed, no fixes attempted

```text
DoD: FAIL
tsc: exit 0
vitest: 1383 passed / 1 failed / 44 skipped (exit 1)
pytest: not run — sequence stopped at Vitest failure
```

Exact failure: `d:/Github/bharat-stock-intelligence/src/server/__tests__/signalOutcomesServiceSource.test.ts:6:1`, `beforeEach` hook timed out after 10,000ms for “does not create a second orphaned row when a technical-sourced PENDING row already exists at the same key”. This is a hook timeout, not evidence of a failed deduplication assertion. Test files: 143 passed / 1 failed / 12 skipped. No timeout increase, test fix, or retry was performed during close-out. Other sessions' passing runs do not replace this audit's failed gate.

## Recommended sequence and closure blockers

1. **Evidence/Calendar:** reconcile 14 September with an authoritative exchange calendar and special-session exceptions; trace writer/provider timestamps for closed-day and post-reference-exit rows. The stored calendar includes entries derived from OHLCV absence, which is not independent evidence. Do not delete the 25 flagged rows merely on reference-universe exit dates. After provenance is established, scope reversible quarantine/repair and enumerate affected features/scores before recomputation.
2. **Evidence:** correlate 16 September retained recommendation cycles with BullMQ starts, subprocess waits, fetch completion and history retention. Existing cron includes the opening slot and the worker already checks market hours; another pre-open guard cannot explain or repair a 10:56 first stored cycle.
3. **Evidence/Sequential:** measure source completion versus feature and scoring input watermarks, then introduce dependency-aware refresh only where late arrivals are actually consumed. No score/weight change is validated here.
4. **Sequential:** diagnose the failed test hook in an isolated test environment in a follow-up, complete the required gate, and establish successful score/backup outputs. A TCP listener and old successful heartbeat alone are insufficient recovery evidence.
5. **Evidence:** audit eligible-symbol field coverage and explicit partial/skip semantics. If a failing provider needs investigation, query the endpoint registry first, then URL templates/raw URLs and proven sibling routes before choosing an alternate. Registry validation dated 13 September is not current endpoint health.

No findings are closed. No application code, production data, schedules, model weights or services were changed by this audit. Scratch evidence scripts were created/modified earlier in this pass; documentation and memory are the close-out deliverables. Inherited working-tree edits were preserved.

## Evidence appendix

All paths below are absolute. These are saved observations from this audit, not claims of a new live query during close-out.

- `d:/Github/bharat-stock-intelligence/scratch/audit_db_overview.result.jsonl`: live DB overview.
- `d:/Github/bharat-stock-intelligence/scratch/audit_final_checks.jsonl`: read-only clock, fundamentals, feature snapshots and detailed checks.
- `d:/Github/bharat-stock-intelligence/scratch/audit_closing_evidence.jsonl`: calendar, stock scores, report statuses, recommendation cycles, ALPSINDUS daily/intraday evidence.
- `d:/Github/bharat-stock-intelligence/scratch/audit_intraday_coverage.txt`: retrospective bar coverage.
- `d:/Github/bharat-stock-intelligence/scratch/audit_jobs_7d.txt` and `d:/Github/bharat-stock-intelligence/scratch/audit_latest_failed_jobs.txt`: runtime/failure evidence.
- `d:/Github/bharat-stock-intelligence/scratch/audit_dq_latest.txt` and `d:/Github/bharat-stock-intelligence/scratch/audit_post_exit.json`: quality checks and post-reference-exit rows.
- `d:/Github/bharat-stock-intelligence/scratch/audit_gate_status.txt`, `d:/Github/bharat-stock-intelligence/scratch/audit_tsc.log`, `d:/Github/bharat-stock-intelligence/scratch/audit_vitest_tail.txt`: gate exit codes and exact failure/counts.

Additional closing evidence: 16 September PRE_MARKET and POST_CLOSE briefings are READY; three older entries remain GENERATING with null generated_at. A READY briefing does not establish fresh inputs. The returned recommendation-cycle dates omit the 14 September holiday, while a POST_CLOSE briefing exists that day; these are distinct consumer behaviours, not proof every scheduler ignores holidays.


## Same-day resolution-pass addendum

A later "resolve all" pass updated AF-20260917-08, AF-20260917-06 and AF-20260917-03 (full detail: the addendum section at the end of `docs/audit-findings.md`):

- **Gate rerun green** on the inherited tree: tsc exit 0; vitest 1,384/44; pytest 2,771/249 (`scratch/resolve_all_*.log`). The original `signalOutcomesServiceSource` timeout never reproduced (single, file x4, and two-file reruns, all ms-scale). A concurrent read-only `pg_stat_activity` poller during the two-file rerun measured peak 6 connections, 0 lock waiters (`scratch/pg_poll.jsonl`). A later full-suite run on the same tree timed out in two DIFFERENT tests (5,000ms each), which passed in isolation minutes later — confirming the environmental-under-load classification; no timeout values were changed.
- **Backup fix built but NOT landed:** `pg_dump` now excludes disposable `pytest_*`/`vitest_*` schemas (the recorded failure's enumerated schemas). Validated by focused pytest (2/2) and a live temporary-database A/B dump check with negative control (`scratch/backup_scope_live_check.txt`). Full vitest went red on 2 unrelated timeouts before pytest could run, so the patch was parked per the repo's DoD precedent, then reapplied at close-out with focused tests green. **Finding remains open: a full DoD run on this diff, plus a successful production backup and restore drill, are still required.**
- **stock_scores refresh (AF-03) remains unproven**; all other findings unchanged. No findings closed.


## Continuation — live observations beginning 13:31 IST, 17 September

This addendum supersedes earlier current-status claims, not historical observations. The ledger now records AF-06 backup and AF-08 prior verification closed by other sessions. This pass changed no application code, schedules, models or services. Extensive inherited working-tree changes remain unshipped or of unverified deployment status.

### Coverage and evidence

Executed `d:/Github/bharat-stock-intelligence/scratch/audit_live_probe_20260917.py` using configured production DB access, read-only transactions, 15-second statement / 2-second lock timeouts. Results: `d:/Github/bharat-stock-intelligence/scratch/audit_live_probe_result_20260917.json`. **121 queries: 120 executed, 1 timed out** (seven-day recommendation-cycle aggregation). Execution success is NOT a health pass. Coverage includes 112 configured table/column freshness queries, 85 job-name aggregates, 3,408 registry entries and URL-template groups. Registry has 18 case-sensitive provider labels including aliases, not 18 independent vendors. No endpoint sweep; historical 'working' flags do not certify current availability. Initial inventory counted 82 root Python `*fetcher*.py` files, not all ingestion paths.

### Confirmed current observations

- 17 September intraday bars: 39,431 rows / 2,334 symbols through 08:00 UTC (13:30 IST), observed beginning 08:01 UTC. This is mid-session coverage, not an expected-universe completion percentage. Statements are not an atomic snapshot.
- 16 September bars: 60,035 / 2,347 symbols through close. AF-01 late first retained recommendation remains unresolved: today's cycle aggregation timed out.
- Intraday fetcher seven-day history: 96 records, 1 failure, p95 duration 475.1 seconds. Ranker: 155 records, 0 failures, p95 44.4 seconds; closed-market success stamps mean these are not trading-session SLA statistics. News: 3 failures / 3,268 records. Preopen: 5 records, no failures.
- Both preopen tables advanced to today. News articles/sentiment arrived around 13:27/13:30 IST. Live NiftyTrader screeners and Trendlyne metrics also advanced today.
- `stock_scores` remains at 15 September: 4,546 intraday and 5,042 long-term retained rows. Fresh raw data has not repaired this output.
- Feature-store 16 September: 2,379 rows, computed 17:23:45 IST. Earnings forecasts/calendar/sector earnings and options enrichments arrived later. Ordering is confirmed; not every later table directly feeds feature_store, so affected fields require consumer-specific tracing.
- Failed heartbeats include scoring, ML daily ops, screener performance, chatbot reingestion and DQ (`ohlcv-fabricated-session`). Historical ML connection refusal does not establish an ongoing listener outage.
- Fundamentals acquisition remains 12 September; ROE 151/2,474 in stock_fundamentals. Daily history is not daily vendor acquisition. A same-date fundamental gate is unjustified: the current backward as-of merge already accepts older available snapshots. Synthetic dry-run of the actual function confirmed older accepted, future excluded, pre-history unknown. First mock failed because it omitted the loader's nanosecond dtype contract; corrected mock passed.

### Serving readback: fresh database, stale intraday output

Actual read-only tRPC GET `http://localhost:3000/api/trpc/getTopRatedStocks`, limit 3, each horizon: HTTP 200. Evidence: `d:/Github/bharat-stock-intelligence/scratch/audit_api_intraday.json` and `d:/Github/bharat-stock-intelligence/scratch/audit_api_long_term.json`.

- Intraday returned sampled component-style rows dated 15 September. At 08:11 UTC the canonical table had 1,456 rows within 90 minutes, latest computed_ts 08:00:21.507197 (naive timestamp interpreted as UTC by application convention). This proves a serving gap on this route, not absence of current canonical data.
- Long-term returned confidence equal to score on all three sampled rows and date-only last_updated. AF-10 remains visible despite inherited source edits removing fabricated confidence.
- Current local source uses computed_ts, no legacy intraday fallback, and LONG_TERM filtering. The running route does not reflect that contract. Controlled deployment and readback remain Sequential-blocked by unrelated shared-tree edits; no restart performed. Do not infer every route is broken.


### Domain coverage and prioritized architecture recommendations

| Domain | Observed route | Audit conclusion |
|---|---|---|
| Prices / technicals | OHLCV -> technical_signals / feature_store -> ranks | Active bars; same-cycle consumption unproven |
| Fundamentals / valuation | Provider tables -> fundamentals_history / feature merges | Broad wiring, uneven field coverage; acquisition differs from snapshot date |
| Earnings / analysts | Dates/beats/forecasts and analyst history -> merges / direct consumers | Present; evening arrivals need completion dependencies |
| News / announcements | news_articles -> sentiment -> intraday tilt / daily features | Active today; event-to-decision SLA not established |
| Indices / F&O / market pulse | Macro, breadth, PCR/GEX -> regime -> intraday rank | Index refresh intraday; heavy stock-option scrapes remain EOD |
| Sectors / screeners | Memberships, rotation, RRG/correlations -> rank components | Populated; latest screener-performance job failed |
| Institutional flow | FII/DII, delivery, deals, MF/ownership -> technical / feature merges | Daily, monthly and event cadences must be assessed separately |
| Pre-market / briefing | Preopen tables / research report consumers | Preopen advanced; READY briefing alone does not prove input freshness |
| Stock intelligence / UI | Canonical ranks plus legacy detail paths | Serving inconsistency reproduced on Top Rated |

Recommendations, NOT implemented:

1. **Controlled deployment first:** isolate already-tested canonical-reader changes; deploy in a controlled window and repeat both horizon GETs against DB timestamps. Do not restart the entire inherited dirty tree. Current fixes are local-code-only relative to the sampled running contract.
2. **Completion dependencies:** preserve early EOD output if useful, then rebuild affected features after required analyst/earnings/flow arrivals. Trigger inference and atomic publication after completion. Equal cron cadence is not a dependency: bars and ranking are independent 15-minute schedules. Use bounded readiness waits/degraded status, not a daily-equality fundamental gate.
3. **Per-symbol completeness:** record eligible, attempted, validated and committed counts plus source-event/acquisition/completion timestamps. Attach consumed input versions to decisions. Separate PARTIAL/SKIPPED/FAILED/SUCCEEDED, retaining legitimate empty-event success. MAX(timestamp) alone cannot establish coverage.
4. **Optimize payloads before concurrency:** intraday already uses 12 workers, thread-local sessions, dual-source fallback and reduced countback. Code records empty MC responses at 24 threads. Prefer per-symbol incremental watermarks with revision overlap and supported bulk endpoints. Coordinate provider-wide quotas across processes; honor throttling and access restrictions.
5. **Protect intraday capacity:** measure queue wait/network/commit/decision latency independently. Reserve bounded capacity for critical market-hour work; background backfills/training should not fill every slot. Five Python processes and an exclusive heavy-job lock do not enforce total RAM usage. Benchmark before changing admission policy.
6. **Storage:** preserve idempotent batched writes; profile row-at-a-time writers before conversion. Consider staging validation and transactional batch publication, bounded pools and partition-aware retention. The history query timeout warrants EXPLAIN/index investigation, not blind timeout increases.
7. **Point-in-time correctness:** distinguish fiscal period, announcement, acquisition and availability dates. Analyst joins use as_of_date; earnings clock reads result dates and surprise merge reads quarter_date. Historical eligibility and actual signal-time consumption require further measurement before accuracy claims.
8. **Selective expansion:** registry labels 3,327 entries EQUITY and 81 FNO_DERIVATIVES; these are not independent feature families. Prioritize symbol/field coverage, corporate-action/calendar correctness, announcement-time history and stock-option timeliness with existing registry/templates. No new vendor justified merely by endpoint count. If sub-minute data is required, a licensed feed is a candidate, not a verified recommendation; **NEEDS USER DECISION** on latency target, universe and budget.

Remaining scope: no exhaustive external endpoint probe, complete per-column lineage census or per-symbol SLA history. No provider declared dead, no source onboarded. AF-01/02/03/04/05/07 and AF-09/10 remain evidence/sequential/calendar-blocked. Source-to-feature-to-engine lineage, point-in-time replay and controlled production readback are required before certification. Backup recovery is recorded as closed in the updated ledger, not newly verified by this pass.

**Verdict: broad ingestion is active, but complete/timely decision consumption is NOT certified. No zero-failure or trading-performance guarantee is justified.**

### Final verification and deployment handoff

DoD PASS: tsc exit 0; Vitest 1,393 passed / 0 failed / 44 skipped; pytest 2,773 passed / 0 failed / 249 skipped / 30 warnings, exit 0. Evidence logs: d:/Github/bharat-stock-intelligence/scratch/audit_continuation_{tsc,vitest,pytest}.log. Existing scoringService integration tests use real throwaway PostgreSQL tables and already seed fresh/stale/NULL timestamps. No duplicate test or application fix added.

Final new-limit/no-cache GET at approximately 14:25 IST still returned seven component-style intraday rows dated 15 September. The current reader's exact SQL returned seven canonical rows computed 14:15 IST on 17 September. Evidence: d:/Github/bharat-stock-intelligence/scratch/audit_api_intraday_uncached.json and d:/Github/bharat-stock-intelligence/scratch/audit_exact_reader_sql.json. This establishes a running-route/local-reader divergence; the precise loaded artifact/runtime DB configuration has not been proven. Controlled isolated deployment and repeat readback are required. Tests passing do not certify production consumption.


### Authorized deployment result — supersedes serving-pending status above

After user approval, restarted only bharat-server with --update-env. Health returned 200. Port 3000 listener PID 37592 runs workspace server.ts via tsx, parent PM2 PID 21700. Intraday API's seven symbols/scores/timestamps matched canonical DB output at 15:00 IST. Long-term seven-symbol ranking matched latest LONG_TERM rows; confidence property absent and generation timestamp correctly surfaced. Saved evidence: d:/Github/bharat-stock-intelligence/scratch/audit_api_postdeploy_intraday.json, audit_api_postdeploy_long_term.json, audit_postdeploy_comparison.json (comparison assertions all true).

The sampled serving mismatch is resolved, not the full data-pipeline audit. No application-code edits or new full-suite run in this deployment step. Restart loaded the shared working tree rather than an isolated patch release. PM2 showed chatbot and engine-worker stopped and host RAM 93.2%; neither was changed here. Feature readiness, legacy score freshness, coverage and sustained operational verification remain open.

