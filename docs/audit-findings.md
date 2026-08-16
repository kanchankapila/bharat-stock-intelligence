# Audit findings ledger

Carried across `/weekend-audit` runs by the `audit-loop` skill. **Never delete a row** — close it
with a date. A finding that reappears after being closed is a much stronger signal than a fresh
one, and only this file can show that. An open row surviving 3 runs is itself a finding.

Lanes: **FIX** (mechanically safe) · **EVIDENCE** (touches a score/weight/threshold — needs a
measurement first) · **INVESTIGATE** (symptom, unproven cause) · **ACCEPT** (known, bounded).

| ID | Found | Class | Finding | Lane | Status | Immunized | Closed |
|---|---|---|---|---|---|---|---|
| AF-20260815-01 | 2026-08-15 | temporal | `scripts/integrity_sweep.py` anchors on raw `MAX(date)` (`latest_date_expr`, L49-71). Enrichment columns are written by `ml-daily-ops` in the evening against the *previous* session, so the newest date is always the one enrichment hasn't reached — the sweep reports ~25 false DEAD columns every run. `087f399` fixed this exact bug in `dataQualityChecks.ts` and its own message says it was reintroduced in **both** files, but only one was fixed. | FIX | **fixed** 2026-08-16 — `latest_date_expr()` now anchors on the newest date strictly older than the last successful `ml-daily-ops` (`job_heartbeat`), mirroring `ml-signal-columns-populated`, with a second-newest fallback when no heartbeat exists so it can never silently revert to the same-day read | anchor + rationale documented in the function's own docstring, naming `087f399` and this ID | 2026-08-16 |
| AF-20260815-02 | 2026-08-15 | deploy | `bharat-server` booted 2026-08-15 05:54 UTC; **11 commits touching `.ts`/`.py` have landed since**, latest 15:43 IST. `.ts` is not hot-reloaded — the running server is ~4h20m behind `HEAD`. | FIX | **fixed** 2026-08-16 — all 4 pm2 processes restarted 11:15 UTC, which is *after* `HEAD` (`e7d7700`, 07:03 UTC). Note the working tree is not deployed, but that is uncommitted work, not drift | — | 2026-08-16 |
| AF-20260815-03 | 2026-08-15 | schema | `data_quality_history` exists live but is absent from `db/schema.postgres.sql` — created via self-creating DDL in `dataQualityChecks.ts:1899`, never reflected back. `npm run schema:drift` fails on it. | FIX | **fixed** 2026-08-16 — verified live: `schema:drift` → "Schema clean", 212 tables parsed = 212 live. Now load-bearing beyond tidiness: vitest builds its throwaway schema from this file | — | 2026-08-16 |
| AF-20260815-04 | 2026-08-15 | test | `signalOutcomesServiceSource.test.ts > excludes confluence-sourced outcomes` fails (`expected +0 to be 1`). Traced: passes 4/4 at `HEAD` in a clean worktree, fails in the working tree. Cause is the in-flight `AND label_definition = 'path_barrier'` filter in `getWinRateStats`; the fixture inserts a row without that column. | FIX | **superseded** 2026-08-16 — that session's work landed; the file is one of 27 converted to the Postgres substrate. The `expected +0 to be 1` signature turned out to be the general write-through-SQLite/read-through-Postgres class, now in `recurring-bugs.md`. Re-verify under `vitest run`, not as this row | — | 2026-08-16 |
| AF-20260816-09 | 2026-08-16 | deploy | `envConfig.ts:23-35` still validates `USE_POSTGRES` at bootstrap and pushes to `FATAL` (hard exit) on any value that isn't `"true"`/`"false"`/unset, with the reason *"Any other value silently routes the app onto SQLite."* **That reason has been false since 2026-08-15** — `usePostgres()` reads no env var, so the variable routes nothing. Net effect: a stale `USE_POSTGRES=1` in someone's `.env` now hard-crashes `bharat-server` at boot over a setting that does nothing, and explains the crash with a fallback that no longer exists. Found by a docs-staleness sweep, not by a failure. | FIX | **fixed** 2026-08-16 — spelling check deleted outright. The connection-info check was **kept and widened**: it no longer hangs off `USE_POSTGRES=true` being present, because with Postgres unconditional a missing `POSTGRES_URL`/`POSTGRES_HOST` is always a real misconfiguration. Now calls the existing `isPostgresConfigured()` rather than re-reading env. **Also caught while fixing:** the boot log line read `${usePg === 'true' ? 'PostgreSQL/TimescaleDB' : 'SQLite'}`, so a correctly-configured server printed **"DB engine: SQLite"** at startup — the worst possible thing to log while debugging a database problem | header comment states why the check was removed, so it is not restored | 2026-08-16 |
| AF-20260816-10 | 2026-08-16 | tooling | Two scripts still gate themselves on the dialect and print a SQLite warning that can never be true: `scripts/run_data_quality_checks.ts:19-22` and `scripts/ci_smoke_test.ts:32-35` both do `if (!usePostgres()) { console.error("...refusing to run against SQLite"); process.exit(1) }`. `usePostgres()` returns `true` unconditionally, so **the guard can never fire** — dead code whose message describes a fallback that no longer exists. Inverse of the "monitor that fires 16/16" class already in `recurring-bugs.md`: a check that can never fail carries exactly as little information as one that always fires. Harmless today (nothing breaks), but it is what made `docs/FETCHER_HEALTH_TRACKER.md` claim `npm run dq:check` "needs `USE_POSTGRES=true`" — a prerequisite that has not existed since 2026-08-15. | FIX | **fixed** 2026-08-16 — both guards deleted; the `pgHealthy()` retry loop underneath is untouched and remains the real gate. Both scripts' header comments also claimed `requires USE_POSTGRES=true`, which is what propagated the false prerequisite into `FETCHER_HEALTH_TRACKER.md` — corrected too | in-place comments record why the guard was removed | 2026-08-16 |
| AF-20260815-05 | 2026-08-15 | data | `mf_sector_allocation` empty; `insider_transactions` 75.3d stale; `regime-edge-trust-floor` at 1 of 2 regimes. All three pre-existing DQ warns, none critical. | INVESTIGATE | **open** (run 3) — `mf_sector_allocation` is recorded in memory as a dead upstream AMFI endpoint; insider filings are sparse by nature (warn-only by design). Now surviving its 3rd run: per this file's header that is itself a finding — decide ACCEPT-with-rationale or fix, don't roll it again | — | — |
| AF-20260816-11 | 2026-08-16 | temporal | **Third occurrence of the enrichment-lag anchor bug**, in the same file as one of its two prior fixes. `technical-signals-feature-coverage` (`dataQualityChecks.ts:1828`) still anchors on `MAX(date) WHERE date < CURRENT_DATE` → **2026-08-14**, while its sibling `ml-signal-columns-populated` (:1674) and `integrity_sweep.py` (AF-20260815-01, fixed yesterday) both anchor on the day before the last successful `ml-daily-ops` → **2026-08-13**. Enrichment columns are written the evening *after* the scan, so the newest date always reads them as 100% NULL. **Reclassified FIX → EVIDENCE during remediation, because the mechanical fix was tested and is wrong.** Swapping in the heartbeat anchor makes it *worse*, not better. Dead-column count per date, measured live with the check's own `jsonb_each` logic: **08-10: 59 · 08-11: 60 · 08-12: 45 · 08-13: 46 · 08-14: 15**. The old anchor picks 08-14 (**15** dead), the heartbeat anchor picks 08-13 (**46**). The reason is that *different writers land on different dates*: `delivery_pct`/`iv_hv_ratio`/`days_to_next_results`/`sector_global_corr_21d` are all **0 on 08-14** and populated on 08-13 (1939/2185/1820/1402), while the whole `mc_*` block is the reverse. **There is no single enrichment-complete date, so no anchor choice is correct.** The real defect is larger than the anchor: the check grades a **moving anchor against a fixed baseline of 53** with bands warn>55 / fail>65, while the quantity's own day-to-day range is **15–60**. Natural variance exceeds the entire warn/fail band, so the verdict is decided by which weekday it runs, not by whether a writer regressed — `recurring-bugs.md`'s threshold-below-noise-floor class. Needs per-column/per-writer expected-cadence, not a scalar count. **Deliberately not fixed**: changing the anchor would trade one set of false positives for another and look like progress. | EVIDENCE | **open** | — | — |
| AF-20260816-12 | 2026-08-16 | data | **Trendlyne blocked upstream, 12 days, and the recorded root cause is wrong.** `trendlyne-midweek` ran today 11:48 UTC and failed; 26/33 runs failed; **no success since 2026-08-04**. Error is `405 Client Error: Not Allowed` on *every* id, for two fetchers: `adv-technical-analysis/{tlid}/24/` and `share-price/price-performance-analysis/{tlid}/`. Memory (`job_scheduling_and_reliability`) attributes this job's failures to "catch-up retries with no resumability", marked "fixed + live-verified" 2026-08-15 — that fix was real but addressed wall-clock waste, **not this**. The endpoints are 405-blocked. Per `feedback_failing_urls.md`: reported, replacement deliberately not researched. Note the fetcher's own early-abort ("aborting early after 20 consecutive failures") worked correctly. | INVESTIGATE | **open** — needs an owner decision: retire, re-auth, or replace | — | — |
| AF-20260816-13 | 2026-08-16 | monitoring | **Both 405-blocked tables PASS their freshness checks.** `trendlyne-price-analysis-freshness` and `trendlyne-adv-tech-daily-freshness` read `max(date)` only, and a partial write keeps that recent. Live coverage against 2,234 mapped tlids: `trendlyne_price_analysis` **165 symbols (7.4%)** on its newest date and **357 rows in its entire lifetime**; `trendlyne_adv_tech_daily` **1,350 (60%)** on 08-14 but 139/125/125 on the days before. Textbook `recurring-bugs.md` "a fresh table is not a delivered feature" — the freshness mandate in `data-sources.md` is satisfied and still blind. Needs a coverage-ratio check, not a freshness one. | FIX | **fixed + live-verified** 2026-08-16 — new hand-rolled check `trendlyne-per-symbol-fetcher-coverage` counts DISTINCT symbols on each table's own newest date against the mapped-tlid universe. Live: **FAIL** at `trendlyne_price_analysis 165/2234 (7.4%)`, while both freshness checks still report PASS in the same run — that contrast is the negative control | **rung 3** (data-quality check). Verified it **discriminates** rather than blanket-firing: `adv_tech_daily` 60.4% → pass and `price_analysis` 7.4% → fail in the same run, the discrimination test `threshold-calibration-audit` demands | 2026-08-16 |
| AF-20260816-14 | 2026-08-16 | deploy | **AF-20260815-02 recurred within 24h of being closed.** `bharat-server` up since 11:15 UTC; `HEAD` `c7099a3` committed **12:55 UTC** and touches `server.ts`, `src/server/envConfig.ts`, `src/server/insightService.ts`. `.ts` is not hot-reloaded, so the running server does not contain the AF-09/AF-10 fixes that same commit landed. The closed row is not wrong — the gap simply reopens on every commit. A one-shot manual restart cannot hold this closed. | FIX | **open** — recurrence, not a new class | — | — |
| AF-20260816-15 | 2026-08-16 | stability | `bharat-server` `restart_time=38` (was 3 on 2026-08-15). Error log carries a **native libuv abort**, twice at 11:51 UTC: `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file src\win\async.c, line 94`. That is a process-level crash, not a caught exception, so nothing in the app's own error handling sees it. No alert fired. | INVESTIGATE | **open** | — | — |
| AF-20260816-16 | 2026-08-16 | docs | ~~`SQLITE_DECOMMISSION_PLAN.md` understates the remaining work 2.8×~~ — **RETRACTED same session, the finding was mine and it was wrong.** I read the headline **37** against a static `grep -rl sqlite3.connect` of **102** and called it staleness. They are two different metrics and both are correct: `conftest.py:394` `pytest_terminal_summary` counts `_SHIM_USERS`, the files that **actually invoke the shim at runtime**, and it printed **37 on the full 2,025-test suite** — not on a subset. The other ~65 files contain the string inside `test_live_datasource_*.py` bodies that are **skipped by default** (230 skipped; they need `RUN_LIVE_DATASOURCE_TESTS=1`), so they never reach the shim in CI. The doc's inventory row (L177, ~101) is the static count and its headline (37) is the runtime count. **The one real residue is wording, not arithmetic:** `CLAUDE.md:112` says "37 files still **call** `sqlite3.connect`" — 102 call it; 37 route through the shim on a default run. | FIX | **open (downgraded to a wording fix)** — the 2.8× claim is withdrawn | — | — |
| AF-20260816-17 | 2026-08-16 | monitoring | `win-probability-scored-in-time` renders a verdict off **n=1**. `technical_signals.win_probability_scored_at` is stamped on **1 of 10,947** rows across 08-10…08-14, and `measurement.md` explicitly records that single row as *"an artifact of a manual test write, NOT the real cadence"*. The check has no minimum-sample guard: `scored === 0` → pass, `scored === 1` → full verdict. It has warned on **36/36 runs**. Separately its comment (:1725-1731) and its own remediation text ("the weekly scorer has not run… re-check after the next `ml-ensemble-train` run") restate the provenance claim **`measurement.md` withdrew on 2026-08-15** — scoring runs *daily* via `queues.ts:1037` `pythonApi.scorePending()`, not weekly. Note the empty column itself is **not** a bug: migration `1787050000000` landed 08-15 and no trading day has elapsed since (08-15 Sat, 08-16 Sun). First real data is Monday 08-17. | FIX | **fixed + live-verified** 2026-08-16 — added a `MIN_SAMPLE = 100` floor: below it the check declines to judge instead of averaging a partial write. Live verdict moved **WARN → PASS** with detail *"Only 1 row(s)… below the 100-row floor… too thin to judge"*. The withdrawn weekly-cadence claim in the check's comment and in its own remediation text was corrected to name `queues.ts:1037` `pythonApi.scorePending()` | **rung 4** — 2 negative-controlled tests in `dataQualityChecks.test.ts`; with the guard stubbed to `if (false)` the new test fails `expected 'warn' to be 'pass'`, restored green. A third test pins that a full 2,192-row batch at 5.2d still FAILS, so the floor cannot swallow a real defect | 2026-08-16 |
| AF-20260816-18 | 2026-08-16 | tooling | `scripts/integrity_sweep.py` full-repo run produced **0 bytes of output in 40 minutes** and had to be abandoned. Not hung on the DB — it holds one `idle in transaction` connection with `wait_event=ClientRead`, i.e. the server is waiting on the client. stdout is block-buffered when piped, so nothing flushes until exit. Scoped (`--table technical_signals`, `python -u`) it returns in seconds. As written it cannot be used inside an audit window, which is the one place it matters. | FIX | **fixed + verified** 2026-08-16 — every finding now streams as it is discovered (`[i/total] [TAG] table: N dead, M frozen`, `flush=True`) instead of every `print` sitting after the loop. Verified: the progress line appears immediately on a scoped run, and the sorted summary still prints in full | **rung 5+** — the WHY is in an in-place comment naming `recurring-bugs.md`'s "a step at the end of a script that routinely gets killed never runs at all", of which this was the reporting-form instance | 2026-08-16 |
| AF-20260816-19 | 2026-08-16 | data | `screener_catalog.source` still holds **both cases** live: `trendlyne`/`Trendlyne` (987/343), `etnow`/`ETnow` (447/425), `moneycontrol`/`MoneyControl` (133/109) — 877 mixed-case rows of 2,539. The 2026-08-13 fix harmonized `signal_bias` (**verified: 0 screener_names with >1 bias**) and both readers `recurring-bugs.md` named (`intraday_ranker.py`, `movement_predictor.py`) **now correctly use `LOWER()`** — so this is latent, not active. Residual: any *future* reader written with exact case silently sees **25.8% fewer** Trendlyne rows (987 vs 1,330). | ACCEPT | **open (latent)** — a static check for exact-case `source =` on this table is the cheap immunization | — | — |
| AF-20260816-20 | 2026-08-16 | job | `marketsmojo_financials_fetcher` killed at its full **40-minute** budget today (`queues.ts:1235`). It degrades gracefully rather than starving — **hypothesis of alphabetical truncation was tested and disproved**: coverage spans A:149…Z:14 across 1,680 symbols, and the `key in known` incremental guard (the 2026-08-14 fix) is correctly in place at :141. But only **431 of 1,680** symbols refresh per 2 days → a full cycle takes ~8 days, and `marketsmojo_financials_history` is the only table over the bloat threshold (4.17M live / 426k dead, 9.3%, 42 UPDATEs per INSERT). The fetch happens *before* the known-values lookup, so an already-current symbol still costs a full HTTP round-trip. | INVESTIGATE | **open** | — | — |
| AF-20260815-06 | 2026-08-15 | docs | `CLAUDE.md:82` claimed `dataQualityChecks.ts` holds 62 checks. Live count is 147 (22 critical); source has ~155 `id:` entries. Understated 2.4×. | FIX | **fixed** 2026-08-15 → `~150` | — | 2026-08-15 |
| AF-20260815-07 | 2026-08-15 | tooling | `/weekend-audit`'s own service probe used `/` for the three FastAPI services, which have no root route — three false DOWNs every run. Found by running it. | FIX | **fixed** 2026-08-15 → probe `/docs` | note in skill Lane 2 | 2026-08-15 |
| AF-20260815-08 | 2026-08-15 | tooling | `/weekend-audit` and `/threshold-calibration-audit` asserted `data_quality_results` has no history. `data_quality_history` (append-only) landed the same day, 265 rows / 152 checks. The verdict-variance query was pointed at the wrong table. | FIX | **fixed** 2026-08-15 → both skills repointed | — | 2026-08-15 |

## Run log

Which lanes actually ran, so a partial pass is never mistaken for a complete one.

### 2026-08-15 — week 33, rotation group 3 (Frontend & canonical)

| Lane | Verdict | Notes |
|---|---|---|
| 0 deploy | ⚠️ | 4/4 pm2 online; `bharat-server` 3 restarts, ~4h20m behind HEAD → AF-02 |
| 1 repo | ⚠️ | `tsc --noEmit` clean · pytest 1962 passed/230 skipped · vitest 937 passed/**1 failed** (AF-04) · `check_recurring_bugs.py` clean over 475 py + 136 ts · `npm run build` ✅ 30.4s · `schema:drift` **fail** (AF-03) |
| 2 services | ✅ | :3000 → 200, :8000/:8001/:8002 `/docs` → 200 |
| 3 jobs+DQ | ⚠️ | DQ 144 pass / 3 warn / 0 critical-fail (AF-05) · `integrity_sweep.py` → AF-01 · no job at 100% fail |
| 4 database | ✅ | 1 active / 7 idle connection, nothing >5 min. Earlier in the session two queries ran 70 and 110 min; they cleared on their own — transient, not carried as a finding |
| 5 frontend | **skipped** | Not run this pass — no browser drive performed. Reported as skipped, never as green |
| 6 rotation | **skipped** | Group 3 (`/canonical-read-audit`, `/shell-parity-audit`, `/data-honesty-review`) not run this pass |
| 7 ledger | ✅ | This file created — first baseline, nothing to compare against yet |

**New this week:** AF-01 through AF-08 (first run, all new by definition).
**Fixed and verified:** AF-06, AF-07, AF-08.
**Next run compares against this table.** Lanes 5 and 6 are the gap to close first.

### 2026-08-16 (cont.) — remediation pass

Four fixes, each verified rather than assumed. `tsc --noEmit` clean · `vitest run` 963 passed /
0 failed · `pytest` 2,025 passed / 230 skipped / 0 failed.

| ID | Verification actually run |
|---|---|
| AF-20260815-01 | Ran `integrity_sweep.py --table technical_signals` live. Anchor moved to `2026-08-13` (was the newest date, `2026-08-14`). **Negative-controlled against production**: on 08-14 all six lag-columns read **0 non-null of 2,192 rows** — i.e. the old anchor genuinely did report them DEAD — while on 08-13 they are 1,939 / 2,185 / 1,820 / 1,402 / 1,402 / 1,939. Six confirmed false positives removed. All 7 columns `measurement.md` documents as genuinely never-written are still correctly reported |
| AF-20260816-09 | `tsc` caught a second `usePg` reference the first edit missed — the boot log line. Fixed |
| AF-20260816-10 | Guards removed; `pgHealthy()` path unchanged |
| new | `insightService.getIndexData` fake-index fallback removed (ACTION_ITEMS #14) |

**Correction to this session's own earlier reporting.** ACTION_ITEMS #4 was reported here and in the
register as "confirmed dead code, zero callers". **That was wrong.**
`buildRiskParityWeights` is live — `server.ts:458` calls it through the *default-export namespace*
(`portfolioModule.default.buildRiskParityWeights`), which a named-import grep does not match. Had
the "delete it" option been taken on that evidence, it would have broken the picks-export endpoint's
risk-parity path. The row is corrected in `ACTION_ITEMS.md` with the lesson: grep the bare symbol,
not the import. Same every-reader blind spot `recurring-bugs.md` records for table consumers, in
module form.

### 2026-08-16 — status reconciliation only, NOT an audit run

**No audit lane was executed.** This was a documentation-and-memory reconciliation pass, and it
is recorded here so the next `/weekend-audit` does not mistake three closed rows for evidence
that a sweep ran.

What was verified directly, and only this:

| Row | Check actually run | Result |
|---|---|---|
| AF-02 | `pm2 jlist` uptime vs `git log -1` | 4/4 online, restarted 11:15 UTC > HEAD 07:03 UTC → **closed** |
| AF-03 | `npm run schema:drift` | "Schema clean", 212 file = 212 live → **closed** |
| AF-04 | ownership traced to the landed SQLite-decommission work | **superseded**, re-verify via `vitest run` |

**Still open and untouched this pass: AF-01 and AF-05.** AF-01 (`integrity_sweep.py` anchoring on
raw `MAX(date)`) is now on its second run as open — worth noting because this ledger's own header
says a row surviving 3 runs is itself a finding.

**Lanes 5 and 6 remain the gap** — unchanged since 2026-08-15, still never run.

> **Correction, made during the 2026-08-16 (full sweep) run below:** the two paragraphs above are
> stale. AF-01 *was* fixed and live-verified earlier the same day — the evidence is in the
> "(cont.) — remediation pass" table above this section. Only AF-05 is genuinely open. The two
> 2026-08-16 sections were written out of order and disagree with each other; this note reconciles
> them rather than editing either, per the never-delete rule.

### 2026-08-16 (full sweep) — first run to execute Lane 6

First pass in this ledger's history to run the deep-audit rotation. Working tree was dirty
(69 changed files, 51 staged — a concurrent session's SQLite-decommission work), so suite results
below are "green including that work", not "green at HEAD".

| Lane | Verdict | Notes |
|---|---|---|
| 0 deploy | ⚠️ | 4/4 pm2 online, but server behind HEAD again (AF-14) and `restart_time` 3→38 with a native libuv abort (AF-15) |
| 1 repo | ✅ | `tsc --noEmit` clean · `vitest run` **963 passed / 0 failed** (102 files) · `pytest` **2,025 passed / 230 skipped / 0 failed** · `check_recurring_bugs.py` clean over 480 py + 136 ts · `schema:drift` clean (212=212) · `npm run build` ✅ |
| 2 services | ✅ | :3000 → 200; :8000/:8001/:8002 `/docs` → 200; `smoke:ci` **10/10 procedures** |
| 3 jobs+DQ | ⚠️ | DQ **149/154, 0 critical**. 5 warns → AF-05, AF-17. `job_heartbeat`: **0 jobs that never succeed**; 1 job currently failed (AF-12). `integrity_sweep` unusable at full scope (AF-18) |
| 4 database | ✅ | 1 active / 6 idle; **0 queries >5min**. Two `idle in transaction` (869s, 405s) observed mid-run and cleared on their own — transient, same as last week. 1 bloated table (AF-20). **81 tables still carry zero planner statistics** (was 300/419 on 2026-08-15 — improving, not closed) |
| 5 frontend | ⚠️ **partial** | Server renders; `App.tsx` default is `v6`, confirmed at :221. **No browser drive, no console-error check, no screenshot** — reported as partial, not green. Also: pm2 serves the **Vite dev middleware**, not the production build |
| 6 rotation | ✅ **first ever** | Ran across all 5 groups rather than week-33's group 3 alone: data-coverage, cross-writer-collision, temporal-correctness, test-integrity, threshold-calibration, canonical-read, job-runtime, measurement-integrity |
| 7 ledger | ✅ | This entry; 10 new rows |
| 8 remediate | **not run** | Findings collected and triaged into lanes only. `audit-loop` not invoked — no fixes applied this pass |

**New this week:** AF-11 … AF-20 (10).
**Unchanged from last week:** AF-05 (now on its 3rd run — escalate per the header rule).
**Fixed and live-verified:** none this pass (Lane 8 not run).

**Three claims tested and DISPROVED rather than reported** — recorded because a clean audit that
only lists hits is not showing its work:
1. *16 SQLite `date('now','-N days')` calls in `dataQualityChecks.ts` are Postgres-invalid.* They
   fail on a raw psycopg2 probe, but `sqlTranslate.ts:118-119` rewrites both forms before
   execution and documents the choice. **Not a bug.**
2. *`technical-signals-feature-coverage` was narrowed to a 5-column allowlist, reopening the blind
   spot it was built to close.* The generic `jsonb_each` implementation is intact at :1831; the
   5-column list is a **separate** check. **Not a bug** — but reading it produced AF-11, which is.
3. *`marketsmojo_financials_fetcher`'s 40-min kill starves the tail of the alphabet* (the
   `trendlyne_adv_tech` no-resumability shape). Coverage is A:149…Z:14 across 1,680 symbols.
   **Disproved by the data**; downgraded to the slow-cycle finding AF-20.

### 2026-08-16 (cont. 2) — Lane 8 remediation

Triage: **3 FIX** (closed) · **1 EVIDENCE** (AF-11, reclassified *out of* FIX during the work) ·
**2 INVESTIGATE** (AF-12, AF-15 — owner decision) · **1 ACCEPT** (AF-19) · **1 RETRACTED** (AF-16) ·
**3 carried** (AF-05, AF-14, AF-20).

| Gate | Result |
|---|---|
| `tsc --noEmit` | clean |
| `vitest run` | **965 passed / 0 failed** (963 before + 2 new negative-controlled tests) |
| `pytest` (full, incl. chatbot) | **2,025 passed / 230 skipped / 0 failed** |
| `check_recurring_bugs.py` | clean, 480 py + 135 ts |
| `schema:drift` | clean, 212 = 212 |
| `dq:check` | **148/155, 0 critical** — count moved 154→155 because AF-13's new check was added, and it correctly FAILS |

**Two findings were destroyed by their own remediation, and that is the useful part of this pass:**

- **AF-11 was not mechanically safe.** The proposed fix (adopt the heartbeat anchor its two
  siblings use) was measured before being applied and makes the check *worse*: dead-column counts
  run 59/60/45/46/**15** across 08-10…08-14, and the two candidate anchors disagree by 31 columns
  on the same table on the same day. Different enrichment writers land on different dates, so no
  anchor is correct. Moved to EVIDENCE, unfixed, with the per-date table recorded.
- **AF-16 was simply wrong and is retracted.** I compared a static `grep` (102 files) against
  `conftest.py`'s runtime `_SHIM_USERS` counter (37) and called it a 2.8× understatement. They
  measure different things; the ~65-file gap is `test_live_datasource_*.py` bodies skipped by
  default. Only a wording inaccuracy in `CLAUDE.md:112` survives.

**Not committed.** The working tree already carries 69 files from a concurrent session's
SQLite-decommission work, and `CLAUDE.md` requires committing by explicit path after re-checking
`git status`. The four files this pass touched are `src/server/dataQualityChecks.ts`,
`src/server/__tests__/dataQualityChecks.test.ts`, `scripts/integrity_sweep.py`, and this ledger.

**Rotation coverage gap that remains:** `/fetcher-accuracy-review`, `/migration-safety-review`,
`/ml-promotion-gate-review`, `/shell-parity-audit`, `/data-honesty-review`, `/trpc-surface-review`
and `/signal-accuracy-review` were exercised only through their static/live sweep components, not
end-to-end. Lane 5's browser drive is still the single largest never-executed check in this file.
