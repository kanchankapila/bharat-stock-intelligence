# SQLite decommission — making Postgres the only database

> ## STATUS 2026-08-16 — TypeScript done, Python is the only thing left
>
> **Goal, restated by the project owner: one database, Postgres, so that no future session ever
> has to reason about which dialect it is on.** Treat any new `sqlite3.connect` /
> `better-sqlite3` / `USE_POSTGRES` read as a regression.
>
> | | state |
> |---|---|
> | Phase 1 (dead code) | **done** (2026-08-15) |
> | Phase 2 TS (27 vitest files) | **done** — `unit` project runs on a throwaway Postgres schema |
> | Phase 3 TS (branches, `db.ts`) | **done** — `dbAsync.ts` has no SQLite arm; `db.ts` renamed to `db.sqlite-legacy.ts`, imported by nothing |
> | CI unit lane | **done** — `build-test` runs a `timescale/timescaledb:latest-pg16` service |
> | Phase 2 Python (~100 files) | **Dialect bugs fixed and the shim is now DEFAULT-ON** (flag deleted 2026-08-16). Plain `python -m pytest` runs the whole suite on Postgres. Trail was 51 → 46 → 0; re-measured directly at **2,025 passed / 230 skipped / 0 failed** (12m50s). Remaining: 37 files still lean on the shim and need converting to the `pg_conn` fixtures, then the shim itself is deleted |
> | Phase 3 Python (`sql_translate.py`) | blocked on the above |
> | Phase 4 (`database.sqlite`) | blocked on the above. **Rename aside, do not delete** (owner's call) |
>
> Verified at this point: `tsc --noEmit` clean · `vitest run` 963 passed/0 failed ·
> `pytest` 2,024 passed/0 failed · `npm run schema:drift` clean (212 tables).
>
> ### What the TS conversion found — why this is worth finishing
>
> Three **live production bugs**, all green under SQLite for their entire lives:
> `timeframe_scores` held 0 rows because `scoringService` wrote an `updated_at` column production
> never had; that upsert's `ON CONFLICT(symbol, timeframe)` matched no constraint (live PK is
> 3-column); and `backtestRunner` called `.slice()` on a TIMESTAMPTZ, crashing every
> `runId`-scoped backtest. All three were mis-declared in `db.ts`.
>
> ### The strategy changed 2026-08-16 — do NOT convert file by file
>
> Editing ~100 fixtures one at a time was tried and abandoned twice (see the codemod warning
> below). The files are not uniform enough to automate and 100 hand edits leaves half the suite on
> the wrong dialect for days.
>
> **Instead, the one call they all share is redirected.** Inside pytest,
> `sqlite3.connect(':memory:')` returns a `db_compat.ConnWrapper` over a private, empty Postgres
> schema (autouse fixture in `src/server/tests/conftest.py`). The tests' own `CREATE TABLE`
> statements then run against real Postgres unchanged, and every dialect bug surfaces at once.
> `ConnWrapper.executescript()` was added for this (it was the single largest blocker — 18 of 44
> otherwise-unconvertible files used it and nothing else).
>
> ```
> SQLITE_SHIM_POSTGRES=1 python -m pytest src/server/__tests__/ src/server/tests/ tests/chatbot/
> ```
>
> ### ✅ Re-measured 2026-08-16 — the dialect failures are GONE. **2,023 passed / 231 skipped / 0 failed.**
>
> Full command, run end to end (13m06s), shim confirmed active by conftest's own terminal line:
> `[sqlite-decommission] 37 test files still reach Postgres through the sqlite3.connect shim`.
>
> Trail: 51 fail → 46 fail → **0 fail**. Earlier revisions of this section said "51" in three
> places after the count had already dropped to 46, and said "46" after it had reached 0. **This
> number is the one thing in this document that moves — re-run the command before quoting it.**
>
> **What this does and does not mean.** It means the genuine dialect bugs (SQLite-only fixture
> DDL — `INTEGER PRIMARY KEY AUTOINCREMENT`, `INSERT OR REPLACE`, NOT NULL columns the real schema
> enforces and SQLite did not, date/type coercions) are fixed, and the blocking reason for keeping
> the flag opt-in is gone. It does **not** mean Phase 2 Python is finished: **37 files still
> contain `sqlite3.connect` and are only working because the shim redirects them.** Converting
> those to the `pg_conn`/`pg_db_conn` fixtures directly is the remaining work, and that counter
> must only go down.
>
> **Next step is now a decision, not a bug hunt:** flip `SQLITE_SHIM_POSTGRES` to default-on (the
> "don't ship a red default suite" objection no longer applies at 0 failures), then convert the 37,
> then delete the flag, the shim, and `sql_translate.py`'s pytest branch together.
>
> ⚠ Measured against the **working tree**, which carries uncommitted Phase 2 work. Re-confirm after
> it lands.
>
> ### Fix SQLite-only DDL in `sql_translate.py`, NOT in the test files
>
> The obvious fix for `syntax error at or near "AUTOINCREMENT"` is to sweep
> `INTEGER PRIMARY KEY AUTOINCREMENT` → `BIGSERIAL PRIMARY KEY` across the fixtures. **That is
> wrong and was reverted**: BIGSERIAL is not valid SQLite, so it breaks those same files on the
> default path, and there is no single spelling that auto-increments on both engines.
>
> Add a `map_sqlite_functions()` entry instead. It runs only on the Postgres path, leaves the
> SQLite path untouched, and no test file has to know which dialect it is on — which is what the
> translator is for. Done for the AUTOINCREMENT family 2026-08-16: **51 → 46 failures, zero test
> files edited, default suite unaffected.** Apply the same reasoning to whatever DDL the remaining
> 46 trip over before reaching for a file edit.
>
> The exception is `INSERT OR REPLACE`, which `translate()` rejects loudly on purpose — an
> ON CONFLICT target cannot be inferred. Those call sites need a real per-file decision.
>
> ### The fixtures, for tests you are writing fresh
>
> `src/server/tests/conftest.py` now offers two fixtures, both isolated in a throwaway schema and
> pinned by `test_pg_db_fixture.py` (5 tests, including "an unqualified write must be invisible to
> `public`"):
>
> - **`pg_conn`** — empty schema; the test keeps its own narrow DDL. **This is the right one for
>   most conversions**, because the existing fixtures do bare `INSERT ... VALUES (?, ?, ?)` with no
>   column list, which only lines up against a table of exactly the width the test declared.
> - **`pg_db` / `pg_db_conn`** — the *full* production schema from `db/schema.postgres.sql`,
>   applied once per session, truncated per test. `pg_db` also rewrites `POSTGRES_URL` with an
>   `options=-c search_path=…`, so production code under test reaches the same schema without
>   knowing it is under test. Use when a test can drop its DDL entirely.
>
> Worked example: `test_delivery_trend_anchor.py` (`sqlite3.connect(':memory:')` → `pg_conn`,
> helper takes the conn as a parameter, `monkeypatch.setattr(..., use_postgres, lambda: False)`
> deleted). 2 tests, 0.97s.
>
> ### `src/server/__tests__/` holds TypeScript tests, not Python ones
>
> The name reads like the Python sibling of `src/server/tests/`, and it is not: it is the **vitest**
> suite. A `git checkout -- src/server/tests src/server/__tests__ tests`, intended to back out a
> bad Python codemod, discarded ~38 unstaged TypeScript conversions along with it — unrecoverable,
> since `git checkout --` throws away working-tree changes. Only `test_delivery_trend_anchor.py`
> survived, because it happened to have been `git add`ed.
>
> **Before any bulk revert during this migration: `git add -A` the work you intend to keep, or
> revert by explicit file list.** The repo's own convention already says commit by explicit path;
> the same discipline applies to undo.
>
> ### Do NOT bulk-codemod this. Tried 2026-08-16, reverted.
>
> A regex pass over all 47 non-live files did real damage and was backed out:
> a `REAL` → `DOUBLE PRECISION` substitution rewrote the word inside prose comments, and the
> "drop the `sqlite3.connect` line" rule mangled files whose fixture uses a temp **file** DB
> (`sqlite3.connect(path)`) rather than `:memory:`. Convert in small batches with `pytest` after
> each. Split of the 101: **54 are `live_datasource`** (skipped by default — lowest risk, convert
> last), **47 regular**, and 4 of those drive the DB through `DATABASE_URL` env injection rather
> than a passed connection.

Scope: remove SQLite as a supported dialect. **Not** the greenfield rebuild —
`MIGRATION_AND_CUTOVER_PLAN.md` covers standing up a new Postgres instance and re-deriving
history. This document is narrower and independent: the live Postgres stays exactly as it is,
and what gets removed is the *second dialect* the codebase still carries.

All figures measured live 2026-08-15 against production Postgres and the working tree.

---

## 0. The premise correction — there is no data to migrate

The instinctive reading of "migrate everything to Postgres" is that production data lives in
SQLite and must be moved. **It does not.** Measured:

- `.env` sets `USE_POSTGRES=true`; `db_compat.database_url()` and `dbAsync`/`pgClient` both
  resolve to Postgres for every service.
- The two files that *looked* like live SQLite consumers — `backend-python/app/pcr_engine.py`
  and `backend-python/app/portfolio_analytics.py`, flagged in the `infra_gotchas` memory as
  "AlphaQuant writing SQLite" — compute a module-level `DATABASE_URL` that force-wraps the value
  in `sqlite:///` (lines 11–12 of each), **but never reference that variable again**. Both call
  `get_engine()` from `db_compat`, which honours `USE_POSTGRES`. Verified by grep: `DATABASE_URL`
  appears only on its own definition lines in both files. Dead, misleading code — not a live
  SQLite binding.
- The local `database.sqlite` is 3.49 GB and its WAL is written during test runs, not by any
  service. It is ~2 months stale against production on the canonical tables:

  | table | SQLite `max()` | Postgres `max()` |
  |---|---|---|
  | `unified_recommendations` | 2026-06-19 | 2026-08-17 |
  | `stock_scores` | 2026-06-21 | 2026-08-14 |

  (`stock_ohlcv` / `technical_signals` read current in SQLite only because the *test suite*
  writes them.)

**So this is not a data migration. It is deleting a code path and replacing a test substrate.**
That is a much smaller and much safer piece of work than it first appears — but the test
substrate half is the expensive part, and it is where the whole cost sits.

## 1. What actually carries the second dialect

**Two columns: what this looked like when the plan was written (2026-08-15), and what is actually
left now.** The right-hand column is the one to act on; the left is kept so the size of the
remaining job is legible.

| Surface | At plan time (08-15) | **Now (08-16, measured)** |
|---|---|---|
| `src/server/db.ts` — SQLite schema-of-record | 3,296 lines, 147 `CREATE TABLE` | **gone** — renamed `db.sqlite-legacy.ts`, imported by nothing |
| `src/server/db_compat.py` — Python dual-dialect facade | 460 lines, 222 importers | unchanged — and **it survives the migration**; only the branching goes |
| `src/server/sqlTranslate.ts` — TS `?`→`$n` + dialect fixups | 211 lines, 11 importers | unchanged, same reason |
| `USE_POSTGRES` branches | 32 `.ts`, 26 `.py` | **9 `.ts` files, and none of them is a live routing branch** — 4 are the `postgresOnly`-style tests pinning the guarantee, 3 are explanatory comments, 1 is the retired legacy file. The 9th (`envConfig.ts`) is a stale *validator* — see AF-20260816-09 |
| Direct `sqlite3` usage (Python) | 122 files | **101 files call `sqlite3.connect` under `src/`** — 100 are test fixtures, plus `explore_mc_tl.py`, which is a deliberate permanent exclusion (it owns its own standalone exploration DB) |
| `better-sqlite3` usage (TS) | 4 files | 4 — but only `db.sqlite-legacy.ts` (retired), `portfolio.router.ts`, `dbAsync.ts`'s comment, and a `.ts` test helper |
| Test files touching SQLite | 251 Python, 27 TypeScript | **~100 Python. TypeScript is 0** |

Live Postgres holds **212 tables** and `db/schema.postgres.sql` now describes exactly those 212
(`npm run schema:drift` → "Schema clean", verified 2026-08-16). The old line here — "`db.ts`
describes 147, the schema file 145, neither has described production for a long time" — is the
argument that won this work; it is now historical.

**`db_compat` and `sqlTranslate` do not disappear.** They also translate `?` placeholders to
`$n` and normalise casts — that job survives Postgres-only. What gets deleted is the *branching*,
not the module.

## 2. The real blocker: CI has no Postgres in the unit lane

`.github/workflows/ci.yml`'s `build-test` job runs `vitest` and `pytest` with **no services** —
deliberately, and documented in the file: vitest gets an in-memory SQLite DB, and pytest was
verified to pass with `USE_POSTGRES` unset and `DATABASE_URL` pointing at a nonexistent SQLite
file. That is the single thing SQLite is genuinely buying today: a zero-dependency test lane.

The `smoke-test` job already proves the alternative works — it boots a
`timescale/timescaledb:latest-pg16` service container and runs the real router against a fresh
schema. **The pattern exists; it just isn't used by the unit lane.**

This is the decision the whole plan hinges on, and it is a real tradeoff, not an oversight:
Postgres-backed unit tests are slower and can flake on container startup; SQLite-backed ones
cannot catch a dialect bug, which is precisely the class `recurring-bugs.md` records over and
over (`STDDEV`/`DISTINCT ON`/`NOW()` failing silently on the SQLite path, NaN tests passing
against unfixed code because SQLite coerces NaN to NULL).

## 3. Phases

Each phase is independently shippable and leaves the system working. Do not start a later phase
before its predecessor is green.

### Phase 1 — delete the dead and the misleading (low risk, do first)
- Remove the unused `DB_PATH`/`DATABASE_URL` lines from `pcr_engine.py` and
  `portfolio_analytics.py`. They are dead, and they are why a prior session recorded these as
  live SQLite writers when they are not.
- Delete `scripts/generate_pg_schema.py` (generates the Postgres snapshot *from SQLite*, which is
  structurally incapable of seeing the ~66 Postgres-only tables). `generatePgSchemaFromLive.ts`
  already supersedes it and reads live catalogs.
- Make `db/schema.postgres.sql` regenerate from live in CI, so drift cannot silently re-open.
- **No behaviour change. Verify with `tsc` + both suites + `npm run schema:drift`.**

### Phase 2 — move the test substrate to Postgres (the expensive phase)

**Refined scope, measured 2026-08-15** (the earlier "251 Python files" figure counted any mention
of SQLite and badly overstated the work):

| Python test files (258 total) | count | conversion cost |
|---|---|---|
| Touch no database at all | **120** | none |
| Reach the DB via `db_compat`/`get_engine` | 75 | low — already dialect-agnostic; needs a schema, not a rewrite |
| Call `sqlite3.connect(...)` directly (94 of them `:memory:`) | **100** | **real work** — each builds its own ad-hoc DDL |
| Set `USE_POSTGRES` explicitly | 68 | mechanical |

So the genuine conversion burden is **~100 files**, not 278 — but those 100 are the hard kind:
each hand-rolls its tables inline, so moving them means giving the suite a real schema source
plus a per-worker throwaway Postgres schema, then reconciling every ad-hoc DDL against it.

**Foundation built and proven 2026-08-15** — the fixture Phase 2 needs, not the full migration:

- `pg_schema` (in `src/server/tests/conftest.py`): a uniquely-named, empty Postgres schema per
  test, `search_path`-pinned so an unqualified table name can only shadow production, never
  write to it. Auto-skips when Postgres is unreachable. `DROP SCHEMA ... CASCADE` on teardown,
  even on failure.
- `pg_conn`: the same schema wrapped in `db_compat.ConnWrapper` — production's own dialect layer,
  not test-only shimming. A function written against `?` placeholders and `ON CONFLICT` runs
  **unmodified**; only the fixture that hands it a connection changes. This is what makes a
  conversion a one-line fixture swap instead of a rewrite.

**Proof, not a demo:** `test_marketsmojo_incremental_write.py` converted from bare
`sqlite3.connect(':memory:')` to `pg_conn`. All 4 tests pass against real Postgres, exercising
the real `ON CONFLICT(...) DO UPDATE` for the first time (SQLite accepts that syntax too, so the
old SQLite version never actually validated the Postgres path production runs). Negative-controlled
against the guard it exists to protect (disabling `if since and row_date <= since: continue`
correctly fails the test, 3 rows written instead of 0). Verified clean: 0 rows written to the real
`public.marketsmojo_technical_history`, 0 leftover throwaway schemas, both before and after a full
suite run (1972 passed).

Three isolation-guarantee tests were added to `test_sql_translate.py`'s "Postgres-only guarantee"
section (same file, same reason as the dialect guards — a new file trips the clock-tick flake) —
these must keep passing before converting any further test: an unqualified write lands in the
throwaway schema, never in `public`; each schema is unique and starts empty; the schema is
actually dropped on teardown.

**What Phase 2 still needs, honestly:** the ~100-file conversion itself. This foundation makes
each one mechanical (swap the fixture, keep the SQL) for files whose DDL a straight port covers,
but any file whose DDL diverges from real Postgres schema (a SQLite-only type, a missing
NOT NULL/CHECK a real migration would enforce) needs individual judgement, not a script. Convert
in small batches, running the isolation tests before and after each batch.

- Add a `timescaledb` service container to `build-test`, mirroring `smoke-test`'s existing block.
- Give the suites a per-worker throwaway *schema* (not database) so `pool: 'forks',
  singleFork: true` can be relaxed later; `vitest.config`'s serialisation exists because parallel
  workers race on `UNIQUE _migrations.name`.
- Convert test fixtures in dependency order: shared `conftest.py`/setup helpers first, then the
  251 + 27 files. Most will need no change — they go through `db_compat`/`dbAsync` already; the
  ones that call `sqlite3.connect(':memory:')` directly are the real work.
- **Expect this to surface real bugs, not just fixture churn.** `recurring-bugs.md` already
  records that a NaN-detection test passed against unfixed code purely because SQLite coerces NaN
  to NULL on insert. Budget for findings, and treat each as a genuine bug, not a test to silence.

### Phase 3 — collapse the dialect branches
- Remove the 58 `USE_POSTGRES` conditionals; keep `db_compat`/`sqlTranslate` for placeholder
  translation only.
- Delete `db.ts`'s `CREATE TABLE` block (3,296 lines). Migrations plus the live-generated
  `schema.postgres.sql` become the sole schema-of-record. **This is the step that ends the
  "db.ts is the SQLite schema-of-record, live Postgres has different types" trap that
  `recurring-bugs.md` documents.**
- Drop `better-sqlite3` from `package.json`.

### Phase 4 — remove the artifact
- Delete `database.sqlite` (3.49 GB) and its `-wal`/`-shm`, and gitignore the pattern.
- Remove the `USE_POSTGRES=false` fallback path from `dbAsync`/`db_compat` entirely, so a
  misconfigured environment **fails loudly instead of silently talking to a stale local file** —
  the exact failure `recurring-bugs.md` records as "a standalone tsx script without
  `import 'dotenv/config'` silently talks to SQLite and prints convincing numbers."

## 4. What this buys, stated honestly

The win is **not** performance, and it is not disk. It is the elimination of a whole bug family
this repo keeps paying for: a dialect that silently accepts what Postgres rejects (and vice
versa), a schema-of-record describing 147 of 211 tables, and a fallback that turns a
misconfiguration into plausible wrong numbers rather than an error.

The cost is concentrated almost entirely in Phase 2, and it is a real cost — 278 test files and a
slower CI lane. Phases 1, 3 and 4 are comparatively mechanical.

**Recommended sequencing: do Phase 1 now** (it is pure deletion of dead code and closes the
schema-drift regeneration gap), then decide on Phase 2 separately — it deserves its own session
and its own go/no-go, because it is the one that changes how every test in the repo gets a
database.
