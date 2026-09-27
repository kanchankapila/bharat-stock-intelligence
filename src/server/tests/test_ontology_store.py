"""The SQL-native mirror: `python -m ontology store` must produce queryable, correct views.

The exported RDF is for tools; this is for the models and analysts who will never open a
file. The whole point of writing 1,068 rows into Postgres is that one `SELECT ... FROM
kg_v_feature` answers "what may I feed this model?". These tests run against a real Postgres
(the repo's `pg_db` fixture), because a view that only exists in a SQLite mental model is
not a view.
"""
import os
import sys

import pytest

SERVER_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if SERVER_DIR not in sys.path:
    sys.path.insert(0, SERVER_DIR)

from ontology import build_ontology, store  # noqa: E402

pytestmark = pytest.mark.postgres


@pytest.fixture(scope="module")
def onto():
    return build_ontology()


def test_plan_counts_match_the_definitions(onto):
    plan = store.plan(onto)
    assert plan["rows"]["kg_class"] == len(onto.classes)
    assert plan["rows"]["kg_property"] == len(onto.properties)
    assert plan["rows"]["kg_card"] == len(onto.cards)
    assert plan["rows"]["kg_binding"] == len(onto.bindings)
    assert plan["rows"]["kg_metric"] == len(onto.metrics)
    assert len(plan["views"]) == 9


def test_sync_roundtrips_every_row(onto, pg_db_conn):
    result = store.sync(onto, conn=pg_db_conn)
    assert result["written"] > 0
    pg_db_conn.commit()
    row = pg_db_conn.execute("SELECT count(*) AS n FROM kg_binding").fetchall()[0]["n"]
    assert row == len(onto.bindings)


def test_kg_class_has_a_row_for_every_class(onto, pg_db_conn):
    store.sync(onto, conn=pg_db_conn)
    pg_db_conn.commit()
    row = pg_db_conn.execute("SELECT count(*) AS n FROM kg_class").fetchall()[0]["n"]
    assert row == len(onto.classes)


def test_feature_view_excludes_labels_and_high_leakage(onto, pg_db_conn):
    """The invariant the views exist to enforce, checked through SQL."""
    store.sync(onto, conn=pg_db_conn)
    pg_db_conn.commit()
    bad = pg_db_conn.execute(
        "SELECT column_name, is_label, leakage_risk FROM kg_v_feature "
        "WHERE is_label OR leakage_risk IN ('high', 'target')"
    ).fetchall()
    assert bad == [], f"kg_v_feature leaked {len(bad)} label/high-risk columns: {bad[:5]}"


def test_never_feature_view_covers_forbidden_tables(onto, pg_db_conn):
    store.sync(onto, conn=pg_db_conn)
    pg_db_conn.commit()
    rows = pg_db_conn.execute(
        "SELECT DISTINCT table_name FROM kg_v_never_feature WHERE training_use = 'forbidden'"
    ).fetchall()
    forbidden = {c.table for c in onto.cards if c.training_use == "forbidden"}
    assert forbidden <= {r["table_name"] for r in rows}


def test_column_view_resolves_every_documented_column(onto, pg_db_conn):
    store.sync(onto, conn=pg_db_conn)
    pg_db_conn.commit()
    row = pg_db_conn.execute("SELECT count(*) AS n FROM kg_v_column").fetchall()[0]["n"]
    assert row == len(onto.bindings)


def test_dataset_view_counts_features_per_table(onto, pg_db_conn):
    store.sync(onto, conn=pg_db_conn)
    pg_db_conn.commit()
    rows = pg_db_conn.execute(
        "SELECT table_name, bound_columns, feature_columns FROM kg_v_dataset"
    ).fetchall()
    assert len(rows) == len(onto.cards)
    for r in rows:
        assert r["feature_columns"] <= r["bound_columns"]


def test_term_view_carries_the_source_column(onto, pg_db_conn):
    store.sync(onto, conn=pg_db_conn)
    pg_db_conn.commit()
    row = pg_db_conn.execute("SELECT count(*) AS n FROM kg_v_term").fetchall()[0]["n"]
    expected = sum(len(v.terms) for v in onto.vocabularies)
    assert row == expected
    named = pg_db_conn.execute(
        "SELECT count(*) AS n FROM kg_v_term WHERE source_column IS NOT NULL"
    ).fetchall()[0]["n"]
    assert named > 0


def test_metric_view_stores_runnable_sql_not_a_description(onto, pg_db_conn):
    store.sync(onto, conn=pg_db_conn)
    pg_db_conn.commit()
    rows = pg_db_conn.execute("SELECT name, sql_text FROM kg_v_metric").fetchall()
    assert len(rows) == len(onto.metrics)
    for r in rows:
        assert r["sql_text"].lstrip().lower().startswith(("select", "with")), r["name"]


def test_alignment_table_excludes_unverified_mappings(onto, pg_db_conn):
    """The conservative filter must hold in SQL too, not just in the RDF export."""
    store.sync(onto, conn=pg_db_conn)
    pg_db_conn.commit()
    rows = pg_db_conn.execute(
        "SELECT count(*) AS n FROM kg_alignment WHERE emitted"
    ).fetchall()[0]["n"]
    from ontology import alignment

    assert rows == len(alignment.emitted_assertions())
    unverified = pg_db_conn.execute(
        "SELECT count(*) AS n FROM kg_alignment WHERE NOT emitted"
    ).fetchall()[0]["n"]
    assert unverified == len(alignment.assertions()) - rows


def test_reset_drops_the_tables_and_views(onto, pg_db_conn):
    """`reset` is the documented undo; verify it removes both layers, not just the tables."""
    store.sync(onto, conn=pg_db_conn)
    pg_db_conn.commit()
    store.reset(conn=pg_db_conn)
    pg_db_conn.commit()
    left = pg_db_conn.execute(
        "SELECT count(*) AS n FROM information_schema.tables "
        "WHERE table_name LIKE 'kg\\_%' AND table_schema = current_schema()"
    ).fetchall()[0]["n"]
    assert left == 0
