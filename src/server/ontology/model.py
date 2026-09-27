"""
The ontology meta-model.

Six frozen dataclasses describe everything this layer knows:

    ClassDef        an entity type (Equity, Bar, Recommendation, Screener, ...)
    PropertyDef     a datatype property carrying *semantics* (what it is, its timing,
                    its leakage risk, its unit) — the part a database column cannot say
    RelationDef     a typed edge between classes, with the table that realizes it and the
                    measured evidence behind it
    MetricDef       a semantic measure with a runnable SQL realization
    DataCard        table-level documentation: grain, cadence, PK, writers, caveats,
                    training-use verdict
    ColumnBinding   the physical mapping  (table, column) -> PropertyDef

`Ontology` is the container plus the integrity rules. `validate()` is deliberately
strict: a semantic layer that silently points at a column which no longer exists is worse
than no semantic layer, because a model will trust it.

Everything is JSON round-trippable (`to_dict` / `from_dict`) so the ontology can be
shipped as a build artifact and diffed across commits.
"""
from dataclasses import asdict, dataclass
from typing import Any, Dict, List, Optional, Sequence, Tuple

from . import vocab

__all__ = [
    "ClassDef",
    "ColumnBinding",
    "DataCard",
    "MetricDef",
    "Ontology",
    "PropertyDef",
    "RelationDef",
]


@dataclass(frozen=True)
class ClassDef:
    """An entity type in the market knowledge graph."""

    name: str
    label: str
    layer: str
    description: str
    parents: Tuple[str, ...] = ()
    key_properties: Tuple[str, ...] = ()   # together these identify an instance (grain)
    grain: str = ""                        # human-readable grain statement
    caveats: Tuple[str, ...] = ()
    #: How this class exists in the database — vocab.REALIZATIONS.
    #:   "table"     one or more data cards realize it (the normal case)
    #:   "reference" a dimension that EXISTS only as a column value (Exchange, Sector, Index):
    #:               no single table owns it, so the "must have a card" rule does not apply
    #:   "abstract"  a parent used only to group subclasses
    #: Declared explicitly because "no table realizes this" is a legitimate modelling fact
    #: about this database, not a defect to be papered over by inventing a card.
    realization: str = "table"

    @property
    def uri(self) -> str:
        return f"bsi:{self.name}"

    @property
    def full_uri(self) -> str:
        return vocab.expand(self.uri)


@dataclass(frozen=True)
class PropertyDef:
    """A datatype property. The semantic fields are the point of the whole package."""

    name: str
    label: str
    semantic_type: str        # vocab.SEMANTIC_TYPES
    description: str
    datatype: str = "string"  # vocab.DATATYPES
    unit: Optional[str] = None
    timing: str = "context"          # vocab.TIMING_CLASSES
    derivation: str = "raw"          # vocab.DERIVATIONS
    leakage_risk: str = "none"       # vocab.LEAKAGE_RISKS
    vocabulary: Optional[str] = None # vocab.Vocabulary name for enum-typed properties
    pit_notes: str = ""              # point-in-time rule, if any
    synonyms: Tuple[str, ...] = ()

    @property
    def uri(self) -> str:
        return f"bsip:{self.name}"

    @property
    def full_uri(self) -> str:
        return vocab.expand(self.uri)

    @property
    def is_feature(self) -> bool:
        """True when a trainer may legitimately use this in X.

        Excludes labels outright and excludes `leakage_risk == "high"`: a column that is
        outcome-side (an exit price, a resolution date) is not a label, but it is still not
        a feature, and the two cases must not be conflated.
        """
        return self.semantic_type in (
            "measure", "ratio", "score", "count", "flag", "dimension", "enum", "unit",
        ) and self.leakage_risk not in ("target", "high")

    @property
    def is_label(self) -> bool:
        return self.semantic_type == "label" or self.leakage_risk == "target"


@dataclass(frozen=True)
class ColumnBinding:
    """The physical realization: this (table, column) carries this property."""

    table: str
    column: str
    property: str
    note: str = ""

    @property
    def ref(self) -> str:
        return f"{self.table}.{self.column}"


@dataclass(frozen=True)
class RelationDef:
    """A typed, quantified edge between two classes."""

    name: str
    label: str
    domain: str                  # ClassDef name
    range: str                   # ClassDef name
    cardinality: str             # vocab.CARDINALITIES
    description: str
    realized_by: Tuple[str, ...] = ()   # tables that materialize the edge
    join_keys: Tuple[str, ...] = ()     # columns used to traverse: ["symbol"], ["symbol","date"]
    graded_status: str = "ungraded"     # vocab.GRADED_STATUS
    evidence: str = ""
    via: str = ""                       # SQL join sketch, for agents
    synonyms: Tuple[str, ...] = ()      # alternate names an agent may query by

    @property
    def uri(self) -> str:
        return f"bsir:{self.name}"

    @property
    def full_uri(self) -> str:
        return vocab.expand(self.uri)


@dataclass(frozen=True)
class MetricDef:
    """A semantically-named measure with a runnable SQL realization.

    This is the bridge between a model/agent asking a *question* ("what is the delivery
    surprise z-score for RELIANCE as of 2026-09-18?") and a *query*. The SQL is a complete
    SELECT using named binds `:symbol` and `:as_of`; `render_literal()` inlines them so the
    statement can be validated with EXPLAIN (which checks every table/column reference
    without scanning a row).
    """

    name: str
    label: str
    description: str
    sql: str
    entity: str                       # ClassDef the metric is *of*
    source_tables: Tuple[str, ...]
    unit: Optional[str] = None
    grain: str = ""
    cadence: str = ""
    timing: str = "coincident"
    derivation: str = "derived"
    leakage_risk: str = "none"
    graded_status: str = "ungraded"
    graded_evidence: str = ""
    caveats: Tuple[str, ...] = ()
    synonyms: Tuple[str, ...] = ()
    params: Tuple[str, ...] = ("symbol", "as_of")
    cheap: bool = True                # True = safe to execute live; False = EXPLAIN only

    @property
    def uri(self) -> str:
        return f"bsim:{self.name}"

    @property
    def full_uri(self) -> str:
        return vocab.expand(self.uri)

    def param_dict(self, symbol: str = "RELIANCE", as_of: str = "2026-09-18") -> Dict[str, Any]:
        """Named binds, exactly as db_compat would pass them."""
        values = {"symbol": symbol, "as_of": as_of}
        return {k: values[k] for k in self.params if k in values}

    def render_literal(self, symbol: str = "RELIANCE", as_of: str = "2026-09-18") -> str:
        """Inline the binds as quoted SQL literals (for EXPLAIN and psql copy/paste).

        Only the two known bind names are substituted. A definition that smuggles a third
        bind raises here rather than emitting SQL that would only fail at run time.
        """
        sql = self.sql
        for key, value in self.param_dict(symbol, as_of).items():
            literal = "'" + str(value).replace("'", "''") + "'"
            sql = sql.replace(f":{key}", literal)
        for p in self.params:
            if f":{p}" in sql:
                raise ValueError(f"metric {self.name}: unsubstituted bind {p!r} remains")
        return sql


@dataclass(frozen=True)
class DataCard:
    """Table-level documentation — what an agent should read before writing SQL.

    Deliberately carries the *caveats* and *training_use* verdict, because those are the
    facts that live nowhere in the database and that a model consumer gets wrong.
    """

    table: str
    label: str
    entity: str                  # ClassDef name this table realizes
    grain: str
    pk: Tuple[str, ...]
    description: str
    cadence: str = "daily"
    freshness_column: Optional[str] = None
    expected_lag_hours: Optional[float] = None
    writers: Tuple[str, ...] = ()
    caveats: Tuple[str, ...] = ()
    training_use: str = "allowed"        # vocab.TRAINING_USE
    forbidden_columns: Tuple[str, ...] = ()
    retention_note: str = ""

    @property
    def uri(self) -> str:
        return f"bsis:{self.table}"

    @property
    def full_uri(self) -> str:
        return vocab.expand(self.uri)

    def label_columns(self, onto: "Ontology") -> Tuple[str, ...]:
        """This table's target columns — the card-level handle on the container's
        `label_columns()` (which is what kg_v_never_feature is built from)."""
        return onto.label_columns(self.table)

    def feature_columns(self, onto: "Ontology") -> Tuple[str, ...]:
        """This table's trainable columns. A table whose verdict is `labels` or
        `forbidden` carries none — that is the whole content of the verdict."""
        if self.training_use in ("labels", "forbidden"):
            return ()
        return tuple(b.column for b in onto.bindings_for_table(self.table)
                     if b.column not in self.forbidden_columns
                     and (p := onto.property_by_name(b.property)) is not None
                     and p.is_feature)


@dataclass
class Ontology:
    """The whole layer: T-Box (classes, properties, relations, vocabularies), the physical
    mapping (cards + column bindings), and semantic metrics."""

    version: str
    classes: Tuple[ClassDef, ...]
    properties: Tuple[PropertyDef, ...]
    cards: Tuple[DataCard, ...]
    bindings: Tuple[ColumnBinding, ...]
    relations: Tuple[RelationDef, ...]
    metrics: Tuple[MetricDef, ...]
    vocabularies: Tuple[vocab.Vocabulary, ...]

    def __post_init__(self) -> None:
        self._cls = {c.name: c for c in self.classes}
        self._prop = {p.name: p for p in self.properties}
        self._card = {c.table: c for c in self.cards}
        self._metric = {m.name: m for m in self.metrics}
        self._rel = {r.name: r for r in self.relations}
        self._voc = {v.name: v for v in self.vocabularies}
        self._binds_by_table: Dict[str, List[ColumnBinding]] = {}
        self._binds_by_prop: Dict[str, List[ColumnBinding]] = {}
        for b in self.bindings:
            self._binds_by_table.setdefault(b.table, []).append(b)
            self._binds_by_prop.setdefault(b.property, []).append(b)

    # ── lookups ──────────────────────────────────────────────────────────────

    def class_by_name(self, name: str) -> Optional[ClassDef]:
        return self._cls.get(name)

    def property_by_name(self, name: str) -> Optional[PropertyDef]:
        return self._prop.get(name)

    def card_by_table(self, table: str) -> Optional[DataCard]:
        return self._card.get(table)

    def metric_by_name(self, name: str) -> Optional[MetricDef]:
        return self._metric.get(name)

    def relation_by_name(self, name: str) -> Optional[RelationDef]:
        return self._rel.get(name)

    def vocabulary_by_name(self, name: str) -> Optional[vocab.Vocabulary]:
        return self._voc.get(name)

    def bindings_for_table(self, table: str) -> Tuple[ColumnBinding, ...]:
        return tuple(self._binds_by_table.get(table, ()))

    def bindings_for_property(self, prop: str) -> Tuple[ColumnBinding, ...]:
        return tuple(self._binds_by_prop.get(prop, ()))

    def tables_for_property(self, prop: str) -> Tuple[str, ...]:
        return tuple(sorted({b.table for b in self._binds_by_prop.get(prop, ())}))

    def property_at(self, table: str, column: str) -> Optional[PropertyDef]:
        """The semantic meaning of a physical column — the core introspection primitive."""
        for b in self._binds_by_table.get(table, ()):
            if b.column == column:
                return self.property_by_name(b.property)
        return None

    def bindings_for_class(self, cls: str) -> Tuple[ColumnBinding, ...]:
        tables = {c.table for c in self.cards if c.entity == cls}
        return tuple(b for b in self.bindings if b.table in tables)

    def cards_for_layer(self, layer: str) -> Tuple[DataCard, ...]:
        return tuple(c for c in self.cards
                     if self._cls.get(c.entity) and self._cls[c.entity].layer == layer)

    def metrics_for_table(self, table: str) -> Tuple[MetricDef, ...]:
        return tuple(m for m in self.metrics if table in m.source_tables)

    def relations_for_class(self, cls: str) -> Tuple[RelationDef, ...]:
        return tuple(r for r in self.relations if r.domain == cls or r.range == cls)

    def columns_of(self, table: str) -> Tuple[str, ...]:
        return tuple(b.column for b in self.bindings_for_table(table))

    def training_safe_columns(self, table: str) -> Tuple[str, ...]:
        """Columns on `table` a trainer may legitimately use in X — labels and leaks out."""
        card = self.card_by_table(table)
        if card is not None and card.training_use in ("forbidden", "labels"):
            return ()
        out = []
        for b in self.bindings_for_table(table):
            if card is not None and b.column in card.forbidden_columns:
                continue
            p = self.property_by_name(b.property)
            if p is not None and p.is_feature:
                out.append(b.column)
        return tuple(out)

    def label_columns(self, table: str) -> Tuple[str, ...]:
        """Columns on `table` that are targets rather than features."""
        out = []
        for b in self.bindings_for_table(table):
            p = self.property_by_name(b.property)
            if p is not None and p.is_label:
                out.append(b.column)
        return tuple(out)

    # ── integrity ────────────────────────────────────────────────────────────

    def validate(self) -> List[str]:
        """Return a list of integrity violations (empty = clean).

        Strict on purpose: a semantic layer that points at a column which no longer exists
        is worse than no semantic layer, because a model trusts it. Called by the test
        suite, by `python -m ontology verify`, and after every definitions edit.
        """
        issues: List[str] = []

        for c in self.classes:
            if c.layer not in vocab.LAYERS:
                issues.append(f"class {c.name}: unknown layer {c.layer!r}")
            if c.realization not in vocab.REALIZATIONS:
                issues.append(
                    f"class {c.name}: unknown realization {c.realization!r} "
                    f"(expected one of {vocab.REALIZATIONS})")
            for parent in c.parents:
                if parent not in self._cls:
                    issues.append(f"class {c.name}: unknown parent {parent!r}")
            for kp in c.key_properties:
                if kp not in self._prop:
                    issues.append(f"class {c.name}: unknown key property {kp!r}")
            # Only a class that claims `table` realization must be backed by a card. A
            # `reference` class (Exchange, Sector) is a dimension that exists only as a
            # column value and an `abstract` one is a grouping node; demanding a table for
            # either would push this layer toward inventing empty cards to satisfy a rule.
            # A `table` class with neither a card nor subclasses is a real documentation gap.
            has_card = any(card.entity == c.name for card in self.cards)
            has_child = any(c.name in other.parents for other in self.classes)
            if c.realization == "table" and not has_card and not has_child:
                issues.append(f"class {c.name}: no realized table and no subclasses")
            if c.realization != "table" and has_card:
                n_cards = sum(1 for card in self.cards if card.entity == c.name)
                issues.append(
                    f"class {c.name}: realization={c.realization!r} but {n_cards} data card(s) "
                    f"realize it — declare 'table' or drop the card")

        for p in self.properties:
            if p.semantic_type not in vocab.SEMANTIC_TYPES:
                issues.append(f"property {p.name}: unknown semantic_type {p.semantic_type!r}")
            if p.datatype not in vocab.DATATYPES:
                issues.append(f"property {p.name}: unknown datatype {p.datatype!r}")
            if p.timing not in vocab.TIMING_CLASSES:
                issues.append(f"property {p.name}: unknown timing {p.timing!r}")
            if p.derivation not in vocab.DERIVATIONS:
                issues.append(f"property {p.name}: unknown derivation {p.derivation!r}")
            if p.leakage_risk not in vocab.LEAKAGE_RISKS:
                issues.append(f"property {p.name}: unknown leakage_risk {p.leakage_risk!r}")
            if p.vocabulary is not None and p.vocabulary not in self._voc:
                issues.append(f"property {p.name}: unknown vocabulary {p.vocabulary!r}")
            if not self.bindings_for_property(p.name):
                issues.append(f"property {p.name}: declared but bound to no column")

        for c in self.cards:
            if c.entity not in self._cls:
                issues.append(f"card {c.table}: unknown entity {c.entity!r}")
            if c.training_use not in vocab.TRAINING_USE:
                issues.append(f"card {c.table}: unknown training_use {c.training_use!r}")
            if not c.pk:
                issues.append(f"card {c.table}: empty primary key")
            bound = set(self.columns_of(c.table))
            for col in c.pk:
                if col not in bound:
                    issues.append(f"card {c.table}: pk column {col!r} is not bound to a property")
            if c.freshness_column and c.freshness_column not in bound:
                issues.append(
                    f"card {c.table}: freshness_column {c.freshness_column!r} is not bound")
            for col in c.forbidden_columns:
                if col not in bound:
                    issues.append(f"card {c.table}: forbidden column {col!r} is not bound")

        for b in self.bindings:
            if b.property not in self._prop:
                issues.append(f"binding {b.ref}: unknown property {b.property!r}")
            if b.table not in self._card:
                issues.append(f"binding {b.ref}: table has no data card")

        for r in self.relations:
            if r.domain not in self._cls:
                issues.append(f"relation {r.name}: unknown domain {r.domain!r}")
            if r.range not in self._cls:
                issues.append(f"relation {r.name}: unknown range {r.range!r}")
            if r.cardinality not in vocab.CARDINALITIES:
                issues.append(f"relation {r.name}: unknown cardinality {r.cardinality!r}")
            if r.graded_status not in vocab.GRADED_STATUS:
                issues.append(f"relation {r.name}: unknown graded_status {r.graded_status!r}")
            for table in r.realized_by:
                if table not in self._card:
                    issues.append(f"relation {r.name}: realized by undocumented table {table!r}")

        for m in self.metrics:
            if m.entity not in self._cls:
                issues.append(f"metric {m.name}: unknown entity {m.entity!r}")
            for table in m.source_tables:
                if table not in self._card:
                    issues.append(f"metric {m.name}: source table {table!r} has no data card")
            if m.graded_status not in vocab.GRADED_STATUS:
                issues.append(f"metric {m.name}: unknown graded_status {m.graded_status!r}")
            if m.leakage_risk not in vocab.LEAKAGE_RISKS:
                issues.append(f"metric {m.name}: unknown leakage_risk {m.leakage_risk!r}")
            for p in m.params:
                if p not in ("symbol", "as_of"):
                    issues.append(f"metric {m.name}: unsupported bind {p!r}")
            issues.extend(validate_metric_sql(m))

        for v in self.vocabularies:
            if not v.terms:
                issues.append(f"vocabulary {v.name}: no terms")
            if not v.source:
                issues.append(f"vocabulary {v.name}: empty source")
            seen = set()
            for t in v.terms:
                if not t.notation:
                    issues.append(f"vocabulary {v.name}: a term has an empty notation")
                if t.notation in seen:
                    issues.append(f"vocabulary {v.name}: duplicate notation {t.notation!r}")
                seen.add(t.notation)
                if t.broader and t.broader not in v.notations():
                    issues.append(
                        f"vocabulary {v.name}: term {t.notation!r} has unknown broader {t.broader!r}")

        return issues

    def summary(self) -> Dict[str, int]:
        """Counts, for the report header and for the `coverage` CLI command."""
        return {
            "classes": len(self.classes),
            "properties": len(self.properties),
            "cards": len(self.cards),
            "bindings": len(self.bindings),
            "relations": len(self.relations),
            "metrics": len(self.metrics),
            "vocabularies": len(self.vocabularies),
            "vocabulary_terms": sum(len(v.terms) for v in self.vocabularies),
        }

    # ── serialization ────────────────────────────────────────────────────────

    def to_dict(self) -> Dict[str, Any]:
        """JSON-ready plain data, so the ontology can ship as a build artifact."""
        return {
            "version": self.version,
            "classes": [asdict(c) for c in self.classes],
            "properties": [asdict(p) for p in self.properties],
            "cards": [asdict(c) for c in self.cards],
            "bindings": [asdict(b) for b in self.bindings],
            "relations": [asdict(r) for r in self.relations],
            "metrics": [asdict(m) for m in self.metrics],
            "vocabularies": [asdict(v) for v in self.vocabularies],
        }

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "Ontology":
        """Inverse of `to_dict`; JSON lists are coerced back to the frozen tuples."""

        def coerce(rows: Sequence[Dict[str, Any]],
                   tuple_fields: Sequence[str]) -> List[Dict[str, Any]]:
            out = []
            for row in rows:
                row = dict(row)
                for f in tuple_fields:
                    if f in row and isinstance(row[f], list):
                        row[f] = tuple(row[f])
                out.append(row)
            return out

        vocabs = []
        for v in data.get("vocabularies", ()):
            v = dict(v)
            v["terms"] = tuple(vocab.ControlledTerm(**t) for t in v.get("terms", ()))
            vocabs.append(vocab.Vocabulary(**v))

        return cls(
            version=data.get("version", vocab.ONTOLOGY_VERSION),
            classes=tuple(ClassDef(**c) for c in coerce(
                data.get("classes", ()), ("parents", "key_properties", "caveats"))),
            properties=tuple(PropertyDef(**p) for p in coerce(
                data.get("properties", ()), ("synonyms",))),
            cards=tuple(DataCard(**c) for c in coerce(
                data.get("cards", ()), ("pk", "writers", "caveats", "forbidden_columns"))),
            bindings=tuple(ColumnBinding(**b) for b in data.get("bindings", ())),
            relations=tuple(RelationDef(**r) for r in coerce(
                data.get("relations", ()), ("realized_by", "join_keys", "synonyms"))),
            metrics=tuple(MetricDef(**m) for m in coerce(
                data.get("metrics", ()), ("source_tables", "caveats", "synonyms", "params"))),
            vocabularies=tuple(vocabs),
        )


def validate_metric_sql(m: MetricDef) -> List[str]:
    """Rules a metric's SQL must satisfy before it can reach an agent or a model.

    Not style preferences — each maps to a failure mode this repo has actually hit. `%` is
    the sql_translate/psycopg2 placeholder trap; a `;` breaks the single-statement executor
    in db_compat; a non-SELECT would be a write path hiding inside a read-only semantic
    layer; a source table that the SQL never references means the metric and its
    documentation have drifted apart.
    """
    issues: List[str] = []
    sql = m.sql.strip()
    if not sql:
        return [f"metric {m.name}: empty sql"]
    lowered = sql.lower()
    if not (lowered.startswith("select") or lowered.startswith("with")):
        issues.append(f"metric {m.name}: sql must be a SELECT/WITH (read-only)")
    if "%" in sql:
        issues.append(f"metric {m.name}: sql contains '%' (placeholder trap) — use '* 100.0'")
    if ";" in sql:
        issues.append(f"metric {m.name}: sql contains ';' (multi-statement not allowed)")
    for token in ("insert ", "update ", "delete ", "drop ", "alter ", "truncate "):
        if token in lowered:
            issues.append(f"metric {m.name}: sql contains write keyword {token.strip()!r}")
    for table in m.source_tables:
        if table.lower() not in lowered:
            issues.append(
                f"metric {m.name}: declared source table {table!r} is not referenced in its sql")
    return issues
