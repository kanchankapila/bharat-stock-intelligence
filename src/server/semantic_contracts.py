"""Materialize the authored ontology as executable data contracts."""
from __future__ import annotations

import json
from typing import Any, Dict, Optional

from db_compat import connect
from semantic_evidence import contract_schema_available


def _json(value: Any) -> str:
    return json.dumps(value, default=str, sort_keys=True)


def _card_payload(card) -> Dict[str, Any]:
    return {
        "description": card.description,
        "primary_key": list(card.pk),
        "freshness_column": card.freshness_column,
        "expected_lag_hours": card.expected_lag_hours,
        "writers": list(card.writers),
        "caveats": list(card.caveats),
        "forbidden_columns": list(card.forbidden_columns),
        "retention_note": card.retention_note,
        "uri": card.uri,
    }


def sync_ontology_contracts(conn=None, onto=None) -> Dict[str, Any]:
    """Upsert data-card contracts and property/feature definitions.

    The caller owns the connection and transaction. Missing tables are a
    deliberate no-op so ontology export remains usable before deployment of the
    additive migration.
    """
    owns = conn is None
    if owns:
        conn = connect()
    try:
        if not contract_schema_available(conn):
            return {"status": "unavailable", "datasets": 0, "features": 0}
        if onto is None:
            from ontology import build_ontology
            onto = build_ontology()

        # Older definitions remain queryable, but only the current release is active.
        for card in onto.cards:
            conn.execute(
                "UPDATE market_data_contract SET active = FALSE, updated_at = now() "
                "WHERE dataset = ? AND version <> ?",
                [card.table, onto.version],
            )
        conn.execute(
            """INSERT INTO market_data_contract
                   (contract_key, dataset, version, grain, cadence, unit, time_semantics,
                    source_kind, training_use, ontology_version, contract, active, updated_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CAST(? AS jsonb), TRUE, now())
                   ON CONFLICT (contract_key) DO UPDATE SET
                     grain=excluded.grain, cadence=excluded.cadence, unit=excluded.unit,
                     time_semantics=excluded.time_semantics, source_kind=excluded.source_kind,
                     training_use=excluded.training_use, ontology_version=excluded.ontology_version,
                     contract=excluded.contract, active=TRUE, updated_at=now()""",
                [
                    f"ontology:{card.table}:{onto.version}", card.table, onto.version,
                    card.grain, card.cadence, None, "see_contract_caveats", "ontology_data_card",
                    card.training_use, onto.version, _json(_card_payload(card)),
                ],
            )

        for prop in onto.properties:
            conn.execute(
                "UPDATE semantic_feature_definition SET active = FALSE, updated_at = now() "
                "WHERE property_name = ? AND version <> ?",
                [prop.name, onto.version],
            )
            bindings = [
                {"table": b.table, "column": b.column, "note": b.note}
                for b in onto.bindings_for_property(prop.name)
            ]
            conn.execute(
                """INSERT INTO semantic_feature_definition
                   (feature_key, property_name, version, description, semantic_type, datatype,
                    unit, timing, derivation, leakage_risk, pit_notes, physical_bindings,
                    usable_as_feature, is_label, active, updated_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CAST(? AS jsonb), ?, ?, TRUE, now())
                   ON CONFLICT (feature_key) DO UPDATE SET
                     description=excluded.description, semantic_type=excluded.semantic_type,
                     datatype=excluded.datatype, unit=excluded.unit, timing=excluded.timing,
                     derivation=excluded.derivation, leakage_risk=excluded.leakage_risk,
                     pit_notes=excluded.pit_notes, physical_bindings=excluded.physical_bindings,
                     usable_as_feature=excluded.usable_as_feature, is_label=excluded.is_label,
                     active=TRUE, updated_at=now()""",
                [
                    f"{prop.name}:{onto.version}", prop.name, onto.version, prop.description,
                    prop.semantic_type, prop.datatype, prop.unit, prop.timing, prop.derivation,
                    prop.leakage_risk, prop.pit_notes, _json(bindings), prop.is_feature, prop.is_label,
                ],
            )
        return {"status": "ok", "datasets": len(onto.cards), "features": len(onto.properties)}
    finally:
        if owns:
            conn.commit()
            conn.close()
