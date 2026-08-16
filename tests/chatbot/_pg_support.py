"""Postgres test support for the chatbot tests.

Why this file exists at all, rather than living in conftest.py: `from conftest import ...`
is AMBIGUOUS once more than one test directory is collected in the same run. Both this
directory and src/server/tests/ contain a conftest.py, and every test file inserts its own
directory onto sys.path -- so `import conftest` resolves to whichever ran first. Collecting
`src/server/__tests__/ src/server/tests/ tests/chatbot/` together (the CI command) made it
resolve to src/server/tests/conftest.py and fail with "cannot import name
patch_tool_connect". `_pg_support` is a name no other module in the repo uses, so it resolves
to this file no matter the sys.path order.

What it provides: the throwaway-schema Postgres fixtures from src/server/tests/conftest.py
(Phase 2 of docs/SQLITE_DECOMMISSION_PLAN.md), loaded by explicit file path so no module-name
collision is possible, plus the helper that redirects a chatbot tool away from production.
"""

import importlib.util
import pathlib
import sys

_ROOT = pathlib.Path(__file__).resolve().parents[2]
_SERVER = _ROOT / "src" / "server"

# pg_conn's body imports db_compat/sqlalchemy at fixture-run time; db_compat lives in src/server.
for _p in (str(_SERVER), str(_SERVER / "chatbot")):
    if _p not in sys.path:
        sys.path.insert(0, _p)

_spec = importlib.util.spec_from_file_location(
    "_server_tests_conftest", _SERVER / "tests" / "conftest.py"
)
_server_conftest = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_server_conftest)

pg_available = _server_conftest.pg_available
pg_schema = _server_conftest.pg_schema
pg_conn = _server_conftest.pg_conn


def patch_tool_connect(monkeypatch, tool_module, conn):
    """Point a chatbot tool module at `conn` instead of production.

    The tools call `conn.close()` when they finish; the pg_conn fixture owns that connection
    and needs it alive for schema teardown, so close() is neutralised here rather than every
    tool being changed to suit its tests.

    Two spellings exist and both must be handled: most tools wrap db_compat behind their own
    `_connect(db_path)`, but screener_tool imports `connect` from db_compat directly. Patching
    only `_connect` raised AttributeError there, so the attribute is resolved rather than
    assumed -- and an unknown third spelling fails loudly instead of silently leaving the tool
    pointed at production.
    """
    def _execute(_s, *a, **k):
        """Roll back a failed statement before re-raising.

        Every chatbot tool wraps its queries in `except Exception` and degrades gracefully --
        correct behaviour, and harmless in production where all these tables exist. In a
        throwaway schema they do not, and on Postgres a failed statement ABORTS THE WHOLE
        TRANSACTION: the tool swallows the real error, and every later query in the same agent
        turn fails with "current transaction is aborted" instead. The first error is lost and
        the cascade is what surfaces. Rolling back here keeps each statement independent, so a
        tool's own error handling behaves the way it does against the real database.
        """
        try:
            return conn.execute(*a, **k)
        except Exception:
            try:
                conn.rollback()
            except Exception:
                pass
            raise

    shim = type("ConnShim", (), {
        "execute": _execute,
        "close": lambda _s: None,
        # rollback/commit must be forwarded, not omitted: a tool that recovers from a failed
        # query by rolling back (news_tool's news_sentiment_items -> news_articles fallback)
        # otherwise hits AttributeError inside its own `except`, the psycopg2 transaction stays
        # aborted, and the fallback silently returns nothing. A shim that answers to less than
        # the real connection turns a recoverable path into a dead one.
        "rollback": lambda _s: conn.rollback(),
        "commit": lambda _s: conn.commit(),
    })()
    for attr in ("_connect", "connect"):
        if hasattr(tool_module, attr):
            monkeypatch.setattr(tool_module, attr, lambda *a, **k: shim)
            return conn
    raise AttributeError(
        f"{tool_module.__name__} exposes neither _connect nor connect -- cannot redirect it "
        f"away from production"
    )
