"""
Offline lexical retrieval over the ontology.

No network, no embedding model, no new dependency: a BM25-lite scorer over the ontology's
own text, with **physical column and table names indexed alongside the semantic names**. That
last part is the practical difference — an agent asked "what does `deliv_pct` mean", or
"which table has `mc_del_pct_20d`", has to be able to find the answer by column name and not
only by concept.

An optional embedding path is deliberately NOT included. `chromadb` and
`sentence-transformers` are in the root requirements, but a retrieval layer that needs a
model download is not runnable in CI, and a fallback that silently degrades is worse than a
deterministic lexical scorer that always works. If semantic recall ever becomes the binding
constraint, add it as an explicit opt-in on top of this rather than as a default.
"""
import math
import re
from dataclasses import dataclass
from typing import Dict, List, Optional, Sequence, Tuple

from .model import Ontology
from .vocab import expand

_TOKEN = re.compile(r"[a-z0-9]+")

_TABLE_NAME = re.compile(r"[a-z0-9_]+")

_STOP = frozenset((
    "a an and are as at be by for from has have how in into is it its of on or that the "
    "their there these this to was were what when where which who why will with without "
    "do does can could should would mean means"
).split())

#: Document kinds the index exposes.
KINDS = ("class", "property", "relation", "metric", "card", "vocabulary")

_K1 = 1.2   # BM25 term-frequency saturation
_B = 0.6    # BM25 length normalisation

#: Field weights — a match on the concept's own name beats a match in its prose.
_W_NAME = 3.0
_W_LABEL = 2.0
_W_COLUMN = 2.5
_W_BODY = 1.0


@dataclass(frozen=True)
class SearchHit:
    """One ranked ontology concept."""

    kind: str
    name: str
    label: str
    score: float
    snippet: str
    uri: str = ""

    def line(self) -> str:
        return f"[{self.kind}] {self.name} — {self.label} (score {self.score:.2f})"


def _tokens(text: str) -> List[str]:
    return [t for t in _TOKEN.findall((text or "").lower())
            if t not in _STOP and len(t) > 1]


def _snippet(text: str, terms: Sequence[str], width: int = 200) -> str:
    """A short window of `text` around its first matching term."""
    if not text:
        return ""
    low = text.lower()
    pos = -1
    for t in terms:
        pos = low.find(t)
        if pos >= 0:
            break
    if pos < 0:
        return text[:width]
    start = max(0, pos - 60)
    out = text[start:start + width].strip()
    return ("..." if start else "") + out


def _documents(onto: Ontology) -> List[Dict]:
    """Every searchable concept, with named fields so weights can be applied per field."""
    docs: List[Dict] = []

    for c in onto.classes:
        docs.append({
            "kind": "class", "name": c.name, "label": c.label, "uri": c.uri,
            "name_text": c.name, "label_text": c.label, "column_text": "",
            "body": " ".join((c.description, c.grain, c.layer, *c.parents, *c.caveats)),
            "ref": c,
        })

    for p in onto.properties:
        cols = " ".join(b.column for b in onto.bindings_for_property(p.name))
        tables = " ".join(onto.tables_for_property(p.name))
        docs.append({
            "kind": "property", "name": p.name, "label": p.label, "uri": p.uri,
            "name_text": p.name, "label_text": p.label, "column_text": cols + " " + tables,
            "body": " ".join((p.description, p.semantic_type, p.timing, p.leakage_risk,
                              p.unit or "", p.pit_notes, *p.synonyms)),
            "ref": p,
        })

    for r in onto.relations:
        docs.append({
            "kind": "relation", "name": r.name, "label": r.label, "uri": r.uri,
            "name_text": r.name, "label_text": r.label,
            "column_text": " ".join((*r.realized_by, *r.join_keys)),
            "body": " ".join((r.description, r.domain, r.range, r.graded_status, r.evidence)),
            "ref": r,
        })

    for m in onto.metrics:
        docs.append({
            "kind": "metric", "name": m.name, "label": m.label, "uri": m.uri,
            "name_text": m.name, "label_text": m.label,
            "column_text": " ".join(m.source_tables),
            "body": " ".join((m.description, m.entity, m.unit or "", m.grain, m.graded_status,
                              m.graded_evidence, *m.synonyms, *m.caveats)),
            "ref": m,
        })

    for card in onto.cards:
        docs.append({
            "kind": "card", "name": card.table, "label": card.label, "uri": card.uri,
            "name_text": card.table, "label_text": card.label,
            "column_text": " ".join(onto.columns_of(card.table)),
            "body": " ".join((card.description, card.grain, card.entity, card.training_use,
                              card.cadence, *card.caveats)),
            "ref": card,
        })

    for v in onto.vocabularies:
        docs.append({
            "kind": "vocabulary", "name": v.name, "label": v.name, "uri": v.uri,
            "name_text": v.name, "label_text": "", "column_text": v.source,
            "body": " ".join((v.description, *[t.notation for t in v.terms],
                              *[t.label for t in v.terms])),
            "ref": v,
        })

    return docs


def _score_document(doc: Dict, query_terms: Sequence[str], df: Dict[str, int],
                    n_docs: int, avg_len: float) -> float:
    name_toks = _tokens(doc["name_text"])
    label_toks = _tokens(doc["label_text"])
    col_toks = _tokens(doc["column_text"])
    body_toks = _tokens(doc["body"])
    dlen = max(1.0, len(name_toks) + len(label_toks) + len(col_toks) + len(body_toks))

    score = 0.0
    for term in query_terms:
        n_qi = df.get(term, 0)
        if n_qi == 0:
            continue
        idf = math.log(1.0 + (n_docs - n_qi + 0.5) / (n_qi + 0.5))
        tf = (name_toks.count(term) * _W_NAME + label_toks.count(term) * _W_LABEL
              + col_toks.count(term) * _W_COLUMN + body_toks.count(term) * _W_BODY)
        if tf <= 0:
            continue
        score += idf * (tf * (_K1 + 1.0)) / (tf + _K1 * (1.0 - _B + _B * dlen / avg_len))
    return score


def search(onto: Ontology, query: str, kinds: Optional[Sequence[str]] = None,
           limit: int = 10) -> List[SearchHit]:
    """Rank ontology concepts against a free-text query.

    `kinds` filters to any of `KINDS`. A query with no usable terms returns nothing rather
    than an arbitrary list — a silent "here are some concepts" is how an agent ends up
    confidently answering a question it did not understand.
    """
    terms = _tokens(query)
    if not terms:
        return []
    wanted = set(kinds) if kinds else set(KINDS)
    docs = [d for d in _documents(onto) if d["kind"] in wanted]
    if not docs:
        return []

    df: Dict[str, int] = {}
    lengths = []
    for d in docs:
        doc_terms = set(_tokens(" ".join((d["name_text"], d["label_text"], d["column_text"],
                                          d["body"]))))
        for t in doc_terms:
            df[t] = df.get(t, 0) + 1
        lengths.append(max(1, len(_tokens(d["body"])) + len(_tokens(d["column_text"]))))
    avg_len = sum(lengths) / len(lengths)

    hits: List[SearchHit] = []
    for d in docs:
        s = _score_document(d, terms, df, len(docs), avg_len)
        if s <= 0:
            continue
        hits.append(SearchHit(
            kind=d["kind"], name=d["name"], label=d["label"], score=round(s, 4),
            snippet=_snippet(d["body"], terms), uri=expand(d["uri"])))
    hits.sort(key=lambda h: (-h.score, h.kind, h.name))
    return _dedupe(hits)[:limit]


def _dedupe(hits: List[SearchHit]) -> List[SearchHit]:
    """One hit per (kind, name) — a name can be surfaced through several indexed fields."""
    seen = set()
    out = []
    for h in hits:
        key = (h.kind, h.name)
        if key in seen:
            continue
        seen.add(key)
        out.append(h)
    return out


def search_columns(onto: Ontology,
                   table: str, limit: int = 200) -> List[Tuple[str, str, str]]:
    """`(column, property, note)` for a table's bound columns, in declaration order.

    The fastest way to answer "what does this column mean" without reading any code.

    A snake_case argument is always read as a TABLE name; free text — anything with a
    space in it — is treated as a concept query and resolved through the property
    index instead, so "block deal value" finds `block_deals.value_cr` without the
    caller knowing either name up front.
    """
    if onto.card_by_table(table) is not None or _TABLE_NAME.fullmatch(table):
        return [(b.column, b.property, b.note)
                for b in onto.bindings_for_table(table)[:limit]]
    hits = search(onto, table, kinds=("property",), limit=min(limit, 10))
    out: List[Tuple[str, str, str]] = []
    for h in hits:
        for b in onto.bindings_for_property(h.name):
            out.append((b.column, b.property, b.note))
    return out[:limit]


def best(onto: Ontology, query: str,
         kinds: Optional[Sequence[str]] = None) -> Optional[SearchHit]:
    """The single highest-scoring hit, or None when nothing matches."""
    hits = search(onto, query, kinds=kinds, limit=1)
    return hits[0] if hits else None
