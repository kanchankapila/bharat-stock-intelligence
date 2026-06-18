# P3f — Python engines → dual-mode Postgres

**Date:** 2026-06-18
**Phase:** Prod-readiness Phase 3, sub-phase **P3f** (follows P3e: TS conversion 100% complete)
**Branch:** `prod-readiness-phase1`
**Status:** Design approved (dual-access `Row` drop-in + per-package helper duplication), spec pending review.

## 1. Problem & Context

The TypeScript side is fully converted to the `dbAsync` dual-mode facade (P3d foundation + P3e
consumers); a single `USE_POSTGRES` flip cuts TS over from SQLite to TimescaleDB. The **Python
engines still open `database.sqlite` directly** (`sqlite3.connect(DB_PATH)` or a hardcoded
`sqlite:///` SQLAlchemy URL). Until they are dual-mode, the cutover (P3g) cannot happen: the
engines and the app would read/write different databases.

P3f gives the Python engines the same dual-mode property the TS layer already has: keep running on
SQLite today, switch to Postgres on the same `USE_POSTGRES=true` env flip, with **no further code
change** at cutover.

### Scope (approved)

**In scope** — the two canonical engine sets:
- `src/server/*.py` — ~29 engine files, ~260 DB-touch sites (the engines invoked by `queues.ts` /
  `scoringService` via `runPython`).
- `backend-python/app/*.py` — ~21 files, the port-8002 AlphaQuant service (a near-duplicate engine
  set; already partly env-driven via `DATABASE_URL`).

**Out of scope** (stay on SQLite, deferred):
- One-off diagnostic scripts: `scripts/diagnose_db*.py`, `scripts/winrate_*.py`,
  `scripts/check_*.py`, `scripts/list_symbols.py`, `scripts/verify_best_picks_sql.py`,
  `scripts/generate_accuracy_report.py`, `scripts/fetch_chart_patterns.py`,
  `scripts/check_symbol_dates.py`, `scripts/check_picks_ohlcv.py`.
- Migration tooling that MUST read SQLite to write PG: `scripts/migrate_sqlite_to_pg.py`,
  `scripts/generate_pg_schema.py`.
- Test suites: `tests/chatbot/*`, `src/server/tests/*`, `src/server/__tests__/*` — stay on
  `:memory:`/sqlite fixtures, like the TS `__tests__` did.
- The chatbot RAG tools (`src/server/chatbot/tools/*`) — read-only SQL against the same DB; convert
  only if trivially covered by the foundation, otherwise defer to a follow-up (they are a separate
  FastAPI deployable on port 8001).

### Discovered constraints (drive the design)

1. **Mixed row access.** Code reads rows both by name (`row['close']`) and by position (`row[0]`
   ×26, `fetchone()[0]` ×11, `row[1]` ×7). `sqlite3.Row` supports both; psycopg2's `RealDictCursor`
   (name-only) and `NamedTupleCursor` (attr/index, not `['col']`) each support only one. → The
   foundation must yield rows supporting **both** access styles.
2. **Wide use of `.commit()` / `.cursor()` / `executemany`** across ~24 files. The connection
   wrapper must expose these.
3. **pandas is read-only** here — `read_sql` is used; **no `to_sql`**. So only a read-path DataFrame
   helper is needed, not a write-path one.
4. **Two existing connection styles:**
   - Raw: `conn = sqlite3.connect(DB_PATH); conn.row_factory = sqlite3.Row; conn.execute('… ?', t)`
     — positional `?` paramstyle, `sqlite3.Row` rows.
   - SQLAlchemy: `create_engine(f"sqlite:///{DB_PATH}")` + `pandas.read_sql` / `text()`
     (`fii_dii_fetcher`, `pcr_fetcher`, `institutional_quant_engine`).
5. **`backend-python/app` is partly ready** — e.g. `scoring_engine.py` already does
   `DB_PATH = os.environ.get('DATABASE_URL', …)` and accepts `sqlite:///` URLs; others
   (`outcome_resolver.py`) still hardcode a raw sqlite path. Conversion there is lighter but
   non-uniform.

## 2. Architecture

Mirror the TS foundation (`pgConfig.ts` → `pgClient.ts` → `dbAsync.ts` + `sqlTranslate.ts`) with a
synchronous Python equivalent. No asyncio — the engines are batch CLIs invoked per-run.

```
src/server/db_compat.py     ← engine factory + connection wrapper + query helpers + read_df  (dbAsync analog)
src/server/sql_translate.py ← deterministic SQLite→PG SQL/param translator (sqlTranslate.ts port)

backend-python/app/db_compat.py     ← own copy (separate deployable/package/requirements)
backend-python/app/sql_translate.py ← own copy
```

Two copies, not a shared import: `src/server` and `backend-python/app` are separate deployables with
separate `requirements.txt` and run from different working directories; the code is already
duplicated between them. A shared cross-package import would be fragile. The two `db_compat.py`
files are byte-identical except their default DB path resolution.

### 2.1 `db_compat.py` — public surface

```python
# Engine / config
def get_engine() -> sqlalchemy.Engine          # cached; URL by USE_POSTGRES
def use_postgres() -> bool                       # env USE_POSTGRES == 'true' (strict, mirrors pgConfig.ts)
def database_url() -> str                         # sqlite:///<abs path> or postgresql://… (port 5433)

# Connection (legacy-surface wrapper, context-managed)
@contextmanager
def connect() -> ConnWrapper                      # .execute / .executemany / .cursor / .commit / .rollback

# Convenience query helpers (open+use+close internally)
def query_all(sql, params=()) -> list[Row]
def query_one(sql, params=()) -> Row | None
def query_scalar(sql, params=(), default=None)    # first column of first row (replaces fetchone()[0])
def execute(sql, params=()) -> int                # rowcount; supports RETURNING via execute_returning
def execute_returning(sql, params=()) -> Row | None
def executemany(sql, seq_of_params) -> int

# Transactions
@contextmanager
def transaction() -> ConnWrapper                  # BEGIN…COMMIT / ROLLBACK on exception

# pandas read path
def read_df(sql, params=()) -> pandas.DataFrame   # pd.read_sql via engine + translator
```

### 2.2 `Row` — dual-access result row

A small `dict` subclass returned by every helper and by the wrapper's `fetchone/fetchall`:

```python
class Row(dict):
    """Ordered dict that also supports positional access: row['col'] AND row[0]."""
    def __init__(self, columns: tuple[str, ...], values: tuple):
        super().__init__(zip(columns, values))
        self._values = tuple(values)
    def __getitem__(self, key):
        if isinstance(key, int):
            return self._values[key]
        return super().__getitem__(key)
```

- sqlite path: build `Row` from `cursor.description` + raw tuple (don't rely on `sqlite3.Row`, so
  both engines return the *same* type).
- pg path: psycopg2 default tuple cursor + `cursor.description` → same `Row`.
- Preserves the existing `row['col']`, `row[0]`, `row[1]`, `fetchone()[0]` call sites with no rewrite
  beyond swapping the connection source.

### 2.3 `ConnWrapper` — the connection adapter

Wraps the underlying DBAPI connection (sqlite3 or psycopg2). `.execute(sql, params)` runs
`sql_translate.translate(sql)` (param style + SQLite-isms), executes, and returns a result object
whose `.fetchone()`/`.fetchall()` yield `Row`. `.executemany`, `.cursor`, `.commit`, `.rollback`,
and context-manager semantics pass through. On psycopg2 the connection uses `autocommit=False`;
`transaction()` brackets `BEGIN…COMMIT`.

### 2.4 `sql_translate.py` — translator (port of `sqlTranslate.ts`)

Deterministic, quote-aware, **no-op when `use_postgres()` is False** (so SQLite stays byte-for-byte
the same). Handles automatically (same rule set the TS translator settled on):

- `?` → `%s` (positional, psycopg2 `pyformat`), skipping `?` inside string literals.
- `datetime('now', …)` / `date('now', …)` literals → Postgres `now()` / interval arithmetic.
- `date(col)` → `(col)::date`.
- `IFNULL` → `COALESCE`; `INSTR` → `POSITION`; `GROUP_CONCAT` → `string_agg`.
- `json_extract` → `->>` / `jsonb`.
- `CAST(x AS REAL/INTEGER)` → `double precision` / `integer`.
- `INSERT OR IGNORE` → `INSERT … ON CONFLICT DO NOTHING`.
- `ROUND(double precision, int)` → wrap value `::numeric` (paren-aware) — PG rejects the 2-arg form
  on doubles.

**Left to error on purpose** (hand-converted per file during the batch, per the established
portability rules):
- `INSERT OR REPLACE` → explicit `ON CONFLICT(<unique cols>) DO UPDATE SET …`.
- `strftime(...)` → `to_char(...)`.
- Parameterised `datetime('now','-'||?||' days')` → compute the cutoff in Python and bind it.

### 2.5 Identifier quoting

The PG schema preserved camelCase columns via double-quoting (e.g. `signals."stopLoss"`,
`watchlist."userId"`). Any converted Python SQL touching those columns MUST double-quote them, same
as the TS rule #1, or result keys/inserts break. This is a manual per-site rule, not translated.

## 3. Config & connection details

`db_compat.database_url()` resolves identically to `pgConfig.ts`:
- `USE_POSTGRES != 'true'` → `sqlite:///<abs path to database.sqlite>` (each package's existing
  `DB_PATH` resolution).
- `USE_POSTGRES == 'true'` → `POSTGRES_URL` if set, else
  `postgresql+psycopg2://{POSTGRES_USER}:{POSTGRES_PASSWORD}@{POSTGRES_HOST}:{POSTGRES_PORT}/{POSTGRES_DB}`
  with the same defaults (`bharat`/`bharat`/`localhost`/`5433`/`bharat_intel`).

`get_engine()` caches one `Engine` per process (`pool_pre_ping=True`). psycopg2-binary and SQLAlchemy
are already in both `requirements.txt`.

## 4. Conversion plan (batched, like P3e)

Order by dependency/cluster, smallest-ripple first. Each engine file:
1. Replace `import sqlite3` / `create_engine(sqlite_url)` with `from db_compat import connect,
   query_all, query_one, query_scalar, execute, transaction, read_df, get_engine`.
2. Swap `sqlite3.connect(DB_PATH)` → `connect()` (or use the query helpers directly); pandas
   `read_sql(sql, conn)` → `read_df(sql, params)` or `pd.read_sql(sql, get_engine())`.
3. Hand-convert non-portable SQL flagged by the translator (`INSERT OR REPLACE`, `strftime`,
   parameterised date math); double-quote camelCase columns.
4. Apply opportunistic improvements per the P3e improvement directive (batch multi-row writes, push
   aggregation into SQL, fix swallowed errors / lost progress, drop dead code) — kept tight and
   called out in the commit message.

**Proposed batches** (final grouping decided in the implementation plan):
- B0 — foundation: `src/server/db_compat.py` + `sql_translate.py` + a Python unit test for the
  translator (mirrors `__tests__/sqlTranslate.test.ts`); copy both into `backend-python/app`.
- B1 — outcome/reward cluster: `outcome_resolver.py`, `reward_engine.py`,
  `confluence_outcome_tracker.py`.
- B2 — scoring: `scoring_engine.py`, `unified_ranker.py`, `screener_performance.py`.
- B3 — ML/DL: `ml_ensemble.py`, `online_learner.py`, `ml_signal_scorer.py`, `dl_engine.py`,
  `dl_trainer.py`, `drift_detector.py`, `feature_engineering.py`, `confluence_ml_engine.py`.
- B4 — analytics/backtest: `performance_tracker.py`, `strategy_optimizer.py`, `backtester.py`,
  `backtest_optimizer.py`, `regime_detector.py`, `rl_agent.py`.
- B5 — fetchers/misc: `fii_dii_fetcher.py`, `pcr_fetcher.py`, `institutional_quant_engine.py`,
  `finbert_scorer.py`, `global_macro_fetcher.py`, `technical_analysis_engine.py`,
  `backfill_ohlcv.py`, `backfill_sectors.py`, `explore_mc_tl.py`.
- B6 — `backend-python/app/*` (lighter, mostly env-driven already).

## 5. Verification

Per batch (mirrors P3e's `tsc + vitest + live-PG` gate):
1. **Import-clean:** `python -c "import <module>"` for each touched file (catches syntax/translate
   wiring errors).
2. **SQLite regression:** run the engine with `USE_POSTGRES` unset against `database.sqlite`; confirm
   it still produces output (the translator is a no-op on SQLite, so behavior is unchanged).
3. **Live-PG smoke:** with the TimescaleDB container up and `USE_POSTGRES=true`, run the engine and
   confirm it reads expected rows and writes land in Postgres (`SELECT count(*)` before/after), the
   same way each P3e batch was live-PG-verified.
4. Foundation batch B0 additionally runs the translator unit test.

**Partial conversion is safe:** `USE_POSTGRES` stays `false` until P3f is 100% done, so half-converted
engines keep running on SQLite exactly as before.

## 6. Out-of-scope / follow-ups

- **P3g cutover** (separate): set `USE_POSTGRES=true` in `.env`, smoke-test end-to-end, fold the
  signal-table physical merge, reroute UI reads onto `unified_recommendations`.
- Diagnostic scripts and test suites remain on SQLite.
- Chatbot RAG tools convert only if trivially covered; otherwise a P3f follow-up.

## 7. Risks

- **Row positional access correctness** — the `Row` subclass must preserve column order from
  `cursor.description`; covered by the translator/foundation unit test plus per-batch live-PG runs.
- **Hidden non-portable SQL** — anything the translator leaves to error surfaces immediately on the
  live-PG smoke run, not silently; this is intentional (same as the TS side).
- **`backend-python/app` divergence** — its files differ from `src/server` copies; each is converted
  and verified independently rather than assumed identical.
