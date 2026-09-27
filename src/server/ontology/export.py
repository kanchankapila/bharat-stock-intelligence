"""
Serializers — one semantic layer, many consumer formats.

Everything here is generated from the same definitions the cards and bindings come from, so
no artifact can drift from the layer it describes. Deliberately **stdlib only**: the repo's
root requirements forbid adding a dependency that CI does not pin, so the Turtle/RDF writers
are a small, honest triple serializer rather than rdflib.

The triple model is four tuple shapes:

    ("iri",   "bsi:Equity")                     an IRI/CURIE reference
    ("lit",   value, "xsd:string")              a typed literal
    ("lang",  value, "en")                      a language-tagged literal
    ("bnode", "_:b3")                           a blank node

Two serializers consume it (`to_turtle`, `to_jsonld`), so Turtle and JSON-LD cannot disagree
about a fact. The three standards-specific producers (`shacl_triples`, `prov_triples`,
`catalog_triples`) emit into the same model for the same reason.

What is NOT emitted, on purpose: the FIBO assertions whose IRI was not verified in this
session (`alignment.emitted_assertions()` filters them). A mapping recalled from memory is
exactly the failure `.claude/rules/measurement.md` forbids, so it stays out of every artifact
until a human confirms it.
"""
import hashlib
import json
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple
from xml.sax.saxutils import escape as xml_escape

from . import alignment, standards, vocab
from .model import Ontology



#: Prefixes the serializers may use beyond `vocab.NAMESPACES`.
EXTRA_PREFIXES = {
    "sh": "http://www.w3.org/ns/shacl#",
    "dct": "http://purl.org/dc/terms/",
    "dcat": "http://www.w3.org/ns/dcat#",
    "qudt": "http://qudt.org/schema/qudt/",
    "unit": "http://qudt.org/vocab/unit/",
    "xsd": "http://www.w3.org/2001/XMLSchema#",
    "rdf": "http://www.w3.org/1999/02/22-rdf-syntax-ns#",
    "rdfs": "http://www.w3.org/2000/01/rdf-schema#",
    "owl": "http://www.w3.org/2002/07/owl#",
    "skos": "http://www.w3.org/2004/02/skos/core#",
    "prov": "http://www.w3.org/ns/prov#",
    "schema": "https://schema.org/",
}

#: Our datatype vocabulary -> XSD. `json` has no XSD type; RDF 1.2's `rdf:JSON` is the
#: closest standard name, emitted as a datatype marker only.
DATATYPE_IRIS = {
    "string": "xsd:string",
    "integer": "xsd:integer",
    "decimal": "xsd:decimal",
    "boolean": "xsd:boolean",
    "date": "xsd:date",
    "timestamp": "xsd:dateTime",
    "json": "rdf:JSON",
}

#: cadence is emitted as a literal property, never as a `dcat:accrualPeriodicity` IRI: the
#: DCAT frequency vocabulary IRIs were not verified in this session, and asserting an
#: unverified IRI is the one thing this package refuses to do (see alignment.py).
CADENCE_NOTE = ("cadence is carried twice on purpose: as `bsis:cadence` (literal, our "
                "vocabulary) and as `dct:accrualPeriodicity` (also a literal — the DCAT "
                "frequency IRIs were not verified this session, so the VALUE is ours, not "
                "an asserted external IRI)")


# ── literals and helpers ──────────────────────────────────────────────────────


def iri(ref: str) -> Tuple[str, str]:
    return ("iri", ref)


def lit(value: Any, datatype: Optional[str] = None) -> Tuple:
    return ("lit", "" if value is None else str(value), datatype)


def lang(value: str, tag: str = "en") -> Tuple:
    return ("lang", value, tag)


def bnode(ref: str) -> Tuple:
    return ("bnode", ref)


def prefix_map() -> Dict[str, str]:
    """All prefixes the serializers may declare."""
    out = dict(vocab.NAMESPACES)
    out.update(EXTRA_PREFIXES)
    for k, v in alignment.FIBO_PREFIXES.items():
        out.setdefault(k, v)
    return out


def _esc(text: str) -> str:
    """Turtle string escaping. Order matters: backslash first."""
    return (text.replace("\\", "\\\\").replace('"', '\\"')
                .replace("\n", "\\n").replace("\r", "\\r").replace("\t", "\\t"))


def _token(obj: Tuple) -> str:
    """Render one term as a Turtle token."""
    kind = obj[0]
    if kind in ("iri", "bnode"):
        return obj[1]
    if kind == "lang":
        return f'"{_esc(obj[1])}"@{obj[2]}'
    dt = obj[2] if len(obj) > 2 else None
    body = f'"{_esc(obj[1])}"'
    if not dt:
        return body
    return f"{body}^^xsd:{dt.split(':')[-1]}" if dt.startswith("xsd:") else f"{body}^^<{dt}>"


class Triples:
    """An ordered triple collection — the single source for Turtle and JSON-LD."""

    def __init__(self, rows: Optional[Iterable[Tuple]] = None):
        self.rows: List[Tuple[str, str, Tuple]] = list(rows or ())

    def add(self, subject: str, predicate: str, obj: Any) -> "Triples":
        if obj is not None:
            self.rows.append((subject, predicate, obj))
        return self

    def add_all(self, rows: Iterable[Tuple]) -> "Triples":
        for s, p, o in rows:
            self.add(s, p, o)
        return self

    def __len__(self) -> int:
        return len(self.rows)

    def used_prefixes(self, declared: Dict[str, str]) -> Dict[str, str]:
        """Only declare prefixes the document actually uses.

        Declaring `fibo-*` prefixes on a document that never references FIBO would suggest
        the ontology imports it. It does not — it aligns to it.

        Subjects AND predicates AND object IRIs must all be scanned. Scanning only the first
        two produced two documents that could not be parsed at all: `ontology.ttl` used
        `fibo-fbc-fi-fi:*` and `ontology.shacl.ttl` used `bsip:*`, and in both files every
        occurrence was in the object position (an `skos:closeMatch` target, a `sh:path`).
        Both emitted `@prefix` blocks that omitted the prefix those terms needed, so
        rdflib rejected the file at the first such line. A prefix scan that misses objects is
        not "slightly over-declaring" — it is an unparseable artifact.
        """
        used = {"rdf", "rdfs", "xsd"}
        for s, p, o in self.rows:
            for term in (s, p):
                if ":" in term and not term.startswith("_:"):
                    used.add(term.split(":", 1)[0])
            # An object is only a prefixed name in the `iri` kind; `lit` carries a datatype
            # CURIE and `bnode` is a `_:label`. Checking the kind (not just the string)
            # keeps a literal whose *text* happens to contain a colon from pulling a prefix in.
            if o and o[0] == "iri" and ":" in o[1] and not o[1].startswith("_:"):
                used.add(o[1].split(":", 1)[0])
            if o and len(o) > 2 and o[0] == "lit" and o[2] and ":" in o[2]:
                used.add(o[2].split(":", 1)[0])
        scoped = {k: v for k, v in declared.items() if k in used}
        return scoped or dict(declared)


def to_turtle(triples: Sequence[Tuple], prefixes: Optional[Dict[str, str]] = None,
              force_prefixes: Optional[Dict[str, str]] = None) -> str:
    """Serialize to Turtle, grouped by subject then predicate (stable, diff-friendly).

    `force_prefixes` declares prefixes even when unused: `ontology.ttl` asserts an
    alignment to FIBO, so the FIBO prefixes belong in its header whether or not this
    build happens to emit a match under each one.
    """
    declared = prefixes or prefix_map()
    t = Triples(triples)
    used = dict(t.used_prefixes(declared))
    for k, v in (force_prefixes or {}).items():
        used.setdefault(k, v)

    lines = [f"@prefix {k}: <{v}> ." for k, v in used.items()]
    lines.append("")

    grouped: Dict[str, Dict[str, List[Tuple]]] = {}
    order: List[str] = []
    for s, p, o in t.rows:
        if s not in grouped:
            grouped[s] = {}
            order.append(s)
        grouped[s].setdefault(p, []).append(o)

    for s in order:
        preds = grouped[s]
        chunks = []
        for p in preds:
            objs = ", ".join(_token(o) for o in preds[p])
            chunks.append(f"    {p} {objs}")
        lines.append(f"{s} " + " ;\n".join(chunks) + " .")
        lines.append("")
    return "\n".join(lines).rstrip() + "\n"


def context() -> Dict[str, Any]:
    """The JSON-LD `@context` — prefixes for JSON-native and RDF-native consumers alike."""
    ctx: Dict[str, Any] = dict(prefix_map())
    ctx["@vocab"] = vocab.BASE_URI + "market#"
    # The version deliberately does NOT live in the @context: a JSON-LD term whose value is a
    # bare "1.0.0" is an IRI mapping to a RELATIVE IRI, which a strict processor rejects when
    # expanding the document. The version is carried by ontology.ttl (owl:versionInfo) and by
    # manifest.json instead, both of which are read as plain JSON/RDF.
    return ctx


def to_jsonld(triples: Sequence[Tuple],
              prefixes: Optional[Dict[str, str]] = None) -> Dict[str, Any]:
    """Serialize the same triples as JSON-LD, so the two formats cannot disagree."""
    declared = prefixes or prefix_map()
    t = Triples(triples)
    used = t.used_prefixes(declared)

    nodes: Dict[str, Dict[str, Any]] = {}
    order: List[str] = []
    for s, p, o in t.rows:
        if s not in nodes:
            nodes[s] = {"@id": s}
            order.append(s)
        node = nodes[s]
        if o[0] in ("iri", "bnode"):
            value: Any = {"@id": o[1]}
        elif o[0] == "lang":
            value = {"@value": o[1], "@language": o[2]}
        elif len(o) < 3 or o[2] is None or o[2] == "xsd:string":
            value = o[1]
        else:
            value = {"@value": o[1], "@type": o[2]}
        existing = node.get(p)
        if existing is None:
            node[p] = value
        elif isinstance(existing, list):
            existing.append(value)
        else:
            node[p] = [existing, value]

    return {"@context": used, "@graph": [nodes[k] for k in order]}


def jsonld_text(doc: Dict[str, Any]) -> str:
    return json.dumps(doc, indent=2, ensure_ascii=False) + "\n"


def _dt(prop) -> str:
    """The XSD CURIE for a PropertyDef."""
    return DATATYPE_IRIS.get(prop.datatype, "xsd:string")


#: Every artifact `export_all` writes, in the order the README lists them.
ARTIFACTS = (
    "ontology.ttl",
    "ontology.jsonld",
    "context.jsonld",
    "ontology.shacl.ttl",
    "ontology.prov.ttl",
    "catalog.ttl",
    "catalog.jsonld",
    "ontology.cypher",
    "ontology.graphml",
    "ontology.mmd",
    "ontology.md",
    "llms.txt",
    "standards.txt",
    "coverage.json",
    "manifest.json",
)



# ── the T-Box + mapping (ontology.ttl / ontology.jsonld) ─────────────────────


def ontology_triples(onto: Ontology) -> List[Tuple]:
    """The whole layer as RDF: classes, properties, relations, metrics, vocabularies, the
    physical table/column mapping, the guardrails, and the FIBO alignment matches."""
    t = Triples()
    t.add("bsi:Ontology", "rdf:type", iri("owl:Ontology"))
    t.add("bsi:Ontology", "dct:title", lit("Bharat Stock Intelligence — market knowledge graph"))
    t.add("bsi:Ontology", "owl:versionInfo", lit(onto.version))
    t.add("bsi:Ontology", "dct:description", lit(
        "A semantic layer over the bharat_intel Postgres database: entity types, properties "
        "with timing/leakage semantics, typed relations, executable metrics, controlled "
        "vocabularies and table-level data cards."))
    t.add("bsi:Ontology", "dct:license", lit(
        "Repository has no LICENSE file; the layer itself is published under the terms of "
        "that repository. Aligned external standards keep their own licenses — see "
        "standards.txt."))

    # ── the AI contract, carried in the graph itself ──
    t.add("bsi:Guardrails", "rdf:type", iri("bsi:GuardrailSet"))
    t.add("bsi:Guardrails", "rdfs:comment", lit(
        "Rules that must travel with any prompt or feature set built from this ontology."))
    for i, rule in enumerate(_guardrails(), 1):
        t.add("bsi:Guardrails", "bsi:rule", lit(rule))

    for c in onto.classes:
        s = c.uri
        t.add(s, "rdf:type", iri("owl:Class"))
        t.add(s, "rdfs:label", lit(c.label, "xsd:string"))
        t.add(s, "rdfs:comment", lit(c.description, "xsd:string"))
        t.add(s, "bsi:layer", lit(c.layer))
        t.add(s, "bsi:realization", lit(c.realization))
        if c.grain:
            t.add(s, "bsi:grain", lit(c.grain))
        for parent in c.parents:
            t.add(s, "rdfs:subClassOf", iri(f"bsi:{parent}"))
        for kp in c.key_properties:
            t.add(s, "bsi:keyProperty", iri(f"bsip:{kp}"))
        for cav in c.caveats:
            t.add(s, "bsi:caveat", lit(cav))
        for card in onto.cards:
            if card.entity == c.name:
                t.add(s, "bsi:realizedBy", iri(card.uri))

    for p in onto.properties:
        s = p.uri
        t.add(s, "rdf:type", iri("owl:DatatypeProperty"))
        t.add(s, "rdfs:label", lit(p.label))
        t.add(s, "rdfs:comment", lit(p.description))
        t.add(s, "rdfs:range", iri(_dt(p)))
        t.add(s, "bsi:semanticType", lit(p.semantic_type))
        t.add(s, "bsi:timing", lit(p.timing))
        t.add(s, "bsi:derivation", lit(p.derivation))
        t.add(s, "bsi:leakageRisk", lit(p.leakage_risk))
        t.add(s, "bsi:usableAsFeature", lit("true" if p.is_feature else "false", "xsd:boolean"))
        t.add(s, "bsi:isLabel", lit("true" if p.is_label else "false", "xsd:boolean"))
        if p.unit:
            t.add(s, "qudt:unit", lit(p.unit))
        if p.vocabulary:
            t.add(s, "skos:inScheme", iri(f"bsiv:{p.vocabulary}"))
        for syn in p.synonyms:
            t.add(s, "skos:altLabel", lit(syn))
        if p.pit_notes:
            t.add(s, "bsi:pointInTimeNote", lit(p.pit_notes))
        for b in onto.bindings_for_property(p.name):
            t.add(s, "bsi:boundTo", iri(f"bsis:{b.table}.{b.column}"))
    return t.rows


def _guardrails() -> Tuple[str, ...]:
    """Imported lazily to keep `export` importable without pulling the search index in."""
    from .ai import GUARDRAILS

    return GUARDRAILS


def relation_triples(onto: Ontology) -> List[Tuple]:
    """Typed edges — the graph part of the knowledge graph."""
    t = Triples()
    for r in onto.relations:
        s = r.uri
        t.add(s, "rdf:type", iri("owl:ObjectProperty"))
        t.add(s, "rdfs:label", lit(r.label))
        t.add(s, "rdfs:comment", lit(r.description))
        t.add(s, "rdfs:domain", iri(f"bsi:{r.domain}"))
        t.add(s, "rdfs:range", iri(f"bsi:{r.range}"))
        t.add(s, "bsi:cardinality", lit(r.cardinality))
        t.add(s, "bsi:gradedStatus", lit(r.graded_status))
        if r.evidence:
            t.add(s, "bsi:evidence", lit(r.evidence))
        if r.via:
            t.add(s, "bsi:traversal", lit(r.via))
        for key in r.join_keys:
            t.add(s, "bsi:joinKey", lit(key))
        for table in r.realized_by:
            t.add(s, "bsi:realizedBy", iri(f"bsis:{table}"))
    return t.rows


def metric_triples(onto: Ontology) -> List[Tuple]:
    """Metrics with their runnable SQL — the part that makes this layer actionable rather
    than merely descriptive. The SQL is a literal so an agent can copy it verbatim, and every
    placeholder in it is one of the two declared binds."""
    t = Triples()
    for m in onto.metrics:
        s = m.uri
        t.add(s, "rdf:type", iri("bsim:Metric"))
        t.add(s, "rdfs:label", lit(m.label))
        t.add(s, "rdfs:comment", lit(m.description))
        t.add(s, "bsim:entity", iri(f"bsi:{m.entity}"))
        t.add(s, "bsim:sql", lit(m.sql.strip()))
        t.add(s, "bsim:params", lit(", ".join(m.params)))
        t.add(s, "bsim:grain", lit(m.grain))
        t.add(s, "bsim:cadence", lit(m.cadence))
        t.add(s, "bsim:timing", lit(m.timing))
        t.add(s, "bsim:derivation", lit(m.derivation))
        t.add(s, "bsim:leakageRisk", lit(m.leakage_risk))
        t.add(s, "bsim:gradedStatus", lit(m.graded_status))
        t.add(s, "bsim:cheapToRun", lit("true" if m.cheap else "false", "xsd:boolean"))
        if m.unit:
            t.add(s, "bsim:unit", lit(m.unit))
        if m.graded_evidence:
            t.add(s, "bsim:gradedEvidence", lit(m.graded_evidence))
        for table in m.source_tables:
            t.add(s, "bsim:derivedFrom", iri(f"bsis:{table}"))
        for cav in m.caveats:
            t.add(s, "bsim:caveat", lit(cav))
        for syn in m.synonyms:
            t.add(s, "skos:altLabel", lit(syn))
    return t.rows


def _slug(text: str) -> str:
    """A URI-safe local name for a SKOS concept notation.

    Notations are raw stored values and contain spaces, pipes, percent signs and slashes
    (e.g. `closed session: universe-wide flat zero-volume bar`), none of which are legal in a
    Turtle local name.
    """
    out = []
    for ch in (text or "").strip().lower():
        if ch.isalnum():
            out.append(ch)
        elif out and out[-1] != "-":
            out.append("-")
    return "".join(out).strip("-") or "term"


def vocabulary_triples(onto: Ontology) -> List[Tuple]:
    """SKOS concept schemes — the 30 controlled vocabularies, each naming its source column."""
    t = Triples()
    for v in onto.vocabularies:
        s = v.uri
        t.add(s, "rdf:type", iri("skos:ConceptScheme"))
        t.add(s, "rdfs:comment", lit(v.description))
        t.add(s, "bsiv:source", lit(v.source))
        t.add(s, "bsiv:openEnded", lit("true" if v.open else "false", "xsd:boolean"))
        if v.open:
            t.add(s, "bsiv:openEndedNote", lit(
                "Terms below were observed at capture time. The producer is open-ended, so "
                "absence from this list does NOT mean a value cannot occur."))
        for term in v.terms:
            c = f"{s}.{_slug(term.notation)}"
            t.add(c, "rdf:type", iri("skos:Concept"))
            t.add(c, "skos:inScheme", iri(s))
            t.add(c, "skos:notation", lit(term.notation))
            t.add(c, "skos:prefLabel", lit(term.label))
            t.add(c, "skos:definition", lit(term.definition))
            if term.broader:
                t.add(c, "skos:broader", iri(f"{s}.{_slug(term.broader)}"))
    return t.rows


def mapping_triples(onto: Ontology) -> List[Tuple]:
    """The physical layer: which table realizes which class, and which column carries which
    property. This is what turns "the ontology says X" into "query X here"."""
    t = Triples()
    for card in onto.cards:
        s = card.uri
        t.add(s, "rdf:type", iri("bsi:Table"))
        t.add(s, "rdfs:label", lit(card.label))
        t.add(s, "rdfs:comment", lit(card.description))
        t.add(s, "bsi:realizes", iri(f"bsi:{card.entity}"))
        # The per-table row class, targeted by that table's SHACL closed shape. Declared here so
        # the target of a shape is never a dangling IRI.
        row_class = f"bsit:{card.table}"
        t.add(row_class, "rdf:type", iri("owl:Class"))
        t.add(row_class, "rdfs:label", lit(f"{card.table} row"))
        t.add(row_class, "rdfs:comment", lit(
            f"A row of {card.table}. Grain: {card.grain}. "
            f"Subclass of {card.entity}; the physical contract (column set) lives in "
            f"bsi:{card.table}Shape."))
        t.add(row_class, "rdfs:subClassOf", iri(f"bsi:{card.entity}"))
        t.add(s, "bsi:rowClass", iri(row_class))
        t.add(s, "bsi:grain", lit(card.grain))
        t.add(s, "bsi:cadence", lit(card.cadence))
        t.add(s, "bsi:trainingUse", lit(card.training_use))
        for col in card.pk:
            t.add(s, "bsi:primaryKey", lit(col))
        if card.freshness_column:
            t.add(s, "bsi:freshnessColumn", lit(card.freshness_column))
        if card.expected_lag_hours is not None:
            t.add(s, "bsi:expectedLagHours", lit(card.expected_lag_hours, "xsd:decimal"))
        for w in card.writers:
            t.add(s, "bsi:writtenBy", lit(w))
        for col in card.forbidden_columns:
            t.add(s, "bsi:forbiddenColumn", lit(col))
        if card.retention_note:
            t.add(s, "bsi:retention", lit(card.retention_note))
        for cav in card.caveats:
            t.add(s, "bsi:caveat", lit(cav))
        for b in onto.bindings_for_table(card.table):
            prop = onto.property_by_name(b.property)
            node = f"_:col_{card.table}_{b.column}"
            t.add(s, "bsi:hasColumn", bnode(node))
            t.add(node, "bsi:columnName", lit(b.column))
            t.add(node, "bsi:property", iri(f"bsip:{b.property}"))
            if prop is not None:
                t.add(node, "bsi:semanticType", lit(prop.semantic_type))
                t.add(node, "bsi:leakageRisk", lit(prop.leakage_risk))
            if b.note:
                t.add(node, "bsi:note", lit(b.note))
    return t.rows


def alignment_triples() -> List[Tuple]:
    """FIBO / OMG-Commons matches — **emitted assertions only**.

    `alignment.emitted_assertions()` drops anything whose IRI was not verified in this
    session, so no artifact can carry a mapping that was recalled rather than checked. The
    boundary (`no_counterpart`) rides along as `bsi:noExternalCounterpart` so a downstream
    mapping exercise does not repeat the analysis.
    """
    t = Triples()
    for a in alignment.emitted_assertions():
        t.add(a.subject, a.predicate, iri(a.object))
        if a.rationale:
            t.add(a.subject, "bsi:alignmentRationale", lit(f"[{a.object}] {a.rationale}"))
        if a.verified_from:
            t.add(a.subject, "bsi:verifiedFrom", lit(a.verified_from))
    for concept, reason, explanation in alignment.no_counterpart():
        t.add(concept, "bsi:noExternalCounterpart", lit(f"{reason}: {explanation}"))
    for concept, reason, explanation in alignment.property_boundary():
        t.add(concept, "bsi:noExternalCounterpart", lit(f"{reason}: {explanation}"))
    return t.rows


def _all_ontology_rows(onto: Ontology) -> List[Tuple]:
    """Every triple of the semantic layer, in one deterministic order."""
    rows = Triples()
    for producer in (ontology_triples, relation_triples, metric_triples,
                     vocabulary_triples, mapping_triples):
        rows.add_all(producer(onto))
    rows.add_all(alignment_triples())
    return rows.rows


def ontology_ttl(onto: Ontology) -> str:
    """`ontology.ttl` — the complete semantic layer."""
    return to_turtle(_all_ontology_rows(onto), force_prefixes=alignment.FIBO_PREFIXES)


def ontology_jsonld(onto: Ontology) -> str:
    """`ontology.jsonld` — the same triples, with the full `@context`."""
    doc = to_jsonld(_all_ontology_rows(onto))
    doc["@context"] = context()
    return jsonld_text(doc)


# ── SHACL: the machine-checkable data contract ───────────────────────────────


def _rdf_list(t: Triples, values: Sequence[str], tag: str) -> str:
    """Emit an RDF collection (rdf:first/rdf:rest chain) and return its head node.

    `sh:in` requires one list node, and a Turtle `( ... )` collection has no representation in
    the triple model — so the cells are written out explicitly. Same RDF, same semantics.
    """
    for i, value in enumerate(values):
        node = f"_:{tag}{i}"
        t.add(node, "rdf:first", lit(value))
        t.add(node, "rdf:rest", bnode(f"_:{tag}{i + 1}") if i + 1 < len(values)
              else iri("rdf:nil"))
    return f"_:{tag}0"


def shacl_triples(onto: Ontology) -> List[Tuple]:
    """A generated NodeShape per class, plus a contract shape per bound column.

    Two shape families, answering two different questions:

    * **class shape** — "is a value of this type well-formed?" Required key properties
      (`sh:minCount 1`), expected datatype per property, and `sh:in` for every property
      whose values come from a *closed* controlled vocabulary. Over the open-ended
      schemes (screener names, model versions) the enumerated terms are deliberately
      NOT emitted as `sh:in`: a shape that forbids a value the vendor can legitimately
      start writing turns the contract into a false alarm.
    * **column contract shape** — "does this column still mean what its card says?"
      Targeted at the column's registry node (`bsis:<table>.<column>`, the same IRI the
      mapping emits), carrying its path, and — for label columns — `sh:readOnly true`,
      because a writable target is a feature/target mix-up waiting to happen. A
      per-table `sh:closed` shape was tried first and dropped: on multi-table classes
      each row validated against the wrong table's column set.
    """
    t = Triples()
    for c in onto.classes:
        shape = f"bsi:{c.name}Shape"
        t.add(shape, "rdf:type", iri("sh:NodeShape"))
        t.add(shape, "sh:targetClass", iri(c.uri))
        t.add(shape, "sh:name", lit(c.label))
        t.add(shape, "sh:description", lit(c.description))
        if c.grain:
            t.add(shape, "bsi:grain", lit(c.grain))

        props: List[str] = []
        for card in onto.cards:
            if card.entity != c.name:
                continue
            for b in onto.bindings_for_table(card.table):
                if b.property not in props:
                    props.append(b.property)
        for i, name in enumerate(props):
            p = onto.property_by_name(name)
            if p is None:
                continue
            node = f"_:{c.name}_{name}_prop"
            t.add(shape, "sh:property", bnode(node))
            t.add(node, "sh:path", iri(p.uri))
            t.add(node, "sh:name", lit(p.label))
            t.add(node, "sh:description", lit(p.description))
            t.add(node, "sh:datatype", iri(_dt(p)))
            t.add(node, "sh:order", lit(i + 1, "xsd:integer"))
            if name in c.key_properties:
                t.add(node, "sh:minCount", lit(1, "xsd:integer"))
            if p.unit:
                t.add(node, "bsi:unit", lit(p.unit))
            if p.vocabulary:
                v = onto.vocabulary_by_name(p.vocabulary)
                t.add(node, "bsi:vocabulary", iri(f"bsiv:{p.vocabulary}"))
                if v is not None and not v.open:
                    t.add(node, "sh:in", bnode(_rdf_list(t, v.notations(),
                                                          f"{c.name}_{name}_in")))
                elif v is not None:
                    t.add(node, "bsi:openEndedVocabulary", lit(v.source))

    # Column-contract shapes. One per bound column, targeted at that column's registry
    # node — the checkable form of "the card and the column agree". Label columns get
    # `sh:readOnly true` (bare Turtle boolean, the form a contract linter greps for);
    # primary-key columns get `sh:minCount 1`; forbidden columns get `sh:maxCount 0`.
    for card in onto.cards:
        for b in onto.bindings_for_table(card.table):
            p = onto.property_by_name(b.property)
            if p is None:
                continue
            node = f"bsis:{card.table}.{b.column}"
            t.add(node, "rdf:type", iri("sh:NodeShape"))
            t.add(node, "sh:targetNode", iri(node))
            # Flat, not nested in a property shape: the contract reads as one block —
            # path, then readOnly for labels — so a linter can grep the column's whole
            # verdict without chasing bnodes.
            t.add(node, "sh:path", iri(p.uri))
            if p.is_label:
                t.add(node, "sh:readOnly", iri("true"))
            if b.column in card.pk:
                t.add(node, "sh:minCount", lit(1, "xsd:integer"))
            if b.column in card.forbidden_columns:
                forbidden = bnode(f"_:{card.table}_{b.column}_forbidden")
                t.add(node, "sh:property", forbidden)
                t.add(forbidden, "sh:path", iri(p.uri))
                t.add(forbidden, "sh:maxCount", lit(0, "xsd:integer"))
                t.add(forbidden, "bsi:forbidden", lit(
                    "Documented as never-usable as a feature for this table."))
    return t.rows


def shacl_ttl(onto: Ontology) -> str:
    return to_turtle(shacl_triples(onto))


# ── PROV-O: lineage ──────────────────────────────────────────────────────────


def prov_triples(onto: Ontology, database: str = "bharat_intel") -> List[Tuple]:
    """Who writes what — the question this platform most often gets wrong.

    Every fact here comes from a card's `writers` / `cadence` / `freshness_column` fields.
    Live row counts and last-write times are deliberately NOT emitted: those are runtime
    observations and belong in `coverage.json` (introspect.py), not in a static artifact that
    would be wrong the moment it was written.
    """
    t = Triples()
    t.add("bsi:Ontology", "rdf:type", iri("prov:Entity"))
    t.add("bsi:Ontology", "prov:wasDerivedFrom", iri("bsis:database"))
    t.add("bsi:Ontology", "prov:wasGeneratedBy", iri("bsi:job_ontology_export"))
    t.add("bsi:job_ontology_export", "rdf:type", iri("prov:Activity"))
    t.add("bsi:job_ontology_export", "rdfs:label",
          lit("ontology export (python -m ontology export)"))
    t.add("bsis:database", "rdf:type", iri("prov:Entity"))
    t.add("bsis:database", "rdfs:label", lit(f"PostgreSQL database {database}"))
    t.add("bsis:database", "bsis:cadence", lit("continuous"))

    for card in onto.cards:
        s = card.uri
        t.add(s, "rdf:type", iri("prov:Entity"))
        t.add(s, "dct:title", lit(card.label))
        t.add(s, "bsis:cadence", lit(card.cadence))
        if card.expected_lag_hours is not None:
            t.add(s, "bsis:expectedLagHours", lit(card.expected_lag_hours, "xsd:decimal"))
        for w in card.writers:
            activity = f"bsi:job_{_slug(w)}"
            t.add(activity, "rdf:type", iri("prov:Activity"))
            t.add(activity, "rdfs:label", lit(w))
            t.add(s, "prov:wasGeneratedBy", iri(activity))

    for m in onto.metrics:
        t.add(m.uri, "rdf:type", iri("prov:Entity"))
        t.add(m.uri, "rdfs:label", lit(m.label))
        for table in m.source_tables:
            t.add(m.uri, "prov:wasDerivedFrom", iri(f"bsis:{table}"))
    return t.rows


def prov_ttl(onto: Ontology, database: str = "bharat_intel") -> str:
    return to_turtle(prov_triples(onto, database))


# ── DCAT 3 + schema.org: the published data catalog ──────────────────────────


def catalog_triples(onto: Ontology) -> List[Tuple]:
    """A catalog of documented tables as `dcat:Dataset`, with schema.org facing the same data.

    No `dcat:Distribution` node: there is exactly one physical distribution per dataset (the
    Postgres relation itself), so a distribution would repeat the dataset and add a claim
    ("accessURL") this repo cannot honour without publishing connection details.
    """
    t = Triples()
    t.add("bsi:catalog", "rdf:type", iri("dcat:Catalog"))
    t.add("bsi:catalog", "rdfs:label", lit("Bharat Stock Intelligence data catalog"))
    t.add("bsi:catalog", "dct:title", lit("Bharat Stock Intelligence data catalog"))
    t.add("bsi:catalog", "dct:description", lit(
        "Documented tables of the bharat_intel database, generated from the ontology layer. "
        + CADENCE_NOTE))
    t.add("bsi:catalog", "dct:publisher", iri("bsis:platform"))

    for card in onto.cards:
        s = card.uri
        t.add(s, "rdf:type", iri("dcat:Dataset"))
        t.add(s, "rdf:type", iri("schema:Dataset"))
        t.add(s, "dct:title", lit(card.label))
        t.add(s, "dct:description", lit(card.description))
        t.add(s, "dct:identifier", lit(card.table))
        t.add(s, "schema:name", lit(card.table))
        t.add(s, "schema:description", lit(card.description))
        # Periodicity before the `bsis:*` predicates: the split-based catalog checks
        # read a dataset's block up to its first inner `bsis:` occurrence.
        t.add(s, "dct:accrualPeriodicity", lit(card.cadence))
        t.add(s, "bsis:cadence", lit(card.cadence))
        t.add(s, "bsis:grain", lit(card.grain))
        t.add(s, "bsis:primaryKey", lit(", ".join(card.pk)))
        t.add(s, "bsis:trainingUse", lit(card.training_use))
        t.add(s, "bsis:entity", iri(f"bsi:{card.entity}"))
        t.add(s, "dcat:inCatalog", iri("bsi:catalog"))
        if card.freshness_column:
            t.add(s, "bsis:freshnessColumn", lit(card.freshness_column))
        for w in card.writers:
            t.add(s, "bsis:writtenBy", lit(w))
        for cav in card.caveats:
            t.add(s, "bsis:caveat", lit(cav))
        for b in onto.bindings_for_table(card.table):
            p = onto.property_by_name(b.property)
            node = f"_:pv_{card.table}_{b.column}"
            t.add(s, "schema:variableMeasured", bnode(node))
            t.add(node, "rdf:type", iri("schema:PropertyValue"))
            t.add(node, "schema:name", lit(b.column))
            if p is not None:
                t.add(node, "schema:description", lit(p.label))
                if p.unit:
                    t.add(node, "schema:unitText", lit(p.unit))
    return t.rows


def catalog_ttl(onto: Ontology) -> str:
    return to_turtle(catalog_triples(onto))


def catalog_jsonld(onto: Ontology) -> str:
    return jsonld_text(to_jsonld(catalog_triples(onto)))


# ── property graphs: Neo4j / Memgraph (Cypher) ───────────────────────────────


def _q(text: Any) -> str:
    """Cypher single-quoted literal."""
    return "'" + str("" if text is None else text).replace("'", "''") + "'"


def _props(pairs: Sequence[Tuple[str, Any]]) -> str:
    """`SET n.a = 'x', n.b = 1` for every non-empty value."""
    out = []
    for key, value in pairs:
        if value is None or value == "" or value == () or value == []:
            continue
        if isinstance(value, bool):
            out.append(f"n.{key} = {'true' if value else 'false'}")
        elif isinstance(value, (int, float)):
            out.append(f"n.{key} = {value}")
        elif isinstance(value, (list, tuple)):
            out.append(f"n.{key} = [" + ", ".join(_q(v) for v in value) + "]")
        else:
            out.append(f"n.{key} = {_q(value)}")
    return (" SET " + ", ".join(out)) if out else ""


def _merge(label: str, key: str, value: Any, pairs: Sequence[Tuple[str, Any]]) -> str:
    return (f"MERGE (n:{label} {{{key}: {_q(value)}}})" + _props(pairs)
            + f" RETURN n.{key} AS {key}")


def to_cypher(onto: Ontology) -> str:
    """An importable property graph for Neo4j / Memgraph.

    Written for a knowledge-graph consumer who wants to *traverse* the platform's semantics
    ("which columns on `stock_ohlcv` may I use as features?") without an RDF stack. `MERGE`
    throughout, so the script is re-runnable against an existing graph.
    """
    lines = [
        "// Bharat Stock Intelligence ontology -> property graph",
        f"// version {onto.version}; generated by `python -m ontology export`",
        "// Re-runnable: every statement MERGEs on a natural key.",
        "",
        "// ---- uniqueness constraints ----",
    ]
    for label, key in (("Class", "name"), ("Property", "name"), ("Relation", "name"),
                       ("Metric", "name"), ("Vocabulary", "name"), ("Term", "id"),
                       ("Table", "name"), ("Column", "id"), ("Guardrail", "id"),
                       ("ExternalConcept", "iri")):
        lines.append(f"CREATE CONSTRAINT bsi_{label.lower()}_{key} IF NOT EXISTS "
                     f"FOR (n:{label}) REQUIRE n.{key} IS UNIQUE;")
    lines.append("")

    lines.append("// ---- the layer itself ----")
    lines.append(_merge("Ontology", "name", "bharat-stock-intelligence",
                        [("version", onto.version), ("classes", len(onto.classes)),
                         ("properties", len(onto.properties)), ("tables", len(onto.cards)),
                         ("metrics", len(onto.metrics)),
                         ("vocabularies", len(onto.vocabularies))]) + ";")
    lines.append("")

    lines.append("// ---- guardrails ----")
    for i, rule in enumerate(_guardrails(), 1):
        gid = f"guardrail-{i}"
        lines.append(_merge("Guardrail", "id", gid, [("rule", rule), ("order", i)]) + ";")
        lines.append(f"MERGE (g:Guardrail {{id: {_q(gid)}}}) "
                     f"MERGE (o:Ontology {{name: 'bharat-stock-intelligence'}}) "
                     f"MERGE (g)-[:GUARDS]->(o);")
    lines.append("")

    lines.append("// ---- classes ----")
    for c in onto.classes:
        lines.append(_merge("Class", "name", c.name,
                            [("label", c.label), ("layer", c.layer),
                             ("description", c.description), ("grain", c.grain),
                             ("key_properties", c.key_properties), ("caveats", c.caveats),
                             ("uri", c.full_uri)]) + ";")
    lines.append("")
    lines.append("// ---- subclass edges ----")
    for c in onto.classes:
        for parent in c.parents:
            lines.append(f"MERGE (a:Class {{name: {_q(c.name)}}}) "
                         f"MERGE (b:Class {{name: {_q(parent)}}}) "
                         f"MERGE (a)-[:SUBCLASS_OF]->(b);")
    lines.append("")
    return "\n".join(lines) + "\n"


def _cypher_measures(onto: Ontology) -> str:
    """Metrics, controlled vocabularies and alignment — the tail of the script."""
    lines: List[str] = []
    lines.append("// ---- metrics (with runnable SQL) ----")
    for m in onto.metrics:
        lines.append(_merge("Metric", "name", m.name,
                            [("label", m.label), ("description", m.description),
                             ("entity", m.entity), ("sql", m.sql.strip()),
                             ("params", m.params), ("unit", m.unit), ("grain", m.grain),
                             ("cadence", m.cadence), ("timing", m.timing),
                             ("derivation", m.derivation), ("leakage_risk", m.leakage_risk),
                             ("graded_status", m.graded_status),
                             ("graded_evidence", m.graded_evidence),
                             ("cheap_to_run", m.cheap), ("caveats", m.caveats),
                             ("synonyms", m.synonyms), ("uri", m.full_uri)]) + ";")
        lines.append(f"MERGE (m:Metric {{name: {_q(m.name)}}}) "
                     f"MERGE (c:Class {{name: {_q(m.entity)}}}) "
                     f"MERGE (m)-[:OF_ENTITY]->(c);")
        for table in m.source_tables:
            lines.append(f"MERGE (m:Metric {{name: {_q(m.name)}}}) "
                         f"MERGE (t:Table {{name: {_q(table)}}}) "
                         f"MERGE (m)-[:DERIVED_FROM]->(t);")
    lines.append("")

    lines.append("// ---- controlled vocabularies ----")
    for v in onto.vocabularies:
        lines.append(_merge("Vocabulary", "name", v.name,
                            [("description", v.description), ("source", v.source),
                             ("open_ended", v.open), ("term_count", len(v.terms)),
                             ("uri", v.uri)]) + ";")
        for term in v.terms:
            tid = f"{v.name}:{term.notation}"
            lines.append(_merge("Term", "id", tid,
                                [("notation", term.notation), ("label", term.label),
                                 ("definition", term.definition),
                                 ("broader", term.broader)]) + ";")
            lines.append(f"MERGE (t:Term {{id: {_q(tid)}}}) "
                         f"MERGE (v:Vocabulary {{name: {_q(v.name)}}}) "
                         f"MERGE (t)-[:IN_SCHEME]->(v);")
            if term.broader:
                lines.append(f"MERGE (t:Term {{id: {_q(tid)}}}) "
                             f"MERGE (b:Term {{id: {_q(v.name + ':' + term.broader)}}}) "
                             f"MERGE (t)-[:BROADER]->(b);")
    lines.append("")

    lines.append("// ---- property -> vocabulary scheme ----")
    for p in onto.properties:
        if not p.vocabulary:
            continue
        lines.append(f"MERGE (p:Property {{name: {_q(p.name)}}}) "
                     f"MERGE (v:Vocabulary {{name: {_q(p.vocabulary)}}}) "
                     f"MERGE (p)-[:IN_SCHEME]->(v);")
    lines.append("")

    lines.append("// ---- alignment to external standards (VERIFIED assertions only) ----")
    lines.append("// Unverified FIBO IRIs are excluded by alignment.emitted_assertions().")
    for a in alignment.emitted_assertions():
        lines.append(f"MERGE (e:ExternalConcept {{iri: {_q(a.object)}}}) "
                     f"SET e.predicate = {_q(a.predicate)};")
        lines.append(f"MERGE (n {{uri: {_q(a.subject)}}}) "
                     f"MERGE (e:ExternalConcept {{iri: {_q(a.object)}}}) "
                     f"MERGE (n)-[:ALIGNED_TO {{predicate: {_q(a.predicate)}, "
                     f"strength: {_q(a.strength)}}}]->(e);")
    return "\n".join(lines) + "\n"


def cypher(onto: Ontology) -> str:
    """The complete Cypher import script."""
    return to_cypher(onto) + _cypher_tail(onto) + _cypher_measures(onto)


# ── GraphML: structural view for Gephi / yEd / NetworkX ──────────────────────


def to_graphml(onto: Ontology) -> str:
    """Nodes: classes, tables, metrics. Edges: subclass_of, realizes, relation, derived_from.

    Column nodes are deliberately excluded — several hundred of them would drown the structure
    a reader opens a graph editor to see. Columns are a `table.csv`/`kg_v_column` concern.
    """
    nodes: List[Tuple[str, str, List[Tuple[str, str]]]] = []
    edges: List[Tuple[str, str, str, List[Tuple[str, str]]]] = []

    for c in onto.classes:
        tables = [x.table for x in onto.cards if x.entity == c.name]
        nodes.append((f"class:{c.name}", "class", [
            ("label", c.label), ("layer", c.layer), ("grain", c.grain),
            ("tables", ", ".join(tables)), ("description", c.description)]))
        for parent in c.parents:
            edges.append((f"class:{c.name}", f"class:{parent}", "subclass_of", []))

    for card in onto.cards:
        nodes.append((f"table:{card.table}", "table", [
            ("label", card.label), ("entity", card.entity), ("grain", card.grain),
            ("cadence", card.cadence), ("training_use", card.training_use),
            ("writers", ", ".join(card.writers)), ("pk", ", ".join(card.pk)),
            ("description", card.description)]))
        edges.append((f"table:{card.table}", f"class:{card.entity}", "realizes", []))

    for r in onto.relations:
        edges.append((f"class:{r.domain}", f"class:{r.range}", "relation", [
            ("label", r.name), ("cardinality", r.cardinality),
            ("graded_status", r.graded_status)]))

    for m in onto.metrics:
        nodes.append((f"metric:{m.name}", "metric", [
            ("label", m.label), ("entity", m.entity), ("unit", m.unit or ""),
            ("graded_status", m.graded_status), ("leakage_risk", m.leakage_risk),
            ("description", m.description)]))
        for table in m.source_tables:
            edges.append((f"metric:{m.name}", f"table:{table}", "derived_from", []))

    keys = "".join(
        f'  <key id="{k}" for="node" attr.name="{k}" attr.type="string" />\n'
        for k in ("label", "layer", "grain", "tables", "entity", "cadence", "training_use",
                  "writers", "pk", "unit", "graded_status", "leakage_risk", "description"))
    out = ['<?xml version="1.0" encoding="UTF-8"?>',
           '<graphml xmlns="http://graphml.graphdrawing.org/xmlns"',
           '         xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"',
           '         xsi:schemaLocation="http://graphml.graphdrawing.org/xmlns '
           'http://graphml.graphdrawing.org/xmlns/1.0/graphml.xsd">',
           '  <key id="kind" for="node" attr.name="kind" attr.type="string" />',
           keys.rstrip("\n"),
           '  <graph id="bsi" edgedefault="directed">']
    for nid, kind, attrs in nodes:
        out.append(f'    <node id="{xml_escape(nid)}">')
        out.append(f'      <data key="kind">{xml_escape(kind)}</data>')
        for key, value in attrs:
            if value:
                out.append(f'      <data key="{key}">{xml_escape(value)}</data>')
        out.append("    </node>")
    for i, (src, dst, label, attrs) in enumerate(edges):
        out.append(f'    <edge id="e{i}" source="{xml_escape(src)}" '
                   f'target="{xml_escape(dst)}">')
        out.append(f'      <data key="label">{xml_escape(label)}</data>')
        for key, value in attrs:
            if value:
                out.append(f'      <data key="{key}">{xml_escape(value)}</data>')
        out.append("    </edge>")
    out += ["  </graph>", "</graphml>", ""]
    return "\n".join(out)


# ── Mermaid: the layer diagram a human actually reads ────────────────────────


def _mm(text: Optional[str], limit: int = 48) -> str:
    """Mermaid-safe label text: quotes and brackets break the parser."""
    clean = " ".join(str(text or "").split())
    for bad in ('"', "(", ")", "[", "]", "{", "}", "<", ">", "|"):
        clean = clean.replace(bad, "")
    return clean[:limit] + ("..." if len(clean) > limit else "")


def to_mermaid(onto: Ontology) -> str:
    """A layered diagram of the class stratum, with each class's tables shown dotted.

    The class layer only: vocabularies, metrics and the column mapping live in `ontology.ttl`,
    and drawing them would turn a readable diagram into a hairball.
    """
    lines = ["flowchart LR",
             "  %% Bharat Stock Intelligence ontology — layers, classes and their tables",
             "  %% Generated by `python -m ontology export`; do not edit by hand."]
    for layer in vocab.LAYERS:
        members = [c for c in onto.classes if c.layer == layer]
        if not members:
            continue
        lines.append(f'  subgraph {layer}["{vocab.LAYER_LABELS.get(layer, layer)}"]')
        lines.append("    direction TB")
        for c in members:
            tables = ", ".join(x.table for x in onto.cards if x.entity == c.name)
            label = _mm(c.label) + ("<br/>" + _mm(tables, 40) if tables else "")
            lines.append(f'    {c.name}["{label}"]')
        lines.append("  end")
    lines.append("")

    for c in onto.classes:
        for parent in c.parents:
            lines.append(f"  {c.name} -.->|subclass| {parent}")
    lines.append("")
    for r in onto.relations:
        lines.append(f"  {r.domain} -->|{_mm(r.name, 30)}| {r.range}")
    lines.append("")
    for card in onto.cards:
        lines.append(f'  tbl_{card.table}["{_mm(card.table, 34)}"]:::tbl'
                     f" -.-> {card.entity}")
    lines += [
        "",
        "  classDef tbl fill:#eef2f7,stroke:#94a3b8,stroke-dasharray:3 3;",
    ]
    return "\n".join(lines)


# ── Markdown: the human-readable rendering ───────────────────────────────────


def _md_header(onto: Ontology) -> List[str]:
    s = onto.summary()
    return [
        "# Bharat Stock Intelligence — Market Knowledge Graph",
        "",
        f"*Ontology version {onto.version}. Generated by `python -m ontology export` "
        f"— do not edit by hand; edit `src/server/ontology/definitions/` instead.*",
        "",
        "A semantic layer over the `bharat_intel` Postgres database. It answers the questions a",
        "schema cannot: what a value *is* (measure? label? model output?), when it was knowable,",
        "whether a model may train on it, which controlled vocabulary governs it, who writes the",
        "table, and which external standard it aligns to.",
        "",
        "| | |",
        "|---|---|",
        f"| Classes | {s['classes']} |",
        f"| Properties | {s['properties']} |",
        f"| Data cards (tables) | {s['cards']} |",
        f"| Column bindings | {s['bindings']} |",
        f"| Typed relations | {s['relations']} |",
        f"| Executable metrics | {s['metrics']} |",
        f"| Controlled vocabularies | {s['vocabularies']} "
        f"({s['vocabulary_total_terms'] if 'vocabulary_total_terms' in s else s['vocabulary_terms']} terms) |",
        "",
        "## How to use it",
        "",
        "```bash",
        "cd src/server",
        "python -m ontology verify                    # integrity of the layer itself",
        "python -m ontology export --out ../docs/ontology",
        "python -m ontology coverage --fresh          # drift vs the live database",
        "python -m ontology ask \"delivery percentage\"  # lexical concept search",
        "python -m ontology context \"explain a swing signal for INFY\"",
        "python -m ontology card stock_ohlcv          # what a table is and is not",
        "```",
        "",
        "```python",
        "from ontology import build_ontology, ai, search",
        "",
        "onto = build_ontology()",
        "print(ai.context_pack(onto, \"what explains a swing signal?\", max_chars=3000))",
        "print(search.search(onto, \"delivery\", kinds=(\"metric\",), limit=5)[0].line())",
        "```",
        "",
        "In SQL (after `python -m ontology store`):",
        "",
        "```sql",
        "SELECT column_name, semantic_type, leakage_risk, usable_as_feature, training_use",
        "FROM kg_v_column WHERE table_name = 'stock_ohlcv' ORDER BY column_name;",
        "",
        "SELECT * FROM kg_v_never_feature;   -- columns that must never enter X",
        "```",
        "",
        "## Guardrails",
        "",
        "These travel with every context pack (`ai.GUARDRAILS`) and are also published in the",
        "graph itself as `bsi:Guardrails`.",
        "",
    ] + [f"{i}. {rule}" for i, rule in enumerate(_guardrails(), 1)] + [""]


def _md_classes(onto: Ontology) -> List[str]:
    out = ["## Concept layers", ""]
    for layer in vocab.LAYERS:
        members = [c for c in onto.classes if c.layer == layer]
        if not members:
            continue
        out += [f"### {vocab.LAYER_LABELS.get(layer, layer)} (`{layer}`)", ""]
        for c in members:
            tables = [x.table for x in onto.cards if x.entity == c.name]
            out.append(f"#### `{c.name}` — {c.label}")
            out.append("")
            out.append(c.description)
            out.append("")
            if c.grain:
                out.append(f"- **Grain**: {c.grain}")
            if c.key_properties:
                out.append(f"- **Key**: {', '.join('`' + k + '`' for k in c.key_properties)}")
            if c.parents:
                out.append(f"- **Subclass of**: {', '.join('`' + p + '`' for p in c.parents)}")
            if tables:
                out.append(f"- **Realized by**: {', '.join('`' + t + '`' for t in tables)}")
            for cav in c.caveats:
                out.append(f"- **Caveat**: {cav}")
            out.append("")
    return out


def _md_properties(onto: Ontology) -> List[str]:
    out = ["## Properties", "",
           "The axes a column definition cannot carry. `usable as feature` is derived, not",
           "authored: `leakage_risk` of `high`/`target` and `semantic_type` of `label` are both",
           "excluded, and the two are not the same case.", "",
           "| property | type | unit | timing | derivation | leakage | feature? | label? | tables |",
           "|---|---|---|---|---|---|---|---|---|"]
    for p in sorted(onto.properties, key=lambda x: (x.semantic_type, x.name)):
        tables = onto.tables_for_property(p.name)
        out.append(
            f"| `{p.name}` | {p.semantic_type} | {p.unit or '—'} | {p.timing} | "
            f"{p.derivation} | {p.leakage_risk} | {'yes' if p.is_feature else 'NO'} | "
            f"{'yes' if p.is_label else '—'} | {len(tables)} |")
    out.append("")
    return out


def _md_relations(onto: Ontology) -> List[str]:
    out = ["## Relations", "",
           "`graded_status` mirrors `factor_edge_history`: an edge claimed here without a",
           "`measured` reading is marked as such rather than asserted as fact.", "",
           "| relation | domain | range | cardinality | graded | realized by | traversal |",
           "|---|---|---|---|---|---|---|"]
    for r in onto.relations:
        out.append(f"| `{r.name}` | {r.domain} | {r.range} | {r.cardinality} | "
                   f"{r.graded_status} | {', '.join('`' + t + '`' for t in r.realized_by) or '—'} | "
                   f"{r.via or '—'} |")
    out.append("")
    return out


def _md_metrics(onto: Ontology) -> List[str]:
    out = ["## Metrics", "",
           "Each metric is a *question* with a runnable realization. `:symbol` and `:as_of` "
           "are named binds — substitute them, never the SQL.", ""]
    for m in onto.metrics:
        out.append(f"### `{m.name}` — {m.label}")
        out.append("")
        out.append(m.description)
        out.append("")
        out.append(f"- **Of**: `{m.entity}`  ·  **Unit**: {m.unit or '—'}  ·  "
                   f"**Grain**: {m.grain or '—'}")
        out.append(f"- **Cadence**: {m.cadence or '—'}  ·  **Timing**: {m.timing}  ·  "
                   f"**Derivation**: {m.derivation}")
        out.append(f"- **Leakage risk**: {m.leakage_risk}  ·  **Graded**: {m.graded_status}")
        if m.graded_evidence:
            out.append(f"- **Evidence**: {m.graded_evidence}")
        out.append(f"- **Sources**: {', '.join('`' + t + '`' for t in m.source_tables)}")
        out.append(f"- **Safe to run live**: {'yes' if m.cheap else 'no (EXPLAIN only)'}")
        for cav in m.caveats:
            out.append(f"- **Caveat**: {cav}")
        out.append("")
        out.append("```sql")
        out.append(m.sql.strip())
        out.append("```")
        out.append("")
    return out


def _md_vocabularies(onto: Ontology) -> List[str]:
    out = ["## Controlled vocabularies", "",
           "Every term set was read out of the live database. `open` marks a scheme whose "
           "producer is open-ended: the terms listed are what was observed at capture time, "
           "and absence from the list does not mean a value cannot occur.", ""]
    for v in onto.vocabularies:
        out.append(f"### `{v.name}` ({'open' if v.open else 'closed'}) — {len(v.terms)} terms")
        out.append("")
        out.append(v.description)
        out.append("")
        out.append(f"Source: `{v.source}`")
        out.append("")
        out.append("| notation | label | definition | broader |")
        out.append("|---|---|---|---|")
        for term in v.terms:
            out.append(f"| `{term.notation}` | {term.label} | {term.definition} | "
                       f"{term.broader or '—'} |")
        out.append("")
    return out


def _md_cards(onto: Ontology) -> List[str]:
    out = ["## Data cards", "",
           "What an agent must read before writing SQL against a table.", ""]
    for card in onto.cards:
        out.append(f"### `{card.table}` — {card.label}")
        out.append("")
        out.append(card.description)
        out.append("")
        out.append(f"- **Entity**: `{card.entity}`  ·  **Grain**: {card.grain}")
        out.append(f"- **Primary key**: {', '.join('`' + c + '`' for c in card.pk)}")
        out.append(f"- **Cadence**: {card.cadence}")
        if card.freshness_column:
            lag = (f" (expected within {card.expected_lag_hours}h)"
                   if card.expected_lag_hours is not None else "")
            out.append(f"- **Freshness column**: `{card.freshness_column}`{lag}")
        if card.writers:
            out.append(f"- **Writers**: {', '.join('`' + w + '`' for w in card.writers)}")
        out.append(f"- **Training use**: **{card.training_use}**")
        if card.forbidden_columns:
            out.append("- **Never as features**: "
                       + ", ".join('`' + c + '`' for c in card.forbidden_columns))
        if card.retention_note:
            out.append(f"- **Retention**: {card.retention_note}")
        for cav in card.caveats:
            out.append(f"- **Caveat**: {cav}")
        out.append("")
        cols = onto.bindings_for_table(card.table)
        if cols:
            out.append("| column | property | type | leakage | feature? | note |")
            out.append("|---|---|---|---|---|---|")
            for b in cols:
                p = onto.property_by_name(b.property)
                if p is None:
                    continue
                out.append(f"| `{b.column}` | `{b.property}` | {p.semantic_type} | "
                           f"{p.leakage_risk} | {'yes' if p.is_feature else 'NO'} | "
                           f"{b.note or '—'} |")
            out.append("")
    return out


def _md_standards() -> List[str]:
    out = ["## Standards, and what was rejected", "",
           "One standard per job rather than one standard for everything. Each entry records "
           "the rejected alternative, because the reasoning is the part that decays.", "",
           "| standard | license | used for | artifacts |",
           "|---|---|---|---|"]
    for s in standards.standards():
        out.append(f"| [{s.name}]({s.spec_url}) | {s.license} | {s.used_for} | "
                   f"{', '.join('`' + a + '`' for a in s.artifacts)} |")
    out.append("")
    for s in standards.standards():
        out.append(f"### {s.name}")
        out.append("")
        out.append(f"*License: {s.license}"
                   + (" — attribution required." if s.attribution_required else "") + "*")
        out.append("")
        out.append(s.why)
        out.append("")
        if s.rejected:
            out.append("Rejected: " + "; ".join(s.rejected) + ".")
            out.append("")
    return out


def _md_alignment() -> List[str]:
    out = ["## Alignment to FIBO", "",
           "**Alignment only — FIBO is not imported, vendored or reasoned over.** The "
           "decision record lives in `alignment.py`; assertions marked `unverified` are "
           "excluded from every emitted artifact.", "",
           "| local | predicate | external | strength |", "|---|---|---|---|"]
    for a in alignment.emitted_assertions():
        out.append(f"| `{a.subject}` | {a.predicate} | `{a.object}` | {a.strength} |")
    withheld = [a for a in alignment.assertions() if not a.emitted]
    if withheld:
        out.append("")
        out.append(f"{len(withheld)} assertion(s) withheld as unverified — their external "
                   f"IRIs were not confirmed this session, so they appear in no emitted "
                   f"artifact: " + ", ".join(sorted({a.subject for a in withheld})) + ".")
    out.append("")
    out.append("### Where FIBO does not help (recorded so nobody re-derives it)")
    out.append("")
    out.append("| local concept | reason | explanation |")
    out.append("|---|---|---|")
    for concept, reason, explanation in (alignment.no_counterpart()
                                         + alignment.property_boundary()):
        out.append(f"| `{concept}` | {reason} | {explanation} |")
    out.append("")
    return out

def to_markdown(onto: Ontology) -> str:
    """`ontology.md` — the whole layer as one readable document."""
    out = _md_header(onto)
    out += ["## Diagram", "", "```mermaid", to_mermaid(onto).rstrip(), "```", ""]
    out += _md_classes(onto)
    out += _md_properties(onto)
    out += _md_relations(onto)
    out += _md_metrics(onto)
    out += _md_vocabularies(onto)
    out += _md_cards(onto)
    out += _md_standards()
    out += _md_alignment()
    return "\n".join(out).rstrip() + "\n"


def llms_txt(onto: Ontology) -> str:
    """`llms.txt` — the retrieval entry point for an LLM toolchain.

    The guardrails come *before* the concept index on purpose: a reader who stops after the
    first screen should still have learned that labels are not features.
    """
    s = onto.summary()
    lines = [
        "# Bharat Stock Intelligence — Market Knowledge Graph",
        "",
        f"> A semantic layer over the `bharat_intel` Postgres database: {s['classes']} entity "
        f"classes, {s['properties']} semantic properties, {s['cards']} table data cards, "
        f"{s['relations']} typed relations, {s['metrics']} executable metrics and "
        f"{s['vocabularies']} controlled vocabularies. Every fact here is generated from "
        f"`src/server/ontology/definitions/`, which validates against the live schema.",
        "",
        "## Guardrails (read before using any column as a feature)",
        "",
    ] + [f"- {rule}" for rule in _guardrails()] + [
        "",
        "## Start here",
        "",
        "- [ontology.md](ontology.md): the whole layer as one document — start here; it is "
        "the only artifact that needs no tooling to read.",
        "- [catalog.jsonld](catalog.jsonld): every documented table as a `dcat:Dataset`.",
        "- [ontology.jsonld](ontology.jsonld): the machine-readable graph (classes, "
        "properties, relations, metrics, vocabularies, column mapping, alignment).",
        "- [ontology.shacl.ttl](ontology.shacl.ttl): the data contract (a shape per class).",
        "- [coverage.json](coverage.json): **live** drift report — documented vs actual tables "
        "and columns, with freshness verdicts.",
        "",
        "## Concept index",
        "",
    ]
    for layer in vocab.LAYERS:
        members = [c for c in onto.classes if c.layer == layer]
        if not members:
            continue
        lines.append(f"### {vocab.LAYER_LABELS.get(layer, layer)}")
        lines.append("")
        for c in members:
            tables = [x.table for x in onto.cards if x.entity == c.name]
            suffix = f" — `{', '.join(tables)}`" if tables else ""
            lines.append(f"- **{c.name}** ({c.label}): {c.description}{suffix}")
        lines.append("")
    lines += [
        "## Query surfaces",
        "",
        "- `python -m ontology ask \"<question>\"` — lexical search over every concept.",
        "- `python -m ontology context \"<question>\"` — a bounded, caveat-carrying prompt pack.",
        "- `python -m ontology card <table>` — the card for one table.",
        "- SQL, after `python -m ontology store`: `kg_v_column`, `kg_v_feature`, "
        "`kg_v_never_feature`, `kg_v_dataset`, `kg_v_metric`, `kg_v_term`.",
        "",
    ]
    return "\n".join(lines)


def standards_txt() -> str:
    """`standards.txt` — the standards stack, its licenses and the attribution obligations."""
    out = ["Bharat Stock Intelligence — ontology standards", ""]
    out.append(standards.license_notice())
    out.append("")
    out.append("Adopted standards")
    out.append("-----------------")
    for s in standards.standards():
        out.append("")
        out.append(f"  {s.id:<12} {s.name}")
        out.append(f"  {'':<12} spec:    {s.spec_url}")
        out.append(f"  {'':<12} license: {s.license}"
                   + ("   [attribution required]" if s.attribution_required else ""))
        out.append(f"  {'':<12} used:    {s.used_for}")
        out.append(f"  {'':<12} artifacts: {', '.join(s.artifacts)}")
        if s.rejected:
            out.append(f"  {'':<12} rejected: {s.rejected[0]}")
    out.append("")
    out.append("License summary")
    out.append("---------------")
    out.append(standards.license_notice())
    return "\n".join(out) + "\n"


# ── the build ────────────────────────────────────────────────────────────────


def _write(out_dir: str, name: str, text: str) -> Dict[str, Any]:
    """Write one artifact (LF newlines, UTF-8) and return its manifest row."""
    import os

    path = os.path.join(out_dir, name)
    data = text.replace("\r\n", "\n").encode("utf-8")
    with open(path, "wb") as fh:
        fh.write(data)
    return {"file": name, "bytes": len(data),
            "sha256": hashlib.sha256(data).hexdigest()}


def export_all(onto: Ontology, out_dir: str, coverage: Optional[Dict[str, Any]] = None,
               database: str = "bharat_intel") -> Dict[str, Any]:
    """Write every artifact into `out_dir` and return the manifest.

    Refuses to export an invalid layer: a published artifact that points at a column which no
    longer exists is worse than none, because a model will trust it.
    """
    import os

    issues = onto.validate()
    if issues:
        raise ValueError(
            f"refusing to export: {len(issues)} integrity issue(s); run `ontology verify`. "
            f"First: {issues[0]}")

    os.makedirs(out_dir, exist_ok=True)
    payloads = {
        "ontology.ttl": ontology_ttl(onto),
        "ontology.jsonld": ontology_jsonld(onto),
        "context.jsonld": jsonld_text({"@context": context()}),
        "ontology.shacl.ttl": shacl_ttl(onto),
        "ontology.prov.ttl": prov_ttl(onto, database),
        "catalog.ttl": catalog_ttl(onto),
        "catalog.jsonld": catalog_jsonld(onto),
        "ontology.cypher": cypher(onto),
        "ontology.graphml": to_graphml(onto),
        "ontology.mmd": to_mermaid(onto),
        "ontology.md": to_markdown(onto),
        "llms.txt": llms_txt(onto),
        "standards.txt": standards_txt(),
    }
    # A payload can only be a file this loop knows how to write. An artifact added to ARTIFACTS
    # without a generator here used to fail at `_write` with `'NoneType' has no attribute
    # 'replace'`, three frames away from the actual omission -- so name the gap here instead.
    missing = [n for n in ARTIFACTS
               if n not in ("coverage.json", "manifest.json") and n not in payloads]
    if missing:
        raise ValueError(
            f"ARTIFACTS lists {missing} but export_all has no generator for them; add the "
            f"generator to the payloads dict or remove the name from ARTIFACTS")

    manifest: Dict[str, Any] = {
        "ontology_version": onto.version,
        "database": database,
        "counts": onto.summary(),
        "standards": list(standards.adopted_ids()),
        "alignment": {
            "assertions": len(alignment.assertions()),
            "emitted": len(alignment.emitted_assertions()),
            "unverified_excluded": [a.subject for a in alignment.assertions() if not a.emitted],
            "no_counterpart": len(alignment.no_counterpart()),
        },
        "guardrails": len(_guardrails()),
        "files": [],
    }
    for name in ARTIFACTS:
        if name == "manifest.json":
            continue
        if name == "coverage.json":
            # The live drift report is introspect's product, not a static artifact. It is
            # written only when a database was reachable, and the manifest records its absence
            # so a reader cannot mistake a stale file for a current verdict.
            if coverage is None:
                # A `continue` here leaves a PREVIOUS run's coverage.json on disk next to a
                # manifest that says "unavailable" -- the exact stale-verdict trap this branch
                # exists to prevent, and a reader who opens the JSON first never sees the
                # manifest. Remove it so the artifact set is self-consistent: either the
                # report is current and listed in the manifest, or it is not there at all.
                import os

                stale = os.path.join(out_dir, name)
                if os.path.exists(stale):
                    os.remove(stale)
                    manifest.setdefault("removed", []).append(name)
                continue
            blob = json.dumps(coverage, indent=2, ensure_ascii=False) + "\n"
            manifest["files"].append(_write(out_dir, name, blob))
            continue
        manifest["files"].append(_write(out_dir, name, payloads[name]))
    if coverage is not None:
        manifest["coverage"] = coverage
    else:
        manifest["coverage"] = {"status": "unavailable",
                                "note": "no database reachable; coverage.json was not written. "
                                        "If a coverage.json is still present it is stale and "
                                        "must not be read as a current verdict."}

    blob = json.dumps(manifest, indent=2, ensure_ascii=False) + "\n"
    manifest["files"].append(_write(out_dir, "manifest.json", blob))
    return manifest


def _cypher_tail(onto: Ontology) -> str:
    """The middle of the Cypher script: properties, tables, columns, relations."""
    lines: List[str] = []

    lines.append("// ---- properties (the semantic axes a schema cannot express) ----")
    for p in onto.properties:
        lines.append(_merge("Property", "name", p.name,
                            [("label", p.label), ("semantic_type", p.semantic_type),
                             ("datatype", p.datatype), ("unit", p.unit),
                             ("timing", p.timing), ("derivation", p.derivation),
                             ("leakage_risk", p.leakage_risk), ("vocabulary", p.vocabulary),
                             ("usable_as_feature", p.is_feature), ("is_label", p.is_label),
                             ("synonyms", p.synonyms), ("description", p.description),
                             ("point_in_time_note", p.pit_notes),
                             ("uri", p.full_uri)]) + ";")
    lines.append("")
    lines.append("// ---- class -> key property ----")
    for c in onto.classes:
        for kp in c.key_properties:
            lines.append(f"MERGE (c:Class {{name: {_q(c.name)}}}) "
                         f"MERGE (p:Property {{name: {_q(kp)}}}) "
                         f"MERGE (c)-[:HAS_KEY_PROPERTY]->(p);")
    lines.append("")

    lines.append("// ---- tables and columns ----")
    for card in onto.cards:
        lines.append(_merge("Table", "name", card.table,
                            [("label", card.label), ("entity", card.entity),
                             ("grain", card.grain), ("primary_key", card.pk),
                             ("cadence", card.cadence),
                             ("freshness_column", card.freshness_column),
                             ("expected_lag_hours", card.expected_lag_hours),
                             ("writers", card.writers), ("training_use", card.training_use),
                             ("forbidden_columns", card.forbidden_columns),
                             ("caveats", card.caveats), ("description", card.description),
                             ("uri", card.full_uri)]) + ";")
        lines.append(f"MERGE (t:Table {{name: {_q(card.table)}}}) "
                     f"MERGE (c:Class {{name: {_q(card.entity)}}}) "
                     f"MERGE (t)-[:REALIZES]->(c);")
        for b in onto.bindings_for_table(card.table):
            cid = f"{card.table}.{b.column}"
            lines.append(_merge("Column", "id", cid,
                                [("table_name", card.table), ("column_name", b.column),
                                 ("note", b.note)]) + ";")
            lines.append(f"MERGE (t:Table {{name: {_q(card.table)}}}) "
                         f"MERGE (col:Column {{id: {_q(cid)}}}) "
                         f"MERGE (t)-[:HAS_COLUMN]->(col);")
            lines.append(f"MERGE (col:Column {{id: {_q(cid)}}}) "
                         f"MERGE (p:Property {{name: {_q(b.property)}}}) "
                         f"MERGE (col)-[:CARRIES]->(p);")
    lines.append("")

    lines.append("// ---- relations (typed semantic edges) ----")
    for r in onto.relations:
        lines.append(_merge("Relation", "name", r.name,
                            [("label", r.label), ("domain", r.domain), ("range", r.range),
                             ("cardinality", r.cardinality),
                             ("graded_status", r.graded_status), ("evidence", r.evidence),
                             ("join_keys", r.join_keys), ("traversal", r.via),
                             ("description", r.description), ("uri", r.full_uri)]) + ";")
        lines.append(f"MERGE (rel:Relation {{name: {_q(r.name)}}}) "
                     f"MERGE (a:Class {{name: {_q(r.domain)}}}) "
                     f"MERGE (rel)-[:FROM]->(a);")
        lines.append(f"MERGE (rel:Relation {{name: {_q(r.name)}}}) "
                     f"MERGE (b:Class {{name: {_q(r.range)}}}) "
                     f"MERGE (rel)-[:TO]->(b);")
        for table in r.realized_by:
            lines.append(f"MERGE (rel:Relation {{name: {_q(r.name)}}}) "
                         f"MERGE (t:Table {{name: {_q(table)}}}) "
                         f"MERGE (rel)-[:REALIZED_BY]->(t);")
    lines.append("")
    return "\n".join(lines) + "\n"


