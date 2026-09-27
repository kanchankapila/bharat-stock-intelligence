"""Semantic graph, data-quality and decision-evidence services.

The canonical serving table remains ``unified_recommendations``. This module
adds a reconstructable evidence ledger beside it and a small PostgreSQL graph
for source facts and claims. It is dependency-free and keeps working before
the semantic migration is deployed by checking table presence.

**Not append-only; immutable-provenance upsert (corrected 2026-09-27,
AF-20260927-10).** These tables were documented as "append-only" while every
writer used ``ON CONFLICT DO UPDATE`` -- including on ``available_at``, so a
refresh silently moved the one column that records when a fact became
knowable, and the bitemporal ``as_of`` reads this layer exists for could not
be trusted. Mutable columns still update in place (one row per key, not an
event stream), but **``available_at`` is now first-write-wins in every writer
here and in ``semantic_identity``** -- it is deliberately absent from every
``DO UPDATE SET`` list. Do not add it back: a corrupted provenance column
cannot be repaired after the fact, and its failure mode is a confident wrong
answer from a biased slice rather than a visible error. If this layer ever
needs full event-sourcing (a new row per change), that is a schema change,
not a writer change.
"""
from __future__ import annotations

import json
import math
import re
from datetime import datetime, timezone
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple

from db_compat import connect

ONTOLOGY_VERSION = "1.1.0"
RANKER_POLICY_VERSION = "unified_ranker.legacy-live-v1"
FEATURE_SET_VERSION = "feature_store.legacy-unversioned-live"
_SYMBOL_RE = re.compile(r"^[A-Z0-9&$\-]{1,20}$")
_COMPONENTS = (
    ("screener_stock_score", "screener"),
    ("ml_score", "ml"),
    ("confluence_score", "confluence"),
    ("technical_score", "technical"),
    ("dl_score", "dl"),
    ("cs_score", "cs"),
    ("breakout_score", "breakout"),
    ("smart_money_score", "smart_money"),
    ("fundamental_score", "fundamental"),
)
_DECISION_TABLES = (
    "market_decision_event",
    "market_decision_evidence",
    "market_decision_outcome",
)
_GRAPH_TABLES = (
    "market_graph_node",
    "market_graph_edge",
    "market_evidence",
    "market_claim",
    "market_claim_evidence",
)
_CONTRACT_TABLES = ("market_data_contract", "semantic_feature_definition")


def _json(value: Any) -> str:
    return json.dumps(value, default=str, sort_keys=True)


def _table_exists(conn, table: str) -> bool:
    row = conn.execute("SELECT to_regclass(?) AS relation", [table]).fetchone()
    return bool(row and row["relation"])


def semantic_schema_available(conn, tables: Sequence[str] = _DECISION_TABLES) -> bool:
    return all(_table_exists(conn, table) for table in tables)


def contract_schema_available(conn) -> bool:
    return all(_table_exists(conn, table) for table in _CONTRACT_TABLES)


def graph_schema_available(conn) -> bool:
    return all(_table_exists(conn, table) for table in _GRAPH_TABLES)


def _direction(classification: Optional[str]) -> int:
    value = (classification or "").casefold()
    if "buy" in value:
        return 1
    if "sell" in value:
        return -1
    return 0


def decision_key(rec: Dict[str, Any]) -> str:
    return f"unified:{rec['symbol']}:{rec['computed_at']}:{rec['generated_at']}"


def _finite(value: Any) -> Optional[float]:
    if value is None:
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


def _component_relation(value: float, direction: int) -> str:
    if direction == 0 or value == 50.0:
        return "context"
    aligned = value >= 50.0 if direction > 0 else value <= 50.0
    return "supports" if aligned else "contradicts"


def build_decision_evidence(rec: Dict[str, Any]) -> List[Dict[str, Any]]:
    """Return structured, non-causal support/context/contradiction rows."""
    # Lazy import (AF-20260927-10): unified_ranker is the source of truth for how many engines
    # actually carry nonzero weight -- avoids a hardcoded count silently drifting from it again,
    # and matches this module's existing pattern of deferring heavy cross-module imports.
    from unified_ranker import FULL_ENGINE_COVERAGE
    direction = _direction(rec.get("classification"))
    rows: List[Dict[str, Any]] = []
    for field, engine in _COMPONENTS:
        value = _finite(rec.get(field))
        if value is None:
            continue
        rows.append({
            "evidence_key": f"component:{engine}",
            "relation": _component_relation(value, direction),
            "evidence_type": "component_score",
            "metric": field,
            "value_json": _json({"value": value, "scale": "0-100"}),
            "source_table": "unified_recommendations",
            "source_ref": f"{rec['symbol']}:{rec['computed_at']}",
            "confidence_kind": "component_score_not_probability",
            "note": f"{engine} component; not an independent causal fact",
        })

    bull = _finite(rec.get("bullish_screener_count")) or 0.0
    bear = _finite(rec.get("bearish_screener_count")) or 0.0
    if bull or bear:
        aligned_count = bull if direction >= 0 else bear
        opposed_count = bear if direction >= 0 else bull
        rows.append({
            "evidence_key": "screener:direction-counts",
            "relation": "supports" if direction and aligned_count > opposed_count else "contradicts" if direction and opposed_count > aligned_count else "context",
            "evidence_type": "vendor_opinion_aggregate",
            "metric": "bullish_screener_count/bearish_screener_count",
            "value_json": _json({"bullish": bull, "bearish": bear}),
            "source_table": "unified_recommendations",
            "source_ref": f"{rec['symbol']}:{rec['computed_at']}",
            "confidence_kind": "vendor_opinion_not_ground_truth",
            "note": "Screener direction is candidate-generation evidence, never ground truth",
        })

    coverage = _finite(rec.get("engine_coverage_count"))
    if coverage is not None:
        rows.append({
            "evidence_key": "context:engine-coverage",
            "relation": "context",
            "evidence_type": "coverage",
            "metric": "engine_coverage_count",
            "value_json": _json({"value": coverage, "engines_present": coverage,
                                  "engines_configured": FULL_ENGINE_COVERAGE}),
            "source_table": "unified_recommendations",
            "source_ref": f"{rec['symbol']}:{rec['computed_at']}",
            "confidence_kind": "metadata",
            "note": "Coverage is a confidence/veto input, not market evidence",
        })
    return rows


def _quality_snapshot(conn) -> Dict[str, Any]:
    if not _table_exists(conn, "data_quality_results"):
        return {"status": "unavailable", "checks": []}
    rows = conn.execute(
        "SELECT check_id, status, detail, checked_at FROM data_quality_results "
        "WHERE critical = 1 ORDER BY check_id"
    ).fetchall()
    checks = [dict(row) for row in rows]
    statuses = {str(row.get("status", "")).upper() for row in checks}
    status = "fail" if statuses & {"FAIL", "ERROR"} else "warn" if "WARN" in statuses else "pass" if checks else "unknown"
    return {"status": status, "checked_at": datetime.now(timezone.utc).isoformat(), "checks": checks}


def _watermark_snapshot(conn) -> Dict[str, Any]:
    if not _table_exists(conn, "market_data_watermark"):
        return {"status": "unavailable", "datasets": {}}
    rows = conn.execute(
        "SELECT dataset, partition_key, as_of, completeness_status, input_watermark, "
        "output_watermark, rejected_rows, source_version, recorded_at "
        "FROM market_data_watermark ORDER BY dataset, partition_key"
    ).fetchall()
    datasets: Dict[str, Any] = {}
    for row in rows:
        item = dict(row)
        key = str(item.pop("dataset"))
        item["as_of"] = str(item["as_of"]) if item.get("as_of") is not None else None
        item["recorded_at"] = str(item["recorded_at"]) if item.get("recorded_at") is not None else None
        datasets.setdefault(key, []).append(item)
    statuses = {str(row.get("completeness_status")) for row in rows}
    overall = "blocked" if "blocked" in statuses else "partial" if "partial" in statuses else "complete" if rows else "unknown"
    return {"status": overall, "datasets": datasets}


def _active_model_versions(conn) -> List[Dict[str, Any]]:
    if not _table_exists(conn, "model_registry"):
        return []
    rows = conn.execute(
        "SELECT model_name, model_version, model_type, horizon_days, cv_roc_auc, test_roc_auc "
        "FROM model_registry WHERE is_active = 1 ORDER BY model_name"
    ).fetchall()
    return [dict(row) for row in rows]


def _guardrails(rec: Dict[str, Any], quality: Dict[str, Any], models: Sequence[Dict[str, Any]]) -> List[str]:
    guardrails = [
        "unified_score_is_not_probability",
        "generated_reasoning_is_not_evidence",
        "vendor_count_is_not_independent_evidence_count",
    ]
    coverage = _finite(rec.get("engine_coverage_count"))
    if coverage is not None and coverage < 2:
        guardrails.append("insufficient_engine_coverage")
    if quality.get("status") in {"fail", "error"}:
        guardrails.append("critical_data_quality_failure")
    if not models:
        guardrails.append("no_active_model_version_attached")
    return guardrails



def _event_row(rec: Dict[str, Any], quality: Dict[str, Any], watermarks: Dict[str, Any], models: Sequence[Dict[str, Any]]) -> Tuple[Any, ...]:
    key = decision_key(rec)
    generated_at = rec.get("generated_at")
    if isinstance(generated_at, str):
        generated_at = datetime.fromisoformat(generated_at.replace("Z", "+00:00"))
    if generated_at is None:
        generated_at = datetime.now(timezone.utc)
    return (
        key, rec["symbol"], rec["computed_at"], generated_at, generated_at,
        "generation_upper_bound", "unified_recommendations", f"{rec['symbol']}:{rec['computed_at']}",
        RANKER_POLICY_VERSION, FEATURE_SET_VERSION, _json(list(models)), rec.get("unified_score"),
        rec.get("classification"), rec.get("timeframe"), "advisory", _json(quality),
        _json(watermarks), _json([]), _json(_guardrails(rec, quality, models)),
    )


def persist_decision_evidence_bundles(conn, recommendations: Iterable[Dict[str, Any]]) -> int:
    """Persist recommendation evidence without changing the canonical ranker result.

    The function intentionally does not commit. The caller owns the surrounding
    transaction, so a failed evidence write can be surfaced and rolled back by
    the job without silently making the decision table look complete.
    """
    if not semantic_schema_available(conn):
        return 0
    quality = _quality_snapshot(conn)
    watermarks = _watermark_snapshot(conn)
    models = _active_model_versions(conn)
    recs = list(recommendations)
    event_rows = []
    evidence_rows: List[Tuple[Any, ...]] = []
    for rec in recs:
        if not rec.get("symbol") or not rec.get("computed_at") or not rec.get("generated_at"):
            continue
        event_rows.append(_event_row(rec, quality, watermarks, models))
        key = decision_key(rec)
        observed_at = rec["generated_at"]
        for item in build_decision_evidence(rec):
            evidence_rows.append((
                key, item["evidence_key"], item["relation"], item["evidence_type"], item["metric"],
                item["value_json"], item["source_table"], item["source_ref"], observed_at, observed_at,
                item["confidence_kind"], item["note"],
            ))
    if event_rows:
        conn.executemany(
            """INSERT INTO market_decision_event
               (decision_key, symbol, computed_at, generated_at, knowledge_cutoff,
                knowledge_cutoff_kind, source_table, source_key, ranker_policy_version,
                feature_set_version, model_versions, score, classification, timeframe,
                decision_status, quality_snapshot, data_watermarks, veto_reasons, guardrails)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CAST(? AS jsonb), ?, ?, ?, ?, CAST(? AS jsonb),
                       CAST(? AS jsonb), CAST(? AS jsonb), CAST(? AS jsonb))
               ON CONFLICT (decision_key) DO UPDATE SET
                 generated_at=excluded.generated_at, knowledge_cutoff=excluded.knowledge_cutoff,
                 model_versions=excluded.model_versions, score=excluded.score,
                 classification=excluded.classification, timeframe=excluded.timeframe,
                 quality_snapshot=excluded.quality_snapshot, data_watermarks=excluded.data_watermarks,
                 guardrails=excluded.guardrails""",
            event_rows,
        )

    if evidence_rows:
        conn.executemany(
            """INSERT INTO market_decision_evidence
               (decision_key, evidence_key, relation, evidence_type, metric, value_json,
                source_table, source_ref, observed_at, available_at, confidence_kind, note)
               VALUES (?, ?, ?, ?, ?, CAST(? AS jsonb), ?, ?, ?, ?, ?, ?)
               ON CONFLICT (decision_key, evidence_key) DO UPDATE SET
                 relation=excluded.relation, evidence_type=excluded.evidence_type,
                 metric=excluded.metric, value_json=excluded.value_json,
                 source_table=excluded.source_table, source_ref=excluded.source_ref,
                 observed_at=excluded.observed_at,
                 confidence_kind=excluded.confidence_kind, note=excluded.note""",
            evidence_rows,
        )
    if _table_exists(conn, "market_data_watermark"):
        first = recs[0] if recs else {}
        record_dataset_watermark(
            conn,
            dataset="unified_recommendations",
            partition_key=str(first.get("computed_at", "ALL")),
            completeness_status="complete" if recs else "partial",
            as_of=first.get("computed_at"),
            output_watermark=first.get("generated_at"),
            expected_rows=len(recs),
            accepted_rows=len(recs),
            rejected_rows=0,
            source_version=RANKER_POLICY_VERSION,
            run_ref=first.get("generated_at"),
        )
    return len(event_rows)


def record_dataset_watermark(
    conn,
    *,
    dataset: str,
    partition_key: str = "ALL",
    completeness_status: str,
    as_of: Optional[str] = None,
    input_watermark: Optional[str] = None,
    output_watermark: Optional[str] = None,
    expected_rows: Optional[int] = None,
    accepted_rows: Optional[int] = None,
    rejected_rows: Optional[int] = None,
    source_version: Optional[str] = None,
    run_ref: Optional[str] = None,
) -> None:
    """Publish producer completeness, not merely the newest row timestamp."""
    if not _table_exists(conn, "market_data_watermark"):
        raise RuntimeError("market data watermark schema is not installed")
    conn.execute(
        """INSERT INTO market_data_watermark
           (dataset, partition_key, as_of, input_watermark, output_watermark,
            expected_rows, accepted_rows, rejected_rows, completeness_status,
            source_version, run_ref, recorded_at)
           VALUES (?, ?, CAST(? AS timestamptz), ?, ?, ?, ?, ?, ?, ?, ?, now())
           ON CONFLICT (dataset, partition_key) DO UPDATE SET
             as_of=excluded.as_of, input_watermark=excluded.input_watermark,
             output_watermark=excluded.output_watermark, expected_rows=excluded.expected_rows,
             accepted_rows=excluded.accepted_rows, rejected_rows=excluded.rejected_rows,
             completeness_status=excluded.completeness_status,
             source_version=excluded.source_version, run_ref=excluded.run_ref,
             recorded_at=now()""",
        [dataset, partition_key, as_of, input_watermark, output_watermark,
         expected_rows, accepted_rows, rejected_rows, completeness_status,
         source_version, run_ref],
    )


def record_decision_outcome(
    conn,
    *,
    decision: str,
    label_definition: str,
    horizon_days: int,
    outcome_status: str = "pending",
    entry_price: Optional[float] = None,
    exit_price: Optional[float] = None,
    return_pct: Optional[float] = None,
    mfe_pct: Optional[float] = None,
    mae_pct: Optional[float] = None,
    resolved_at: Optional[str] = None,
    source_table: Optional[str] = None,
    source_ref: Optional[str] = None,
) -> None:
    """Attach a versioned realized outcome without merging label definitions."""
    if not semantic_schema_available(conn):
        raise RuntimeError("market decision schema is not installed")
    conn.execute(
        """INSERT INTO market_decision_outcome
           (decision_key, label_definition, horizon_days, outcome_status, entry_price,
            exit_price, return_pct, mfe_pct, mae_pct, resolved_at, source_table, source_ref)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CAST(? AS timestamptz), ?, ?)
           ON CONFLICT (decision_key, label_definition, horizon_days) DO UPDATE SET
             outcome_status=excluded.outcome_status, entry_price=excluded.entry_price,
             exit_price=excluded.exit_price, return_pct=excluded.return_pct,
             mfe_pct=excluded.mfe_pct, mae_pct=excluded.mae_pct,
             resolved_at=excluded.resolved_at, source_table=excluded.source_table,
             source_ref=excluded.source_ref""",
        [decision, label_definition, int(horizon_days), outcome_status, entry_price,
         exit_price, return_pct, mfe_pct, mae_pct, resolved_at, source_table, source_ref],
    )


def _fallback_recommendation(symbol: str) -> Optional[Dict[str, Any]]:
    conn = connect()
    try:
        row = conn.execute(
            "SELECT symbol, computed_at, generated_at, unified_score, classification, "
            "conviction_level, timeframe, trade_reasoning FROM unified_recommendations "
            "WHERE symbol = ? ORDER BY generated_at DESC NULLS LAST LIMIT 1",
            [symbol],
        ).fetchone()
        return dict(row) if row else None
    except Exception:
        try:
            conn.rollback()
        except Exception:
            pass
        return None
    finally:
        conn.close()


def get_decision_evidence(symbol: str, decision: Optional[str] = None) -> Dict[str, Any]:
    """Read a decision bundle; fall back honestly when the new ledger is absent."""
    normalized = (symbol or "").upper().strip()
    if not _SYMBOL_RE.fullmatch(normalized):
        return {"status": "invalid", "error": "symbol must be an exchange ticker", "symbol": symbol}
    conn = connect()
    try:
        if not semantic_schema_available(conn):
            return {
                "status": "fallback",
                "reason": "semantic decision ledger is not installed",
                "recommendation": _fallback_recommendation(normalized),
                "limitations": ["No structured evidence bundle exists for this recommendation yet."],
            }
        if decision:
            event = conn.execute(
                "SELECT * FROM market_decision_event WHERE decision_key = ? AND symbol = ?",
                [decision, normalized],
            ).fetchone()
        else:
            event = conn.execute(
                "SELECT * FROM market_decision_event WHERE symbol = ? "
                "ORDER BY generated_at DESC LIMIT 1", [normalized]
            ).fetchone()
        if not event:
            return {
                "status": "not_found",
                "symbol": normalized,
                "recommendation": _fallback_recommendation(normalized),
            }
        evidence = conn.execute(
            "SELECT evidence_key, relation, evidence_type, metric, value_json, source_table, "
            "source_ref, observed_at, available_at, confidence_kind, note "
            "FROM market_decision_evidence WHERE decision_key = ? "
            "ORDER BY relation, evidence_key", [event["decision_key"]]
        ).fetchall()
        outcomes = conn.execute(
            "SELECT label_definition, horizon_days, outcome_status, entry_price, exit_price, "
            "return_pct, mfe_pct, mae_pct, resolved_at, source_table, source_ref "
            "FROM market_decision_outcome WHERE decision_key = ? "
            "ORDER BY horizon_days, label_definition", [event["decision_key"]]
        ).fetchall()
        return {
            "status": "ok",
            "decision": dict(event),
            "evidence": [dict(row) for row in evidence],
            "outcomes": [dict(row) for row in outcomes],
        }
    finally:
        conn.close()


def ontology_context(question: str, max_chars: int = 2500) -> Dict[str, Any]:
    """Return the deterministic ontology context pack used by agents."""
    from ontology import ai, build_ontology
    return ai.context_report(build_ontology(), question, max_chars=max_chars)



def upsert_market_entity(
    conn,
    node_key: str,
    node_type: str,
    label: str,
    *,
    canonical_symbol: Optional[str] = None,
    attributes: Optional[Dict[str, Any]] = None,
    valid_from: Optional[str] = None,
    valid_to: Optional[str] = None,
    available_at: Optional[str] = None,
    source: str,
    source_ref: Optional[str] = None,
    revision: Optional[str] = None,
) -> int:
    """Upsert one canonical graph entity and return its stable database id."""
    if not graph_schema_available(conn):
        raise RuntimeError("market graph schema is not installed")
    row = conn.execute(
        """INSERT INTO market_graph_node
           (node_key, node_type, label, canonical_symbol, attributes, valid_from, valid_to,
            available_at, source, source_ref, revision)
           VALUES (?, ?, ?, ?, CAST(? AS jsonb), ?, ?, COALESCE(CAST(? AS timestamptz), now()), ?, ?, ?)
           ON CONFLICT (node_type, node_key) DO UPDATE SET
             label=excluded.label, canonical_symbol=excluded.canonical_symbol,
             attributes=excluded.attributes, valid_from=excluded.valid_from,
             valid_to=excluded.valid_to,
             source=excluded.source, source_ref=excluded.source_ref, revision=excluded.revision
           RETURNING node_id""",
        [node_key, node_type, label, canonical_symbol, _json(attributes or {}), valid_from,
         valid_to, available_at, source, source_ref, revision],
    ).fetchone()
    return int(row["node_id"])


def record_market_evidence(
    conn,
    *,
    evidence_key: str,
    source_type: str,
    content: Dict[str, Any],
    source_ref: Optional[str] = None,
    source_uri: Optional[str] = None,
    content_hash: Optional[str] = None,
    observed_at: Optional[str] = None,
    available_at: Optional[str] = None,
    extraction_method: Optional[str] = None,
    extraction_version: Optional[str] = None,
    quality_status: str = "unverified",
) -> str:
    """Persist source evidence separately from the claim it may support."""
    if not graph_schema_available(conn):
        raise RuntimeError("market graph schema is not installed")
    conn.execute(
        """INSERT INTO market_evidence
           (evidence_key, source_type, source_ref, source_uri, content_hash, content,
            observed_at, available_at, extraction_method, extraction_version, quality_status)
           VALUES (?, ?, ?, ?, ?, CAST(? AS jsonb), ?, COALESCE(CAST(? AS timestamptz), now()),
                   ?, ?, ?)
           ON CONFLICT (evidence_key) DO UPDATE SET
             source_type=excluded.source_type, source_ref=excluded.source_ref,
             source_uri=excluded.source_uri, content_hash=excluded.content_hash,
             content=excluded.content, observed_at=excluded.observed_at,
             extraction_method=excluded.extraction_method,
             extraction_version=excluded.extraction_version, quality_status=excluded.quality_status""",
        [evidence_key, source_type, source_ref, source_uri, content_hash, _json(content),
         observed_at, available_at, extraction_method, extraction_version, quality_status],
    )
    return evidence_key


def record_market_fact(
    conn,
    *,
    assertion_key: str,
    from_node: Dict[str, Any],
    predicate: str,
    object_value: Any,
    source: str,
    source_ref: Optional[str] = None,
    available_at: Optional[str] = None,
    valid_from: Optional[str] = None,
    valid_to: Optional[str] = None,
) -> None:
    """Record a typed, bitemporal edge; source tables remain authoritative."""
    if not graph_schema_available(conn):
        raise RuntimeError("market graph schema is not installed")
    from_id = upsert_market_entity(conn, source=source, source_ref=source_ref, available_at=available_at, **from_node)
    row = conn.execute(
        """INSERT INTO market_graph_edge
           (from_node_id, predicate, object_value, valid_from, valid_to, available_at,
            source, source_ref, assertion_key)
           VALUES (?, ?, CAST(? AS jsonb), ?, ?, COALESCE(CAST(? AS timestamptz), now()), ?, ?, ?)
           ON CONFLICT (assertion_key) DO UPDATE SET
             from_node_id=excluded.from_node_id, predicate=excluded.predicate,
             object_value=excluded.object_value, valid_from=excluded.valid_from,
             valid_to=excluded.valid_to,
             source=excluded.source, source_ref=excluded.source_ref
           RETURNING edge_id""",
        [from_id, predicate, _json(object_value), valid_from, valid_to, available_at,
         source, source_ref, assertion_key],
    ).fetchone()
    if not row or row["edge_id"] is None:
        raise RuntimeError("market fact insert did not return an edge id")


def record_market_claim(
    conn,
    *,
    claim_key: str,
    subject_node: Dict[str, Any],
    predicate: str,
    object_value: Any,
    method: str,
    stance: str = "unknown",
    claim_status: str = "ungraded",
    horizon: Optional[str] = None,
    available_at: Optional[str] = None,
    source: str,
    source_ref: Optional[str] = None,
) -> str:
    """Record an explicit claim; it remains ungraded unless evidence says otherwise."""
    if not graph_schema_available(conn):
        raise RuntimeError("market graph schema is not installed")
    subject_id = upsert_market_entity(
        conn, source=source, source_ref=source_ref, available_at=available_at, **subject_node
    )
    conn.execute(
        """INSERT INTO market_claim
           (claim_key, subject_node_id, predicate, object_value, horizon, stance,
            claim_status, method, available_at)
           VALUES (?, ?, ?, CAST(? AS jsonb), ?, ?, ?, ?, COALESCE(CAST(? AS timestamptz), now()))
           ON CONFLICT (claim_key) DO UPDATE SET
             subject_node_id=excluded.subject_node_id, predicate=excluded.predicate,
             object_value=excluded.object_value, horizon=excluded.horizon,
             stance=excluded.stance, claim_status=excluded.claim_status,
             method=excluded.method""",
        [claim_key, subject_id, predicate, _json(object_value), horizon, stance,
         claim_status, method, available_at],
    )
    return claim_key


def link_claim_evidence(
    conn, claim_key: str, evidence_key: str, relation: str, contribution: Optional[float] = None, note: str = ""
) -> None:
    conn.execute(
        """INSERT INTO market_claim_evidence (claim_key, evidence_key, relation, contribution, note)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT (claim_key, evidence_key) DO UPDATE SET
             relation=excluded.relation, contribution=excluded.contribution, note=excluded.note""",
        [claim_key, evidence_key, relation, contribution, note],
    )


def get_entity_neighborhood(
    conn,
    node_key: str,
    node_type: str,
    limit: int = 100,
    as_of: Optional[str] = None,
) -> Dict[str, Any]:
    """Read a bounded graph neighborhood without exposing arbitrary SQL."""
    if not graph_schema_available(conn):
        return {"status": "unavailable", "reason": "market graph schema is not installed"}
    node_params: List[Any] = [node_type, node_key]
    node_filter = "node_type = ? AND node_key = ?"
    if as_of:
        node_filter += (
            " AND available_at <= CAST(? AS timestamptz)"
            " AND (valid_from IS NULL OR valid_from <= CAST(? AS timestamptz))"
            " AND (valid_to IS NULL OR valid_to > CAST(? AS timestamptz))"
        )
        node_params.extend([as_of, as_of, as_of])
    node = conn.execute(
        "SELECT node_id, node_key, node_type, label, canonical_symbol, attributes, "
        "valid_from, valid_to, available_at, source, source_ref "
        f"FROM market_graph_node WHERE {node_filter}",
        node_params,
    ).fetchone()
    if not node:
        return {"status": "not_found", "node_key": node_key, "node_type": node_type}
    edge_filter = ""
    edge_params: List[Any] = []
    if as_of:
        edge_filter = (
            " AND e.available_at <= CAST(? AS timestamptz)"
            " AND (e.valid_from IS NULL OR e.valid_from <= CAST(? AS timestamptz))"
            " AND (e.valid_to IS NULL OR e.valid_to > CAST(? AS timestamptz))"
        )
        edge_params.extend([as_of, as_of, as_of])
    outgoing = conn.execute(
        "SELECT e.predicate, e.object_value, e.valid_from, e.valid_to, e.available_at, "
        "e.source, e.source_ref, n.node_key AS target_key, n.node_type AS target_type "
        "FROM market_graph_edge e LEFT JOIN market_graph_node n ON n.node_id = e.to_node_id "
        f"WHERE e.from_node_id = ?{edge_filter} "
        "ORDER BY e.predicate, e.assertion_key LIMIT ?",
        [node["node_id"], *edge_params, max(1, min(int(limit), 500))],
    ).fetchall()
    incoming = conn.execute(
        "SELECT e.predicate, e.object_value, e.valid_from, e.valid_to, e.available_at, "
        "e.source, e.source_ref, n.node_key AS source_key, n.node_type AS source_type "
        "FROM market_graph_edge e JOIN market_graph_node n ON n.node_id = e.from_node_id "
        f"WHERE e.to_node_id = ?{edge_filter} "
        "ORDER BY e.predicate, e.assertion_key LIMIT ?",
        [node["node_id"], *edge_params, max(1, min(int(limit), 500))],
    ).fetchall()
    return {
        "status": "ok",
        "node": dict(node),
        "outgoing": [dict(row) for row in outgoing],
        "incoming": [dict(row) for row in incoming],
    }


def get_entity_graph(symbol: str, limit: int = 100, as_of: Optional[str] = None) -> Dict[str, Any]:
    """Return a bounded canonical identity neighborhood for one ticker."""
    if not _SYMBOL_RE.fullmatch(symbol):
        return {"status": "invalid", "error": "symbol must be an exchange ticker"}
    conn = connect()
    try:
        if not graph_schema_available(conn):
            return {"status": "unavailable", "reason": "market graph schema is not installed"}
        node = conn.execute(
            "SELECT node_key FROM market_graph_node WHERE node_type = 'instrument' "
            "AND canonical_symbol = ? "
            + (
                "AND available_at <= CAST(? AS timestamptz) "
                "AND (valid_from IS NULL OR valid_from <= CAST(? AS timestamptz)) "
                "AND (valid_to IS NULL OR valid_to > CAST(? AS timestamptz)) "
                if as_of else ""
            )
            + "ORDER BY node_id LIMIT 1",
            [symbol, as_of, as_of, as_of] if as_of else [symbol],
        ).fetchone()
        if not node:
            return {"status": "not_found", "symbol": symbol}
        return get_entity_neighborhood(conn, node["node_key"], "instrument", limit, as_of=as_of)
    finally:
        conn.close()

