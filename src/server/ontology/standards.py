"""
The open standards this layer speaks, and why each one — including what was rejected.

"Which open source should represent this data?" has a different right answer per consumer,
so this module picks one standard per job rather than one standard for everything:

    a model trainer         needs a machine-checkable contract: SHACL + JSON
    an RDF / GraphDB user   needs OWL + SKOS + Turtle
    a data catalog / LLM    needs DCAT + schema.org + JSON-LD
    a lineage/ops auditor   needs PROV-O
    a unit-correct consumer needs QUDT
    a graph-database user   needs Cypher + GraphML
    a human                 needs Mermaid + Markdown

Every entry is a real standard with a permissive license, chosen over a named rejected
alternative. `license_notice()` renders the attribution obligations that follow from
emitting these terms — which matters, because this repository has no LICENSE file and the
ontology output is meant to be publishable.
"""
from dataclasses import dataclass
from typing import Tuple


@dataclass(frozen=True)
class Standard:
    """One adopted standard, with the reasoning and the rejected alternative recorded."""

    id: str
    name: str
    spec_url: str
    license: str
    used_for: str
    why: str
    artifacts: Tuple[str, ...]
    rejected: Tuple[str, ...] = ()
    attribution_required: bool = False


def standards() -> Tuple[Standard, ...]:
    """The adopted stack, in the order the README's standards section presents it."""
    return (
        Standard(
            "skos", "SKOS (Simple Knowledge Organization System)",
            "https://www.w3.org/TR/skos-reference/", "W3C Document License (royalty-free)",
            "The 30 controlled vocabularies: regimes, conviction buckets, outcome labels, "
            "OI buildup, edge verdicts, adjustment bases, suspect reasons.",
            "Concept schemes are literally what SKOS is for, and every triple store, "
            "vocabulary viewer and RAG pipeline already reads skos:prefLabel / skos:notation. "
            "It needs no reasoning, so it costs nothing at query time.",
            ("ontology.ttl (skos:ConceptScheme + skos:Concept)", "ontology.jsonld"),
            rejected=("A bespoke enum table — unreadable outside this repo.",
                      "OWL enumerations — needs a reasoner, and heavier to diff when a vendor "
                      "adds a new screener category."),
        ),
        Standard(
            "owl", "OWL 2 (class/property subset)",
            "https://www.w3.org/TR/owl2-overview/", "W3C Document License (royalty-free)",
            "The T-Box: 40+ classes, the subClassOf hierarchy, datatype and object "
            "properties, domain/range.",
            "The only widely-supported way to publish a class hierarchy with typed "
            "properties. Deliberately uses only the cheap part — subclass, domain, range, "
            "cardinality — and emits no restrictions, so no consumer needs DL reasoning. "
            "That is precisely why a full FIBO import was rejected.",
            ("ontology.ttl", "ontology.jsonld"),
            rejected=("OWL 2 DL with restrictions — needs HermiT/ELK to draw any conclusion.",
                      "UML/XMI — no agent reads it."),
        ),
        Standard(
            "shacl", "SHACL (Shapes Constraint Language)",
            "https://www.w3.org/TR/shacl/", "W3C Document License (royalty-free)",
            "A generated NodeShape per class: required key properties, expected datatypes, "
            "vocabulary membership (sh:in) for enum-typed columns, and per-card shapes that "
            "make an unexpected column visible.",
            "SHACL turns this ontology from documentation into a machine-checkable data "
            "contract, which is what makes the layer useful to a model pipeline rather than "
            "merely informative. It is generated from the same bindings the cards use, so it "
            "cannot drift from them.",
            ("ontology.shacl.ttl",),
            rejected=("JSON Schema alone — cannot express vocabulary membership, per-table "
                      "closedness, or graph relations.",
                      "Hand-written validation SQL — already tried in this repo "
                      "(`data_quality_results`) and it drifted from the schema."),
        ),
        Standard(
            "jsonld", "JSON-LD 1.1",
            "https://www.w3.org/TR/json-ld11/", "W3C Document License (royalty-free)",
            "The agent/LLM-facing serialization of the whole graph, with an `@context` that "
            "binds bsi:/bsip:/bsim: alongside the aligned FIBO prefixes.",
            "It is JSON for consumers that are not RDF-native (every LLM toolchain) while "
            "remaining valid RDF for those that are. The `@context` is also what lets a "
            "downstream user substitute the FIBO IRIs without touching this repo.",
            ("ontology.jsonld", "context.jsonld"),
            rejected=("RDF/XML — verbose, and nothing in this stack parses it.",
                      "A bespoke JSON schema — no external tooling, no interop."),
        ),
        Standard(
            "prov", "PROV-O (Provenance Ontology)",
            "https://www.w3.org/TR/prov-o/", "W3C Document License (royalty-free)",
            "Lineage: which job writes each table, when it last succeeded, what the freshness "
            "column is, and which tables a metric was derived from.",
            "This platform's number-one failure mode is not modelling — it is a consumer "
            "trusting data whose writer silently stopped, or using a value before it was "
            "knowable. PROV-O is the standard vocabulary for exactly those two questions "
            "(`prov:wasGeneratedBy`, `prov:generatedAtTime`).",
            ("ontology.prov.ttl", "coverage.json"),
            rejected=("A custom lineage table — this repo already has three that drifted and "
                      "had to be consolidated into one tracker."),
        ),
        Standard(
            "dcat", "DCAT 3 (Data Catalog Vocabulary)",
            "https://www.w3.org/TR/vocab-dcat-3/", "W3C Document License (royalty-free)",
            "A catalog of every documented table as `dcat:Dataset`, with distribution, "
            "accrual periodicity, temporal coverage, row count and quality verdict.",
            "It is the standard for publishing a data catalog, so a 240-table database "
            "becomes discoverable by generic catalog tooling instead of only by people who "
            "read this repo. `cadence` maps onto `dct:accrualPeriodicity`, and the "
            "training-use verdict rides along as a note.",
            ("catalog.ttl", "catalog.jsonld"),
            rejected=("schema.org Dataset alone — no accrual periodicity, no distributions, "
                      "no catalog grouping."),
        ),
        Standard(
            "qudt", "QUDT 2.1 (Quantities, Units, Dimensions and Data Types)",
            "https://qudt.org/", "CC BY 4.0",
            "Units for every measure: INR and the crore multiplier, percent, shares, days, "
            "contracts, index points, per-session counts.",
            "The FIBO exercise surfaced that `block_deals.value_cr` is crores-as-bare-float "
            "and `insider_trades.valueInr` is rupees-as-bare-float with no declared unit "
            "anywhere in the schema. QUDT is the de-facto RDF standard for units and is far "
            "lighter than FIBO's accounting module.",
            ("ontology.ttl (qudt:unit annotations)",),
            rejected=("FIBO CurrencyAmount for units — a large module to declare one term.",
                      "UN/CEFACT unit codes alone — no quantity/dimension model."),
            attribution_required=True,
        ),
        Standard(
            "schema_org", "schema.org Dataset / DataFeed",
            "https://schema.org/Dataset", "CC BY-SA 3.0",
            "Web-facing discovery metadata for the same datasets DCAT describes.",
            "Search engines and LLM retrieval paths read schema.org; DCAT is for catalogs "
            "and schema.org is for the open web. Both are emitted from one card, so they "
            "cannot disagree with each other.",
            ("catalog.jsonld",),
            rejected=("Atom / RFC 4287 feeds as the discovery layer — no measure or unit "
                      "model, and no place for a training-use verdict.",
                      "DCAT alone for the web tier — generic crawlers and LLM ingestion "
                      "expect schema.org terms."),
        ),
        Standard(
            "fibo", "FIBO (Financial Industry Business Ontology)",
            "https://spec.edmcouncil.org/fibo/", "MIT (EDM Council)",
            "Alignment only — asserted mappings from local concepts onto FIBO / OMG-Commons "
            "IRIs, emitted as skos:exactMatch / closeMatch.",
            "FIBO covers instruments, parties and corporate events well, and this platform's "
            "own derived intelligence barely at all — while reasoning over the full "
            "SEC+DER+MD+IND+FND+CAE closure needs an OWL reasoner this stack does not run. "
            "Mapping buys the interop without the weight. Decision record in alignment.py.",
            ("ontology.ttl (skos:*Match triples)",),
            rejected=("Vendoring and importing FIBO — a multi-megabyte OWL 2 DL closure with "
                      "no reasoner, against this repo's rule against unpinned dependencies.",
                      "FIBO as the backbone — see alignment.py."),
            attribution_required=True,
        ),
        Standard(
            "identifiers", "ISO 10962 CFI / ISO 6166 ISIN / FIGI / ISO 17442 LEI",
            "https://www.iso.org/standard/81140.html",
            "ISO identifier schemes (free to reference)",
            "Naming the identifier schemes: which column is an ISIN, which is a vendor scrip "
            "code, which is a per-vendor opaque id.",
            "Aligning to identifier SCHEMES is the real interop win and it costs nothing — no "
            "vocabulary to vendor, just an honest statement that `stock_master.isin` is an "
            "ISIN while `mcsymbol`/`tlid`/`tickertape_sid`/`scripcode`/`fincode` are "
            "vendor-private ids that must never be joined across vendors.",
            ("ontology.ttl (identifier typing on bsi:Equity)",),
            rejected=("Treating every id column as equivalent — the cause of the observed "
                      "cross-vendor mapping drift."),
        ),
        Standard(
            "graph_formats", "Cypher (Neo4j) / GraphML / Mermaid",
            "https://opencypher.org/", "Apache-2.0 / BSD-style / MIT",
            "Loadable graph exports and human-readable diagrams of the same graph.",
            "An RDF-only ontology is unusable to practitioners who have a graph database "
            "rather than a triple store. All three are generated from one edge list, so they "
            "cannot diverge.",
            ("ontology.cypher", "ontology.graphml", "schema.mmd"),
            rejected=("A bespoke node/edge dump with no loader — unreadable by the one "
                      "tool (a graph database) that would consume it.",
                      "GraphML alone — Gephi reads it, but cypher-shell cannot load it."),
        ),
        Standard(
            "reviewed_not_adopted", "XBRL / IFRS taxonomy",
            "https://www.xbrl.org/", "Public specifications",
            "REVIEWED, NOT ADOPTED — recorded because it is the obvious candidate for "
            "fundamentals.",
            "It is the right target for `fundamentals_history` if the platform ever ingests "
            "actual filings: XBRL tags are regulatory truth with a stated period and unit. "
            "Today those columns are vendor-scraped ratios of undocumented derivation, so "
            "aligning them to XBRL tags would be false precision. Revisit if filings are "
            "onboarded — and the discovery-registry contract would find that endpoint first.",
            (),
            rejected=("Aligning vendor ratios to XBRL now — no provenance to support it."),
        ),
    )


def adopted_ids() -> Tuple[str, ...]:
    """Ids actually emitted by `export.py` (excludes review-only entries)."""
    return tuple(s.id for s in standards() if s.id != "reviewed_not_adopted")


def license_notice() -> str:
    """Attribution obligations for the emitted third-party terms."""
    lines = [
        "THIRD-PARTY TERMS IN THE GENERATED ARTIFACTS",
        "",
        "The generated ontology documents reference terms from the standards and vocabularies",
        "below. The generated files are derived works of this repository. The notices here",
        "satisfy the attribution conditions of the referenced vocabularies.",
        "",
    ]
    for s in standards():
        if s.id == "reviewed_not_adopted":
            continue
        mark = "attribution required" if s.attribution_required else "no attribution required"
        lines.append(f"- {s.name}")
        lines.append(f"    spec:    {s.spec_url}")
        lines.append(f"    license: {s.license} ({mark})")
    lines += [
        "",
        "FIBO is a trademark of EDM Council, Inc.",
        "QUDT is licensed CC BY 4.0; the QUDT ontology is NOT redistributed here — only IRIs",
        "into it are referenced.",
        "",
        "The generated artifacts are provided AS IS, WITHOUT WARRANTY OF ANY KIND, express",
        "or implied — including any implied warranty of fitness for a particular trading",
        "purpose.",
        "",
        "NOTE: this repository has no root LICENSE file, so the generated artifacts currently",
        "carry no license grant of their own. Choosing one is a user decision, not one this",
        "tooling should make silently.",
    ]
    return "\n".join(lines)
