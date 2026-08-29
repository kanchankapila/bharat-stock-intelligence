# SQLite decommission — making Postgres the only database

**Status: COMPLETE (2026-08-19).** Postgres/TimescaleDB is the only database this codebase
reasons about. `use_postgres()` / `usePostgres()` return `true` unconditionally, everywhere,
including inside pytest — there is no environment variable that reroutes a real process onto
SQLite any more. Treat any new `sqlite3.connect` / `better-sqlite3` / `USE_POSTGRES` *routing*
read as a regression.

## What's true today

- `src/server/db.ts` — deleted outright (`a2a20d2`). No `db.sqlite-legacy.ts` either.
- `dbAsync.ts` has no SQLite arm.
- `vitest`'s `unit` project runs against a throwaway Postgres schema built from
  `db/schema.postgres.sql` (`vitest.globalSetup.ts`); its `live` project talks to real production.
- Python: 93 files converted from `sqlite3.connect(':memory:')` to `pg_memory_conn()`
  (`src/server/pg_test_support.py`); the monkeypatch shim is gone. `conftest.py` lives at
  `src/server/conftest.py` (moved up from `src/server/tests/` so it also covers
  `src/server/__tests__/`'s Python files, which had no conftest at all before). Fixtures:
  `pg_memory_conn()` (1:1 `sqlite3.connect(':memory:')` replacement), `pg_conn` (empty schema,
  bring your own DDL — right for most conversions), `pg_db`/`pg_db_conn` (full production schema).
- `sql_translate.py`'s `_in_pytest()` pytest-only carve-out is deleted; `use_postgres()` returns
  `True` unconditionally including inside pytest.
- **Deliberately still present**: `database.sqlite` (3.49GB, stale ~2 months against production)
  is kept, not deleted — the project owner's explicit call, not an oversight. `db_compat.py` /
  `sqlTranslate.ts` also survive on purpose — they still handle `?`→`$n` placeholder translation
  and cast normalization independent of dialect branching.
- Two real production bugs were found and fixed during the conversion, not just fixture churn:
  `db_compat.ConnWrapper` didn't survive a failed statement on Postgres (a swallowed
  `except Exception: print(...)` killed the whole transaction, not just the local statement — one
  missing table could classify `unified_ranker`'s entire universe as Hold and still exit 0); and
  `src/server/__tests__/`'s Python files ran on real SQLite for their whole lives because that
  directory had no `conftest.py`, invisible to the shim's own progress counter.

## Verification

`tsc --noEmit` clean · `pytest` 2,026 passed / 230 skipped / 0 failed · `check_recurring_bugs.py`
clean. A skipped-Postgres run now exits non-zero rather than a silent-pass warning
(`pg_memory_conn()` + `pytest_sessionfinish`), matching what `vitest.globalSetup.ts` already did.

Nothing is open here. For unrelated database facts (schema-of-record, hypertable constraints,
connection-pool sizing), see `.claude/rules/recurring-bugs.md`'s "SQL dialect" and "Connection
budgets" sections.
