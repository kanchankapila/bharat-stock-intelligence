"""
Bharat Stock Intelligence — market ontology, semantic layer and knowledge graph.

Why this exists
---------------
`bharat_intel` (240 public tables, 5.7 years of OHLCV, 106K news items, 12M screener
appearances) is the platform's only real asset, but its meaning lives in the heads of the
engines that write it and in a 98 KB prose report. That is a bad interface for two classes
of consumer this repo now has:

  1. **Models** — a trainer needs to know, per column, whether it is a *feature*, a
     *label*, an *identifier*, a *probability*, a *vendor opinion* or a *leak*. It needs
     units, grain, and the point-in-time rule. Nothing in the database says any of that.
  2. **AI agents** — an LLM with `query_stocks_db` can guess a SELECT, but it cannot know
     that `unified_recommendations.computed_at` is TEXT while
     `confluence_signals.computed_at` is TIMESTAMPTZ, that `target_*` columns are labels,
     that `stock_futures_oi_history` is a 14-date panel, or that two "different vendors'
     quality ranks are the same column under two names.

This package is a *schema-level* (T-Box) ontology plus a *bound* physical mapping: it names
what exists, binds it to real tables and columns in this database, records the semantics
each column carries, and emits the whole thing in formats both models and agents can
consume (JSON-LD, OWL/SKOS Turtle, Cypher, GraphML, Mermaid, Markdown, `llms.txt`) and in
Postgres (`kg_*` tables + canonical `kg_v_*` views).

Layout
------
    vocab.py        namespaces + SKOS controlled vocabularies (values verified live)
    model.py        the meta-model (frozen dataclasses) + validation
    definitions/    the authored ontology: classes, properties, cards, relations, metrics
    search.py       offline lexical retrieval over the ontology (no network, no deps)
    ai.py           builds bounded, caveat-carrying context packs for LLM prompts
    introspect.py   compares the ontology against LIVE information_schema (coverage/drift)
    store.py        materialises kg_* tables and kg_v_* views into Postgres
    export.py       JSON-LD / Turtle / Cypher / GraphML / Mermaid / Markdown / llms.txt
    cli.py          `python -m ontology build|export|verify|coverage|ask|context|card|identity`

Contract with the rest of the repo
----------------------------------
* **Dependency-free by construction**: stdlib only (`dataclasses`, `json`, `re`,
  `collections`). No `rdflib`, no `pyyaml` — neither is pinned in `requirements.txt`, and a
  semantic layer that cannot be imported on a clean CI runner is not a semantic layer.
* **Postgres-only**, like everything else post-2026-08-16. DB access goes through
  `db_compat` (`connect()` / `query_all`) so `?` placeholders and type coercion keep
  working.
* **No `%` character in any SQL held here.** `sql_translate` does not escape literal
  percent signs, and a `%` reaching psycopg2 through a bind-parameter path is parsed as a
  parameter marker (`.claude/rules/recurring-bugs.md`). Percentages are expressed as
  `* 100.0`.
* **Deleting a column is a breaking change to this layer too.** `verify` reports drift, and
  `tests/test_ontology_definitions.py` fails the suite when a binding names a table or
  column that no longer exists live.

Quick start
-----------
    from ontology import build_ontology, ai, search

    onto = build_ontology()
    ai.context_pack(onto, "what explains a swing signal for INFY?", max_chars=2500)
    search.search(onto, "delivery", kinds=("metric",), limit=5)
"""

from .model import (
    ClassDef,
    ColumnBinding,
    DataCard,
    MetricDef,
    Ontology,
    PropertyDef,
    RelationDef,
)
from .definitions import build_ontology
from . import ai, export, introspect, search, store, vocab

__all__ = [
    "ClassDef",
    "ColumnBinding",
    "DataCard",
    "MetricDef",
    "Ontology",
    "PropertyDef",
    "RelationDef",
    "build_ontology",
    "ai",
    "export",
    "introspect",
    "search",
    "store",
    "vocab",
]

__version__ = "1.1.0"
