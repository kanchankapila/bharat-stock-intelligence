"""
Materialize the ontology into Postgres — the semantic layer becomes queryable SQL.

An LLM prompt pack and a Turtle file serve an agent and an RDF consumer. Neither serves the
people and jobs already speaking SQL in this repo, who need to answer:

    "which columns on `stock_ohlcv` may I use as features, and which are labels?"
    "what is the grain of `unified_recommendations` and who writes it?"
    "which vocabulary governs `conviction_level`, and what does each term mean?"

`kg_*` tables hold the layer; `kg_v_*` views are the read surface, so consumers never need to
know the normal form. Everything is derived: `reset()` drops and rebuilds, and a `schema_version`
row in `kg_meta` records which ontology version produced the data.

Identifiers are unqualified on purpose — the connection's `search_path` decides where they
land. Tests get a throwaway schema for free (see `conftest.py`), and production writes to
`public`.
"""
import json
from typing import Any, Dict, List, Optional, Sequence, Tuple

from . import alignment, vocab
from .model import Ontology

#: Bump when `_DDL` changes shape; `reset()` is then required before `sync()` will work again.
SCHEMA_VERSION = "1"

_VIEWS = (
    "kg_v_class",
    "kg_v_column",
    "kg_v_feature",
    "kg_v_never_feature",
    "kg_v_dataset",
    "kg_v_metric",
    "kg_v_relation",
    "kg_v_term",
    "kg_v_guardrail",
)

_DDL = (
    """CREATE TABLE IF NOT EXISTS kg_class (
        name text PRIMARY KEY,
        label text NOT NULL,
        layer text NOT NULL,
        description text NOT NULL,
        grain text NOT NULL DEFAULT '',
        key_properties text[] NOT NULL DEFAULT '{}',
        parents text[] NOT NULL DEFAULT '{}',
        caveats text[] NOT NULL DEFAULT '{}',
        uri text NOT NULL,
        realization text NOT NULL DEFAULT 'table'
    )""",
    """CREATE TABLE IF NOT EXISTS kg_property (
        name text PRIMARY KEY,
        label text NOT NULL,
        semantic_type text NOT NULL,
        description text NOT NULL,
        datatype text NOT NULL,
        unit text,
        timing text NOT NULL,
        derivation text NOT NULL,
        leakage_risk text NOT NULL,
        vocabulary text,
        point_in_time_note text NOT NULL DEFAULT '',
        synonyms text[] NOT NULL DEFAULT '{}',
        usable_as_feature boolean NOT NULL,
        is_label boolean NOT NULL,
        uri text NOT NULL
    )""",
    """CREATE TABLE IF NOT EXISTS kg_card (
        table_name text PRIMARY KEY,
        label text NOT NULL,
        entity text NOT NULL,
        grain text NOT NULL,
        primary_key text[] NOT NULL DEFAULT '{}',
        description text NOT NULL,
        cadence text NOT NULL,
        freshness_column text,
        expected_lag_hours real,
        writers text[] NOT NULL DEFAULT '{}',
        caveats text[] NOT NULL DEFAULT '{}',
        training_use text NOT NULL,
        forbidden_columns text[] NOT NULL DEFAULT '{}',
        retention_note text NOT NULL DEFAULT '',
        uri text NOT NULL
    )""",
    """CREATE TABLE IF NOT EXISTS kg_binding (
        table_name text NOT NULL,
        column_name text NOT NULL,
        property_name text NOT NULL,
        note text NOT NULL DEFAULT '',
        PRIMARY KEY (table_name, column_name)
    )""",
    """CREATE TABLE IF NOT EXISTS kg_relation (
        name text PRIMARY KEY,
        label text NOT NULL,
        domain_class text NOT NULL,
        range_class text NOT NULL,
        cardinality text NOT NULL,
        description text NOT NULL,
        realized_by text[] NOT NULL DEFAULT '{}',
        join_keys text[] NOT NULL DEFAULT '{}',
        graded_status text NOT NULL,
        evidence text NOT NULL DEFAULT '',
        traversal text NOT NULL DEFAULT '',
        uri text NOT NULL
    )""",
    """CREATE TABLE IF NOT EXISTS kg_metric (
        name text PRIMARY KEY,
        label text NOT NULL,
        description text NOT NULL,
        sql_text text NOT NULL,
        entity text NOT NULL,
        source_tables text[] NOT NULL DEFAULT '{}',
        unit text,
        grain text NOT NULL DEFAULT '',
        cadence text NOT NULL DEFAULT '',
        timing text NOT NULL,
        derivation text NOT NULL,
        leakage_risk text NOT NULL,
        graded_status text NOT NULL,
        graded_evidence text NOT NULL DEFAULT '',
        cheap_to_run boolean NOT NULL,
        caveats text[] NOT NULL DEFAULT '{}',
        synonyms text[] NOT NULL DEFAULT '{}',
        params text[] NOT NULL DEFAULT '{}',
        uri text NOT NULL
    )""",


    """CREATE TABLE IF NOT EXISTS kg_vocabulary (
        name text PRIMARY KEY,
        description text NOT NULL,
        source text NOT NULL,
        open_ended boolean NOT NULL,
        term_count integer NOT NULL,
        uri text NOT NULL
    )""",
    """CREATE TABLE IF NOT EXISTS kg_term (
        vocabulary text NOT NULL,
        notation text NOT NULL,
        label text NOT NULL,
        definition text NOT NULL,
        broader text,
        PRIMARY KEY (vocabulary, notation)
    )""",
    """CREATE TABLE IF NOT EXISTS kg_alignment (
        subject text NOT NULL,
        predicate text NOT NULL,
        object_iri text NOT NULL,
        rationale text NOT NULL DEFAULT '',
        strength text NOT NULL,
        verified_from text NOT NULL DEFAULT '',
        emitted boolean NOT NULL,
        PRIMARY KEY (subject, object_iri)
    )""",
    """CREATE TABLE IF NOT EXISTS kg_guardrail (
        ordinal integer PRIMARY KEY,
        rule text NOT NULL
    )""",
    """CREATE TABLE IF NOT EXISTS kg_meta (
        key text PRIMARY KEY,
        value text NOT NULL
    )""",
)

_VIEW_DDL = (
    """CREATE VIEW kg_v_class AS
    SELECT c.name, c.label, c.layer, c.realization, c.grain, c.key_properties, c.parents,
           c.caveats, c.uri,
           (SELECT count(*) FROM kg_card k WHERE k.entity = c.name) AS realized_by_tables
    FROM kg_class c""",
    """CREATE VIEW kg_v_column AS
    SELECT b.table_name, b.column_name, b.property_name, p.label AS property_label,
           p.semantic_type, p.datatype, p.unit, p.timing, p.derivation, p.leakage_risk,
           p.vocabulary, p.usable_as_feature, p.is_label, p.point_in_time_note,
           c.label AS table_label, c.entity, c.grain AS table_grain, c.cadence,
           c.training_use, c.caveats AS table_caveats, b.note
    FROM kg_binding b
    JOIN kg_property p ON p.name = b.property_name
    JOIN kg_card c ON c.table_name = b.table_name""",
    """CREATE VIEW kg_v_feature AS
    SELECT table_name, column_name, property_name, property_label, semantic_type, unit, timing,
            is_label, leakage_risk, training_use
    FROM kg_v_column
    WHERE usable_as_feature
      AND training_use NOT IN ('labels', 'forbidden')""",
    """CREATE VIEW kg_v_never_feature AS
    SELECT table_name, column_name, property_name, semantic_type, unit, leakage_risk,
           is_label, training_use, table_caveats
    FROM kg_v_column
    WHERE is_label OR leakage_risk IN ('target', 'high') OR training_use = 'forbidden'""",
    """CREATE VIEW kg_v_dataset AS
    SELECT c.table_name, c.label, c.entity, c.grain, c.cadence, c.freshness_column,
           c.expected_lag_hours, c.training_use, c.writers, c.caveats,
           count(b.column_name) AS bound_columns,
           count(*) FILTER (WHERE p.usable_as_feature) AS feature_columns
    FROM kg_card c
    LEFT JOIN kg_binding b ON b.table_name = c.table_name
    LEFT JOIN kg_property p ON p.name = b.property_name
    GROUP BY c.table_name, c.label, c.entity, c.grain, c.cadence, c.freshness_column,
             c.expected_lag_hours, c.training_use, c.writers, c.caveats""",
    """CREATE VIEW kg_v_metric AS
    SELECT name, label, description, entity, unit, grain, cadence, timing, derivation,
           leakage_risk, graded_status, graded_evidence, cheap_to_run, source_tables,
           params, sql_text, caveats, synonyms
    FROM kg_metric""",
    """CREATE VIEW kg_v_relation AS
    SELECT name, label, domain_class, range_class, cardinality, graded_status, realized_by,
           join_keys, traversal, description
    FROM kg_relation""",
    """CREATE VIEW kg_v_term AS
    SELECT t.vocabulary, v.source AS source_column, v.open_ended, t.notation, t.label,
           t.definition, t.broader
    FROM kg_term t JOIN kg_vocabulary v ON v.name = t.vocabulary""",
    """CREATE VIEW kg_v_guardrail AS
    SELECT ordinal, rule FROM kg_guardrail""",
)

_DELETES = (
    "kg_class", "kg_property", "kg_card", "kg_binding", "kg_relation", "kg_metric",
    "kg_vocabulary", "kg_term", "kg_alignment", "kg_guardrail", "kg_meta",
)


#: table -> (INSERT sql, ordered field names resolved against each definition object).
_INSERTS: Dict[str, Tuple[str, Tuple[str, ...]]] = {
    "kg_class": (
        "INSERT INTO kg_class (name, label, layer, description, grain, key_properties, "
        "parents, caveats, realization, uri) VALUES (?, ?, ?, ?, ?, CAST(? AS text[]), "
        "CAST(? AS text[]), CAST(? AS text[]), ?, ?)",
        ("name", "label", "layer", "description", "grain", "key_properties", "parents",
         "caveats", "realization", "uri")),
    "kg_property": (
        "INSERT INTO kg_property (name, label, semantic_type, description, datatype, unit, "
        "timing, derivation, leakage_risk, vocabulary, point_in_time_note, synonyms, "
        "usable_as_feature, is_label, uri) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, "
        "CAST(? AS text[]), ?, ?, ?)",
        ("name", "label", "semantic_type", "description", "datatype", "unit", "timing",
         "derivation", "leakage_risk", "vocabulary", "pit_notes", "synonyms", "is_feature",
         "is_label", "uri")),
    "kg_card": (
        "INSERT INTO kg_card (table_name, label, entity, grain, primary_key, description, "
        "cadence, freshness_column, expected_lag_hours, writers, caveats, training_use, "
        "forbidden_columns, retention_note, uri) VALUES (?, ?, ?, ?, CAST(? AS text[]), ?, ?, "
        "?, ?, CAST(? AS text[]), CAST(? AS text[]), ?, CAST(? AS text[]), ?, ?)",
        ("table", "label", "entity", "grain", "pk", "description", "cadence",
         "freshness_column", "expected_lag_hours", "writers", "caveats", "training_use",
         "forbidden_columns", "retention_note", "uri")),
    "kg_binding": (
        "INSERT INTO kg_binding (table_name, column_name, property_name, note) "
        "VALUES (?, ?, ?, ?)",
        ("table", "column", "property", "note")),
    "kg_relation": (
        "INSERT INTO kg_relation (name, label, domain_class, range_class, cardinality, "
        "description, realized_by, join_keys, graded_status, evidence, traversal, uri) "
        "VALUES (?, ?, ?, ?, ?, ?, CAST(? AS text[]), CAST(? AS text[]), ?, ?, ?, ?)",
        ("name", "label", "domain", "range", "cardinality", "description", "realized_by",
         "join_keys", "graded_status", "evidence", "via", "uri")),
    "kg_metric": (
        "INSERT INTO kg_metric (name, label, description, sql_text, entity, source_tables, "
        "unit, grain, cadence, timing, derivation, leakage_risk, graded_status, "
        "graded_evidence, cheap_to_run, caveats, synonyms, params, uri) "
        "VALUES (?, ?, ?, ?, ?, CAST(? AS text[]), ?, ?, ?, ?, ?, ?, ?, ?, ?, "
        "CAST(? AS text[]), CAST(? AS text[]), CAST(? AS text[]), ?)",
        ("name", "label", "description", "sql", "entity", "source_tables", "unit", "grain",
         "cadence", "timing", "derivation", "leakage_risk", "graded_status",
         "graded_evidence", "cheap", "caveats", "synonyms", "params", "uri")),
    "kg_vocabulary": (
        "INSERT INTO kg_vocabulary (name, description, source, open_ended, term_count, uri) "
        "VALUES (?, ?, ?, ?, ?, ?)",
        ("name", "description", "source", "open", "term_count", "uri")),
    "kg_term": (
        "INSERT INTO kg_term (vocabulary, notation, label, definition, broader) "
        "VALUES (?, ?, ?, ?, ?)",
        ("vocabulary", "notation", "label", "definition", "broader")),
    "kg_alignment": (
        "INSERT INTO kg_alignment (subject, predicate, object_iri, rationale, strength, "
        "verified_from, emitted) VALUES (?, ?, ?, ?, ?, ?, ?)",
        ("subject", "predicate", "object", "rationale", "strength", "verified_from",
         "emitted")),
    "kg_guardrail": (
        "INSERT INTO kg_guardrail (ordinal, rule) VALUES (?, ?)",
        ("ordinal", "rule")),
}


# ── payload ──────────────────────────────────────────────────────────────────


def _arr(values: Optional[Sequence[Any]]) -> str:
    """A Postgres array literal (`{"a","b"}`).

    Built by hand rather than relying on the driver's list adapter, because an empty Python
    list has no element type and Postgres rejects the resulting `ARRAY[]`. Escaping both `\\`
    and `"` keeps the literal valid for values containing either.
    """
    items = []
    for v in values or ():
        text = str(v).replace("\\", "\\\\").replace('"', '\\"')
        items.append('"' + text + '"')
    return "{" + ",".join(items) + "}"


def _val(obj: Any, field: str) -> Any:
    value = getattr(obj, field)
    if isinstance(value, bool) or value is None:
        return value
    if isinstance(value, (list, tuple)):
        return _arr(value)
    return value


def _payload(onto: Ontology) -> Dict[str, List[Tuple]]:
    """`{kg_table: [param tuples]}` — the whole layer, in insert order."""
    from .ai import GUARDRAILS

    rows: Dict[str, List[Tuple]] = {name: [] for name in _INSERTS}

    for c in onto.classes:
        rows["kg_class"].append(tuple(_val(c, f) for f in _INSERTS["kg_class"][1]))
    for p in onto.properties:
        rows["kg_property"].append(tuple(_val(p, f) for f in _INSERTS["kg_property"][1]))
    for card in onto.cards:
        rows["kg_card"].append(tuple(_val(card, f) for f in _INSERTS["kg_card"][1]))
    for b in onto.bindings:
        rows["kg_binding"].append(tuple(_val(b, f) for f in _INSERTS["kg_binding"][1]))
    for r in onto.relations:
        rows["kg_relation"].append(tuple(_val(r, f) for f in _INSERTS["kg_relation"][1]))
    for m in onto.metrics:
        rows["kg_metric"].append(tuple(_val(m, f) for f in _INSERTS["kg_metric"][1]))
    for v in onto.vocabularies:
        rows["kg_vocabulary"].append((v.name, v.description, v.source, v.open, len(v.terms),
                                      v.uri))
        for term in v.terms:
            rows["kg_term"].append((v.name, term.notation, term.label, term.definition,
                                    term.broader))
    for a in alignment.assertions():
        rows["kg_alignment"].append((a.subject, a.predicate, a.object, a.rationale,
                                     a.strength, a.verified_from, a.emitted))
    for i, rule in enumerate(GUARDRAILS, 1):
        rows["kg_guardrail"].append((i, rule))
    return rows


def _open(conn=None) -> Tuple[Any, bool]:
    if conn is not None:
        return conn, False
    import db_compat

    return db_compat.connect(), True


def reset(conn=None) -> List[str]:
    """Drop every `kg_*` view and table. The only destructive operation in the package, and
    it only ever touches objects this module created."""
    c, owns = _open(conn)
    dropped: List[str] = []
    try:
        for view in _VIEWS:
            c.execute(f"DROP VIEW IF EXISTS {view} CASCADE")
        for table in _DELETES:
            c.execute(f"DROP TABLE IF EXISTS {table} CASCADE")
            dropped.append(table)
        c.commit()
    finally:
        if owns:
            c.close()
    return dropped


def plan(onto: Ontology) -> Dict[str, Any]:
    """What `sync()` would write, computed without opening a connection.

    Used by `ontology store --dry-run` and by the tests. Counting rows is free; the point is
    that the *definition* is checkable (and the total is reportable) without the DDL, so a
    definition change can be reviewed before anything is created in the database.
    """
    payload = _payload(onto)
    counts = {table: len(rows) for table, rows in payload.items()}
    return {
        "counts": counts,
        "rows": counts,
        "total_rows": sum(counts.values()),
        "views": list(_VIEWS),
    }


def sync(onto: Ontology, conn=None, validate: bool = True) -> Dict[str, Any]:
    """Create/refresh the `kg_*` tables and views from the ontology. Returns counts.

    Idempotent: every table is emptied and rewritten inside one transaction, so a re-run leaves
    exactly the layer the definitions describe — no rows from a previous ontology version.
    (A changed *column list* needs `reset()` first; that is what `SCHEMA_VERSION` is for, and
    `CREATE TABLE IF NOT EXISTS` will not silently reshape an existing table.)
    """
    if validate:
        issues = onto.validate()
        if issues:
            raise ValueError(f"refusing to sync: {len(issues)} integrity issue(s); "
                             f"run `ontology verify`. First: {issues[0]}")

    c, owns = _open(conn)
    try:
        for view in _VIEWS:
            c.execute(f"DROP VIEW IF EXISTS {view} CASCADE")
        for stmt in _DDL:
            c.execute(stmt)

        payload = _payload(onto)
        counts: Dict[str, int] = {}
        for table in _DELETES:
            c.execute(f"DELETE FROM {table}")
        for table, rows in payload.items():
            sql = _INSERTS[table][0]
            if rows:
                c.executemany(sql, rows)
            counts[table] = len(rows)

        for stmt in _VIEW_DDL:
            c.execute(stmt)

        import db_compat

        meta = (
            ("schema_version", SCHEMA_VERSION),
            ("ontology_version", onto.version),
            ("synced_at", db_compat.now_utc_iso()),
            ("base_uri", vocab.BASE_URI),
            ("counts", json.dumps(counts, sort_keys=True)),
        )
        c.executemany("INSERT INTO kg_meta (key, value) VALUES (?, ?)", meta)
        c.commit()
        return {"counts": counts, "views": list(_VIEWS),
                "rows": sum(counts.values()), "written": sum(counts.values()),
                "schema_version": SCHEMA_VERSION}
    finally:
        if owns:
            c.close()

