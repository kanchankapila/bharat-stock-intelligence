"""Exposes the shared Postgres fixtures to every test in this directory.

Background: every DB-backed test here built a SQLite file with `sqlite3.connect(tmp_path/...)`
and passed its path in as `db_path`. That has been a no-op since the Postgres-only migration
(2026-08-15) -- every chatbot tool's `_connect(db_path)` ignores its argument and calls
`db_compat.connect()`. So the fixture DB was created, never read, and the assertions ran
against LIVE PRODUCTION instead: `test_get_quant_scores_sorted_by_momentum` failed with
'SABEVENTS' == 'INFY', a real production symbol, not test data. 13 of 29 tests in this
directory were failing that way, and CI never noticed because ci.yml collected only
src/server/__tests__/ and src/server/tests/.

Rather than reintroduce a SQLite path the repo deliberately closed, these tests now use the
same `pg_conn` throwaway-schema fixture as src/server/tests/ and monkeypatch the tool module's
connection helper to point at it.

The implementation lives in _pg_support.py, NOT here: two conftest.py files on the collection
path make a bare `import conftest` resolve unpredictably. See that file's docstring.
"""

import os
import sys

sys.path.insert(0, os.path.dirname(__file__))

# Re-exported so pytest discovers them as fixtures for every test in this directory.
from _pg_support import pg_conn, pg_schema  # noqa: E402,F401
