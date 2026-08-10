"""Regression tests for repair_nan_recommendations (data_integrity_repair.py).

The 2026-07-31 NaN-poisoning bug left 13,505 rows in unified_recommendations whose
unified_score is NaN but which still carry a Buy/Sell/Hold classification, because every
comparison against NaN is False so neither `unified < 1` nor _classify's thresholds could
reject them. Source is fixed; this purges the historical residue.

These tests run against a THROWAWAY SCHEMA inside the live Postgres instance, shadowing
`unified_recommendations` via search_path. That is deliberate and not over-engineering:
SQLite cannot represent NaN at all (it coerces to NULL on insert), so the SQLite test path
is structurally incapable of reproducing the bug -- a test written against it would pass
against the unfixed code and protect nothing. Mirrors the pattern already used by
test_live_datasource_mc_corporate_calendar.py.
"""
import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

psycopg2 = pytest.importorskip("psycopg2")

SCHEMA = "t_nanpurge"

PG = dict(host="127.0.0.1", port=5433, user="bharat", password="bharat", dbname="bharat_intel")


def _pg_available():
    try:
        psycopg2.connect(connect_timeout=3, **PG).close()
        return True
    except Exception:
        return False


pytestmark = pytest.mark.skipif(not _pg_available(), reason="live Postgres not reachable")


class _Conn:
    """Minimal ConnWrapper-alike over a raw psycopg2 connection pinned to the test schema.

    repair_nan_recommendations only needs .execute()/.commit() and reads rows by key, which
    is exactly what RealDictCursor gives -- so the real function runs unmodified.
    """

    def __init__(self, raw):
        self.raw = raw

    def execute(self, sql, params=None):
        from psycopg2.extras import RealDictCursor
        cur = self.raw.cursor(cursor_factory=RealDictCursor)
        cur.execute(sql, params or ())
        return cur

    def commit(self):
        self.raw.commit()


@pytest.fixture()
def conn():
    # sql_translate.use_postgres() reads os.environ fresh on EVERY call, so in a full-suite
    # run whichever test file last set USE_POSTGRES wins -- and repair_nan_recommendations
    # early-returns on the SQLite branch, making these tests pass vacuously while protecting
    # nothing. Caught exactly that way: green in isolation, red in the full suite. Pin and
    # restore around the test rather than trusting collection order.
    _prev = os.environ.get("USE_POSTGRES")
    os.environ["USE_POSTGRES"] = "true"

    admin = psycopg2.connect(**PG)
    admin.autocommit = True
    cur = admin.cursor()
    cur.execute(f"DROP SCHEMA IF EXISTS {SCHEMA} CASCADE")
    cur.execute(f"CREATE SCHEMA {SCHEMA}")
    cur.execute(f"""
        CREATE TABLE {SCHEMA}.unified_recommendations (
            symbol TEXT, computed_at TEXT,
            unified_score DOUBLE PRECISION, classification TEXT
        )
    """)
    cur.execute(f"""
        INSERT INTO {SCHEMA}.unified_recommendations VALUES
            ('GOODBUY',  '2026-08-10', 72.5,        'Buy'),
            ('GOODSELL', '2026-08-10', 21.0,        'Sell'),
            ('GOODHOLD', '2026-08-10', 50.0,        'Hold'),
            ('NANBUY',   '2026-07-25', 'NaN',       'Buy'),
            ('NANSELL',  '2026-07-25', 'NaN',       'Sell'),
            ('NANHOLD',  '2026-07-25', 'NaN',       'Hold'),
            ('INFBUY',   '2026-07-25', 'Infinity',  'Buy')
    """)
    work = psycopg2.connect(**PG)
    work.cursor().execute(f"SET search_path TO {SCHEMA}, public")
    work.commit()
    try:
        yield _Conn(work)
    finally:
        work.close()
        cur.execute(f"DROP SCHEMA IF EXISTS {SCHEMA} CASCADE")
        admin.close()
        if _prev is None:
            os.environ.pop("USE_POSTGRES", None)
        else:
            os.environ["USE_POSTGRES"] = _prev


def _symbols(conn):
    return {r["symbol"] for r in
            conn.execute("SELECT symbol FROM unified_recommendations").fetchall()}


def test_purges_every_non_finite_row(conn):
    import data_integrity_repair as dir_

    dir_.repair_nan_recommendations(conn, dry=False)
    left = _symbols(conn)
    assert "NANBUY" not in left
    assert "NANSELL" not in left
    assert "NANHOLD" not in left
    # +/-Infinity is the same class of unusable score and must go too.
    assert "INFBUY" not in left


def test_never_deletes_a_finite_row(conn):
    """The guard against over-correcting: a real recommendation must survive untouched."""
    import data_integrity_repair as dir_

    dir_.repair_nan_recommendations(conn, dry=False)
    assert _symbols(conn) == {"GOODBUY", "GOODSELL", "GOODHOLD"}


def test_dry_run_writes_nothing(conn):
    import data_integrity_repair as dir_

    before = _symbols(conn)
    dir_.repair_nan_recommendations(conn, dry=True)
    assert _symbols(conn) == before


def test_idempotent(conn):
    import data_integrity_repair as dir_

    dir_.repair_nan_recommendations(conn, dry=False)
    first = _symbols(conn)
    dir_.repair_nan_recommendations(conn, dry=False)
    assert _symbols(conn) == first


def test_nan_is_not_detectable_by_the_portable_ieee_trick(conn):
    """Pins WHY the implementation is dialect-specific rather than using `x != x`.

    Postgres deliberately defines NaN = NaN as TRUE so btree ordering is total, so the
    usual IEEE self-inequality test silently matches NOTHING here. If this ever starts
    failing, the cast-to-text implementation can be simplified -- until then, do not
    'simplify' it into a portable-looking form that does nothing.
    """
    rows = conn.execute(
        "SELECT COUNT(*) AS c FROM unified_recommendations "
        "WHERE unified_score <> unified_score"
    ).fetchall()
    assert int(rows[0]["c"]) == 0
