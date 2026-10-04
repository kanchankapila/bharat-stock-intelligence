---
paths:
  - "src/server/queues.ts"
  - "src/server/jobs/**"
  - "src/server/jobRegistry.ts"
  - "src/server/pythonRunner.ts"
  - "src/server/pgClient.ts"
  - "src/server/db_compat.py"
  - "src/server/monitorScripts.ts"
  - "src/server/**/*{Job,job}*"
  - "src/server/**/*fetcher*"
  - "src/server/**/*{backfill,sync,optimizer,trainer}*"
  - "ecosystem.config.cjs"
  - "scripts/*.ps1"
---
# Job & runtime bug classes: schedules, budgets, retries, repairs, connections

Split out of `recurring-bugs.md` (the index) on 2026-09-26 so each area loads only when you touch matching files. Same rules as the index: every class here has recurred; **🤖** = enforced by `scripts/check_recurring_bugs.py`; forensic detail in `docs/recurring-bugs-history.md`.

## Signals, writes & job runtime

> The 21 ML/model/measurement-harness classes that used to sit here (promotion gates, training
> labels, train/serve skew, sklearn `cv=`, fabricated backtest scripts, drift thresholds, panel
> slicing) moved to **`.claude/rules/ml-model-bugs.md`** on 2026-08-27 — load that when touching
> a model, a gate, or a measurement harness.

- **Omitting `runPython`'s third argument silently gives the step a 5-minute budget, and the step stays green until data growth puts it past exactly 300s — then the whole parent job DEGRADES on a number nobody ever chose.** 2026-09-26 (AF-20260927-12): `ml-weekly-retrain`'s `performance_tracker.py --horizon 15` call had no timeout arg; the step died at exactly 300,000ms (114k outcome rows) while the daily chain's identical calls already passed `15 * 60_000` explicitly — the sibling budget was right there to copy. Standalone re-run: 550s under load, 3m14s–4m32s clean, so the default was wrong by 2-3x at current data size. Same latent shape found in `ml-weekly-data`'s `outcome_resolver.py` calls (fixed the same day; `<60s` today but batch-capped, so pinned). **Fix shape:** every `runPython` call whose script reads a growing table gets an EXPLICIT budget, sized off a measured standalone run (the exit-policy-train comment protocol in queues.ts: re-time standalone, compare against contention, then pick) or copied from the sibling caller that already runs the same workload. **Tell:** `runPython(` call sites with only two arguments in `queues.ts` / `jobs/*.ts` — scan them whenever you touch a chain, and never "just leave the default" for a step whose input grows.
- **The same per-item computation implemented twice — a single-item path and a batched/parallel path — drifts the moment a feature or fix lands on only one of them, and the scheduled job almost always runs the batched one.** 2026-09-14 (AF-20260914-01): `feature_engineering.py`'s worker `_compute_symbol_unscaled` (the ONLY compute path the nightly full-universe `dl-feature-refresh` job runs) carried 8 of `process_symbol`'s 13 merges, so the nightly `ON CONFLICT DO UPDATE` upsert rewrote NULL over the analyst/earnings-clock/delivery/options/block-deal columns every day while each merge's own unit test stayed green — they test the merge, not the wiring into both paths. One day earlier, same class on the model side: `load_inference_sequence` missing the scaler step `load_symbol_sequences` got (AF-20260913-01, recorded in `.claude/rules/ml-model-bugs.md`). **Guard shape that worked: a source-level parity test** — `inspect.getsource()` both call sites, extract the call sequence, assert equal (`test_feature_wiring.py::TestWorkerPathMergeParity`), plus a per-item presence test for the symmetric-drop shape that equality alone cannot see. When you add a step to one path, the parity test fails until it lands in the other.
- **A processor's own `catch`/`.catch()` block that logs `'failed'` to `job_heartbeat`/`recordHeartbeat`/`updateMonitorState` and then rethrows will ALWAYS be followed by the worker's `.on('failed', ...)` handler logging the SAME failure again, if that handler also calls the same logger.** `withJobTimeout` is `Promise.race([fn(), timeout])` — a rethrow from inside `fn()` propagates through the race exactly like an outer timeout does, so BOTH reach BullMQ's rejection path and fire `.on('failed')` regardless of which one already logged. Found 2026-09-10 in `quant-eod-sync` (confirmed: two `job_run_history` rows 9ms apart, identical error text, for one real budget-timeout failure — inflating its 7-day fail-rate metric) and, by the same shape, latent in `mover-screener-capture` (not yet manifested in observed history). The worker's `.on('failed')` handler is a strict superset of "the processor's own catch already logged it" — it fires for BOTH the inner-rethrow case AND a true outer-timeout the processor's own catch can never see, so it alone is sufficient; the processor's own catch should `console.error` + `throw`, never also call the logger. **Tell:** a job name appearing in more than one call site logging `'failed'` with a literal string in the same file/module — `check_recurring_bugs.py`-adjacent, immunized by repo-doctor's `dual-failure-log` check (scans for a job name logged `'failed'` from 2+ literal call sites).
- **A UNION half that supplies NULL for the column the consumer keys on is inert, and its row count hides that** — the query returns rows, a `processed` counter grows, the job logs success, but that half's contribution is silently discarded at the accumulate step. **Write a control assertion** that a row from the "included" half actually changes the output — a test that only checks the excluded half stayed out passes identically against a filter that excludes everything.
- **An enum-ish column with two spellings differing only by case silently defeats an `IN`/`NOT IN` list**, and worse, if the column is also part of a composite PK, both spellings survive forever as separate rows that never collide. Recurred in `signal_source` (`technical` vs `TECHNICAL`, two producers) and again worse in `screener_catalog` (3 producers, 3 different casings on the same PK, 67% of rows had a same-name-different-casing duplicate that could disagree on `signal_bias`). Re-run `SELECT name, count(DISTINCT val) ... HAVING count(DISTINCT val) > 1` before trusting any consensus number built by grouping on such a column, not just once after a new producer is added.
- **An upsert keyed on a value DERIVED from a name (a slug), not the provider's own numeric id, silently discards the provider's id whenever the provider reassigns it** — whichever id a batch loop processes last wins the row, with no error. Low severity if content is never actually lost (only the old id value vanishes), but look up by name/derived key rather than trusting a specific historical id still resolves.
- **A ternary branching on `== 'bullish'` (or similar) silently treats every OTHER value — including a legitimate third state like `'neutral'` — as the opposite pole.** Extract a single 3-way polarity mapping (`1 if bullish else (-1 if bearish else 0)`) and share it across every call site that needs the same classification, so the direction and the reasons-bucketing can't disagree with each other.
- **A "generated at" column listed in `ON CONFLICT DO UPDATE SET` stops being a generation time and becomes a last-seen time** on every re-run — and it stays 100% populated, so no NULL/freshness check catches it. Tell: a value later than its own `created_at`. Remove the column from the update list (first write wins). A corrupted provenance column doesn't just shrink your sample when you filter on it — it can hand you a confident, wrong answer from a biased slice.
  **RECURRED 2026-09-27 across NINE writers at once (AF-20260927-10), with a second failure mode worth its own line.** The semantic layer's `available_at` ("when did this become knowable to us") was in every `DO UPDATE SET` list in `semantic_evidence.py` (5) and `semantic_identity.py` (4), while the module docstring called the tables "append-only" — so the documented contract and the code disagreed, and the bitemporal `as_of` reads the layer exists for were unsound. **The new wrinkle: a provenance column can be sourced from something EARLIER than the write, and that direction is worse than "last-seen".** `sync_identity` passed `nse_stocks.last_updated` as `available_at` — a mutable vendor edit stamp that is frequently *before* the sync that wrote the row, so the row claims we knew a fact before we did, and a point-in-time read at that instant returns a row that did not yet exist: **look-ahead, manufactured by a provenance bug rather than by a join.** Fixed by passing `None` and letting the writers' own `COALESCE(CAST(? AS timestamptz), now())` stamp the run's real time. **Two tells:** a provenance value EARLIER than the row's own first write (not just later than `created_at`), and any provenance column fed from a vendor's own `updated_at`/`last_modified` rather than from your write path. **Guard shape that generalises:** a source-derived scan asserting the column appears in no `DO UPDATE SET` block, with a non-vacuity assertion that the scan found real upsert blocks (`test_no_writer_puts_available_at_back_into_a_do_update_set`) — per this file's header, a check beats another paragraph for a class that has now recurred.
- **A frontend null-check layered on a column that already defaults to a wrong non-null value (e.g. `0.0` instead of `NULL`) is dead code**, and `tsc`/a green suite/a screenshot cannot tell you that — query the actual column, not the rendered page.
- **A value formatted for ONE display consumer (currency-prefixed, unit-suffixed) can silently become the stored value every OTHER consumer reads as a number.** Check every reader of a column for a numeric cast before assuming a formatting change is presentation-only.
- **A step that only runs at the END of a script that routinely gets killed by its timeout never runs at all** — and the wasted runtime and the missing data are the same bug. A `runPython` step logging "killed by timeout" on a recurring basis means check what comes AFTER the kill point in that script and assume it has never executed. Put a slow producer's dependent parse step in its own queue step so it degrades to "parse what landed," not "parse nothing."
- **A per-call API with no since-parameter turns an upsert into quadratic write amplification**, and the row count hides it (millions of rows written for a handful of genuinely new ones). Read `MAX(date)` per key once and skip what you already hold — the fix is on the write side, not the fetch side.
- **A `dict.get(key) == value` skip-check on a write-amplification guard can't distinguish "never written" from "already stored as NULL"** — both come back `None`. Use `key in known and known[key] == new_value`, not a bare `.get()` comparison, whenever the column can legitimately hold NULL.
- **A THROTTLED vendor response and a genuinely-empty one must not collapse to the same value —
  otherwise "we got rate-limited on every symbol" is indistinguishable from "this universe has no
  data", and the run reports a clean success over nothing.** Recurred twice, and the second time
  only because the first fix was recorded in memory instead of here:
  (1) `insider_transactions_fetcher` (2026-07-31) — `fetch_nse_insider()` returned `[]` both when
  NSE throttled and when a symbol genuinely had no filings; fixed to `None` vs `[]`.
  (2) `finstack_cashflow_fetcher` (2026-09-10, AF-20260910-06) — finstack wraps yfinance, and
  Yahoo answers a throttled caller with `{"error": true, "message": "Too Many Requests. Rate
  limited."}`, the SAME envelope shape as "no quarterly cash flow for this ticker". Both flattened
  to `[]` and were tallied as "no vendor coverage"; with 6 parallel workers and no backoff a single
  throttle burned the whole ~2,000-symbol universe, printed `0 wrote / 2000 had no vendor
  coverage`, and `main()` returned 0 unconditionally so the step recorded success. The table holds
  **59 rows / 15 symbols** since 2026-09-01 and how much of that gap is real coverage vs.
  accumulated throttling is now unknowable for the historical rows.
  **The fix shape:** classify the throttle explicitly BEFORE parsing (the parser flattening every
  error envelope to `[]` is fine and should stay pure), count it separately, back off, **abort once
  throttling is sustained** — continuing burns the rest of the universe for nothing and keeps the
  throttle warm — and exit non-zero so the step cannot report success. **Tell:** a fetcher whose
  "no coverage" count is a large round fraction of its universe, or a vendor-coverage claim in a
  docstring that nobody re-derived after the fetcher started running at scale. Related but
  distinct: `data-sources.md`'s Trendlyne cumulative-allowance entry (there, no amount of backoff
  converges — only a bounded slice + resume-from-DB does).
- **A full-universe fetcher with no resumability turns "retried on catch-up" into "always starts from zero"** — a killed run's real progress is thrown away every retry, compounding any transient slowdown into total failure instead of graceful degradation. Track `MAX(date)`-per-key against wall-clock cost the same way the write-amplification fix does against write volume.
- **`keep_alive: 0` on a repeated local-LLM/embedding call forces a full reload between EVERY call in the same run**, even with zero external contention. Drop it (default keep-alive) for any script calling the same endpoint in a loop.
- **A provider-issued id column that silently holds the wrong shape (e.g. a symbol instead of the provider's numeric id) is a permanent, self-concealing 404** for every row with that shape, while also burning retry/backoff budget that masks a real transient outage in the noise floor. `SELECT count(*) FROM t WHERE provider_id !~ '^[0-9]+$'` (or whatever shape the provider actually uses) before trusting a column `data-sources.md` calls opaque/numeric.
- **A timestamp used as a uniqueness key is only as fine-grained as the SYSTEM CLOCK TICK, not as precise as its ISO output implies** (Windows: 15.6ms; two calls in the same tick return the SAME value). If that key backs `ON CONFLICT DO NOTHING`, the second write in a tick is silently discarded. Bump by 1µs on collision if the constraint depends on strict ordering. The answer differs by platform (Linux ~1ns) — "it never happens in prod" can be true on Linux and false in dev, or the reverse.
- **A test dismissed as an "order-dependent flake" can be a real defect whose trigger is timing** — before labelling anything flaky, reproduce deterministically and read the actual assertion message; it may name the bug outright. Instrumentation that widens timing (e.g. `-s` adding I/O) can hide a timing bug rather than reveal it.
- **A value written as a SENTINEL (e.g. `0.0`) instead of NULL for "missing" is invisible to every freshness/coverage check and silently poisons any measurement built on that column** — and the fix can't be retroactive (a `0.0` is indistinguishable after the fact from a genuine zero; rewriting historical rows fabricates evidence). Tell: `count(*) FILTER (WHERE col = 0)` as a large round fraction of the universe. Record the fix date as a population boundary and source measurements from raw tables for anything before it.

- **A BullMQ job left in `active` state by a killed worker is a ZOMBIE that looks exactly like a
  healthy long-running job, and for a weekly queue it silently eats the entire week's slot.**
  Found 2026-08-30: `dl-retrain-weekly`'s Saturday 2026-08-29 11:30 IST run still showed
  `active` ~29h later, with `getJobCounts()` reporting `active: 2`. There was no corresponding
  `python.exe` in the OS process table — a pm2 restart had killed the worker mid-run, and BullMQ
  keeps the job in `active` until its `stalledInterval`/`maxStalledCount` reclaim fires (here
  masked further by a 24h `lockDuration` chosen for a genuinely long training job). The job
  therefore neither ran nor reported failure, and the *consequence* surfaced somewhere else
  entirely: `model_registry`'s last BiLSTM row was 5 days stale, which reads as "the DL model
  isn't improving" rather than "the trainer never executed". **Tell:** cross-check any long-
  `active` job against the OS process table before believing it is running — an `active` BullMQ
  job with no matching child process is a zombie, and the older it is the more certain that is.
  Same family as this file's `cron_restart` "Registered != running" entry (a dormant job that
  looks idle-healthy) and its "lateness branch that can never fire" entry: silence reads as
  health in all three. Do NOT diagnose from `pm2 list`/`getJobCounts()` alone.

- **A timeout budget is calibrated against the query the step ran WHEN THE BUDGET WAS SET, and
  widening a SHARED query helper silently invalidates every caller's budget at once.** The
  2026-08-30 feature-completeness fix repointed `online_learner.load_recent_outcomes()` (plus
  `cs_ranker.py`/`exit_policy.py`) at `ml_ensemble.full_feature_train_sql()` — ~30 hand-rolled
  columns to ~275. `online_learner`'s ml-daily-ops budget stayed at the 120_000 chosen for the
  narrow query; live-measured after the fix it takes **3m34.8s (215s)**, so the step could never
  again pass, and because it is a `T.run()` step it fails the whole `ml-daily-ops` parent rather
  than degrading. It had in fact ALREADY timed out at 120s on 2026-08-28, before the widening —
  so the fix converted an intermittent failure into a guaranteed one. **When you change a shared
  query/feature helper, grep every caller for its own timeout constant and re-measure each one
  — the helper's own callers are the blast radius, not just the file you edited.** Sibling of
  this file's "measured 119s against a 120_000 budget — a 1-second margin" cases: the recurring
  defect is choosing a budget with no headroom, then never revisiting it when the work grows.
- **A backlog-draining job that resolves ONE capped page per run, with inflow above (cap x runs per day), reports success forever while the backlog grows.** `live_screener_resolver.py` took the oldest 50,000 pending rows per run, 3-4 runs a day, against ~260,000 new appearances a day: the newest outcome was 3+ weeks old, every consumer (optimizer, ML ranker, backtester) trained on month-old data, and no job failed (AF-20261003-10). **Tell:** a log line that says `Resolved N` with the SAME N (the cap) on every run, and `MAX(<outcome date>)` far behind `MAX(<input date>)`. Fix: drain pages until empty or a wall-clock budget, one commit per page, with a keyset cursor `(sort_key, id) > (?, ?)` so a row that can never resolve (no outcome row is written for it) is skipped instead of re-selected as the head of every page. Same family as `outcome_resolver`'s newest-first `LIMIT 2000` starvation (AF-20260930-27, AF-20261001-31). Check the throughput arithmetic (cap x runs/day vs rows/day) whenever you add a `LIMIT` to a work queue.
- **Loading millions of per-event rows into pandas to `groupby` them is a database job.** `live_screener_optimizer.py` pulled 10.9M outcome rows (9.8GB peak, then a timeout) to group by `(run_id, symbol)`; `GROUP BY` + `ARRAY_AGG(DISTINCT ...)` ships ~one row per group (AF-20261003-11). Memory ceilings and budgets are not the fix - they just move the failure date as the table grows.

## Limits in the wrong unit, and orderings that are only a comment (2026-09-12)

- **A COUNT limit does not bound MEMORY, and a PER-PROCESS ceiling does not bound the HOST — two
  jobs can each be legal and jointly kill the box.** `MAX_PYTHON_CONCURRENT = 5` caps how many
  Python subprocesses run; `PY_CHILD_MEM_LIMIT_MB = 20480` caps each process TREE. Neither is a
  host budget. Measured 2026-09-12 (AF-20260912-13): `strategy_optimizer.py` at 16,870MB peak
  commit ran alongside `dl_trainer.py` at 13,820MB on a 23.5GB host — both comfortably under the
  20GB per-tree ceiling, together 30.4GB. Commit hit **94.3% of 82GB**, available memory **339MB**,
  **102,856 pages/sec**. This is the same host-commit exhaustion that killed the WSL2 VM six times
  on 09-06..11 (AF-20260911-01), except the cause was CONCURRENCY, not one runaway process — so
  every per-process guard added after that incident was structurally incapable of catching it.
  **Tell:** any limit whose unit differs from the resource you are worried about. Ask "5 of WHAT,
  and 5 times HOW BIG?" — if the answer to the second question is unbounded, the cap bounds
  nothing that matters. Fixed with an exclusive slot for scripts over `PY_HEAVY_THRESHOLD_MB`,
  seeded from measured `peakMemMb`, not estimates.
  **A full byte budget is the obvious fix and it is a trap**: with strict FIFO a 16GB job at the
  head blocks every small job behind it; with first-fit the big job starves instead. Either way
  the loser hits `SLOT_WAIT_TIMEOUT_MS` (3 min) and FAILS — you trade a memory bug for a mass
  job-failure bug. Serialise only the heavy population against itself and leave everything else
  on the untouched count semaphore.

- **A comment asserting a safety property is not the property, and a WRONG one actively prevents
  the fix — because the next reader stops looking.** `queues.ts` said "pythonRunner caps global
  Python concurrency at 5, so this can't oversubscribe the box" while `pythonRunner.ts` said, of
  the same mechanism, "It is per job tree, not per host: 5 slots can still sum past RAM." Both
  comments were in the repo for weeks; the second is correct. **Tell:** two files describing the
  same guard in incompatible terms — grep the guard's own definition before trusting either, and
  when you find the wrong one, FIX THE COMMENT in the same pass, or the next session re-derives
  the same false conclusion. Same family as this file's stale-`dataQualityChecks.ts`-comment
  entry, where a comment claiming warn 60 / fail 80 sent a session chasing a discrepancy that
  did not exist.

- **A cron offset is not a dependency. `B` scheduled 60 minutes after `A` does not run "after A"
  unless A is guaranteed to finish in under 60 minutes — and a job chain's own step budgets tell
  you immediately whether that is possible.** `dl-retrain-weekly` was `0 6 * * 6` carrying the
  comment "after ml retrain"; `ml-weekly-retrain` fires at `0 5 * * 6` and its last three runs
  measured **87.4 / 110.7 / 192.7 min**, with ~853 min of summed runPython budget. The DL job
  therefore started mid-chain **every single week**, and the comment made it look intentional.
  **Tell:** any "after X" / "once X has finished" comment on a `repeat: { pattern: ... }`. Check
  it against `job_run_history`'s measured `duration_ms` for X, not against the intent. **Prefer
  day-separation over a cross-job guard** when a whole day is free — there is no guard to get
  wrong, and the two heaviest jobs here simply cannot coexist any more. If they must share a day,
  the ordering has to be a real completion trigger, never an offset.

- **A train job that fetches cannot be scheduled around its own resource profile.** `ml-weekly-retrain`'s first 15 steps were fetchers and labellers (~513 min of budget) ahead of
  ~340 min of training, so the job was I/O-bound for hours and then abruptly 17GB-RAM-bound, and
  nothing downstream could reason about when the expensive part started. Split fetch from train:
  the train half reads the DB only. Label prep (`outcome_resolver`, `exit_labeler`) belongs with
  the FETCH half even though it writes no vendor data — `exit_policy.py --train` depends on it,
  so landing labels a day earlier strengthens the ordering instead of racing it.

- **Market data cannot change while the market is closed — a weekend re-fetch is re-reading
  Friday.** `stock_ohlcv` holds **zero Saturday/Sunday bars** (verified live 2026-09-12). Any
  price/volume/OI-derived job on a weekend slot is doing at best a rare-correction sweep at
  full-universe cost. Separately and more expensively, **fetch cadence must match the DATA's own
  cadence, not the job's convenience**: measured the same day, `finstack_cashflow_history` held 6
  distinct periods with a newest `period_end` of **2026-06-30** while being re-fetched weekly
  across ~2,000 symbols — ~13 full-universe crawls per one quarter of new data. **Tell:** compare
  `count(DISTINCT <period column>)` against `count(DISTINCT fetched_at::date)`. If fetch days far
  exceed data periods, the schedule is wrong, not the fetcher. Gate on
  `max(period_end) < expected_current_period` and skip entirely otherwise (the
  `finstack_cashflow_checked` marker pattern — and note the skip marker must be its OWN table,
  never the history table, or names with no vendor coverage are re-crawled forever).

## Repairs, fallbacks and skip-lists that don't do what they say

- **A repair path can share the exact failure mode it repairs — and then the repair IS the crash
  site.** The idiom for discarding a possibly-dead connection is `conn.close(); conn = connect()`.
  But `ConnWrapper.close()` delegates to SQLAlchemy's `Connection.close()`, which issues a
  **ROLLBACK** before returning the DBAPI connection to the pool, and on a dead socket that
  rollback raises the very `psycopg2.OperationalError: server closed the connection unexpectedly`
  the reconnect was written to prevent. Bit twice, six weeks apart: `strategy_optimizer.py`
  (2026-08-29, discarding a full grid search + 888 computed overrides) and `backtest_optimizer.py`
  (2026-09-10, AF-20260910-24). **The tell is where the output stops**: captured stdout ended on
  the grid loop's own last print and stderr was a `do_rollback` traceback — i.e. the first
  post-loop statement, which was the reconnect itself.
  **The compounding failure is organisational, not technical:** the guard was written into
  `strategy_optimizer.py` and never propagated to its sibling, which had been fixed for the
  ORIGINAL bug *two days earlier*. One class, two files, one fixed. That is why it now lives in
  shared **`db_compat.reconnect()`** — a guard re-typed per call site is a guard that will be
  missing from the next call site. **Use `db_compat.reconnect(conn)` anywhere a connection sat
  idle while a DIFFERENT handle did minutes of work; never hand-roll close-then-connect.**
  Related, same file: a cleanup `conn.close()` inside a `finally` raises on a dead handle and a
  raise from `finally` **REPLACES the propagating exception** — so the real failure is swallowed
  and reported as a connection error at teardown. Wrap cleanup closes.

- **A skip-list built from rows successfully WRITTEN can never contain the things that never
  write — so those are re-fetched on every run, forever.** `mf_holdings_fetcher`'s staleness skip
  read the symbols present in its output table; a symbol the vendor has no data for is never
  written, so it never enters the list. Measured 2026-09-10: of the fetcher's own 1,969-symbol
  universe, 1,403 had ever been written and **566 (29%) were re-crawled every single run** at
  ~1s each — ~9-17min of pure waste against a 20-min budget, which is what finally tipped it into
  `Timed out after 1200000ms` and failed `ml-weekly-retrain` (AF-20260910-28).
  **The fix is a negative cache, and the naive version is a trap this file already names**
  ("a THROTTLED vendor response and a genuinely-empty one must not collapse to the same value"):
  the fetcher returned a bare `None` for HTTP!=200 (incl. 429), a clean 200 carrying no data, AND
  any exception. Caching that indiscriminately turns a transient rate-limit into **silent
  permanent data loss**. Classify first (`ok` / `empty` / `error`), cache ONLY `empty`, give it a
  TTL matched to the data's real cadence (90d here, quarterly disclosures), count errors
  separately and abort on sustained ones.
  **Tell:** a fetcher whose runtime grows monotonically while its output row count does not, or
  whose "no data" count is a large stable fraction of its universe. **Measure against the JOB'S
  OWN universe, not the master list** — the first count here was 1,037 against `nse_stocks`
  (2,366), but 397 of those have no vendor id and are never attempted; the real figure was 566.

- **A `try/catch` placed around the statement that CANNOT fail, while the privileged statement
  sits outside it, is a fallback that never fires — and its docstring will confidently promise
  the degradation it never performs.** `scripts/install-pm2-autostart.ps1` wrapped
  `New-ScheduledTaskTrigger -AtStartup` (constructing a trigger object, which succeeds
  unelevated) and left `Register-ScheduledTask` — the call that actually needs elevation —
  outside the catch. So the boot trigger was always included, every unelevated install died with
  a raw `CimException`, and the NOTES claimed "the logon trigger alone works unelevated"
  (AF-20260910-26). **Tell:** read which statement the guard actually encloses, then ask which
  statement exercises the privilege/IO/network. They are frequently not the same one. And when
  you fix it, **re-run and check the fallback path actually executes** — here it then revealed
  that this box refuses task registration unelevated for ANY trigger set, so the promise was
  doubly false.
  **RECURRED 2026-09-18, one level deeper, and this time it hid for 8 days behind a good-looking
  metric.** The 2026-09-10 fix moved the try to the right statement and added a logon-only retry
  -- but put that retry OUTSIDE any try. It raised the same `Access is denied`, so the script
  still exited having installed NOTHING. Meanwhile AF-20260917-14 read 6 clean days of
  `job_run_history` gaps and credited them to this script "having taken effect". Checked live:
  no scheduled task, empty Startup folder -- the host had simply not rebooted since 09-13, and
  that boot was restarted BY HAND 3.5 minutes later. **Tell, and it generalises well beyond
  installers: before crediting a good outcome to a fix, confirm the fix EXISTS in the running
  system** (`Get-ScheduledTask`, the Startup folder, `pm2 describe` -- not the script's source).
  A metric that improves after a change is a hypothesis about that change, not evidence of it.
  Fixed with a third rung that needs no privilege (per-user Startup-folder `.cmd` ->
  `pm2 resurrect`), and actually run.

- **A dotted-string monkeypatch target silently stops intercepting when the package is
  importable under two module identities — and the test then performs the real side effect
  against production while still looking like an ordinary assertion failure.** This repo is on
  `sys.path` twice (src/server, and the repo root), so `db_compat` and `src.server.db_compat` are
  DIFFERENT module objects with different attributes. When a guard moved from
  `strategy_optimizer` into shared `db_compat`, the existing
  `monkeypatch.setattr('src.server.db_compat.connect', ...)` matched nothing, the real
  `connect()` ran, and the test **opened a live production connection** (AF-20260910-25).
  **Tell:** the failure repr names a REAL object where a sentinel was expected —
  `assert <db_compat.ConnWrapper object at 0x...> is <object object at 0x...>`; the module prefix
  in that repr tells you which identity actually loaded. **Fix:** import the module and patch the
  OBJECT (`monkeypatch.setattr(_db_compat, 'connect', ...)`), which is immune to aliasing. Same
  family as this file's "a test that can reach a side effect WILL perform it against production",
  reached through module aliasing rather than a missing mock.

- **"We could not measure this" is usually "we did not look in the right stream."** `queues.ts`
  carried a comment saying a step's budget was "headroom based on the observed failure rate, not
  a re-measured confirmation" because a standalone script can't pick up the live auth token — yet
  `quantStep`'s own `finally` had been logging `[QUANT EOD] <label> took X.Xmin` all along, to
  **pm2 stdout** (`logs/pm2-out.log`), not the structured app log everyone greps. The numbers
  were there: niftytrader-scores 23.8min / 25.4min against a 45min budget, with the one failure
  having run to exactly 45.0min (it hit the cap; it did not merely exceed a tight one) — so the
  right action was **no change**, not a defensive bump. **Before declaring a runtime
  unmeasurable, grep the process-manager's stdout log as well as the application log**, and
  before raising any budget, check whether the SUCCESSFUL runs have actually moved.

- **A generator fed by an executor that has EVERY task submitted is not bounded by how slowly
  its consumer reads — the pool keeps working while the generator is suspended, and every
  finished result sits in memory unread.** `dl_sequence_loader.load_sequences_bounded` did
  `{pool.submit(f, s) for s in symbols}` then `as_completed(...)`; `train_lstm` read it in
  100-symbol chunks and trained each for minutes, so during every pause the pool loaded the rest
  of the ~2,300-symbol universe. The caller's own docstring said "streaming in chunks to bound
  RAM". Measured: one process at 38-52.7GB of commit on a 23GB host, which exhausted Windows
  commit, killed the WSL2 VM, and took TimescaleDB and Redis down uncleanly 6 times
  (AF-20260911-01). **Tell:** `submit` in a comprehension or loop over the full input, feeding a
  consumer that does slow work per item. Fix: a sliding window — keep at most N futures pending
  (`wait(pending, FIRST_COMPLETED)`), submit the next only as one is yielded. **A unit test with an
  instant loader and an instant consumer passes either way.** Stall the consumer and count how
  far the loader ran ahead (it was 199 of 200).
- **An automatic retry with no limit on the retry-of-a-retry turns a job that crashes the host
  into a crash loop.** The orphan-requeue (AF-20260909-06) relaunched the memory-exhausting DL
  retrain on each boot after it had just killed the VM: 3 make-ups in 7 hours (AF-20260911-02).
  Its "already in flight" guard cannot see this, because the dead make-up is no longer in flight.
  Mark retries (`orphanRequeue: true`) and refuse to retry anything already carrying the mark.
- **A verification that reads a file's HEADER cannot detect a missing TAIL.** `pg_restore --list`
  read a dump truncated at 1.55GB of ~4.3GB and listed 496 tables, because a streamed `-Fc`
  dump writes its TOC first (AF-20260911-03). Verify by reading the whole artifact
  (`pg_restore -f /dev/null`), and prove the check on a real truncated file, not a fresh one.

## Connection budgets

- **A connection-pool `max` sized for the production server is wrong inside a test process, and
  the symptom is a TEST TIMEOUT with zero assertion failures -- which reads as flakiness, not
  exhaustion.** `pgClient.ts` built every pool with `max: 22`, including in test processes.
  vitest runs TWO projects (`unit` + `live`), each a `singleFork` process building its own pool
  from that same function, so the suite alone demanded up to 44 connections on top of a running
  `bharat-server` claiming another 22 -- against `max_connections = 60` with ~37 already in use
  at rest (pm2 stack + TimescaleDB background workers). The file's own budget comment
  (`bharat-server 22 + alphaquant 5 + ml-api 5 + chatbot 3 + Python 10 = 45 / 60`) had never
  counted the test processes at all. Months of "intermittent vitest flakiness" were this.
  **Three tells, and the first two are what make it hard to see:**
  (1) *every* failure is `Test timed out in 5000ms/10000ms` and *no* failure is an assertion --
  a real logic bug produces assertion failures, starvation never does;
  (2) the failing FILES change from run to run while the count stays similar -- which file loses
  the race is random, the mechanism is constant, so chasing the named file finds nothing;
  (3) every one of those files passes in isolation.
  **Do not use peak `pg_stat_activity` count as the discriminator** -- a refused or timed-out
  connection never registers a backend, so peak-in-use reads LOWER during starvation than during
  a healthy run (measured here: 33 while failing vs 45 while passing). Pass/fail and wall-clock
  duration are the honest signals. **Fix at the pool, not the worker count:** capping
  `--maxWorkers` does nothing when the config already uses `singleFork`. Size the pool by role --
  `max: Number(process.env.PG_POOL_MAX ?? (process.env.VITEST ? 5 : 22))` -- and whenever you
  change a service's pool size, re-add up the whole budget against `SHOW max_connections`,
  including tests, or the next process to start is the one that gets refused.


## Everyday memory contention (2026-09-30)

- **`tensor.pin_memory()` on a WHOLE dataset leaks page-locked host memory for the life of the
  process.** PyTorch's caching host allocator keeps every freed pinned block (power-of-two sized)
  and `torch.cuda.empty_cache()` does NOT release it -- only `torch._C._host_emptyCache()` does.
  Measured on this box: pin-then-free 100..500MB -> private bytes 1,620 -> 2,521MB, back to 1,624
  only after `_host_emptyCache`; three differently-sized training folds held **2,424MB** after
  everything was freed. `dl_engine` pinned every 2.4GB chunk and every walk-forward fold, so
  ~2.8h into each retrain the host could not back any CUDA allocation: even `empty_cache()` raised
  `CUDA error: out of memory`, and the OOM retry died at `BiLSTMModel().to(DEVICE)` on a few MB
  (dl-trainer 6/6 failed 09-27..30). **Tell:** a CUDA OOM on a tiny allocation while `nvidia-smi`
  shows the card mostly free, on a WDDM host near its commit limit. Fix: never pin whole datasets
  (per-batch pageable copies were FASTER here, 24.5s vs 34.3s); release with
  `dl_engine.release_cuda_memory()`. Guarded by `test_dl_pinned_host_memory.py`.
- **An admission gate keyed on a hand-maintained weight table goes stale within weeks.**
  `pythonRunner.SCRIPT_PEAK_MB` lacked `live_screener_optimizer` (9.8GB) and
  `live_screener_ml_ranker --train` (8.7GB); both weighed the 600MB default and were never
  serialised. Weights are now learned from every run's measured `peakMemMb` (max of the last 10,
  per script + `--mode`, persisted in `logs/py-script-peaks.json`), with the table as a floor.
  Key by mode, not script: one script can have a 1.4GB scorer and an 8.7GB trainer.
- **"Latest row per symbol" with no time bound over a compressed hypertable decompresses the
  whole history on every call.** `unified_ranker._get_confluence_latest_map` ran `ROW_NUMBER()
  OVER (PARTITION BY symbol ...)` across all of `confluence_signals` (6GB, 8.1M rows, compressed
  after 30d): measured 937s and still running, IO-bound, in the 22:30-00:00 IST window where the
  ranker and screener-performance then timed out. It grew with the table, so every timeout bump
  bought a few weeks. Bound it inside the uncompressed window (`computed_at >= NOW() - 30 days`).
  **Tell:** a job whose runtime rises steadily with no code change -- profile each loader before
  raising its budget.
- **A crawl that aborts on a vendor allowance and restarts in FIXED list order refreshes the
  same head of the list forever.** Trendlyne TA stopped at ~144 of 1,860 daily; ~810 symbols had
  not been touched since mid-July. Order such crawls stalest-first by the table's own
  `last_updated`, so a bounded daily slice converges.
- **A per-15-min model process on CUDA contends with the trainer for the same WDDM card.**
  `finbert_news_sentiment.py` (96 runs/day) is pinned to CPU: same speed warm, ~0.9GB less commit.
- **`pm2 reload`/`restart` of a venv Python service on Windows orphans the real interpreter, and
  the next instance then crash-loops on `[Errno 10048]` (port in use).** pm2 tracks the
  `venv\Scripts\python.exe` redirector; killing it leaves the real interpreter (and its child)
  holding the port, still serving, while pm2 restarts a copy every few seconds (chatbot reached 46
  restarts, engine-worker 74, on 2026-09-30). `pm2 stop` left 4 such processes alive. Deploy
  procedure for these services: `pm2 stop <app>` -> kill every remaining `python.exe` whose
  command line names the script -> `pm2 start <app> --update-env` -> confirm `restart_time` holds
  steady for a minute. **Tell:** `waiting restart` plus a climbing restart count while the port
  still answers 200.
