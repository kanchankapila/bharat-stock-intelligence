# Recurring Bug Classes

Each of these has bitten this codebase **more than once**. Grep for the signature before you write, and again before you claim a fix is done.

## Dates & scheduling

| Signature | Why it breaks | Recurrences |
|---|---|---|
| `date.today()` / `datetime.now()` as an **exact-match write target** (`WHERE date = ?`) | Post-close jobs now finish after midnight IST, so "today" resolves to a day with no grid row → UPDATE matches 0 rows, silently. Use `as_of.logical_trading_date()`. | 11 files |
| `date.today()` anchoring a `CASE WHEN date >= x ELSE NULL` guard | On any weekend/holiday the anchor matches nothing and the `ELSE` **nulls the column's entire history**. Anchor to `MAX(date) FROM stock_ohlcv`. | 10 |
| Raw `daysStale()` on a freshness check | Monday morning reads Friday data as 3 days stale. Use `tradingDaysStale()`. | 4 |
| Hand-rolled "step back N weekdays" | Skips no holidays, so `--days 90` covers 87 sessions. Use `as_of.trading_days_back()`. | 2 |
| A `cronPattern` mirrored into `jobRegistry.ts` / `monitorScripts.ts` | Drifts from the real registration → phantom "late"/"stale" alerts forever. Guarded now by 5 mirror-consistency test suites — keep them passing. | 6 |

## NaN & null

| Signature | Why it breaks |
|---|---|
| `float(x or 0)` / `int(x or 0)` on a model-output column | **NaN is truthy** — `nan or 0` is `nan`. Use `math.isfinite`, and **skip** rather than coerce to 0 (coercing fabricates the worst possible score). |
| `x != x` to detect NaN in Postgres | Postgres defines `NaN = NaN` as TRUE for total btree ordering. The IEEE self-inequality matches nothing and reports "clean". |
| A NaN-detection test on SQLite | SQLite coerces NaN to NULL on insert, so the test passes against unfixed code. Use a throwaway Postgres schema. |
| `ORDER BY col DESC` with possible NaN | Postgres sorts NaN **highest** — NaN rows rank #1. Wrap in `NULLIF(col, 'NaN'::float8)`. |
| Fixing NaN at the source | Does **not** clean rows the bug already wrote. `run()` purges only the `computed_at` it is currently writing; 13,505 poisoned rows survived a source fix for weeks. |

## SQL dialect (`db_compat` / `sqlTranslate`)

| Signature | Why it breaks |
|---|---|
| Raw `%s` placeholders in a Postgres branch | Bypasses `translate()`, which expects `?`. psycopg2 throws on the literal `%`. | 
| Multi-word casts (`::double precision`) | `stripPgCasts` only matches single-token type names; leaves a dangling ` precision` on the SQLite path. Use `::float8`. |
| `STDDEV`, `DISTINCT ON`, `NOW()`, `ANY(ARRAY[])` | Postgres-only. On the SQLite fallback the whole query fails and the caller silently gets `{}` — which can **disable a gate entirely** rather than error. |
| `pd.read_sql(raw_string, conn)` containing a literal `%` | Different execution path from `db_compat`; the `%` is read as a param marker. Wrap in `sqlalchemy.text()`. |
| `CREATE TABLE IF NOT EXISTS` after adding a column | No-ops on an existing table. Needs an explicit `safe_alter`. |
| A column type assumed from `db.ts` | `db.ts` is the SQLite schema-of-record; live Postgres has native `DATE`/`TIMESTAMPTZ` columns. Check `information_schema.columns`. |

## Writes & keys

- **Any table written as "today's full recomputation" needs a purge of rows the run did not produce**, not just an upsert. A row that a newly-added gate now excludes keeps its stale row and stays visible to every consumer. (3 recurrences: `unified_recommendations`, `intraday_outcome_resolver`, `stock_event_triggers`.)
- **A backfill loop that gates re-selection on one of several columns it fills** permanently excludes rows that got the first column filled but not the rest. (2 recurrences.)
- **A provider-issued id needs the provider in the PK.** (4 recurrences — see `data-sources.md`.)
- **Restricting a universe upstream** re-tunes every absolute threshold downstream. An engine fix that deflates one score collapsed actionable Buys 612 → 22 under an unchanged floor.

## Models & measurement

- **A metric-based promotion gate cannot catch weight divergence or output saturation.** All-NaN weights make validation *raise*, which a handler swallows; a 70%-saturated model still scores AUC 0.66. Gate on the artifact, not only its score.
- **AUC can be excellent and useless.** `flyer_classifier` holds AUC 0.81 with IC −0.041 (t=−9.02) — it measures *who* flies, not *when*.
- **Grouping training rows by day when scoring reads one snapshot** is train/serve skew. Found in 3 files; `test_auc` 0.641 → 0.486 once honest.
- **A flat cost-per-rebalance systematically reorders factors by turnover** and can invert the ranking. Two conclusions sign-flipped.
- **A stale baseline can become permanently unbeatable** and block every honest retrain. See `model_promotion.staleness_override_applies`.

## Environment & deploy

- **Declared ≠ installed.** `node-pg-migrate` in `package.json` but not `npm install`ed; `nse` in `requirements.txt` but not in the venv. Both silently broke a live job for days.
- **Written ≠ applied.** A migration verified against a throwaway local cluster is not applied to production. Confirm `npm run migrate:up` ran against the real `POSTGRES_URL`.
- **Committed ≠ deployed.** `.ts` is not hot-reloaded; `pm2 restart bharat-server` is required. Check `pm_uptime` against the fix commit's timestamp before believing a fix is live.
- **Two venvs drift independently.** `PYTHON_PATH=backend-python/venv` is what production uses. Bare `python` on PATH is a different install with a different sklearn. Never run a training script with the wrong one.
- **A manual `UPDATE app_settings` is not a fix.** It reverts on any fresh DB and is invisible to every other environment. Seed it in a migration.

## Testing

- **Negative-control every new test**: revert the fix, confirm the test fails, restore. Three separate suites here were 100% green while protecting nothing.
- **A test that reimplements the logic under test** passes against the unfixed source. Call the real function.
- **A test that derives its expectation from the constant it is testing** passes vacuously (`all([])` is `True`).
- **A test that relies on a library's inferred default** to manufacture its own precondition silently stops testing anything when the library changes. Construct the condition explicitly.
- **Env vars a shared facade reads are shared state.** `USE_POSTGRES` is read fresh per call; a suite running in one process leaks whichever file set it last. Pin it in the fixture.
