# SQLite decommission — making Postgres the only database

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

| Surface | Measured size |
|---|---|
| `src/server/db.ts` — SQLite schema-of-record | 3,296 lines, 147 `CREATE TABLE` |
| `src/server/db_compat.py` — Python dual-dialect facade | 460 lines, **222 importers** |
| `src/server/sqlTranslate.ts` — TS `?`→`$n` + dialect fixups | 211 lines, 11 importers |
| `USE_POSTGRES` conditional branches | 32 `.ts` files, 26 `.py` files |
| Direct `sqlite3` usage (Python) | 122 files |
| `better-sqlite3` usage (TS) | 4 files |
| Test files touching SQLite | **251 Python, 27 TypeScript** |

Live Postgres holds **211 tables**; `db.ts` describes **147**; `db/schema.postgres.sql` describes
**145**. The SQLite schema-of-record has not described production for a long time — which is the
strongest argument for this work, independent of tidiness.

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
