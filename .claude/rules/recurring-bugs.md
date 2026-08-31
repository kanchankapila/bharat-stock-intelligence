# Recurring Bug Classes

Each of these has bitten this codebase **more than once**. Grep for the signature before you write, and again before you claim a fix is done. Full forensic detail (exact dates, investigation steps, specific numbers) for every entry below: `docs/recurring-bugs-history.md` (split out 2026-08-28 for length — that file is the derivation, this one is what to grep before writing).

**🤖 = enforced by `scripts/check_recurring_bugs.py`** (runs in CI on changed files). Everything unmarked is enforced only by you remembering to read this file — and the recurrence counts below were all recorded *after* the class was documented here, so assume prose alone does not hold. If you fix a class that recurs again, the durable move is a check in that script, not another paragraph here.

Currently automated (9 checks): `date.today()` write-anchor, short calendar-day read cutoff (`check_short_calendar_lookback`), raw `%s` placeholder, missing `live_datasource` test, `x != x` NaN test in SQL, multi-word `::` cast, skip-path-stamped-as-success (`.ts`, `check_skip_not_success`), unqualified `information_schema` query (`check_information_schema_missing_table_schema`), degraded-read `print()` to stdout (`check_degraded_print_to_stdout`). Also automated, in `verify-gate.mjs` rather than `check_recurring_bugs.py`: unmeasured signal/scoring changes require backtest evidence before "done" is accepted. (That class, and every other model/harness class, lives in `.claude/rules/ml-model-bugs.md`.) Deliberately not automated: `float(x or 0)` — measured at 50 matches repo-wide, mostly legitimate `None`→0 on DB aggregates; catching it needs type information the script doesn't have.

## Dates & scheduling

| Signature | Why it breaks | Recurrences |
|---|---|---|
| `date.today()` / `datetime.now()` as an **exact-match write target** (`WHERE date = ?`) | Post-close jobs now finish after midnight IST, so "today" resolves to a day with no grid row → UPDATE matches 0 rows, silently. Use `as_of.logical_trading_date()`. | 11 files |
| 🤖 `date.today()` anchoring a `CASE WHEN date >= x ELSE NULL` guard | On any weekend/holiday the anchor matches nothing and the `ELSE` **nulls the column's entire history**. Anchor to `MAX(date) FROM stock_ohlcv`. | 10 |
| Raw `daysStale()` on a freshness check | Monday morning reads Friday data as 3 days stale. Use `tradingDaysStale()`. | 4 |
| Hand-rolled "step back N weekdays" | Skips no holidays, so `--days 90` covers 87 sessions. Use `as_of.trading_days_back()`. | 2 |
| 🤖 `date.today() - timedelta(days=N)` as a **read** cutoff, N<=4, over a trading-day table | A Fri->Mon gap is 3 calendar days, a long weekend 4 — the window can contain NO trading session, so the read returns `{}` and the caller silently degrades instead of erroring. Distinct from the write-anchor row above (this check does NOT cover read windows). **Worst live instance**: `scoring_engine.py`'s `win_prob_map` going empty on Mondays dropped Factor 3 from mean 17.71/20 to 8/20 uniformly — invisible to rank-based diagnostics. Triage every hit: does the caller degrade/no-op, or is it benign (an age-threshold, a read of the script's own output, a source that genuinely writes weekends)? A genuinely benign site gets a line-level `trading-day-exempt: <reason>` marker, never a file-level allowlist (which would blind the check to future real instances in the same file). Use `as_of.trading_days_back(n, conn)[-1]`. | 12 sites, 9 fixed 2026-08-23, 3 exempt |
| A `cronPattern` mirrored into `jobRegistry.ts` / `monitorScripts.ts` | Drifts from the real registration → phantom "late"/"stale" alerts forever. Guarded by 5 mirror-consistency test suites — keep them passing. | 6 |
| A coverage/completeness **ratio** computed over a window that includes **today** | Same root cause as `daysStale()` above, different shape: if today's rows are written by one job and enriched by a later one, a same-day denominator reads as a false collapse for the whole gap between the two jobs, every weekday. Measure the ratio over the most recently **completed** day (`date = MAX(date) WHERE date < today`), not "last N days" inclusive of today. | 2 |

## NaN & null

| Signature | Why it breaks |
|---|---|
| `float(x or 0)` / `int(x or 0)` on a model-output column | **NaN is truthy** — `nan or 0` is `nan`. Use `math.isfinite`, and **skip** rather than coerce to 0 (coercing fabricates the worst possible score). |
| 🤖 `x != x` to detect NaN in Postgres | Postgres defines `NaN = NaN` as TRUE for total btree ordering. The IEEE self-inequality matches nothing and reports "clean". (Plain Python `x != x` is correct and used on purpose in ~10 fetchers — the checker only flags the SQL form.) |
| A NaN-detection test on SQLite | SQLite coerces NaN to NULL on insert, so the test passes against unfixed code. Use a throwaway Postgres schema. |
| `ORDER BY col DESC` with possible NaN | Postgres sorts NaN **highest** — NaN rows rank #1. Wrap in `NULLIF(col, 'NaN'::float8)`. |
| Fixing NaN at the source | Does **not** clean rows the bug already wrote. `run()` purges only the `computed_at` it is currently writing; poisoned historical rows survive a source fix for weeks. |

## SQL dialect (`db_compat` / `sqlTranslate`)

| Signature | Why it breaks |
|---|---|
| 🤖 Raw `%s` placeholders in a Postgres branch | Bypasses `translate()`, which expects `?`. psycopg2 throws on the literal `%`. |
| 🤖 Multi-word casts (`::double precision`) | `stripPgCasts` only matches single-token type names; leaves a dangling ` precision` on the SQLite path. Use `::float8`. (Checker covers `.py` only.) |
| `STDDEV`, `DISTINCT ON`, `NOW()`, `ANY(ARRAY[])` | Postgres-only. On the SQLite fallback the whole query fails and the caller silently gets `{}` — which can **disable a gate entirely** rather than error. |
| `pd.read_sql(raw_string, conn)` containing a literal `%` | Different execution path from `db_compat`; the `%` is read as a param marker. Wrap in `sqlalchemy.text()`. |
| `CREATE TABLE IF NOT EXISTS` after adding a column | No-ops on an existing table. Needs an explicit `safe_alter`. |
| A column type assumed from `db.ts` | `db.ts` is deleted (`a2a20d2`, 2026-08-16) — schema-of-record is `db/schema.postgres.sql` (`npm run schema:regen`); live Postgres has native `DATE`/`TIMESTAMPTZ` columns your SQLite-heritage intuition will get wrong. Check `information_schema.columns` before trusting a column's type. **Recurred 6 times through 2026-08-26** across TS/Python cross-type comparisons (`date` vs `text`, most recently a wave of 12 sites across 8 engines the day after a TEXT→DATE migration only partially swept its own blast radius). Convention: cast the DATE side to `::text` at the call site, not the TEXT side to `::date` — pytest fixtures declare these columns TEXT, so the `::date` direction is red under tests even though it passes live Postgres. **Diagnostic shortcut:** the PG error string names which side needed the cast — `operator does not exist: X op Y` — read it before guessing. |
| A bulk `unnest($1::text[], ...)` insert with one array-*typed* column alongside scalar-array columns | `unnest()` flattens **every** dimension of a multidimensional array argument — an array-typed column (e.g. `text[]`) does not get treated as "one array value per row" the way scalar-array params do. Pass the array column as `jsonb[]` instead (a scalar type for a 1-D array parameter) and reconstitute inside the `SELECT` with `ARRAY(SELECT jsonb_array_elements_text(col))`. |

## Writes & keys

- **A one-shot script calling `openRun` must seed its own `job_definition` row first** (`ON CONFLICT DO NOTHING`), the same as every sibling script in its directory — `ingestion_run.job_id` FKs to it, so a missing seed throws on the script's first real invocation. Pair with a try/finally around the body (`pool.end()` in the finally) — an uncaught error outside a try/catch propagates to `main().catch()`, which sets `process.exitCode` but never closes the pool, so the process hangs on open connection timers instead of exiting with a clear error.
- **Any table written as "today's full recomputation" needs a purge of rows the run did not produce**, not just an upsert — a row a newly-added gate now excludes keeps its stale row and stays visible to every consumer. (3 recurrences: `unified_recommendations`, `intraday_outcome_resolver`, `stock_event_triggers`.)
- **A backfill loop that gates re-selection on one of several columns it fills** permanently excludes rows that got the first column filled but not the rest. (2 recurrences.)
- **A provider-issued id needs the provider in the PK.** (4 recurrences — see `data-sources.md`.)
- 🤖 **A job whose skip path falls through to the same "completed/success" handler as a real run will erase that day's failures.** Have the skip path return a marker (`{ skipped: true }`) and make the success handler decline it. Same class as `measurement.md`'s "success heartbeat on a step that wrote nothing" warning. **Recurred 6 times**, not once: fixing the first instance and writing the static check (`check_skip_not_success`) immediately found 4 more live in the same file, then a 6th in a completely different shape — a SHARED `.on('completed')` handler (`jobs/registerJob.ts`) the checker structurally can't see because the processor and its handler live in different files. **When you write a static check for a class, note in the check's own comment what file layout makes the class invisible to it** — "the checker is clean" is not "the class is extinct."
- **A lateness/deadline branch anchored on the CURRENT cadence boundary can never fire, for any input** — `now - boundary` is by construction less than `everyMs`, so any `graceMinutes` larger than the cadence puts the deadline permanently in the future. A heartbeat seeded 7 months stale still reported `late=false`. Anchor on the most recent boundary whose grace has **already expired**. Same family as "a monitor that fires on EVERY run carries no information," inverted — one that can never fire carries none either, and is harder to notice because silence reads as health.
- **A "don't queue a duplicate catch-up" guard matching on `data.isCatchup` alone doesn't recognize the job's own currently-active legitimate run** — only another catch-up. A server restart mid-real-run sees nothing catch-up-shaped pending, concludes "missed," and queues a duplicate behind the real one. Match a currently-`active` job of the same name regardless of `isCatchup`, not just the marker field.
- **A fetcher failing most requests despite correct headers, sane rate limiting, and an intact request-count allowance may be blocked on TLS fingerprint (JA3), not content or rate.** Some WAFs fingerprint the TLS ClientHello independently of headers/UA. `tl_fetch.py` is a ready-made `curl_cffi`/Scrapling adapter (real Chrome fingerprint, `requests.Session`-shaped shim) for any fetcher that turns out to need it.
- **`dict.get(key, default)` returns the default only when the key is MISSING, not when it's present with an explicit `null`.** A provider is free to send `null` where it used to send nothing. Use `.get(k) or {}` / `or []`, not `.get(k, {})`.
- **An import-time environment variable set inside a function is set too late.** Some libraries (e.g. `huggingface_hub`) snapshot env vars into module constants at import — a `setdefault` inside a loader function has no effect on an already-imported library. Move the `setdefault` to module top. **The test trap this causes**: asserting `os.environ["X"]` after import passes identically against the broken ordering, because `setdefault` sets the var either way — assert the library's own resolved constant instead (in a clean subprocess), not `os.environ`.
- **A monkeypatched stub whose signature is hand-copied from the real function is a second declaration of the same interface that nothing keeps honest.** Prefer `functools.wraps`/signature-checked fakes, or accept `*args, **kwargs` so a new real kwarg can't break the stub while the call site is fine.
- **A freshness monitor probing a job's OUTPUT TABLE reports a gated job as "stale" every time the gate correctly rejects.** Derive last-run from the LATEST of the output probe, a stored `_ran_at`, and `job_heartbeat.last_success_at` — never the output table alone.
- **A data-quality check that fires on a bare `count > 0` will fail on correct data.** Compare a SHARE of rows against a floor sized to the real defect's magnitude. A check that cries wolf on real data stops being read.
- **A column referenced in SQL that doesn't exist** nulls not just its own output but potentially the WHOLE batched `SELECT` it sits in (Postgres aborts the entire statement on `UndefinedColumn`), and if that's wrapped in a blanket `except: pass`, it does so silently. Check `information_schema.columns` before ordering/partitioning by a column you assume exists, and grep every reader of the table — this recurred 3 times in the same table (`quant_scores`, which has no `date` column).
- 🤖 **`except Exception: pass` around a failed statement does NOT contain the failure on Postgres — it aborts the WHOLE transaction**, and every later statement on that connection dies with `current transaction is aborted`, naming a table that's perfectly fine. SQLite tolerates this (a failed statement is local there), which is why it survives — 5+ separate instances found in one day once someone checked. Fix at the source with `conn.rollback()` inside the `except` (only where the function owns its transaction — a shared helper can discard a caller's pending work). A generic backstop exists (`db_compat.ConnWrapper` rolls back before re-raising, gated on actually querying transaction status rather than inferring from the exception type) but does not restore data an earlier swallowed read should have returned. **Tell:** an error naming a table/column that demonstrably exists, or a "graceful" fallback returning empty instead of falling back — look for an earlier swallowed failure on the same connection.
- **A connection checked out once at the top of a long function and then left idle while a separate connection does 10+ minutes of real work can be closed server-side, and `pool_pre_ping` will not catch it** — pre_ping only validates a connection at POOL CHECKOUT, not while it sits checked-out-but-unused. Recurred twice (`strategy_optimizer.py` 2026-08-25/26, `backtest_optimizer.py` 2026-08-27, both fixed the same way): reconnect (`conn.close(); conn = connect()`) right before the gap's first post-loop use. **Tell:** `psycopg2.OperationalError: server closed the connection unexpectedly` on the FIRST statement after a long CPU-bound loop that used a different connection/handle, plus orphaned scratch rows from the prior crashed run (the crash lands after the loop's own work committed via its own connection, but before this function's own cleanup could run).
- **A function that takes a `conn` argument and then ignores it (opens its own connection/pool instead) silently defeats every caller's isolation** — including schema scoping in tests, which can make a "test" write directly into production. Grep any function whose signature takes `conn`/`con` for `get_engine()`/`connect()`/a module-level pool inside its own body.
- **Restricting a universe upstream re-tunes every absolute threshold downstream.** An engine fix that deflates one score can collapse actionable output under an unchanged floor (612→22 Buys, one incident). **A related, subtler cause: a multiplier whose INPUT is degenerate**, not the multiplier's own calibration — a crowding discount fired on 98.6% of the universe because 5 upstream factor columns were accidentally constant, and a uniform multiplier is invisible to every rank-based diagnostic since it can't change any ranking, only shift the population against absolute thresholds. **Two tells, either enough:** a gate/veto/discount firing on ~100% of its population carries zero information (check prevalence directly, don't assume miscalibration); a final blended score landing BELOW every component that fed it is not a weighted blend (grep for a `*=` applied after the blend). Measure the input's distribution before "fixing" the multiplier's threshold.

## Signals, writes & job runtime

> The 21 ML/model/measurement-harness classes that used to sit here (promotion gates, training
> labels, train/serve skew, sklearn `cv=`, fabricated backtest scripts, drift thresholds, panel
> slicing) moved to **`.claude/rules/ml-model-bugs.md`** on 2026-08-27 — load that when touching
> a model, a gate, or a measurement harness.

- **A UNION half that supplies NULL for the column the consumer keys on is inert, and its row count hides that** — the query returns rows, a `processed` counter grows, the job logs success, but that half's contribution is silently discarded at the accumulate step. **Write a control assertion** that a row from the "included" half actually changes the output — a test that only checks the excluded half stayed out passes identically against a filter that excludes everything.
- **An enum-ish column with two spellings differing only by case silently defeats an `IN`/`NOT IN` list**, and worse, if the column is also part of a composite PK, both spellings survive forever as separate rows that never collide. Recurred in `signal_source` (`technical` vs `TECHNICAL`, two producers) and again worse in `screener_catalog` (3 producers, 3 different casings on the same PK, 67% of rows had a same-name-different-casing duplicate that could disagree on `signal_bias`). Re-run `SELECT name, count(DISTINCT val) ... HAVING count(DISTINCT val) > 1` before trusting any consensus number built by grouping on such a column, not just once after a new producer is added.
- **An upsert keyed on a value DERIVED from a name (a slug), not the provider's own numeric id, silently discards the provider's id whenever the provider reassigns it** — whichever id a batch loop processes last wins the row, with no error. Low severity if content is never actually lost (only the old id value vanishes), but look up by name/derived key rather than trusting a specific historical id still resolves.
- **A ternary branching on `== 'bullish'` (or similar) silently treats every OTHER value — including a legitimate third state like `'neutral'` — as the opposite pole.** Extract a single 3-way polarity mapping (`1 if bullish else (-1 if bearish else 0)`) and share it across every call site that needs the same classification, so the direction and the reasons-bucketing can't disagree with each other.
- **A "generated at" column listed in `ON CONFLICT DO UPDATE SET` stops being a generation time and becomes a last-seen time** on every re-run — and it stays 100% populated, so no NULL/freshness check catches it. Tell: a value later than its own `created_at`. Remove the column from the update list (first write wins). A corrupted provenance column doesn't just shrink your sample when you filter on it — it can hand you a confident, wrong answer from a biased slice.
- **A frontend null-check layered on a column that already defaults to a wrong non-null value (e.g. `0.0` instead of `NULL`) is dead code**, and `tsc`/a green suite/a screenshot cannot tell you that — query the actual column, not the rendered page.
- **A value formatted for ONE display consumer (currency-prefixed, unit-suffixed) can silently become the stored value every OTHER consumer reads as a number.** Check every reader of a column for a numeric cast before assuming a formatting change is presentation-only.
- **A step that only runs at the END of a script that routinely gets killed by its timeout never runs at all** — and the wasted runtime and the missing data are the same bug. A `runPython` step logging "killed by timeout" on a recurring basis means check what comes AFTER the kill point in that script and assume it has never executed. Put a slow producer's dependent parse step in its own queue step so it degrades to "parse what landed," not "parse nothing."
- **A per-call API with no since-parameter turns an upsert into quadratic write amplification**, and the row count hides it (millions of rows written for a handful of genuinely new ones). Read `MAX(date)` per key once and skip what you already hold — the fix is on the write side, not the fetch side.
- **A `dict.get(key) == value` skip-check on a write-amplification guard can't distinguish "never written" from "already stored as NULL"** — both come back `None`. Use `key in known and known[key] == new_value`, not a bare `.get()` comparison, whenever the column can legitimately hold NULL.
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
## Monitoring blind spots

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
## Investigating production without breaking it

- **A client-side timeout does NOT cancel the server-side query — it orphans it**, and on a big table that orphan can hold a lock that blocks the whole platform for hours, which then gets misdiagnosed as a storage-engine cost problem. Diagnose lock contention (`pg_stat_activity`, `wait_event_type = 'Lock'`) before theorizing about decompression/storage cost — a query "hanging" on one specific table while others respond normally is lock contention until proven otherwise. Prevent it with a server-side `SET LOCAL statement_timeout`, not a client-side `timeout` wrapper.

- **Matching a `pg_stat_activity` row to a suspected-orphan bug BY QUERY TEXT ALONE, without checking its `query_start` against wall-clock time, can kill the wrong connection — including the very job you're trying to unblock.** 2026-08-30: a genuinely orphaned `idle in transaction` connection from an earlier killed script (matching the exact bug class above) was found and `pg_terminate_backend()`'d — but a SECOND `pg_stat_activity` snapshot, taken right after relaunching the real job, showed another `idle in transaction` row with the same `INSERT INTO feature_store...` query text and a `duration` that read as suspiciously small (single-digit/negative milliseconds from a JS `now() - query_start` computation). That row was pattern-matched to "another instance of the same orphan bug" and killed too — except a near-zero duration is the opposite signal: it meant the transaction had JUST started, i.e. it was the newly-launched legitimate job's own connection caught mid-batch between commits, not a stale orphan. Killing it crashed the job (`sqlalchemy.exc.PendingRollbackError: Can't reconnect until invalid transaction is rolled back`). No data was lost (the writes were `ON CONFLICT DO UPDATE`, so already-committed rows survived), but the job had to be restarted from scratch. **Tell:** `idle in transaction` alone is not evidence of an orphan — a live batch job legitimately sits `idle in transaction` between statements while accumulating a batch before its next `commit()`. Before terminating any backend PID, cross-check `query_start` against `now()` on the SAME query (not two separate snapshots minutes apart) and prefer `pg_blocking_pids(pid)` / a `wait_event_type = 'Lock'` read on some OTHER session to confirm something is actually blocked ON this connection, not just that this connection's query text looks familiar.
- **A migration's own "files remaining" progress counter cannot count the files it never reaches** — derive coverage counts from the source tree (`grep -rl`), never from the instrument measuring its own coverage.
- **A test that WRITES through one engine (a raw driver) and READS through another (an app-level facade) asserts nothing**, and stays green as long as both happen to land on the same backend. Pick one; if the code under test uses the facade, the fixture must too.
- **Moving a test substrate onto the real dialect is not fixture churn — budget for real production bugs it will surface**, because the old substrate structurally could not fail on them (wrong column names, wrong PK assumptions, methods the driver doesn't support all passed silently under a more forgiving engine).
- **A test parser that reads another file by hardcoded PATH and swallows the read error (`except OSError: continue`) degrades silently**, and the failure surfaces somewhere unrelated with a message that reads like a different bug entirely. Assert the file exists; don't silently continue on a missing input.
- **A schema DDL file that qualifies some statements to a schema but not others (e.g. indexes but not `CREATE TABLE`) creates tables where you point it and then indexes production's copy** when applied anywhere but the default schema. Schema-qualify everything or assert nothing outside the target schema was touched.

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

## Automated bulk-edit passes

- **A script that injects the same lines into hundreds of files will land them in the wrong
  place in a handful, and the wrong place is not distributed evenly -- it clusters on the files
  with an unusual header.** A 2026-08-28 pass inserted `import polars as pl` at absolute line 1
  of ~200 `src/server/*.py`. In 17 files that put it ABOVE the shebang (making `#!` inert), and
  in `event_triggers.py` it pushed `from __future__ import annotations` out of first-statement
  position -- a hard `SyntaxError` that failed pytest at COLLECTION, so **the entire suite ran
  zero tests while the session-log recorded it as "running green."** In one more
  (`investsights_fundamentals_fetcher.py`) the injected class block landed INSIDE the module
  docstring, where it is inert text that no import error ever reports.
  **Tells, in the order they are cheap to check:** (1) `py_compile` every file the pass touched
  -- not a sampled few, and note that `pytest -q`'s summary line does NOT distinguish "collected
  and passed" from "aborted during collection", so read for `Interrupted:`/`ERROR collecting`
  specifically; (2) `head -1` every touched file and confirm nothing precedes a `#!`;
  (3) AST-walk for the injected symbol rather than grepping for it -- a grep matches the copy
  sitting dead inside a docstring, an `ast.ImportFrom` walk does not.
- **An import-time dependency added by a bulk pass must be declared where CI installs from, and
  in this repo that is `backend-python/requirements.txt`, NOT the repo-root `requirements.txt`.**
  The same pass made `polars`/`tenacity` import-time deps of ~200 modules and declared them only
  at the root, so every one of them would `ModuleNotFoundError` on a clean checkout while passing
  locally purely because the dev venv already had both. Sibling of "Declared != installed" below,
  inverted: installed where you are testing, undeclared where it runs.
- **"Onboarded N files" is a count of files EDITED, never of capability delivered -- verify the
  injected construct is actually reachable before recording it as done.** The same pass added a
  `BaseFetcher` subclass to 74 fetchers and a `WorkflowDAG` import to 37 engines; measured
  afterwards, **zero of the 74 classes were instantiated, `@governed_fetcher` decorated zero
  functions, zero DAGs were built, and the injected `to_polars_df` helper had zero call sites
  across all 199 copies.** Nothing behaved differently than before the pass. The check is one
  grep per construct (instantiation, decorator application, call site) -- and it is the
  difference between scaffolding and a feature. Same family as ml-model-bugs.md's
  "evidence-shaped output" class, in bulk-refactor form.

- **A test that locates a value in SOURCE TEXT by character distance from a marker breaks when
  you add a COMMENT — and the failure names the source, not your comment.**
  `jobRegistryGraceMinutesConsistency.test.ts` finds each job's `lockDuration` by scanning
  forward from the first occurrence of its jobName marker, capped at `MAX_LOOKAHEAD = 4000`
  chars. Adding a 3-line explanatory comment INSIDE `addJobWithCatchup(regimeQueue, ...)`'s opts
  object pushed `'regime-intraday'` -> `lockDuration` from 3933 to 4189 and failed two cases with
  "no lockDuration found near marker ... source shape may have changed" (CI 2026-08-31). Nothing
  about the behaviour changed; only the whitespace between two tokens did.
  **Second instance in this file** — `queues.ts` already carries an inline warning about the
  same hazard for the `'ml-daily-ops'` marker, which is what makes this a class and not an
  accident. It was documented, read, and walked into anyway.
  **Two traps when fixing it, both hit here on the first attempt (which made it WORSE, 4646):**
  (1) moving the comment ABOVE the call is the right fix — text before the marker costs zero
  distance — but (2) if your new comment QUOTES the marker string, the comment becomes the
  FIRST occurrence and moves the search origin earlier, which is worse than where you started.
  The test's own docstring warns about a stray reference to the same string; that warning applies
  to comments you add while fixing it. Refer to the marker descriptively, and assert the literal
  still appears exactly the expected number of times.
  **Margins here are thin by nature** (~100 chars after the fix; only 67 on main beforehand), so
  measure rather than eyeball: compute `src.indexOf(marker)` and the nearest `lockDuration` match
  offset directly, and compare against the pre-change baseline from `git show <ref>:<file>` — not
  merely against the cap, or you will land back at the edge without noticing.
  **How it reached CI:** the comment edits were followed by `tsc --noEmit` only. CLAUDE.md
  requires vitest for ANY `.ts` change, and the green vitest run being relied on predated the
  edits. A typecheck cannot see a source-text-parsing test. **Re-run the suite after the LAST
  edit, not after the last edit you considered risky** — this one looked like a pure comment.
## Environment & deploy

- **Declared ≠ installed.** A dependency in `package.json`/`requirements.txt` but not actually installed silently breaks a live job for days.
- **Written ≠ applied.** A migration verified against a throwaway cluster is not applied to production. Confirm `npm run migrate:up` ran against the real `POSTGRES_URL`.
- **Committed ≠ deployed.** `.ts` is not hot-reloaded; `pm2 restart bharat-server` is required. Check `pm_uptime` against the fix commit's timestamp.
- **Registered ≠ running, for a pm2 `cron_restart` job specifically.** `pm2 start` launches it immediately once regardless of schedule; if that first launch fails (dependency not up yet), it settles into `stopped`/`pid 0` and waits for its NEXT cron slot with zero retries — up to 7 days of silent dormancy for a weekly job, indistinguishable in `pm2 list` from healthy idling. Check `pm2 describe <name>` / `pm2 logs` for the actual last failure before concluding "no scheduler exists." After fixing the underlying cause, a `cron_restart` job does not self-heal — `pm2 restart <name>` manually.
- **A standalone script that imports the DB facade without loading `.env` can silently talk to the wrong backend and print convincing wrong numbers.** Print the resolved connection target and assert a row count against a number you already know from a trusted client before believing an ad hoc script's output. (Structurally closed here 2026-08-15 — `usePostgres()`/`use_postgres()` now default to Postgres unconditionally with no env-var override for any real process, so this specific failure mode is history; the general lesson — verify the connection before trusting the result — still applies to any future default-selection logic.)
- **A server that binds its port LAST will restart forever on `EADDRINUSE` without pm2 ever detecting instability**, if the crash happens after `min_uptime` has already elapsed (e.g. after initializing other services first). Attach an explicit error handler to the listener so a bind failure surfaces immediately instead of escalating through generic exception handling with the real cause buried in noise.
- **A manual `UPDATE app_settings` is not a fix** — it reverts on any fresh DB and is invisible to every other environment. Seed it in a migration.
- **Deleting a thing does not delete the checks and instructions that point at it — and an orphaned check does not go quiet, it starts emitting false signals in the opposite direction.** Grep the removed identifier across `.md`, `.claude/commands/`, `.claude/skills/`, and validator/bootstrap code whenever you remove an env var, column, file, or fallback — a stale check can crash a correct process, or a freshness check pointed at a superseded table can warn on every run forever while the table nothing reads sits there as the actual bug. **Tell for the latter:** a freshness check that has NEVER passed is more likely watching an abandoned table than reporting a real outage — grep who actually reads the table before fixing the fetcher.

## Testing

- **A warning printed by a test runner is not a verdict — CI and hooks read the EXIT CODE.** A suite that skips everything it can't reach (e.g. no DB) and still exits 0 is advisory-only to any automation consuming it; flip the exit code non-zero when a test was skipped for a reason that shouldn't be silently tolerated (e.g. an unreachable required dependency).
- **A `live_datasource`-gated test is code that DOES NOT RUN by default, so it rots silently** — the gate must stay (a third-party outage must never redden CI), but treat these files as needing a periodic manual full run, and after any bulk change touching test fixtures, explicitly check which of the gated files it did not execute. A stub that dispatches on its input (not a blanket return) fails loudly on an unexpected call instead of confidently answering with someone else's data.
- **An unqualified `information_schema.columns`/`information_schema.tables` query can silently read a leaked throwaway test schema as a second copy of a real table**, producing duplicate column names that break downstream code with an error naming no table or schema. 🤖 Automated — `check_information_schema_missing_table_schema`. Fix: `AND table_schema = current_schema()`, not a hardcoded `'public'` (which breaks inside test fixtures that deliberately scope into their own schema).
- **Negative-control every new test**: revert the fix, confirm the test fails, restore. Suites here have been 100% green while protecting nothing.
- **A test that reimplements the logic under test** (hand-copies the resolution logic into the test file instead of importing it) passes against the unfixed source, because the mirror never sees the fix or the bug. Call the real function.
- **A test that derives its expectation from the constant it is testing** passes vacuously (`all([])` is `True`).
- **A test that relies on a library's inferred default to manufacture its own precondition** silently stops testing anything when the library changes its default. Construct the condition explicitly.
- **Env vars a shared facade reads are shared state across a test worker process** — a static top-level `import`/env-set in one test file can pollute every other test file sharing that worker, even in a suite that's itself skipped. Guard any real-credential-loading import inside the same conditional that gates the suite, never as a static top-level import.
- **A config env var a library snapshots at IMPORT time is a no-op if set after the import, and the obvious test for it passes against the broken ordering** — `os.environ["X"] == "1"` after import passes whether or not the setting took effect if a `setdefault` was used. Assert the library's own resolved constant (in a clean subprocess), not `os.environ`.
- **A guard test built on a hand-enumerated allowlist only guards what someone remembered to list.** Derive the list from the source tree (scan for the pattern and assert the scan equals the allowlist) so a new instance fails the test instead of silently slipping through.
- **A tokenizer/AST-based check whose logic silently depends on which Python version parses it** (e.g. PEP 701 f-string tokenization changed in 3.12) can pass on a dev venv and fail on CI with neither side erroring. Keep a local venv matching CI's actual interpreter version for testing changes to any such check; write the check's own emptiness self-test (assert it finds what it's meant to guard) so a silent 0-matches failure mode can't hide behind a merely-passing suite.
