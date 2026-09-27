"""Tests for the semantic graph and decision-evidence layer."""
import os
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))
from semantic_contracts import sync_ontology_contracts
from semantic_identity import _valid_isin, sync_identity
from semantic_evidence import (
    build_decision_evidence,
    decision_key,
    get_entity_neighborhood,
    link_claim_evidence,
    persist_decision_evidence_bundles,
    record_decision_outcome,
    record_market_claim,
    record_market_evidence,
    record_market_fact,
)


def _recommendation():
    return {
        "symbol": "RELIANCE",
        "computed_at": "2026-09-25",
        "generated_at": datetime(2026, 9, 25, 10, 0, tzinfo=timezone.utc),
        "unified_score": 78.0,
        "classification": "Buy",
        "timeframe": "LONG_TERM",
        "screener_stock_score": 82.0,
        "ml_score": 70.0,
        "confluence_score": 76.0,
        "technical_score": 64.0,
        "dl_score": None,
        "cs_score": 58.0,
        "breakout_score": 73.0,
        "smart_money_score": 52.0,
        "fundamental_score": 80.0,
        "bullish_screener_count": 8,
        "bearish_screener_count": 2,
        "engine_coverage_count": 6,
    }


def test_component_evidence_keeps_support_and_contradiction_separate():
    rows = build_decision_evidence(_recommendation())
    by_key = {row["evidence_key"]: row for row in rows}
    assert by_key["component:technical"]["relation"] == "supports"
    assert by_key["screener:direction-counts"]["relation"] == "supports"
    assert all(row["confidence_kind"] != "probability" for row in rows)
    assert all("trade_reasoning" not in row["note"] for row in rows)


def test_decision_evidence_persists_quality_and_watermark_snapshot(pg_db_conn):
    conn = pg_db_conn
    conn.execute("DELETE FROM market_decision_evidence")
    conn.execute("DELETE FROM market_decision_event")
    conn.execute("DELETE FROM market_data_watermark")
    conn.execute("DELETE FROM data_quality_results")
    conn.execute(
        "INSERT INTO data_quality_results (check_id, label, category, critical, status, detail, checked_at) "
        "VALUES (?, ?, ?, ?, ?, ?, ?)",
        ("semantic-test", "semantic test", "semantic", 1, "WARN", "test warning", 1),
    )
    conn.execute(
        "INSERT INTO market_data_watermark (dataset, partition_key, completeness_status, output_watermark) "
        "VALUES (?, ?, ?, ?)",
        ("stock_ohlcv", "ALL", "complete", "2026-09-25"),
    )

    rec = _recommendation()
    count = persist_decision_evidence_bundles(conn, [rec])
    record_decision_outcome(
        conn,
        decision=decision_key(rec),
        label_definition="path_barrier",
        horizon_days=5,
        outcome_status="resolved",
        return_pct=1.25,
        resolved_at="2026-09-30T10:00:00Z",
        source_table="signal_outcomes",
    )
    conn.commit()

    event = conn.execute("SELECT * FROM market_decision_event").fetchone()
    evidence = conn.execute("SELECT * FROM market_decision_evidence ORDER BY evidence_key").fetchall()
    outcome = conn.execute("SELECT * FROM market_decision_outcome").fetchone()
    assert count == 1
    assert event["decision_status"] == "advisory"
    assert event["knowledge_cutoff_kind"] == "generation_upper_bound"
    assert "unified_score_is_not_probability" in event["guardrails"]
    assert event["quality_snapshot"]["status"] == "warn"
    assert event["data_watermarks"]["status"] == "complete"
    assert {row["relation"] for row in evidence} >= {"supports", "context"}
    assert outcome["label_definition"] == "path_barrier"
    assert outcome["return_pct"] == 1.25


def test_graph_fact_claim_and_evidence_round_trip(pg_db_conn):
    conn = pg_db_conn
    conn.execute("DELETE FROM market_claim_evidence")
    conn.execute("DELETE FROM market_claim")
    conn.execute("DELETE FROM market_evidence")
    conn.execute("DELETE FROM market_graph_edge")
    conn.execute("DELETE FROM market_graph_node")

    record_market_evidence(
        conn,
        evidence_key="news:reliance:1",
        source_type="news",
        source_ref="news_sentiment_items:1",
        content={"headline": "Reliance results beat expectations"},
        available_at="2026-09-25T09:00:00Z",
        extraction_method="fixture",
        quality_status="candidate",
    )
    record_market_fact(
        conn,
        assertion_key="fact:reliance:results-beat",
        from_node={
            "node_key": "INFY:RELIANCE",
            "node_type": "instrument",
            "label": "Reliance Industries",
            "canonical_symbol": "RELIANCE",
        },
        predicate="has_earnings_observation",
        object_value={"status": "beat"},
        source="news_sentiment_items",
        source_ref="news_sentiment_items:1",
        available_at="2026-09-25T09:00:00Z",
    )
    record_market_claim(
        conn,
        claim_key="claim:reliance:results-positive",
        subject_node={
            "node_key": "INFY:RELIANCE",
            "node_type": "instrument",
            "label": "Reliance Industries",
            "canonical_symbol": "RELIANCE",
        },
        predicate="earnings_direction",
        object_value={"direction": "positive"},
        method="fixture-claim",
        stance="bullish",
        claim_status="inferred",
        available_at="2026-09-25T09:00:00Z",
        source="news_sentiment_items",
    )
    link_claim_evidence(conn, "claim:reliance:results-positive", "news:reliance:1", "supports")
    conn.commit()

    neighborhood = get_entity_neighborhood(conn, "INFY:RELIANCE", "instrument")
    assert neighborhood["status"] == "ok"
    assert neighborhood["outgoing"][0]["predicate"] == "has_earnings_observation"
    claim = conn.execute("SELECT * FROM market_claim WHERE claim_key = ?", ("claim:reliance:results-positive",)).fetchone()
    assert claim["claim_status"] == "inferred"
    assert conn.execute("SELECT count(1) AS n FROM market_claim_evidence").fetchone()["n"] == 1


def test_ontology_contracts_materialize_cards_and_feature_guardrails(pg_db_conn):
    result = sync_ontology_contracts(conn=pg_db_conn)
    pg_db_conn.commit()
    assert result["status"] == "ok"
    assert result["datasets"] >= 45
    assert result["features"] >= 200
    row = pg_db_conn.execute(
        "SELECT usable_as_feature, is_label, leakage_risk FROM semantic_feature_definition WHERE property_name = ?",
        ("win_probability",),
    ).fetchone()
    assert row["usable_as_feature"] is False
    assert row["is_label"] is False
    assert row["leakage_risk"] == "high"
    old = pg_db_conn.execute(
        "SELECT count(1) AS n FROM market_data_contract "
        "WHERE dataset = ? AND version <> '1.1.0' AND active = TRUE",
        ("stock_ohlcv",),
    ).fetchone()
    assert old["n"] == 0



def _seed_identity_master(conn):
    conn.execute("DELETE FROM nse_stocks")
    conn.execute(
        "INSERT INTO nse_stocks (symbol, name, sector, industry, isin, listing_date, exchange, status, mcsymbol, tlid, stockid, companyid, tickertape_sid, fincode, scripcode, last_updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, now())",
        ("AAA", "Alpha Limited", "IT", "Software", "INE877I01016", "2020-01-01", "NSE", "ACTIVE", "MC", "11", "101", "201", "AAA", "301", "500001"),
    )
    conn.execute(
        "INSERT INTO nse_stocks (symbol, name, sector, industry, isin, listing_date, exchange, status, mcsymbol, last_updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, now())",
        ("BBB", "Beta Limited", "Banking", "Bank", None, "2021-01-01", "NSE", "ACTIVE", "MC",),
    )


def test_identity_sync_uses_isin_and_keeps_provisionals_separate(pg_db_conn):
    conn = pg_db_conn
    for table in (
        "market_identifier_gap", "market_identifier", "market_listing",
        "market_instrument", "market_issuer", "market_graph_edge", "market_graph_node",
    ):
        conn.execute("DELETE FROM " + table)
    _seed_identity_master(conn)
    result = sync_identity(conn=conn)
    conn.commit()

    assert result["master_rows"] == 2
    assert result["instruments_with_isin"] == 1
    assert result["provisional_instruments"] == 1
    alpha = conn.execute("SELECT * FROM market_instrument WHERE isin = ?", ("INE877I01016",)).fetchone()
    beta = conn.execute("SELECT * FROM market_instrument WHERE name = ?", ("Beta Limited",)).fetchone()
    assert alpha["identity_basis"] == "isin"
    assert beta["identity_basis"] == "provisional_symbol"
    assert alpha["issuer_id"] != beta["issuer_id"]
    gap = conn.execute("SELECT * FROM market_identifier_gap WHERE provider = ?", ("moneycontrol",)).fetchone()
    assert gap is not None
    assert len(gap["candidate_instrument_ids"]) == 2
    edges = conn.execute("SELECT predicate FROM market_graph_edge WHERE source = 'nse_stocks'").fetchall()
    assert {row["predicate"] for row in edges} == {"ISSUES", "LISTED_AS"}


def test_migration_and_schema_snapshot_declare_the_same_semantic_tables(pg_schema):
    conn, schema = pg_schema
    root = Path(__file__).resolve().parents[3]
    migration = (root / "migrations" / "20260925120000_market-semantic-decision-layer.sql").read_text(encoding="utf-8")
    snapshot = (root / "db" / "schema.postgres.sql").read_text(encoding="utf-8")
    # the snapshot quotes identifiers ("market_x"); the migration does not
    pattern = r'CREATE TABLE IF NOT EXISTS "?(market_[a-z_]+)"?'
    migration_names = re.findall(pattern, migration)
    snapshot_names = re.findall(pattern, snapshot)
    # Set inclusion, not list equality: the snapshot legitimately carries other market_* tables
    # this migration never declared (market_breadth, market_holidays, ...), in whatever order
    # schema.postgres.sql happens to list them. What must never happen is a table this migration
    # creates being absent from the snapshot (AF-20260927-01) — that's the actual deploy-drift bug.
    missing = [t for t in migration_names if t not in snapshot_names]
    assert not missing, f"declared in the migration but missing from db/schema.postgres.sql: {missing}"
    cursor = conn.cursor()
    cursor.execute(migration)
    conn.commit()
    count = cursor.execute(
        "SELECT count(1) AS n FROM information_schema.tables "
        "WHERE table_schema = current_schema() AND table_name LIKE 'market\\_%'"
    )
    assert cursor.fetchone()[0] >= len(migration_names)


def test_isin_checksum_rejects_sentinel_or_malformed_value():
    assert _valid_isin("INE877I01016") == "INE877I01016"
    assert _valid_isin("ZZZ555Z55555") is None
    assert _valid_isin("INE000A01017") is None

