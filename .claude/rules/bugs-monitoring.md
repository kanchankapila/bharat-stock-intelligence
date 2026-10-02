---
paths:
  - "src/server/dataQualityChecks.ts"
  - "src/server/**/*{Heartbeat,heartbeat,Digest,digest,telegram,Telegram,monitor,Monitor,alert,Alert,drift,Drift}*"
  - "src/server/performance_tracker.py"
  - "src/server/jobs/digests.jobs.ts"
  - "scripts/*{watch,triage,report,sweep,Report,Watch,drift}*"
  - ".claude/skills/repo-doctor/**"
  - "grafana/**"
---
# Monitoring bug classes: blind spots, noise floors, alerts that never deliver

Split out of `recurring-bugs.md` (the index) on 2026-09-26 so each area loads only when you touch matching files. Same rules as the index: every class here has recurred; **🤖** = enforced by `scripts/check_recurring_bugs.py`; forensic detail in `docs/recurring-bugs-history.md`.

## Monitoring blind spots

- **An inline wrapper that declares fewer parameters than its caller passes silently drops the
  extras.** `registerJob` calls `monitorFn(name, status, detail, durationMs)`; three wrappers in
  `dl.jobs.ts` were written `(_name, status, detail) => updateMonitorState(...)`, so
  `job_run_history.duration_ms` was NULL on every run of `dl-engine-infer`/`dl-trainer`/
  `regime-detector` -- 8 jobs in total once direct call sites were counted (AF-20260913-06). It
  made a trainer run look like ~0 minutes and blocked measuring a widened inference read against
  its budget. **Tell:** `SELECT job_name FROM job_run_history GROUP BY 1 HAVING count(duration_ms)=0`.
  Immunized by `monitorFnForwardsDuration.test.ts`. Note `bullJobDurationMs(job)` needs
  `finishedOn`, so it returns undefined INSIDE a running processor -- measure from `processedOn`.

- **A vendor time series' newest point is the in-progress one, and storing it under the run's
  calendar date writes rounded values on non-trading days.** MoneyControl's index fundamentals
  graph ends at "today": every `nifty_pe_fetcher` run stored it -- NIFTY50 pb **2.0** against ~2.9,
  under Saturday/Sunday dates (504 weekend rows, 94 indices). The same feed returns isolated
  glitches (pe 1.1 among 21.8; pe == pb = 26.0). **Guard at the write boundary, and measure the
  guard before trusting it**: the rule set flagged 0 of 5,889 points on 23 years of clean history
  (incl. 2008/2020) and 0.3% of stored values -- and the measurement caught a first draft that
  would have deleted BSETELECOM's genuinely negative P/B (AF-20260913-08). Related: MC's
  `duration` enum is `1M,3M,6M,1Y,5Y,Max`, case-sensitive, and longer windows are COARSER (5Y
  weekly, Max monthly) -- read the 422 message, it lists the enum.

- **A comment saying a step "moved to" another job is a CLAIM, not a schedule — and when the move
  never lands, the step runs nowhere and leaves no heartbeat to notice.** 2026-09-10
  (AF-20260910-16): `insider_transactions_fetcher.py` was taken off the nightly chain on
  2026-08-13 for costing 14m47 of the critical path, and `queues.ts` recorded
  `insider_transactions_fetcher.py moved to the weekly retrain (processMlWeeklyRetrain)`. It was
  never added there. Measured 28 days later: **zero** invocations anywhere in `.ts`/`.cjs`, **no
  `job_heartbeat` row and no `job_run_history` entry at all**, and `insider_transactions` frozen
  at 2026-05-02 (~131 days stale, roughly double the 75.3d recorded when it was first flagged).
  **The absence of a heartbeat row is the tell, and it is easy to misread**: every other dead-job
  class here shows a heartbeat that is stale or `failed`; a job that was never registered has no
  row at all, so a query for stale/failed jobs returns it in neither. Ask "which scripts have no
  heartbeat row?", not only "which heartbeats are stale?".
  **The masking condition is worth its own line:** the matching data-quality check
  (`insider-trades-recency`) is deliberately **warn-only** because SEBI PIT filings are genuinely
  event-driven and sparse — `data-sources.md`'s documented "sparse by nature" exemption. A
  warn-only freshness check structurally cannot distinguish "sparse" from "the writer is gone",
  so every sparse-by-nature datasource is a place this class can hide indefinitely. The fix is
  not a tighter threshold (that would re-introduce the false positives the exemption exists to
  prevent) — it is asserting the schedule exists.
  **Immunized** by `src/server/__tests__/queuesMovedStepsAreScheduled.test.ts`, which parses
  `queues.ts`'s own "moved to/off" comments and asserts each named script has a real `runPython`
  call. Two build-time lessons from it: the scheduler surface is **not** just `queues.ts`
  (registrations are decomposed into `jobs/*.jobs.ts` — scanning only `queues.ts` produced two
  false positives), and a `RegExp` assembled inside a **template literal** loses its backslashes
  (`\(` becomes `(`), so it silently matches nothing and reports every case as a failure, which
  looks exactly like a real finding. Prefer substring matching, and always include a non-vacuity
  assertion that the scan found something.


- **Removing a monitor does not remove its last verdict — a snapshot table keyed on the monitor's
  own id keeps that verdict readable forever, and every consumer reads it as current.**
  `data_quality_results` holds one upserted row per `check_id` and never deletes;
  `getLatestDataQualityResults()` (what the daily digest reads, deliberately, so it need not re-run
  168 queries) returned every row with no filter against `DATA_QUALITY_CHECKS`. So `deploy-drift`
  and `port-drift`, switched off on purpose (pm2 apps dropped 2026-08-27 `b27e588`, checks removed
  2026-08-29 AF-20260829-17), still reported `status='fail'` stamped 2026-08-29 in the 2026-08-30
  digest — red for monitoring nobody wanted. **The tell is arithmetic, and it was sitting in the
  digest itself:** the snapshot table held 170 rows while the same message's data-integrity section
  reported 168 checks. Whenever a "latest status per X" table disagrees on COUNT with the registry
  that defines X, the difference is dead rows being reported as live.
  **What makes this a class and not an incident:** it was the THIRD patch for one removal —
  `dataQualityChecks.ts` and `jobHeartbeat.ts`'s `getStaleJobs()` had each already grown a bespoke
  `['deploy-drift','port-drift']` exclusion list, each with a comment citing the "deleting a thing
  does not delete the checks pointing at it" entry below. **Two hand-maintained exclusion lists for
  one removal is the signal that the generic fix is missing** — a third consumer you have not
  thought of is reading the same stale rows. Fix it at the shape, not per consumer: purge rows the
  run did not produce (the full-recomputation rule under "Writes & keys"), AND filter the read to
  the live registry so it is self-cleaning before the next sweep. Leave the append-only *history*
  table alone — it records what was true then, which is a different question.

- **A vendor can stop returning ONE FIELD while still answering normally, and every freshness
  check stays green for as long as it takes someone to look.** Found 2026-09-17 (AF-20260917-07):
  `fundamentals_history.return_on_equity` decayed 1,928/2,229 symbols (86%, 2026-07-02) -> 1,443
  (65%, 08-03) -> 1,092 (49%, 08-09) -> 476 (21%, 08-16) -> **151 (6.1%) from 08-23 onward**. Six
  weeks, monotone, nothing fired — the table was written daily and was never stale for a moment.
  ROE feeds the percentile ranks in `institutional_quant_engine.py`, `multi_factor_scorer.py` and
  `quantScoringWorker.ts`, so all three were silently ranking 151 names out of ~2,474.
  **Proving it is the vendor and not you costs one query, and skipping it sends you into the
  fetcher for nothing:** `fundamentalsSyncService.ts` reads `debtToEquity` and `returnOnEquity`
  from the SAME `financialData` object in the SAME Yahoo `quoteSummary` response. d/e reads 85%
  and ROE 6.1%. Same request, same parse, same auth — therefore the field itself stopped coming
  back. **Whenever a column looks broken, find a SIBLING column from the same response and compare
  coverage before opening the fetcher.**
  **Monitor shape:** per-field fill rates on the latest snapshot, not a table timestamp —
  `fundamentals-history-vendor-field-decay` in `dataQualityChecks.ts`. Calibrate against live data
  and confirm it DISCRIMINATES before shipping (ml-model-bugs.md's always-fires rule): as built it
  reads FAIL on `return_on_equity` (6.1%) and pass on `debt_to_equity` (85.2%),
  `operating_margins` (97.0%) and `piotroski_f_score` (97.3%).
  **And do not "fix" it by COALESCE-ing in the first alternate that has coverage.** Measured here:
  `historical_fundamentals.roe` is the same quantity (Pearson 1.0000) but shares the upstream and
  decayed identically; `trendlyne_stock_profile.roe` is percent-scaled with 322 symbols; and
  `investsights_factor_scores.roe` has the coverage (2,103 symbols, daily) but reads Pearson
  **0.7727** with outright sign flips — a different ROE definition (standalone vs consolidated).
  AF-20260913-02 rejected a substitute at 0.745 for exactly this reason. A correlation in the
  0.7s is the tell, not a green light.

- **A table-freshness check cannot see whether the FEATURE that table exists to produce ever landed.** A fresh table is not a delivered feature — count 100%-NULL columns on the last COMPLETED day, generically (via `jsonb_each` over the row), not via a hand-enumerated column list that only guards what someone remembered to add.
- **A data-quality check's own assumption goes stale, silently, when the source logic it guards grows a new legitimate case.** When editing any date/provenance-rollforward function, grep every data-quality check reading the column it stamps — a check's SQL doesn't know when its premise changed underneath it.
- 🤖 **A degraded-read message printed to stdout (not stderr) defeats the one hook that would surface it** — subprocess wrappers that only inspect stderr for "finished with warnings" never see a `print()`'d degradation message. Use `print(..., file=sys.stderr)` inside anything invoked via a subprocess wrapper that only checks stderr.

- 🤖-adjacent **`const reason = stderr || stdout` discards the real failure reason for every
  script that emits a harmless warning.** `pythonRunner.ts`'s non-zero-exit branch chose ONE
  stream with `||`. Any script importing torch writes UserWarnings to stderr on literally every
  run ('expandable_segments not supported', 'PYTORCH_CUDA_ALLOC_CONF is deprecated'), so `err` is
  never empty for the ML scripts, the `||` short-circuits, and the stdout tail holding the actual
  error is thrown away. Found 2026-08-30: `dl-retrain-weekly`'s make-up run was recorded — in
  `job_run_history`, in the BullMQ `failedReason` AND in the heartbeat — with a 448-character
  'error' consisting of nothing but those two torch warnings. No error text existed anywhere in
  the system. The irony is that the branch's own comment already described the stdout case it was
  failing to handle (`dl_trainer.py` prints `[TRAINER] Done: {...'error':...}` to stdout and THEN
  `sys.exit(1)`, deliberately, so a swallowed exception cannot be logged as success). Fixed by
  concatenating both tails, labelled, instead of choosing one.
  **Tell:** any `a || b` where both operands are diagnostic output. A warning is enough to make
  the first operand truthy, and warnings are the norm, not the exception. This is the mirror image
  of the existing 'degraded-read `print()` to stdout' entry above: there the message went to the
  stream nothing read; here the message went to the right stream and was discarded anyway because
  the *other* stream happened to be non-empty. Both produce the same end state — a failure with no
  recoverable reason — so check both directions when a job reports an error you cannot act on.
- **A process the OS killed writes NOTHING to either stream, so a runner that builds its failure
  message from stdout/stderr falls through to a bare magic number that reads exactly like a script
  crash.** 2026-09-10: `[PY] exit_policy.py encountered an error ... exit code 1073807364` and
  `ml_ensemble.py ... exit code 3221225794`, with `fullStderr` containing nothing but that same
  sentence. Neither script had a bug — `0x40010004` is DBG_TERMINATE_PROCESS and `0xC0000142` is
  STATUS_DLL_INIT_FAILED, i.e. Windows tearing down the process tree during a planned Windows
  Update restart (System event 1074, TrustedInstaller, confirmed against `LastBootUpTime`).
  **Decode the exit code before believing the script failed.** The ones seen on this box:
  `1073807364`/`0x40010004` terminated by the OS, `3221225794`/`0xC0000142` DLL init failed (host
  shutting down, or out of memory/desktop heap), `3221225786`/`0xC000013A` console closed/Ctrl+C,
  `3221225477`/`0xC0000005` genuine native crash, `137` OOM-killer. `pythonRunner.describeExitCode()`
  / `isHostTeardownExit()` now do this automatically, so the log says `HOST/OS TERMINATION: ...`.
  **Tell:** a failure whose captured stderr *is* the "Command failed with exit code N" sentence —
  that means both streams were empty, which a failing Python script essentially never produces
  (it leaves a traceback). Cross-check the host's `LastBootUpTime` and System event log 1074/6008
  before opening the script. Same family as the `stderr || stdout` and degraded-`print()`-to-stdout
  entries above: a failure recorded with no recoverable reason.
- **The whole platform silently stops when the host sleeps or reboots, and every heartbeat check
  still reads "healthy" — because a job that never ran writes no failure row.** Same 2026-09-10
  incident: pm2 has no Windows service and no scheduled task (`pm2 startup` does not support
  Windows), so after the update restart the platform stayed down **4.4h** until a human started it,
  and this was the *fourth-largest* such window in 14 days — nine gaps over 2h, ~40h total, against
  a measured healthy inter-job gap of p50 0.23min / p95 5.2min / p99 14.5min. Not one existing
  check noticed, because they all ask "did this job fail?" and never "did anything run at all?".
  **Tell:** query the gap, not the failures — `lag(ran_at) OVER (ORDER BY ran_at)` across ALL of
  `job_run_history`; any window with zero runs of any kind is downtime, not idleness. Immunized by
  repo-doctor's `platform-outage-gaps` (WARN >90min, ~6x measured p99). Fix the cause with
  `scripts/install-pm2-autostart.ps1`, and re-run `pm2 save` whenever the running app set changes.
- **A Telegram send that treats a 429 as final silently drops the report it was sending.** Telegram's
  `sendMessage` answers `HTTP 429 {retry_after: N}` with the exact wait it wants; `telegramService.sendMarkdownMessage`
  used to log the error and report failure, so when the 2026-09-08 08:15 IST morning digest hit
  `retry after 8`, the digest was simply lost (`job-digest-morning failed: job digest failed to send to Telegram`
  in `job_run_history`). **Tell:** a daily report that "randomly" fails on a schedule with no code change, and
  `[TelegramService] Failed to dispatch` bodies containing `error_code: 429` in the app log. Fixed 2026-09-09:
  bounded retries honoring `retry_after` (+ per-chunk ~1.1s pacing) inside `sendMarkdownMessage`, so every
  caller (digests, watchdog alerts, recommendations digest, accuracy digest) inherits the fix.
- **A notification gate that reads a field its pipeline never populates is not a strict gate — it is an
  always-false dead report.** `technicalSignalsService.sendTelegramSignals` gated on `r.winProbability >= 0.85`,
  but NOTHING in `runTechnicalSignalScan` ever sets `r.winProbability` (the column `technical_signals.win_probability`
  it would write is NULL platform-wide, live-verified 2026-09-09) — so the "NSE DAILY SCAN" Telegram digest
  had never sent a single message, while the code, the scan, and the docs all implied it worked. This is the
  second instance of the shape (the websocket `confidence >= 85` gate died the same way on 2026-07-12 when the
  confidence scale was swapped for win_probability). **Tell:** a report channel with zero sends since a known
  scale/route change; grep for the WRITER of the gated field, not just the reader, before touching the
  threshold. Fixed 2026-09-09: gate reuses the scan's own actionable threshold (`signalScore >= 5`, 7 in BEAR —
  the same values that mirror into `recommendation_log`), one digest per date with retry-on-failure, and the
  send routed through `telegramService` so balancing/chunking/429-retry/DB-configured settings all apply.
- **The same class, at its most destructive: a test that issues `DROP TABLE` on an unqualified name
  will, on some run, really delete the production table — and the symptom surfaces weeks later as
  "this whole subsystem is dead", never as a red test.** Found 2026-09-17 (AF-20260917-19) by
  `npm run schema:drift`, not by any suite: `high_flyer_daily_stats` and `high_flyer_retrospective`
  were in `db/schema.postgres.sql` and **absent from live Postgres**, while 15 files still read or
  wrote them, including a scheduled `ml-daily-ops` step and the daily Telegram accuracy digest. No
  `%flyer%` job had recorded a run in 21 days.
  **The attribution is exact, and that is what makes this worth remembering:**
  `src/server/__tests__/signalAccuracyDigest.test.ts` drops those TWO tables by name, and
  `high_flyer_candidates` — created by the same Python `CREATE TABLE IF NOT EXISTS` block, in the
  same function, but never named in any test — was still there. When a subsystem loses exactly the
  objects some test names and keeps the ones it doesn't, stop theorising and read the test.
  **Its guard was a dead env var.** The file opened with `process.env.DATABASE_URL = ':memory:'`,
  which stopped steering anything when the SQLite path was deleted on 2026-08-19 (`a2a20d2`), so
  `dbAsync` resolved to Postgres regardless. A guard written for an architecture that no longer
  exists reads exactly like a guard that works. **Tell:** grep test files for env vars naming a
  backend this repo no longer has.
  **The real isolation is the throwaway schema, and it is not unconditional.** `pgClient.ts` pins
  `search_path` to `"<throwaway>",public` under the comment "can only ever shadow a production
  table, never write to one" — the same sentence AF-20260917-11 already disproved for
  `conftest.py`'s `pg_schema`. Being FIRST protects only a name the throwaway schema HAS, and
  protects nothing at all when `VITEST_PG_SCHEMA` is unset, which is every run outside the vitest
  `unit` project including a developer running one file by hand. **Fix shape:** a test that drops
  tables must ASSERT `VITEST_PG_SCHEMA` is set and throw otherwise — cheap, and it fails loudly in
  the one situation where the damage is real. Immunized by
  `src/server/__tests__/testsDoNotDropProductionTables.test.ts`, a source-derived scan (not an
  allowlist) that only counts DROPs actually passed to a DB call, so `pgClient.test.ts` asserting
  that a string is REJECTED is not a false positive.

- **A test that can reach a network side effect without a mock WILL, on some full-suite run, perform it against production.**
  `addJobWithCatchupReclaims.test.ts` drove the real reclaim→requeue path; the dynamic `import('../telegramService')` inside
  `alertOrphanedJob` resolved to the REAL service, so `vitest run` sent live `job: orphan (queue fake-queue)` alerts to the
  production chat — 15 of them on 2026-09-09, with zero test failures, because no test asserted on sends. This is the test-side
  twin of "a developer's Postgres IS production": side effects need the same isolation as data. **Tell:** Telegram messages
  whose job/queue names match test fixtures (no production queue is named `fake-queue`); a chat that receives N identical
  alerts after a `vitest run`. Fixed 2026-09-09 at two layers: per-file `vi.mock('../telegramService')` on every
  registerJob-importing test (policy), and a runtime guard in `sendMarkdownMessage` (`process.env.VITEST` → no-op) so any
  future unmocked test is inert. Immunized by repo-doctor's `tests-mock-telegram` + `tg-vitest-guard` checks.
- **A digest/lateness flag is a snapshot — cross-check the LIVE state before chasing it.** The 09-09 evening digest flagged
  `nt-live-filter-capture` "~16h late" and ml dispersion "dying (ml 100%)" while both were already healthy (32/32 capture
  slots that day; latest DQ read ml 0% after the recovered runs). Digests build from state that 15-min pollers keep moving;
  verify against the log's latest completed slot and a fresh heartbeat before spending a session on the flag. Related
  measurement trap: `job_heartbeat` stores naive-UTC epochs and pg's JSON rendering appends a bogus `Z` to
  `AT TIME ZONE`-converted values — UTC instants read as IST wall times and vice versa; use raw epoch math (repo-doctor does).
- **"All critical jobs succeeded today" cannot be read off `job_heartbeat` — four instruments lie in four different ways
  (2026-10-02, AF-20261002-01/-03).** (1) A heartbeat is the LAST run: both critical failures (`quant-scoring` 11:48,
  `stuck-signal-resolver` 12:44) had been overwritten by retried successes, so the table read 16/16 green. Count
  `job_run_history` rows with `status <> 'success'` over the IST day (`ran_at >= '<prev day> 18:30+00'`) instead. (2) On a
  trading holiday a "success" can be a logged skip (`unified-ranker` 22:30, duration 0 s, "skipped — trading holiday");
  judge by the output table's `generated_at`, not the stamp. (3) `[QUEUE] <job> sent` is a generic `onCompleted` hook that
  also prints after a SKIPPED run — delivery evidence is `[TelegramRecs] Sent N message(s)`, and counting those showed the
  digest went out THREE times. (4) `pgmigrations.run_on` is a naive UTC `timestamp` (DB `TimeZone=UTC`): applying
  `AT TIME ZONE 'Asia/Kolkata'` to it shifts it the wrong way by 5.5 h, which made a migration look applied hours before
  the failure it explained. Also: a Windows exit code `0xC0000017` / `0xC000012D` in two scripts in the same millisecond, followed
  by a Node `ENOMEM`, is one host-memory event, not two script bugs. **Tell:** an exact tie between "green dashboard" and
  "I was told something failed" — query the run history for the day before reading any heartbeat.
- **A buy/sell inversion can exist at the DISPLAY layer while the data is correct — check the mapping when a report "looks backwards".**
  The 2026-09-09 accuracy-digest audit: the ranker was monotone-correct (avg unified_score Strong Buy 85.6 → Strong Sell 14.0),
  class strings title-case, retrospective class sets pinned by tests — but the Grafana "top losers" panel mapped
  `Strong Sell → dark-green / Strong Buy → dark-red`, the exact mirror of the correct gainers panel. A user asking "is buy/sell
  defined opposite?" was right — about the dashboard, not the data. **Tell:** two panes in the same dashboard that colour the same
  classification differently; a "correct call" rendered green in one view and red in another. Fix the mapping; and reach for the
  cause the user actually suspected (grep the WRITER, check monotonicity of `classification` vs `unified_score`) before blaming a
  direction bug that isn't there. Immunized by repo-doctor's `grafana-systemcall-colors` (greps for the inverted
  `Strong Sell → dark-green` signature in `grafana/*.json`).
- **A one-sided accuracy report hides the system's real hit rate — report BOTH halves of a directional confusion.** Before 2026-09-09
  the Signal Accuracy digest only surfaced flyers rated Sell/Strong Sell that rallied (wrong-direction) but not the flyers rated
  Buy/Strong Buy that made high "as recommended" — so a reader could not distinguish "we are inverted" from "we are right sometimes
  and only showing the misses". The digest now buckets every mover by prior call (correct/wrong/neutral) and lists the top confirmed
  as-recommended calls next to the worst wrong calls. **Tell:** an accuracy report whose only named examples are failures cannot
  separate a directional bug from a low-but-real hit rate.
## Noise floors, and metrics that overflow into a plausible wrong number

- **A log-level classifier that recognises exactly ONE logging format reports ordinary progress
  output as a crash, and a loud noise floor is what trains everyone to skip the warnings that
  matter.** `classifyStderr`'s benign pattern required `INFO:` **with a colon** directly after
  the timestamp. Python's own default format (`%(asctime)s %(levelname)s %(message)s`) emits
  `INFO panel: 27608 rows` with no colon, and any logger with a name field emits
  `[finstack] INFO:`. Neither matched, so both fell through to the `real_error` default:
  measured over a 3-day pm2 window, **14 of 57 `real_error` events were false alarms** across 7
  scripts whose runs had succeeded (AF-20260912-02). **Tell:** grep a classifier's own output for
  scripts whose ENTIRE stderr is progress lines. **When widening such a pattern, add a
  counter-case in the same commit** asserting a genuine failure from the same script still
  classifies as real (`[DeliveryTrend] Fetch error ... 503`) — otherwise the widening quietly
  becomes a mute button. Keep ERROR/CRITICAL out of the benign set so they still fall through.

- **A warning that names no subject is unactionable, and "returns empty on a degraded read" makes
  it invisible.** `trendlyneScreener.ts` logged the bare string `Unexpected API response format`
  and returned `{ success: false, data: [] }` — no screener, no id, no status, no payload shape,
  so three occurrences could not be attributed to a screener or a cause (AF-20260912-05). A
  degraded-read message must name the subject and say how the response differed from the
  contract the code checked.

- **A `cumprod` over a long panel overflows to `inf`, and `Series.min()`/`.max()` SKIP NaN — so
  the metric returns a plausible, finite, correctly-signed number computed from only the rows
  before the overflow.** `performance_tracker`'s `max_drawdown_pct` compounded the h=15 group
  (**93,278 rows, mean clipped return +2.216%**) via `(1 + r/100).cumprod()`; past the overflow
  `(cum - peak)/peak` is `inf/inf = NaN`, `.min()` skipped it, and the existing non-finite guard
  therefore never fired. All 41 groups over 5,000 signals were pinned at exactly `-100.0`
  (AF-20260912-04). **Compute any drawdown/cumulative ratio in LOG space** —
  `exp(cumsum(log1p(r)) - cummax(cumsum(log1p(r)))) - 1` is algebraically identical with an
  exponent `<= 0` by construction, so it cannot overflow. **Tell:** a metric that is suspiciously
  round or identical across many groups (`-100.0` for all of them). **And do not write
  `assert x is not None` as the test** — that is what passed against this bug on the first
  attempt; assert that **no overflow warning is raised**, since NaN-skipping means the value
  looks fine either way.

- **A throwaway test schema leaks into production whenever the runner is killed before its own
  teardown, and an unqualified `information_schema` read then sees it as a second copy of every
  real table.** Two `vitest_%` schemas with 227 tables each were live, with **no reaper of any
  kind** — and they bit the same session that found them: a PK inspection of `bulk_block_deals`
  came back with every column listed twice (AF-20260912-12). Stamp each throwaway schema with
  its own `created_at` and reap siblings **by AGE** (not "anything that is not mine" —
  concurrent runs are legitimate and dropping a sibling mid-run fails it with a hundred
  `relation does not exist` errors). The pytest side has one too (CORRECTED 2026-09-30 — this
  line said it had none): `pg_test_support.purge_orphan_schemas()` reaps `t_*`/`pytest_*`
  orphans, widened to `pytest_*` on 2026-08-27 (AF-20260827-07). A `pytest_<12hex>` schema
  seen live is usually a run in progress — match it to a `pg_stat_activity` backend before
  calling it a leak.

## Placeholder credential in an executable alert path = registered-but-never-delivered monitoring (2026-09-14)

A hardcoded placeholder credential (chat id `-100123456789`, token `123456:ABC-DEF...`) inside a
script that REGISTERS alerting (crons, webhooks, digests) does not fail — it succeeds, writes its
config, and every future alert silently routes to a nonexistent destination. Worse than no
monitoring: the dashboard/ledger says alerts are wired. Rule: **executable alert paths source
real credentials from the repo `.env` and fail loudly (`: "${VAR:?...}"`) at registration time;
templates/templates-docs may be EMPTY with a "copy from repo .env" pointer, never fake.** Found in
the Hermes integration batch (AF-20260914-04); the same class as "Registered != running" — a
successful registration is not evidence of a working delivery path.


## "Not measured" reported as "measured and found nothing" (2026-09-29, two sites in one session)

A verdict function that grades a thing must distinguish **"I measured it and it did not help"**
from **"I could not measure it"**. Collapsing them produces a result that reads like evidence and
is not, and the two demand opposite actions: drop the feature, versus go and get more history.

Both instances were the same shape — a data source whose history does not span the evaluation
window — and neither was visible from the output:

- `legacy/screen.py` reported `"admitted": [], "rejected": 38`. Every reason was
  `coverage 0% < 30%`: the screen evaluates the earliest 250 sessions so feature selection never
  sees the test folds (2021-01-01 → cutoff 2022-01-04), while the imported legacy history begins
  **2026-05-16**. Zero overlap, so all 1,078,510 imported facts were structurally unadmittable.
  The cutoff is CORRECT and was not changed — moving it to meet the data is the look-ahead bug it
  exists to prevent.
- `modeling/ablation.py`, found an hour later by the very data meant to exercise it.
  `mc_estimates` spans 38 distinct days of a 6-year window, so removing the group cannot move the
  ensemble: `delta_ic` came out **exactly 0.0** with a **NaN t**, printed as `no evidence` beside
  `options` (t=−0.61) and `global_cues` (t=−0.09), which genuinely had been measured.

**The tell is an exact zero with a null/NaN test statistic.** A real neutral result is a small
number with a real t; `0.0` and `NaN t` together mean the comparison never happened. Treat that
pair as "not evaluable" and say so in the output.

**The check, when you write any grader:** before trusting a per-item verdict, count how many
periods that item actually *has data on* and report it beside the verdict (`dates_with_data`,
`coverage`). A verdict with no denominator beside it cannot be audited. Guard it with a test
whose fixture has a field present on only the last N dates of the window and assert it classifies
as not-evaluable — negative-control it, because the failing assertion is the whole point: without
the fix it reads `no evidence`.

Fixed and immunized in AF-20260929-09; `bharat_alpha/tests/test_legacy_bridge.py` and
`tests/test_ablation.py` carry the guards.
