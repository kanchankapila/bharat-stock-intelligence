from ontology import build_ontology
from ontology.introspect import DECISION_BEARING_TABLES, coverage


def test_every_decision_bearing_live_table_has_authored_semantics(pg_db_conn):
    report = coverage(build_ontology(), conn=pg_db_conn)
    assert report["gaps"]["missing_decision_bearing_tables"] == []
    assert report["counts"]["decision_bearing_coverage_pct"] == 100.0
    assert report["counts"]["decision_bearing_target"] == len(DECISION_BEARING_TABLES)
