"""Regression test for fix_provider_scan_collisions.py's check_composite_keys -- against a
stub connection (no live DB needed for CI), plus one negative control per this repo's own
convention. The 2026-08-12 predecessor of this script logged a canned success message
without querying anything; this pins that check_composite_keys actually inspects the PK."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from fix_provider_scan_collisions import check_composite_keys  # noqa: E402


class _StubConn:
    """Fakes just enough of db_compat's connection interface: to_regclass(?) and the
    information_schema PK query, keyed by the table name each call is scoped to."""
    def __init__(self, tables: dict[str, list[str] | None]):
        self._tables = tables  # table -> list of PK columns, or None for "doesn't exist"
        self._pending_table = None

    def execute(self, sql, params=()):
        if "to_regclass" in sql:
            self._pending_table = params[0]
            return self
        if "PRIMARY KEY" in sql:
            self._pending_table = params[0]
            return self
        raise AssertionError(f"unexpected query: {sql}")

    def fetchone(self):
        exists = self._pending_table in self._tables and self._tables[self._pending_table] is not None
        return (self._pending_table,) if exists else None

    def fetchall(self):
        cols = self._tables.get(self._pending_table) or []
        return [(c,) for c in cols]


def test_all_composite_passes():
    conn = _StubConn({"screener_master": ["source", "scan_id"]})
    assert check_composite_keys(conn, {"screener_master": "source"}) == []


def test_NEGATIVE_CONTROL_bare_pk_missing_provider_column_is_flagged():
    """The real 2026-08-03..05 bug shape: a PK on the bare id alone."""
    conn = _StubConn({"screener_master": ["scan_id"]})  # no 'source'
    problems = check_composite_keys(conn, {"screener_master": "source"})
    assert len(problems) == 1
    assert "missing 'source'" in problems[0]


def test_missing_table_is_flagged():
    conn = _StubConn({"nonexistent": None})
    problems = check_composite_keys(conn, {"nonexistent": "source"})
    assert len(problems) == 1
    assert "does not exist" in problems[0]


def test_no_primary_key_at_all_is_flagged():
    conn = _StubConn({"screener_master": []})
    problems = check_composite_keys(conn, {"screener_master": "source"})
    assert len(problems) == 1
    assert "no PRIMARY KEY" in problems[0]


def test_clean_multi_table_run_reports_nothing():
    conn = _StubConn({
        "screener_master": ["source", "scan_id"],
        "screener_reliability": ["source", "scan_id"],
    })
    assert check_composite_keys(conn, {
        "screener_master": "source",
        "screener_reliability": "source",
    }) == []
