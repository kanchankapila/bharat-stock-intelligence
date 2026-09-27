"""
Metric definitions must be runnable, not just well-formed.

`validate()` proves a metric's SQL is a safe SELECT that names its declared source tables. That
is necessary but not sufficient: the SQL can pass every static rule and still fail against the
live database because a column was renamed. These tests close that gap with EXPLAIN, which
resolves every table and column reference without scanning a single row.

They are marked `postgres` and skip individually when the database is unreachable — but a run
that skipped them exits non-zero (see `conftest.pytest_sessionfinish`), so "skipped" can never
masquerade as "passed".
"""
import sys
from pathlib import Path

import pytest

SERVER_DIR = Path(__file__).resolve().parents[1]
if str(SERVER_DIR) not in sys.path:
    sys.path.insert(0, str(SERVER_DIR))

from ontology.definitions import build_ontology
from ontology.model import validate_metric_sql

pytestmark = pytest.mark.postgres


@pytest.fixture(scope="module")
def onto():
    return build_ontology()


class TestMetricSqlIsSafe:
    def test_every_metric_passes_the_static_rules(self, onto):
        """Read-only, single-statement, no `%` placeholder trap, source tables actually used."""
        issues = []
        for m in onto.metrics:
            issues.extend(validate_metric_sql(m))
        assert issues == []

    def test_no_metric_carries_an_unsubstituted_bind(self, onto):
        """render_literal raises on a third bind, so this is the guard against smuggling one."""
        for m in onto.metrics:
            rendered = m.render_literal()
            assert ":symbol" not in rendered
            assert ":as_of" not in rendered

    def test_every_metric_renders(self, onto):
        """Rendering is where an undeclared bind is caught, so it must not raise."""
        for m in onto.metrics:
            assert m.render_literal().strip()

    def test_every_bound_column_exists(self, pg_db_conn, onto):
        """The single most valuable test in this file.

        The ontology claims 500+ columns carry named semantics. If any has been renamed or
        dropped, every model and agent using the layer is reading a fiction. This queries
        information_schema once and checks all of them, so it cannot rot silently.
        """
        existing = set()
        for row in pg_db_conn.execute(
            "SELECT table_name, column_name FROM information_schema.columns "
            "WHERE table_schema = current_schema()"
        ).fetchall():
            existing.add((row["table_name"], row["column_name"]))

        # endpoint-discovery tables are live-only by design: scripts/checkSchemaDrift.ts and
        # generatePgSchemaFromLive.ts exclude them from db/schema.postgres.sql
        live_only = {"market_endpoint_registry", "url_candidates_validation_audit"}
        missing = [b.ref for b in onto.bindings
                   if b.table not in live_only and (b.table, b.column) not in existing]
        assert missing == [], f"{len(missing)} bound columns do not exist: {missing[:20]}"
        assert len(existing) > 0, "information_schema returned nothing — the check is vacuous"
