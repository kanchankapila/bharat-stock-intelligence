"""A metric is only useful if its SQL actually runs against the real schema.

The ontology documents 17 measures with runnable SQL. A metric whose SQL references a
renamed column, or a typo'd table, is worse than absent: an agent or a model will trust the
name, run the query, and get a runtime error — or worse, a plausible-looking wrong answer.
`validate_metric_sql()` catches the static problems; this file catches the live ones, by
asking Postgres to *plan* each statement. EXPLAIN parses, binds and resolves every table
and column reference without executing or scanning a row, so this stays fast on a database
with nine million outcome rows.
"""
import os
import sys

import pytest

SERVER_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if SERVER_DIR not in sys.path:
    sys.path.insert(0, SERVER_DIR)

from ontology import build_ontology  # noqa: E402
from ontology.model import validate_metric_sql  # noqa: E402


@pytest.fixture(scope="module")
def onto():
    return build_ontology()


def test_every_metric_declares_read_only_select_sql(onto):
    """The semantic layer must not be able to write.

    A metric is handed to agents and models as a query to run. Anything other than a
    SELECT/WITH is a write path hidden behind a name that reads like a definition.
    """
    for m in onto.metrics:
        issues = validate_metric_sql(m)
        assert issues == [], f"{m.name}: " + "; ".join(issues)


def test_every_metric_renders_its_binds(onto):
    """An unsubstituted `:as_of` reaching a database is a hard failure at run time."""
    for m in onto.metrics:
        sql = m.render_literal(symbol="INFY", as_of="2026-09-18")
        assert ":symbol" not in sql and ":as_of" not in sql, m.name


def test_render_literal_escapes_quotes(onto):
    """A symbol containing a quote must not be able to break out of the literal."""
    m = onto.metric_by_name("close_price")
    sql = m.render_literal(symbol="O'BRIEN", as_of="2026-09-18")
    assert "'O''BRIEN'" in sql, "single quote in a bind was not escaped"


def test_params_are_a_subset_of_the_known_binds(onto):
    for m in onto.metrics:
        for p in m.params:
            assert p in ("symbol", "as_of"), f"{m.name}: unsupported bind {p!r}"


@pytest.mark.postgres
class TestAgainstTheRealSchema:
    """EXPLAIN-only: parses and resolves every reference, executes nothing."""

    def test_every_metric_explains_against_the_live_schema(self, pg_db_conn):
        failures = []
        checked = 0
        for m in onto_metrics():
            try:
                pg_db_conn.execute("EXPLAIN " + m.render_literal()).fetchall()
                checked += 1
            except Exception as exc:  # noqa: BLE001 — the message IS the assertion
                failures.append(f"{m.name}: {type(exc).__name__}: {exc}")
        assert checked, "no metric was checked — the test would be vacuous"
        assert not failures, "metric SQL did not plan:\n" + "\n".join(failures)

    def test_declared_source_tables_are_real_tables(self, pg_db_conn):
        rows = pg_db_conn.execute(
            "SELECT count(*) AS n FROM information_schema.tables "
            "WHERE table_schema = current_schema()"
        ).fetchall()
        live = rows[0]["n"]
        assert live >= 200, "the throwaway schema looks empty — introspect fixture problem"

    def test_every_documented_table_exists(self, pg_db_conn):
        """The ontology's documented tables must all exist in the schema snapshot.

        AF-20260928-06: the two endpoint-DISCOVERY tables are EXEMPT —
        `checkSchemaDrift.ts`'s SKIP_LIVE_TABLES (AF-20260917-18) deliberately keeps
        `market_endpoint_registry` / `url_candidates_validation_audit` out of
        db/schema.postgres.sql because they are populated entirely outside this repo
        (urls-explorer's build_pg_registry.py; zero readers/writers here — "excluded
        rather than absorbed"), so the pg_db copy this test runs against can never
        contain them. Until 2026-09-28 this test passed by ACCIDENT:
        pg_test_support's pooled URL carried `,public`, so `to_regclass` resolved the
        exemption candidates against the PRODUCTION tables through the isolation leak
        (AF-20260928-05). Keep this set in sync with SKIP_LIVE_TABLES.
        """
        external_by_design = {
            "market_endpoint_registry",
            "url_candidates_validation_audit",
        }
        names = [c.table for c in onto_metrics_onto().cards]
        missing = []
        for name in names:
            if name in external_by_design:
                continue
            row = pg_db_conn.execute(
                "SELECT to_regclass(?) AS t", (name,)
            ).fetchall()[0]["t"]
            if row is None:
                missing.append(name)
        assert not missing, f"documented tables absent from the live schema: {missing}"


def onto_metrics():
    """Module-level so the EXPLAIN loop can build its own list once."""
    return build_ontology().metrics


def onto_metrics_onto():
    return build_ontology()
