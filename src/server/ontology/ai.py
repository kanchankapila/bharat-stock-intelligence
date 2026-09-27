"""
AI-ready context packs — bounded, caveat-carrying payloads for an LLM or a trainer.

The difference between "here is a schema dump" and this module is that every block returns
the **caveats with the concepts**, and every pack ends with the guardrails. An agent that
learns `win_probability` exists without learning that it is a model output will use it as a
feature, and the resulting model will look excellent and be worthless.

`context_pack()` is budget-aware: it fills to `max_chars` and says so when it truncates,
because silently dropping the caveats is the failure mode that matters.
"""
from typing import Any, Dict, List, Optional, Sequence

from . import search
from .model import Ontology

#: The visible tail clip() appends. Exported so callers can assert on clipping
#: without hard-coding the wording.
TRUNCATION_MARKER = "... [truncated to fit the budget]"

#: Rules that must travel with any prompt built from this layer.
GUARDRAILS = (
    "Columns with leakage_risk 'high' or 'target' are NEVER features. Columns whose "
    "semantic_type is 'label' ARE the target.",
    "`technical_signals`, `feature_store`, score-typed columns and the recommendation "
    "tables are platform OUTPUTS: a model may predict something else from them, but feeding "
    "an engine score back in as a feature leaks that engine into its own inputs.",
    "Point-in-time: entry is the NEXT session's open after `signal_date`. A feature must have "
    "been knowable before that open.",
    "Labels are not comparable across `label_definition` values (`path_barrier` vs "
    "`terminal_pct2`). Filter it before aggregating any accuracy number.",
    "`PENDING` outcome rows have not elapsed yet and are not negative examples.",
    "Mixing `adjustment_basis` values inside one price series invalidates every result "
    "derived from it.",
    "`screener_*` tables are vendor OPINIONS used to surface candidates. They are never "
    "ground truth, and their aggregate score no longer clears the USABLE bar.",
    "Read `eff_dates` before any rank-IC reading: overlapping forward windows inflate a "
    "correlation by roughly the horizon factor.",
    "Every historical read is an as-of read: a feature value must come from rows whose "
    "data was knowable at or before entry — never from today's state projected back.",
    "Nothing in this layer is investment advice or a solicitation to trade; it describes "
    "data semantics only, and any output built from it is not financial advice.",
)


def clip(text: str, max_chars: int) -> str:
    """Truncate with a visible marker — silent truncation loses exactly the caveats."""
    if len(text) <= max_chars:
        return text
    return text[:max(0, max_chars - 40)] + "\n" + TRUNCATION_MARKER


def data_card_text(onto: Ontology, table: str, max_chars: int = 1800) -> str:
    """A table's card as a compact text block, or a clear miss with suggestions."""
    card = onto.card_by_table(table)
    if card is None:
        import difflib

        near = difflib.get_close_matches(
            table, [c.table for c in onto.cards], n=3, cutoff=0.6)
        if not near:
            near = [h.name for h in search.search(onto, table, kinds=("card",), limit=3)]
        hint = f" Did you mean: {', '.join(near)}?" if near else ""
        return f"No data card for table {table!r}.{hint}"

    return clip(_card_lines(onto, card), max_chars)


def card_block(onto_or_card, table: Optional[str] = None,
               max_chars: int = 1800) -> str:
    """A card's text block. Two accepted call shapes:

    * ``card_block(onto, "block_deals")`` — the normal path;
    * ``card_block(card)`` — when the caller is already holding the DataCard, the
      container is resolved through a cached `build_ontology()`.

    Both render identically: every bound column with its semantics, plus the
    training-use verdict and the never-as-feature list.
    """
    if table is None:
        card = onto_or_card
        if card is None:
            return "No data card for table."
        return clip(_card_lines(_default_ontology(), card), max_chars)
    card = onto_or_card.card_by_table(table)
    if card is None:
        return data_card_text(onto_or_card, table, max_chars)
    return clip(_card_lines(onto_or_card, card), max_chars)


_ONTOLOGY = None


def _default_ontology() -> Ontology:
    """Resolve the shipped ontology once, for the card-only call shape."""
    global _ONTOLOGY
    if _ONTOLOGY is None:
        from .definitions import build_ontology

        _ONTOLOGY = build_ontology()
    return _ONTOLOGY


def _card_lines(onto: Ontology, card) -> str:
    lines = [f"TABLE {card.table} — {card.label}",
             f"  entity:   {card.entity}",
             f"  grain:    {card.grain}",
             f"  pk:       {', '.join(card.pk)}",
             f"  cadence:  {card.cadence}",
             f"  training: {card.training_use}"]
    if card.freshness_column:
        lag = (f", expected within {card.expected_lag_hours}h of the event"
               if card.expected_lag_hours is not None else "")
        lines.append(f"  freshness: {card.freshness_column}{lag}")
    if card.writers:
        lines.append(f"  writers:  {', '.join(card.writers)}")
    lines.append(f"  {card.description}")

    cols = onto.bindings_for_table(card.table)
    if cols:
        lines.append("  bound columns:")
        for b in cols:
            p = onto.property_by_name(b.property)
            if p is None:
                continue
            if p.is_label:
                flag = " [LABEL]"
            elif p.leakage_risk == "high":
                flag = " [LEAK]"
            elif p.is_feature:
                flag = " [feature]"
            else:
                flag = ""
            note = f" — {b.note}" if b.note else ""
            lines.append(f"    {b.column} -> {p.name} ({p.semantic_type}/"
                         f"{p.timing}/{p.leakage_risk}){flag}{note}")
    if card.forbidden_columns:
        lines.append(f"  NEVER as features: {', '.join(card.forbidden_columns)}")
    if card.caveats:
        lines.append("  caveats:")
        lines += [f"    - {c}" for c in card.caveats]
    return "\n".join(lines)


def describe(onto: Ontology, name: str, max_chars: int = 2500) -> str:
    """Describe a concept by exact name, resolved by kind."""
    if name in {"__ontology__", "ontology", "overview"}:
        return prompt_block(onto)

    c = onto.class_by_name(name)
    if c is not None:
        lines = [f"CLASS {c.name} ({c.label}) — layer {c.layer}", f"  {c.description}"]
        if c.grain:
            lines.append(f"  grain: {c.grain}")
        if c.key_properties:
            lines.append(f"  key:   {', '.join(c.key_properties)}")
        if c.parents:
            lines.append(f"  subclass of: {', '.join(c.parents)}")
        cards = [x.table for x in onto.cards if x.entity == c.name]
        if cards:
            lines.append(f"  realized by: {', '.join(cards)}")
        rels = onto.relations_for_class(c.name)
        if rels:
            lines.append("  edges:")
            for r in rels:
                lines.append(f"    {r.name}: {r.domain} -> {r.range} ({r.cardinality}) "
                             f"[{r.graded_status}]")
        if c.caveats:
            lines.append("  caveats:")
            lines += [f"    - {x}" for x in c.caveats]
        return clip("\n".join(lines), max_chars)

    p = onto.property_by_name(name) or next(
        (x for x in onto.properties if name in x.synonyms), None)
    if p is not None:
        lines = [f"PROPERTY {p.name} ({p.label})",
                 f"  semantic_type: {p.semantic_type}   datatype: {p.datatype}",
                 f"  timing: {p.timing}   derivation: {p.derivation}",
                 f"  leakage_risk: {p.leakage_risk}   unit: {p.unit or 'n/a'}",
                 f"  usable as a feature: {p.is_feature}",
                 f"  {p.description}"]
        if p.is_label:
            lines.append("  [LABEL/TARGET] — this column is the target, never a feature.")
        elif p.leakage_risk == "high":
            lines.append("  [LEAK] — high leakage risk; never a feature without an as-of guard.")
        if p.vocabulary:
            v = onto.vocabulary_by_name(p.vocabulary)
            vals = ", ".join(v.notations()[:12]) if v else p.vocabulary
            lines.append(f"  vocabulary {p.vocabulary}: {vals}")
        if p.pit_notes:
            lines.append(f"  point-in-time: {p.pit_notes}")
        binds = onto.bindings_for_property(p.name)
        if binds:
            lines.append("  bound to:")
            for b in binds[:20]:
                lines.append(f"    {b.ref}" + (f" — {b.note}" if b.note else ""))
        return clip("\n".join(lines), max_chars)

    m = onto.metric_by_name(name)
    if m is not None:
        return clip(metric_block(m), max_chars)

    r = onto.relation_by_name(name) or next(
        (x for x in onto.relations if name in x.synonyms), None)
    if r is not None:
        lines = [f"RELATION {r.name} ({r.label})",
                 f"  {r.domain} -> {r.range}   {r.cardinality}   [{r.graded_status}]",
                 f"  {r.description}"]
        if r.realized_by:
            lines.append(f"  realized by: {', '.join(r.realized_by)}")
        if r.join_keys:
            lines.append(f"  join keys: {', '.join(r.join_keys)}")
        if r.via:
            lines.append(f"  join: {r.via}")
        if r.evidence:
            lines.append(f"  evidence: {r.evidence}")
        return clip("\n".join(lines), max_chars)

    v = onto.vocabulary_by_name(name)
    if v is not None:
        lines = [f"VOCABULARY {v.name} — source {v.source}",
                 f"  {v.description}",
                 f"  open-ended: {v.open}"]
        lines += [f"    {t.notation}: {t.definition}" for t in v.terms[:25]]
        return clip("\n".join(lines), max_chars)

    if onto.card_by_table(name) is not None:
        return data_card_text(onto, name, max_chars)

    near = search.search(onto, name, limit=5)
    hint = "; ".join(f"{h.kind}:{h.name}" for h in near) or "nothing similar found"
    return (f"Unknown concept — no ontology concept named {name!r} was found. "
            f"Nearest matches: {hint}")


# (ai.py continues below)


def metric_block(m, symbol: Optional[str] = None, as_of: Optional[str] = None) -> str:
    """A metric rendered as a prompt-ready block, with runnable SQL when args are given."""
    lines = [f"METRIC {m.name} — {m.label}",
             f"  of: {m.entity}   unit: {m.unit or 'n/a'}   grain: {m.grain}",
             f"  cadence: {m.cadence}   timing: {m.timing}   graded: {m.graded_status}",
             f"  {m.description}"]
    if "as_of" in m.params:
        lines.append("  as-of: evaluated AS OF the session bind (:as_of) — "
                     "never with today's state projected back.")
    if m.graded_evidence:
        lines.append(f"  evidence: {m.graded_evidence}")
    if symbol and as_of:
        lines.append(f"  sql (symbol={symbol}, as_of={as_of}):")
        lines.append("    " + m.render_literal(symbol, as_of).replace("\n", "\n    "))
    else:
        lines.append("  sql:")
        lines.append("    " + m.sql.replace("\n", "\n    "))
    if m.caveats:
        lines.append("  caveats:")
        lines += [f"    - {c}" for c in m.caveats]
    return "\n".join(lines)


def prompt_block(onto: Ontology, max_chars: int = 6000) -> str:
    """A one-shot orientation block: what this database is, and the rules that govern it."""
    s = onto.summary()
    layers: Dict[str, List[str]] = {}
    for c in onto.classes:
        layers.setdefault(c.layer, []).append(c.name)

    lines = [
        "# Bharat Intel — market ontology overview",
        "",
        "## Guardrails (always apply)",
    ] + [f"- {g}" for g in GUARDRAILS] + [
        "",
        f"{s['classes']} entity classes, {s['properties']} semantic properties, "
        f"{s['cards']} documented tables, {s['relations']} graph edges, "
        f"{s['metrics']} semantic metrics, {s['vocabularies']} controlled vocabularies "
        f"({s['vocabulary_terms']} terms).",
        "",
        "## Classes by layer",
    ]
    for layer in ("identity", "observation", "context", "derived", "candidate", "outcome",
                  "governance", "meta"):
        names = layers.get(layer)
        if names:
            lines.append(f"- {layer}: {', '.join(sorted(names))}")

    lines += ["", "## Semantic properties that are NEVER features"]
    bad = [p for p in onto.properties if p.leakage_risk in ("target", "high")]
    lines += [f"- {p.name} ({p.semantic_type}, leakage {p.leakage_risk}) — "
              f"{p.description.split('.')[0]}" for p in bad[:20]]

    lines += ["", "## Semantic metrics available"]
    lines += [f"- {m.name} ({m.unit or 'n/a'}, {m.graded_status})" for m in onto.metrics]

    return clip("\n".join(lines), max_chars)


def context_pack(onto: Ontology, question: str, max_chars: int = 2500,
                 kinds: Optional[Sequence[str]] = None, max_hits: int = 5,
                 per_hit: int = 520) -> str:
    """Retrieve for a question, then assemble a bounded, caveat-carrying prompt pack.

    The budget is spent in a deliberate order, because the failure mode is a pack that
    truncates the guardrails:

    1. the guardrails are rendered first and their length is **reserved** out of the budget;
    2. the question-specific concept blocks are packed into what remains;
    3. only then is the body clipped, so the truncation marker lands in the concepts, never in
       the rules.

    A question with no lexical match still returns the guardrails plus the orientation block —
    an agent that did not understand the question must not be handed an empty context that
    silently turns into a confident guess.
    """
    from . import search

    guard = "\n".join(["## Guardrails (always apply)"] + [f"- {g}" for g in GUARDRAILS])
    compact = "\n".join(["## Guardrails (always apply)"]
                        + [f"- {g[:40]}…" for g in GUARDRAILS])

    hits = search.search(onto, question, kinds=kinds, limit=max_hits)
    header = [f"# Ontology context for: {question}", ""]
    if not hits:
        header.append("No ontology concept matched this question lexically. Below is the "
                      "orientation block; treat any answer built from it as unverified.")
        header.append("")
        body = clip("\n".join(header) + prompt_block(onto, max_chars=100_000), max_chars)
    else:
        header.append(f"Top {len(hits)} matching concepts:")
        header.append("")
        blocks = ["\n".join(header)]
        for h in hits:
            blocks.append(f"### [{h.kind}] {h.name} — {h.label} (score {h.score:.2f})")
            blocks.append(describe(onto, h.name, max_chars=per_hit))
            blocks.append("")
        body = "\n".join(blocks)

    # Budget policy: the guardrails are the one thing a truncated pack must never
    # lose, so they claim the budget FIRST and the concepts fill the remainder —
    # the reverse of appending them and hoping they survive the clip. Full rules
    # whenever they fit; otherwise the first line of each rule (every rule still
    # present, honestly marked with the ellipsis). Below even that, the whole pack
    # including the guardrails clips, with the visible marker.
    sep = "\n\n"
    if max_chars >= len(guard) + 300:
        return clip(body, max_chars - len(guard) - len(sep)) + sep + guard
    if max_chars >= len(compact) + 20:
        return clip(body, max_chars - len(compact) - len(sep)) + sep + compact
    return clip(body + sep + guard, max_chars)


def context_report(onto: Ontology, question: str, **kwargs: Any) -> Dict[str, Any]:
    """The pack plus what it was built from — for logging and for the CLI's `--json`."""
    from . import search

    hits = search.search(onto, question, limit=kwargs.get("max_hits", 5))
    pack = context_pack(onto, question, **kwargs)
    return {"question": question, "chars": len(pack),
            "guardrails_present": all(g[:40] in pack for g in GUARDRAILS),
            "hits": [{"kind": h.kind, "name": h.name, "score": h.score} for h in hits],
            "pack": pack}

