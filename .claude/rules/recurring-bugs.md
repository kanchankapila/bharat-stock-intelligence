# Recurring Bug Classes

Each of these has bitten this codebase **more than once**. Grep for the signature before you write, and again before you claim a fix is done.

**🤖 = enforced by `scripts/check_recurring_bugs.py`** (runs in CI on changed files). Everything unmarked is enforced only by you remembering to read this file — and the recurrence counts below were all recorded *after* the class was documented here, so assume prose alone does not hold. If you fix a class that recurs again, the durable move is a check in that script, not another paragraph here.

Currently automated: `date.today()` write-anchor, raw `%s` placeholder, missing `live_datasource` test, `x != x` NaN test in SQL, multi-word `::` cast. Deliberately not automated: `float(x or 0)` — measured at 50 matches repo-wide, mostly legitimate `None`→0 on DB aggregates; catching it needs type information the script doesn't have.

## Dates & scheduling

| Signature | Why it breaks | Recurrences |
|---|---|---|
| `date.today()` / `datetime.now()` as an **exact-match write target** (`WHERE date = ?`) | Post-close jobs now finish after midnight IST, so "today" resolves to a day with no grid row → UPDATE matches 0 rows, silently. Use `as_of.logical_trading_date()`. | 11 files |
| 🤖 `date.today()` anchoring a `CASE WHEN date >= x ELSE NULL` guard | On any weekend/holiday the anchor matches nothing and the `ELSE` **nulls the column's entire history**. Anchor to `MAX(date) FROM stock_ohlcv`. | 10 |
| Raw `daysStale()` on a freshness check | Monday morning reads Friday data as 3 days stale. Use `tradingDaysStale()`. | 4 |
| Hand-rolled "step back N weekdays" | Skips no holidays, so `--days 90` covers 87 sessions. Use `as_of.trading_days_back()`. | 2 |
| A `cronPattern` mirrored into `jobRegistry.ts` / `monitorScripts.ts` | Drifts from the real registration → phantom "late"/"stale" alerts forever. Guarded now by 5 mirror-consistency test suites — keep them passing. | 6 |
| A coverage/completeness **ratio** (not just a staleness gap) computed over a window that includes **today** | Same root cause as `daysStale()` above, different shape: if today's rows are written by one job (e.g. a morning scan) and enriched by a later one (e.g. an evening ML-scoring pass), a same-day denominator reads as a false collapse for the whole gap between the two — every weekday, not just Mondays. `technical-signals-freshness-coverage`'s win_probability ratio had exactly this bug even after its *staleness* half was already fixed for the Monday case (2026-08-10) — fixed 2026-08-11 by measuring the ratio over the most recently **completed** day (`date = MAX(date) WHERE date < today`), not "last N days" inclusive of today. | 2 |

## NaN & null

| Signature | Why it breaks |
|---|---|
| `float(x or 0)` / `int(x or 0)` on a model-output column | **NaN is truthy** — `nan or 0` is `nan`. Use `math.isfinite`, and **skip** rather than coerce to 0 (coercing fabricates the worst possible score). |
| 🤖 `x != x` to detect NaN in Postgres | Postgres defines `NaN = NaN` as TRUE for total btree ordering. The IEEE self-inequality matches nothing and reports "clean". (In plain Python `x != x` is correct and is used on purpose in ~10 fetchers — the checker only flags the SQL form.) |
| A NaN-detection test on SQLite | SQLite coerces NaN to NULL on insert, so the test passes against unfixed code. Use a throwaway Postgres schema. |
| `ORDER BY col DESC` with possible NaN | Postgres sorts NaN **highest** — NaN rows rank #1. Wrap in `NULLIF(col, 'NaN'::float8)`. |
| Fixing NaN at the source | Does **not** clean rows the bug already wrote. `run()` purges only the `computed_at` it is currently writing; 13,505 poisoned rows survived a source fix for weeks. |

## SQL dialect (`db_compat` / `sqlTranslate`)

| Signature | Why it breaks |
|---|---|
| 🤖 Raw `%s` placeholders in a Postgres branch | Bypasses `translate()`, which expects `?`. psycopg2 throws on the literal `%`. | 
| 🤖 Multi-word casts (`::double precision`) | `stripPgCasts` only matches single-token type names; leaves a dangling ` precision` on the SQLite path. Use `::float8`. (Checker covers `.py` only — `sqlTranslate` itself is `.ts` and is not scanned.) |
| `STDDEV`, `DISTINCT ON`, `NOW()`, `ANY(ARRAY[])` | Postgres-only. On the SQLite fallback the whole query fails and the caller silently gets `{}` — which can **disable a gate entirely** rather than error. |
| `pd.read_sql(raw_string, conn)` containing a literal `%` | Different execution path from `db_compat`; the `%` is read as a param marker. Wrap in `sqlalchemy.text()`. |
| `CREATE TABLE IF NOT EXISTS` after adding a column | No-ops on an existing table. Needs an explicit `safe_alter`. |
| A column type assumed from `db.ts` | `db.ts` is the SQLite schema-of-record; live Postgres has native `DATE`/`TIMESTAMPTZ` columns. Check `information_schema.columns`. |

## Writes & keys

- **Any table written as "today's full recomputation" needs a purge of rows the run did not produce**, not just an upsert. A row that a newly-added gate now excludes keeps its stale row and stays visible to every consumer. (3 recurrences: `unified_recommendations`, `intraday_outcome_resolver`, `stock_event_triggers`.)
- **A backfill loop that gates re-selection on one of several columns it fills** permanently excludes rows that got the first column filled but not the rest. (2 recurrences.)
- **A provider-issued id needs the provider in the PK.** (4 recurrences — see `data-sources.md`.)
- **A job whose skip path falls through to the same "completed/success" handler as a real run will erase that day's failures.** The `technical-signals` worker returned early outside market hours; the post-close runs then stamped `success` over 13 genuine failures earlier the same day, every day, for two sessions. Have the skip path return a marker (`{ skipped: true }`) and make the success handler decline it. Same class as the "success heartbeat on a step that wrote nothing" warning in `measurement.md`.
- **A freshness monitor that probes a job's OUTPUT TABLE reports a gated job as "stale" every time the gate correctly rejects.** `strategy-optimizer` writes to `screener_weight_history` only when the optimised weights beat baseline on held-out data, so two consecutive correct rejections (2026-08-09, 2026-08-10) got reported as "stale since Aug 03" while the job ran clean weekly. Derive last-run from the LATEST of the output probe, the stored `_ran_at`, and `job_heartbeat.last_success_at` -- never the output table alone. Applies to any promotion-gated script.
- **A data-quality check that fires on a bare count > 0 will fail on correct data.** `stock_delivery_data.trades = delivery_qty` is legitimately true for an illiquid name (ASTAR: 4 shares in 4 trades, 100% delivery). Compare a SHARE of rows against a floor sized to the real defect (that one was 100% of 664,006 rows, so a 5% floor has enormous margin). A check that cries wolf on real data stops being read -- same argument as the ungated live-network test in `data-sources.md`.

- **A column referenced in SQL is not a column that exists.** `quant_scores` is `PRIMARY KEY (symbol)`, one row per symbol, and has no `date` column -- but two queries added in one sweep wrapped it in `ORDER BY date DESC` (a latest-per-symbol window that was never needed). One aborted the entire technical scan for two days; the other sat behind `.catch(() => null)` writing NULLs in silence. Check `information_schema.columns` before ordering/partitioning by a date column, and grep **every** reader of the table -- this arrived twice in the same commit.

- **Restricting a universe upstream** re-tunes every absolute threshold downstream. An engine fix that deflates one score collapsed actionable Buys 612 → 22 under an unchanged floor.

## Models & measurement

- **A metric-based promotion gate cannot catch weight divergence or output saturation.** All-NaN weights make validation *raise*, which a handler swallows; a 70%-saturated model still scores AUC 0.66. Gate on the artifact, not only its score.
- **AUC can be excellent and useless.** `flyer_classifier` holds AUC 0.81 with IC −0.041 (t=−9.02) — it measures *who* flies, not *when*.
- **Grouping training rows by day when scoring reads one snapshot** is train/serve skew. Found in 3 files; `test_auc` 0.641 → 0.486 once honest.
- **A flat cost-per-rebalance systematically reorders factors by turnover** and can invert the ranking. Two conclusions sign-flipped.
- **A champion/challenger gate is meaningless if run-to-run seed noise is wider than the champion/challenger gap.** `regime_detector.train_hmm` fit one EM seed (`random_state=42`) and compared it to the incumbent on held-out likelihood. Measured 2026-08-11, the same retrain across 6 seeds scored 9.95 / 10.12 / 9.98 / 11.17 / 10.87 / 10.75 against an incumbent at 11.02 -- the spread straddles the champion, so the verdict was seed luck, not model quality. Use multiple restarts and pick the best by the **training** objective; picking by the holdout is selecting on the gate's own metric and turns its out-of-sample test in-sample. Before trusting any promotion decision, check the metric's run-to-run spread against the gap it is judging.
- **An `InconsistentVersionWarning` on an unpickled estimator is not itself evidence of corruption -- verify before retraining on account of it.** The regime HMM's `StandardScaler` warned 1.9.0-under-1.8.0 for weeks; its `mean_`/`scale_`/`var_`/`n_samples_seen_` were all intact and `transform()` reproduced `(x-mean_)/scale_` to 0.000e+00. Retraining purely to silence it would have swapped a good model for a worse one. Check the fitted attributes and a round-trip transform first; retrain if they actually differ.

- **A stale baseline can become permanently unbeatable** and block every honest retrain. See `model_promotion.staleness_override_applies`.

- **An `int` passed as `cv=` to any sklearn meta-estimator silently means `StratifiedKFold`, which shuffles time order.** `_base_models` built six `CalibratedClassifierCV(..., cv=3)` and handed them to `_fit_stack`, whose outer loop is a `TimeSeriesSplit(gap=embargo)` — so the embargo was enforced on the stack and ignored by every base model's own calibration, which fit isotonic/sigmoid on folds containing future rows. Nothing errors and the code reads as deliberate. Pass the splitter object, not a count, anywhere a nested `cv=` sits inside a time-series harness — and grep for `cv=` as an int whenever you see `TimeSeriesSplit` in the same file.

## Environment & deploy

- **Declared ≠ installed.** `node-pg-migrate` in `package.json` but not `npm install`ed; `nse` in `requirements.txt` but not in the venv. Both silently broke a live job for days.
- **Written ≠ applied.** A migration verified against a throwaway local cluster is not applied to production. Confirm `npm run migrate:up` ran against the real `POSTGRES_URL`.
- **Committed ≠ deployed.** `.ts` is not hot-reloaded; `pm2 restart bharat-server` is required. Check `pm_uptime` against the fix commit's timestamp before believing a fix is live.
- **A standalone `tsx` script that imports `dbAsync` without `import 'dotenv/config'` silently talks to SQLite, not production Postgres — and it will happily print convincing numbers.** `USE_POSTGRES` lives in `.env`, which the pm2 server loads at boot but a hand-run script does not, so the facade falls back to the dev SQLite DB. Hit 2026-08-12 while "live-verifying" a fix: the script reported 121,669 `screener_appearances` rows for Trendlyne and 26 carrying the new column; Postgres actually had **435,700 rows and 0**. It even resolved a *different* `screenpk` for the same screener (24700 vs 358883), which is the cheapest tell. **Verify the connection before trusting the result** — print `process.env.USE_POSTGRES` and assert a row count against a figure you already know from `psql`/`db_compat`. Same family as the two-venvs trap below and `infra_gotchas`' "AlphaQuant writing SQLite". `PYTHON_PATH=backend-python/venv` is what production uses. Bare `python` on PATH is a different install with a different sklearn. Never run a training script with the wrong one.
- **A manual `UPDATE app_settings` is not a fix.** It reverts on any fresh DB and is invisible to every other environment. Seed it in a migration.

## Testing

- **Negative-control every new test**: revert the fix, confirm the test fails, restore. Three separate suites here were 100% green while protecting nothing.
- **A test that reimplements the logic under test** passes against the unfixed source. Call the real function.
- **A test that derives its expectation from the constant it is testing** passes vacuously (`all([])` is `True`).
- **A test that relies on a library's inferred default** to manufacture its own precondition silently stops testing anything when the library changes. Construct the condition explicitly.
- **Env vars a shared facade reads are shared state.** `USE_POSTGRES` is read fresh per call; a suite running in one process leaks whichever file set it last. Pin it in the fixture.
- **A guard test built on a hand-enumerated allowlist only guards what someone remembered to list.** `screenerAppearedAt.test.ts` opened with "pins that all three screener syncs record `appeared_at`" and listed three — there are **four** writers, and the omitted one (`trendlyneScreener.ts`) is the largest, 435,700 of the table's 741,251 rows. Result: `appeared_at` was populated on **10 rows platform-wide** while the suite stayed green and the column looked delivered. Same shape as the "grep EVERY reader of the table" rule above, in test clothing. Derive the list from the source tree (scan for the INSERT/call and assert the scan equals the allowlist) so adding a 5th provider fails the test instead of silently writing NULLs forever.
