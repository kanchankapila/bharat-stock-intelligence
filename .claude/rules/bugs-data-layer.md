---
paths:
  - "src/server/**/*.py"
  - "scripts/**/*.py"
  - "**/*.sql"
  - "migrations/**"
  - "db/**"
  - "src/server/{dbAsync,pgClient,sqlTranslate,stockMapping}.ts"
  - "src/server/routers/**"
  - "src/data/**"
  - "src/server/**/*{Service,service}.ts"
---
# Data-layer bug classes: dates, NaN, SQL dialect, writes & keys, provider ids

Split out of `recurring-bugs.md` (the index) on 2026-09-26 so each area loads only when you touch matching files. Same rules as the index: every class here has recurred; **🤖** = enforced by `scripts/check_recurring_bugs.py`; forensic detail in `docs/recurring-bugs-history.md`.

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

- **A test that computes its fixture from `date.today()` at MODULE IMPORT and asserts on a
  `date.today()`-dependent result at RUN time fails only when the suite crosses midnight.** Found
  2026-09-17 (AF-20260917-25 — filed as -20, renumbered 2026-09-27 because the ranker-timeout row also carried -20): `test_market_regime_fetcher.py` set
  `_FUTURE_EXPIRY = date.today() + timedelta(days=10)` at module level; `_fetch_basis_from_nt()`
  annualizes by `365 / (expiry - date.today()).days` and the test hardcodes the 10-day answer
  (`21.973`). The full suite imported at 22:33 and reached that test at **00:12 the next day**, so
  days-to-expiry was 9, the basis was 24.4144, and the run failed with the source perfectly correct.
  **Profile to recognise: one failure in an otherwise clean run, passes in isolation, and the suite
  ran long enough to span midnight.** That looks exactly like an order-dependent flake, which is how
  this survives — this file's own rule ("a test dismissed as an order-dependent flake can be a real
  defect") applies, and the runtime is the clue, not the ordering. A long suite here runs 25-95 min,
  so any evening start can cross the boundary.
  **Fix shape: pin BOTH sides.** Anchor the fixture to a fixed date and inject that same date into
  the module under test, so import time and assert time cannot disagree. Do **not** "fix" it by
  recomputing the expectation from the same formula the code uses — that passes vacuously against a
  broken formula (see the derived-expectation entry under Testing).
  **And negative-control the real shape:** shifting the pinned date alone moves the fixture and the
  clock together and still passes, which proves nothing. The control has to advance only the
  injected `today()` — that reproduced `assert 24.4144 == 21.973`, the exact observed value.
  **Tell:** grep test files for a module-level (not inside a test function) `date.today()` /
  `datetime.now()` feeding a fixture whose assertion is a hardcoded number.

## NaN & null

| Signature | Why it breaks |
|---|---|
| `float(x or 0)` / `int(x or 0)` on a model-output column | **NaN is truthy** — `nan or 0` is `nan`. Use `math.isfinite`, and **skip** rather than coerce to 0 (coercing fabricates the worst possible score). |
| 🤖 `x != x` to detect NaN in Postgres | Postgres defines `NaN = NaN` as TRUE for total btree ordering. The IEEE self-inequality matches nothing and reports "clean". (Plain Python `x != x` is correct and used on purpose in ~10 fetchers — the checker only flags the SQL form.) |
| A NaN-detection test on SQLite | SQLite coerces NaN to NULL on insert, so the test passes against unfixed code. Use a throwaway Postgres schema. |
| `ORDER BY col DESC` with possible NaN | Postgres sorts NaN **highest** — NaN rows rank #1. Wrap in `NULLIF(col, 'NaN'::float8)`. |
| Fixing NaN at the source | Does **not** clean rows the bug already wrote. `run()` purges only the `computed_at` it is currently writing; poisoned historical rows survive a source fix for weeks. |

- **`pd.DataFrame(rows_of_dicts)` converts Python `None` to `NaN` in any column that also holds
  a real float — so an `if x is None` guard downstream can never fire, and the NaN then reaches
  the database.** Found 2026-09-05 in `analyst_revision.py`: `compute_revisions()` correctly
  emitted `None` for a missing metric, `write_revisions()` correctly checked `is None` before
  writing, and the check was dead code because the value was `NaN` by the time it was read. The
  failure surfaced two layers away as `psycopg2.errors.NumericValueOutOfRange: bigint out of
  range` — because `technical_signals.analyst_count_chg` is `bigint` and Postgres cannot cast NaN
  to an integer type. That error reads like an overflow and sends you hunting for a huge number
  that does not exist.
  **Two things make this class nasty:** (1) it only appears when the column has a MIX of floats
  and Nones — a column of all-`None` stays `object` dtype and keeps its Nones, so a naive test
  fixture passes against unfixed code and proves nothing (this happened here on the first
  attempt, and the suite caught it); (2) the module already had NaN-safe `_float`/`_int` helpers
  and already used them on the INPUT side, so a reviewer greps, sees the helpers, and moves on.
  **Tell:** any `pd.DataFrame(...)` built from dicts that may contain `None`, whose values are
  later tested with `is None` or passed to `executemany`. Coerce at the DB boundary with an
  explicit `math.isfinite` check, and write NULL — never 0.0, which fabricates a real-looking
  reading (see the sentinel-instead-of-NULL entry above).

## SQL dialect (`db_compat` / `sqlTranslate`)

| Signature | Why it breaks |
|---|---|
| 🤖 Raw `%s` placeholders in a Postgres branch | Bypasses `translate()`, which expects `?`. psycopg2 throws on the literal `%`. |
| 🤖 Multi-word casts (`::double precision`) | `stripPgCasts` only matches single-token type names; leaves a dangling ` precision` on the SQLite path. Use `::float8`. (Checker covers `.py` only.) |
| `STDDEV`, `DISTINCT ON`, `NOW()`, `ANY(ARRAY[])` | Postgres-only. On the SQLite fallback the whole query fails and the caller silently gets `{}` — which can **disable a gate entirely** rather than error. |
| `pd.read_sql(raw_string, conn)` containing a literal `%` | Different execution path from `db_compat`; the `%` is read as a param marker. Wrap in `sqlalchemy.text()`. |
| `CREATE TABLE IF NOT EXISTS` after adding a column | No-ops on an existing table. Needs an explicit `safe_alter`. |
| A column type assumed from `db.ts` | `db.ts` is deleted (`a2a20d2`, 2026-08-16) — schema-of-record is `db/schema.postgres.sql` (`npm run schema:regen`); live Postgres has native `DATE`/`TIMESTAMPTZ` columns your SQLite-heritage intuition will get wrong. Check `information_schema.columns` before trusting a column's type. **Recurred 6 times through 2026-08-26** across TS/Python cross-type comparisons (`date` vs `text`, most recently a wave of 12 sites across 8 engines the day after a TEXT→DATE migration only partially swept its own blast radius). Convention: cast the DATE side to `::text` at the call site, not the TEXT side to `::date` — pytest fixtures declare these columns TEXT, so the `::date` direction is red under tests even though it passes live Postgres. **Diagnostic shortcut:** the PG error string names which side needed the cast — `operator does not exist: X op Y` — read it before guessing. **Inverted recurrence, 2026-09-03 (AF-20260831-04): converting a TEXT column to native DATE breaks every EXISTING defensive `::text` cast written for the old type, and the blast radius is bigger than the migration's own row-count estimate.** A 131-column/112-table TEXT→DATE migration found 20+ call sites across 9 `.py` files (`ml_ensemble.py` alone had ~35 occurrences across 4 near-duplicate query blocks) and 4 `.ts` files that had correctly cast one side to `::text` to match the *old* TEXT column — post-migration, that same cast now forces a mismatch against the *new* DATE type (`operator does not exist: date >= text`, mirror image of the original class). One shared helper (`as_of.py`'s `as_of_join_sql()`) had the assumption baked into its own parameter name (`base_date_is_text`) and needed its cast-direction formula inverted, not just its call sites patched. **Tell:** after any TEXT→DATE migration, grep for `<newly-date-column>::text` AND for a bare `col1 = col2` where col2 used to need casting — the safe check is running the FULL test suite (both languages) before declaring the migration's application-code impact "none," not just spot-checking the tables the migration touched. A migration comment claiming "no application code changes" is a hypothesis, not a verified fact, until both suites are green. |
| A bulk `unnest($1::text[], ...)` insert with one array-*typed* column alongside scalar-array columns | `unnest()` flattens **every** dimension of a multidimensional array argument — an array-typed column (e.g. `text[]`) does not get treated as "one array value per row" the way scalar-array params do. Pass the array column as `jsonb[]` instead (a scalar type for a 1-D array parameter) and reconstitute inside the `SELECT` with `ARRAY(SELECT jsonb_array_elements_text(col))`. |

## Writes & keys

- **A one-shot script calling `openRun` must seed its own `job_definition` row first** (`ON CONFLICT DO NOTHING`), the same as every sibling script in its directory — `ingestion_run.job_id` FKs to it, so a missing seed throws on the script's first real invocation. Pair with a try/finally around the body (`pool.end()` in the finally) — an uncaught error outside a try/catch propagates to `main().catch()`, which sets `process.exitCode` but never closes the pool, so the process hangs on open connection timers instead of exiting with a clear error.
- **Any table written as "today's full recomputation" needs a purge of rows the run did not produce**, not just an upsert — a row a newly-added gate now excludes keeps its stale row and stays visible to every consumer. (3 recurrences: `unified_recommendations`, `intraday_outcome_resolver`, `stock_event_triggers`.)
- **A backfill loop that gates re-selection on one of several columns it fills** permanently excludes rows that got the first column filled but not the rest. (2 recurrences.)
- **A provider-issued id needs the provider in the PK.** (4 recurrences — see `data-sources.md`.)
- **A `CASE WHEN date >= floor THEN <new value> ELSE NULL END` write guard, where `floor` is
  `logical_write_floor()` (`MAX(date) FROM stock_ohlcv`, which advances by one trading day every
  run), silently re-nulls EVERY historical row on EVERY run — including rows a PRIOR run had just
  correctly set. Each run's `floor` is later than the last, so `date >= floor` stops matching
  yesterday's row the moment today exists, and `ELSE NULL` then wipes it. Net effect: no matter
  how often (even daily) the job runs, only the single most-recent date ever stays populated —
  looks exactly like "the column has no signal" to anything reading the table, including a
  cross-sectional feature-coverage check. Found 2026-09-01 (data/model audit) in
  `index_membership_fetcher.py` (`is_nifty50`/`is_nifty100`/`is_nifty200`/`is_midcap150`/
  `is_smallcap250`/`nifty_tier`): `job_run_history` showed `'success'` every weekday for two
  weeks straight, yet `technical_signals` held real values on only the single most-recent date at
  any moment — every earlier date read `NULL` despite its own "successful" run. Grepping the
  exact template (`date >= ? THEN COALESCE(?, col) ELSE NULL END`) found the **identical**
  mistake, evidently copied fetcher-to-fetcher, in 8 more files (77 more columns):
  `mc_chart_patterns_fetcher.py`, `mc_pricefeed_fetcher.py`, `nt_dashboard_fetcher.py`,
  `trendlyne_adv_tech_fetcher.py`, `trendlyne_fundamentals_fetcher.py`,
  `trendlyne_overview_fetcher.py`, `trendlyne_price_analysis_fetcher.py`,
  `working_capital_fetcher.py`. Fixed uniformly: `ELSE NULL END` → `ELSE <col> END` (preserve the
  row's own current value instead of nulling it), so each run becomes additive — bless today,
  leave every other already-blessed day alone — matching what "run it daily" was already assumed
  to achieve (a prior fix, AF-20260828-21, moved `index-membership` to a daily schedule
  specifically to close this gap, and never noticed the `ELSE NULL` branch defeated it).
  **Not every `date >= floor` guard is this bug** — `financial_ratios_fetcher.py` and
  `working_capital_fetcher.py`'s OWN primary floor (`as_of_floor()`, keyed on a fiscal-year-end
  disclosure date) barely advances, so `ELSE NULL` there rarely fires in the erosion-causing
  direction; `mf_holdings_fetcher.py`/`mf_stock_holdings_fetcher.py` are the same shape. Preserving
  instead of nulling is still strictly safer for these (never worse, closes a rarer fallback-path
  version of the same bug), so they were fixed too where touched, but the acute, guaranteed-daily
  version of this class needs `logical_write_floor()` as the PRIMARY (not fallback) floor input —
  check which one a file uses before assuming urgency. **Tell:** cross-check `job_run_history`
  showing repeated `'success'` against the actual per-date fill-rate of the column it's supposed
  to write (`GROUP BY date`) — a job that "succeeds" daily but only ever shows ONE populated date
  in the table it writes is this bug, not a scheduling gap. A mocked-cursor unit test cannot catch
  it (only checks SQL text, not row-level effect across two runs) — needs a real UPDATE evaluated
  against real rows across two sequential floor values (`pg_memory_conn()`, not `_FakeConn`).
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
- **`except Exception: pass` around a failed statement does NOT contain the failure on Postgres — it aborts the WHOLE transaction** (**CORRECTED 2026-09-25: this bullet carried a 🤖 marker but NO automated check exists for it — `check_recurring_bugs.py` has none, and the "Currently automated (9 checks)" list above never included it. And the `conn.rollback()` fix below is only needed for connections that do NOT go through `db_compat`: every `ConnWrapper`/`CursorWrapper.execute` already runs inside `_usable_after_failure()`, which rolls back an ABORTED transaction (asked of the driver via `transaction_status`, not inferred from the exception) and then re-raises. So "silent handler + DB call + no explicit rollback" is NOT the bug signature for `db_compat` callers — a check built on it would be a false-positive machine. The residual defect is a different one: the failed read is swallowed with no log, so the row/symbol/chunk silently drops out and the job reports success (AF-20260901: 136 silent prefetch syntax errors in `outcome_resolver.py`; AF-20260925-02). Measured 2026-09-25 by AST over non-test `src/server/*.py`: 619 broad handlers, 112 silent (`pass`/`continue`), 29 of those silent AND wrapping a DB call, in 12 files — 4 fixed 2026-09-25 (`outcome_resolver.py`), 25 open (2 of those, in `cs_ranker.py`/`online_learner.py`, are moot: both were unscheduled 2026-08-31, `9ceb4e72`; and the 6 swallowed queries checked in `ml_ensemble.py`/`cs_ranker.py`/`exit_policy.py`/`online_learner.py` all run cleanly on live Postgres — test the swallowed SQL through `db_compat` before assuming a handler hides a failure). **Method that found real bugs (AF-20260925-05): wrap the connection in a proxy whose `execute` records the exception then re-raises, call every public function against live Postgres, and list the recorded failures — 3 chatbot tools in `market_tool.py` were broken (`column "total_news" does not exist`, `column "stock_count" does not exist`, `model_registry.auc`/`accuracy` are really `cv_roc_auc`/`cv_accuracy`) while `tests/chatbot/` passed, because no test asserts a non-empty result against the real schema. Use `pg_stat_activity` with `query_start - backend_start` to tell your own fresh connection from a pooled service one before ever cancelling anything.** Grep-window context misleads here: a `try` whose body is only `json.loads` can sit right under a DB call in the enclosing loop; check `Try.body`, not the neighbouring lines.**), and every later statement on that connection dies with `current transaction is aborted`, naming a table that's perfectly fine. SQLite tolerates this (a failed statement is local there), which is why it survives — 5+ separate instances found in one day once someone checked. Fix at the source with `conn.rollback()` inside the `except` (only where the function owns its transaction — a shared helper can discard a caller's pending work). A generic backstop exists (`db_compat.ConnWrapper` rolls back before re-raising, gated on actually querying transaction status rather than inferring from the exception type) but does not restore data an earlier swallowed read should have returned. **Tell:** an error naming a table/column that demonstrably exists, or a "graceful" fallback returning empty instead of falling back — look for an earlier swallowed failure on the same connection.
- **A connection checked out once at the top of a long function and then left idle while a separate connection does 10+ minutes of real work can be closed server-side, and `pool_pre_ping` will not catch it** — pre_ping only validates a connection at POOL CHECKOUT, not while it sits checked-out-but-unused. Recurred twice (`strategy_optimizer.py` 2026-08-25/26, `backtest_optimizer.py` 2026-08-27, both fixed the same way): reconnect (`conn.close(); conn = connect()`) right before the gap's first post-loop use. **Tell:** `psycopg2.OperationalError: server closed the connection unexpectedly` on the FIRST statement after a long CPU-bound loop that used a different connection/handle, plus orphaned scratch rows from the prior crashed run (the crash lands after the loop's own work committed via its own connection, but before this function's own cleanup could run).
- **Recurrence of the entry directly below, 2026-09-17 (AF-20260917-19), and this one cost a
  subsystem: `db_compat.safe_alter(conn_or_none, ddl)` documented its first argument as "accepted
  for API compatibility, **ignored**" and always did `with get_engine().begin()`.** Three call
  sites pass a real connection precisely because they are altering a table they just created in
  the SAME still-open transaction. The private connection cannot see an uncommitted table, so the
  `ADD COLUMN`s failed with `relation does not exist`, the `except` swallowed them into a
  `print()`, and the caller committed a table missing three of its columns. `ml-daily-ops` then
  failed nightly on `column "direction" does not exist`.
  **What makes this the instructive one: that exact symptom had already been "fixed" on
  2026-09-04** — the double `ADD COLUMN IF NOT EXISTS IF NOT EXISTS` regex bug, in this same
  helper, with a careful comment naming `high_flyer_retrospective.py` as the discovering case.
  That fix was correct and it was not the whole bug. **When a symptom returns to a function you
  already fixed, the prior fix being right is not evidence that the cause is the same.** Fixed by
  honouring the argument when supplied (a psycopg2 cursor and a `ConnWrapper` both take a plain
  string; a raw SQLAlchemy `Connection` needs `text()`), which covers all three at-risk sites in
  one diff and leaves the 11 `None` callers untouched.

- **A stale `CREATE TABLE IF NOT EXISTS` body in application code silently UNDOES a migration the
  moment the table is recreated — and `pgmigrations` keeps saying the migration ran.** Same
  incident. `high_flyer_retrospective.py` still declared `date TEXT`; migrations `20260903150000`
  and `20260903150002` had converted both tables to native `DATE`. Because `CREATE TABLE IF NOT
  EXISTS` no-ops on an existing table, that stale body was invisible for as long as the table
  survived — and the instant the table was dropped and the script recreated it, the column came
  back TEXT with the migration ledger still recording the conversion as applied. **Tell:** any
  table whose DDL exists in BOTH a migration and an in-code `CREATE TABLE IF NOT EXISTS` — diff
  them, because only one of the two is ever exercised on a given run. This is the mirror image of
  measurement.md's "a migration's ledger row proves execution of *a* statement, not necessarily
  the one you meant": here the ledger row is honest about the past and wrong about the present.
  Verify a column's type through `information_schema`, never through `pgmigrations`.
  **RECURRED the next day (AF-20260918-05) and is now guarded:** `delivery_trend_fetcher.
  ensure_schema()` still declared `bulk_block_deals` without the `source` column and PK that
  migration `20260912120000` added -- a no-op against production, but a table its own upsert
  cannot write to on any fresh database. Found only because a live store test ran instead of
  skipping. Guarded by `src/server/tests/test_inline_ddl_pk_matches_schema.py`, which compares
  every in-code DDL's PRIMARY KEY to `db/schema.postgres.sql`. **Deliberately the PK, not the
  column list:** a full-column scan was measured first and flagged 42 blocks, mostly legitimate
  (`safe_alter` adding columns after the CREATE) -- an always-fires guard. The PK is what every
  `ON CONFLICT` target depends on; that scan flags the real defect and nothing else.

- **A function that takes a `conn` argument and then ignores it (opens its own connection/pool instead) silently defeats every caller's isolation** — including schema scoping in tests, which can make a "test" write directly into production. Grep any function whose signature takes `conn`/`con` for `get_engine()`/`connect()`/a module-level pool inside its own body.
- **Restricting a universe upstream re-tunes every absolute threshold downstream.** An engine fix that deflates one score can collapse actionable output under an unchanged floor (612→22 Buys, one incident). **A related, subtler cause: a multiplier whose INPUT is degenerate**, not the multiplier's own calibration — a crowding discount fired on 98.6% of the universe because 5 upstream factor columns were accidentally constant, and a uniform multiplier is invisible to every rank-based diagnostic since it can't change any ranking, only shift the population against absolute thresholds. **Two tells, either enough:** a gate/veto/discount firing on ~100% of its population carries zero information (check prevalence directly, don't assume miscalibration); a final blended score landing BELOW every component that fed it is not a weighted blend (grep for a `*=` applied after the blend). Measure the input's distribution before "fixing" the multiplier's threshold.

## Provider identifiers, reverse maps and "the vendor is dead" (2026-09-12 pm2 warn/error sweep)

- **A wrapper around a vendor SDK does not inherit this repo's identifier discipline — check
  what identifier the wrapped library actually needs.** `finstack_cashflow_fetcher.py` called an
  MCP tool with the bare NSE symbol; finstack wraps `yfinance`, whose id for an NSE listing is
  `<symbol>.NS`. A bare Indian ticker does not merely miss on Yahoo — **it resolves to whichever
  US-listed company owns that ticker**. Measured 2026-09-12: `IEX` -> IDEX Corporation,
  `HAL` -> Halliburton, `CUB` -> Lionheart Holdings. 13 of 17 stored symbols held a foreign
  company's cash-flow statements, and ~2,000 others 404'd (AF-20260912-01). **Tell, and it was
  visible in the table for 11 days: a `currency` column reading USD for names that report in
  INR.** Whenever a fetcher goes through a wrapper/MCP server/SDK rather than a URL you can
  read, print the exact argument it sends and check it against `data-sources.md`'s provider-ID
  table. Also: **a docstring calling something "source honesty" is not evidence** — this one
  recorded `INFY returns 4 quarters (reported in USD)` as a documented quirk when it was the
  NYSE ADR.

- **RECURRED 2026-09-18 (AF-20260918-02), from the DATABASE side rather than `stocklist.json`,
  and this time on a Nifty 50 name.** Two live fetchers -- `eps_surprise_fetcher.py` and
  `mc_techscanner_fetcher.py` -- built `{row["mcsymbol"]: row["symbol"] for row in rows}` over
  `nse_stocks`. Measured: **2,340 rows carry an mcsymbol, only 2,274 codes are distinct, 62 codes
  map to more than one symbol** -- `KMF -> {KOTAK, KOTAKBANK, MAHINDRA}`,
  `TEL -> {TATAMOTORS, TMPV, TOUCHWOOD}`, `AI -> {AARTIIND, ARCHIDPLY}`. So MoneyControl's bulk
  earnings for Kotak Mahindra Bank could be written against Mahindra, silently.
  **The entry below was already in this file and the bug was still written twice**, which is the
  argument for fixing it somewhere a future caller cannot miss: it now lives in shared
  `src/server/mc_symbol_map.py` (`build_mc_to_symbol`, keeps singletons, drops and REPORTS
  ambiguous codes), not as a paragraph. Same reasoning as `db_compat.reconnect()` -- a guard
  re-typed per call site is a guard that will be missing from the next call site.
  **Tell, cheapest first:** `SELECT count(*), count(DISTINCT <code>) FROM <table>` -- if those two
  numbers differ, every dict comprehension over that column is lossy. Guarded by
  `test_mc_symbol_map.py`'s source-derived scan for `["mcsymbol"]:`.

- **A reverse map built from a provider-id column is ambiguous unless you prove the column is
  unique, and a dict comprehension silently resolves the ambiguity by file position.**
  `mcsymbol` in `stocklist.json` looks like a unique MoneyControl code and is not: **39 of 1,940
  codes map to more than one NSE symbol** — `API` -> {ASIANPAINT, AGROPHOS}, `LC03` -> {LUPIN,
  LAXMICOT}, `CI29` -> {COALINDIA, COMPINFO}, `TEL` -> {TMPV, TOUCHWOOD}. `{e['mcsymbol']:
  e['symbol'] for e in entries}` keeps whichever entry came LAST, so a real institutional deal in
  Asian Paints would be booked against Agrophos with no error anywhere. **Build the map as
  `code -> set(symbols)` and keep only the singletons**, dropping ambiguous codes the way the
  ISIN issuer-prefix resolver does (`ml-model-bugs.md`) — never guessing is the rule, and
  "whichever one the file listed last" is a guess. **Tell:** any `{x[k]: x[v] for x in ...}` over
  a provider-id field; assert `len(by_code) == len(map)` or print the difference.

- **A retired symbol left in the universe master reads as "this stock has no data" rather than
  "we are asking for the wrong ticker".** `TATAMOTORS` had **zero `stock_ohlcv` rows ever** while
  `TMPV` — the renamed PV entity that kept ISIN `INE155A01022` — had 1,417. `nseStocks.ts`
  already knew TMPV and 101 tables already held TMPV rows; only the provider-mapping master was
  stale (AF-20260912-10). **RENAME the entry, never delete it** — deleting drops the row's 7
  provider mappings with it. And **verify each provider id individually rather than assuming
  they all moved**: here MoneyControl `sc_id`, Trendlyne `tlid`, Tickertape `sid` and MarketsMojo
  `stockid` all carried over unchanged and only `tlname` changed. **Tell:** a symbol in
  `stocklist.json` with zero rows in `stock_ohlcv`; cross-check against `nseStocks.ts` and
  against the ISIN before believing the stock is untraded.

- **Adding a token to a request can LOWER your access, so isolate headers one at a time before
  concluding a route needs auth.** `fetch_niftytrader()` opened with `if not bearer: return []`
  on the strength of an in-code comment asserting the route "401s unconditionally now, even with
  a valid token". Measured route-by-route: **`sec-fetch-*` + token -> 200; `sec-fetch-*` with NO
  token -> 200 (identical bytes); token WITHOUT `sec-fetch-*` -> 403; neither -> 403.** The
  `sec-fetch-site/mode/dest` trio was the discriminator and the token was irrelevant, so the
  guard converted any future token lapse into silent zero rows from a fully-open endpoint
  (AF-20260912-09). This is `data-sources.md`'s "determine the MINIMUM the new call needs",
  applied to a route already believed understood — **re-derive it rather than trusting the
  comment, including a comment written by a previous careful session.**

- **Before asking the user for a vendor capture, query the 3,000+ endpoint discovery registry
  and check repo alternates — the answer is often already cataloged or integrated.** Prompted by
  the user on 2026-09-12 and codified 2026-09-13: a sweep resolved two of three "dead vendor" gaps
  with no ask at all: NSE bulk-deals was covered by MoneyControl `deals/list` (200, carries `deal_type: bulk`)
  **and NSE's own `/api/block-deal` still returned 200 — only the bulk route retired**; movers were covered by
  `frapi.marketsmojo.com/market_Gainersloser/getData` (200, already wired as `MOJO_MOVERS_URL`)
  plus MC `price-shockers` and NT's EOD screener. Only ET was genuinely unreachable
  (host-wide 503 `DNS failure`, unchanged under chrome/chrome124/safari17_0 impersonation, so not
  a fingerprint block; **re-probed 2026-09-13: `screener.indiatimes.com` screener POST is back —
  200, 167 records** — so recheck before treating ET as down).
  **Mandatory Sequence whenever an endpoint fails or a new source is needed:**
  1. Query `market_endpoint_registry` in PostgreSQL (`bharat_intel` on `:5433`, 3,408 live working endpoints; views `v_working_market_endpoints`, `v_stock_screeners`, `v_fno_endpoints`).
  2. Check `url_endpoints` (830 templates) via `python -m url_explorer.ingest --find-alternates "<targets>" --exclude <failing-host>`.
  3. Inspect `unique_urls.txt` (3,103 raw URLs) and `DATA_FETCHING_GUIDE.md` for proven headers/payloads.
  4. Grep the repo for sibling endpoints and probe each route by route.
  5. **THEN ask**, with the per-route breakdown. Asking first is cheap, but reporting "vendors are dead" when active endpoints exist in the 3,000+ registry or in-tree is a documented failure mode.

- **Declaring a source dead or building web scrapers from scratch without checking the 3,000+ discovery registry.**
  **Tell:** Concluding an API is permanently dead or attempting external browser scraping when an active alternative or updated route already exists in `market_endpoint_registry` (3,408 live endpoints) or `unique_urls.txt` (3,103 URLs).
  **Fix:** Always run a discovery registry query (`SELECT provider, target_url, use_case FROM market_endpoint_registry WHERE ...`) or `--find-alternates` before proposing new scrapers or declaring data unobtainable.

- **A vendor payload can be byte-identical for two different query params — check before relying
  on the split.** MarketsMojo's movers endpoint returned the same 181,942 bytes for
  `type=gainer` and `type=loser`, both keyed `"losers"`. The param looks ignored and the body
  appears to carry both sides.

## Write amplification & memory on the hot paths (2026-09-11 performance sweep)

- **`CASE WHEN date >= floor THEN new ELSE col END ... WHERE symbol = ?` rewrites the symbol's
  WHOLE history to change one row.** For every older row the SET is `col = col`, but Postgres
  still writes a new tuple. Measured on `mc_pricefeed_fetcher`'s statement over the live
  universe: 115,629 tuples / 216MB WAL per run unbounded vs 2,535 / 6MB with `AND date >= floor`
  in the WHERE — identical data, and nine fetchers had this shape (~2GB WAL/night on a 362MB
  table). Bound the WHERE with the SAME floor (the lower one if a statement uses two). An
  `ELSE NULL` statement is NOT this class — bounding it changes what it writes. 🤖-adjacent:
  `src/server/tests/test_case_update_date_bounded.py` scans every such statement.
- **An `ELSE col` recompute over all history writes rows whose value didn't change.**
  `ml_calibration.py` re-fit and rewrote all 115,284 scored rows nightly; only 31.6% changed.
  Compare against the stored value and send the changes (`xmin` is the test observable: any
  UPDATE, even to an identical value, gives the row a new one).
- **One network round trip per row is the default for `executemany` through db_compat** —
  SQLAlchemy's psycopg2 dialect falls through to `cursor.executemany` for `text()`. Batched
  (`db_compat.executemany_batched`) a 14k-row upsert went 10.9s → 1.7s. It is opt-in, NOT an
  engine-wide `executemany_mode='values_plus_batch'`, because batching makes `rowcount` report only
  the LAST statement (1 instead of 14,000) and `analyst_revision.py`'s `n == 0` "matched nothing"
  guard reads it. Use the helper only where the caller ignores the count.
- **`conn.execute(...).fetchall()` on a multi-million-row read builds a dict-subclass `Row` per
  row.** 2.7M `stock_ohlcv` rows: 2,280MB peak Python heap vs 380MB streamed as tuples via
  `db_compat.iter_rows`. When you add streaming, set `stream_results` on the STATEMENT:
  `Connection.execution_options()` mutates a SQLAlchemy 2.0 connection in place, turning every
  later statement into a server-side cursor (`DECLARE ... CURSOR FOR INSERT` → syntax error).
- **A memo cache keyed on generated SQL is a leak.** `translateSql`'s cache assumed static
  call-site SQL, but `bulkUpsert` builds a new string per chunk row count: ~2.7MB retained per
  30-column entry, never evicted. Size-capped and entry-capped since; the same audit applies to
  any cache keyed on a string that embeds a variable-length list.
- **`date::text >= date('now', ...)` on a native DATE column defeats the index and, on a
  hypertable, chunk exclusion.** `stock_ohlcv`'s freshness check: 1,220ms / 42 chunks scanned vs
  207ms / 40 excluded, every 15 minutes. Compare DATE to DATE (`col >= current_date - N`) after
  verifying the column type. 🤖-adjacent for dataQualityChecks.ts via
  `dataQualityChecksSargable.test.ts`.
- **Two `registerRepeatableJob()` calls on one queue delete each other's schedule on every boot**
  — it clears EVERY repeatable on its queue before adding its own. The nightly job digest had not
  fired on its cron since a morning digest was added to its queue (2026-09-02); it only ran as a
  boot-time catch-up. 🤖-adjacent: `repeatableQueuesUnique.test.ts`.

