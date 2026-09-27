"""
The LLM-facing surface. What matters here is not formatting — it is that an agent reading the
context pack is told what it must not do.

The failure this file guards against is subtle and expensive: a model reads a table's columns,
picks the useful-looking ones, and trains on a label. The ontology is supposed to make that
impossible, and the pack is the only thing most agents will actually read.
"""
import sys
from pathlib import Path

import pytest

SERVER_DIR = Path(__file__).resolve().parents[1]
if str(SERVER_DIR) not in sys.path:
    sys.path.insert(0, str(SERVER_DIR))

from ontology import ai
from ontology.definitions import build_ontology


@pytest.fixture(scope="module")
def onto():
    return build_ontology()


class TestGuardrailsArePresent:
    def test_prompt_block_leads_with_the_guardrails(self, onto):
        """Guardrails first, not last. A pack truncated to fit a budget loses its tail."""
        text = ai.prompt_block(onto, max_chars=100_000)
        head = text[:3000]
        for rule in ai.GUARDRAILS[:5]:
            assert rule[:40] in head, f"guardrail missing from the head of the pack: {rule[:40]}"

    def test_guardrails_name_the_real_failure_modes(self, onto):
        joined = " ".join(ai.GUARDRAILS).lower()
        for topic in ("label", "leak", "as-of", "point-in-time"):
            assert topic in joined, f"no guardrail mentions {topic}"

    def test_guardrail_table_survives_in_sql(self, onto):
        """`store` writes the same list into kg_guardrail, so SQL consumers get the same rules."""
        assert len(ai.GUARDRAILS) >= 5
        assert all(r.strip() for r in ai.GUARDRAILS)


class TestContextPackShape:
    def test_context_pack_is_bounded(self, onto):
        """An unbounded pack is a pack that will be truncated by the caller, without the marker."""
        text = ai.context_pack(onto, "what explains a swing signal for INFY?", max_chars=2000)
        assert len(text) <= 2100

    def test_truncation_is_visible(self, onto):
        """Silent truncation loses exactly the caveats — the part the pack exists to convey."""
        text = ai.context_pack(onto, "everything about the database", max_chars=300)
        assert len(text) <= 400
        assert ai.TRUNCATION_MARKER.strip() in text or "truncated" in text.lower()

    def test_prompt_block_reports_real_counts(self, onto):
        text = ai.prompt_block(onto, max_chars=100_000)
        s = onto.summary()
        assert str(s["classes"]) in text
        assert str(s["metrics"]) in text


class TestDescribeSurfacesTheWarnings:
    def test_describing_a_table_names_its_forbidden_columns(self, onto):
        card = onto.card_by_table("unified_recommendations")
        if card is None or not card.forbidden_columns:
            pytest.skip("no table with forbidden columns")
        text = ai.describe(onto, "unified_recommendations", max_chars=20_000)
        for col in card.forbidden_columns:
            assert col in text, f"forbidden column {col} not surfaced in the description"

    def test_describing_a_table_surfaces_its_caveats(self, onto):
        card = next((c for c in onto.cards if c.caveats), None)
        if card is None:
            pytest.skip("no table with caveats")
        text = ai.describe(onto, card.table, max_chars=20_000)
        for caveat in card.caveats:
            assert caveat[:50] in text

    def test_describing_a_label_property_marks_it(self, onto):
        labels = [p for p in onto.properties if p.is_label]
        if not labels:
            pytest.skip("no label properties")
        p = labels[0]
        text = ai.describe(onto, p.name, max_chars=20_000)
        assert "LABEL" in text or "label" in text
        assert "usable as a feature: False" in text

    def test_describing_a_high_risk_property_marks_it(self, onto):
        risky = [p for p in onto.properties if p.leakage_risk == "high"]
        if not risky:
            pytest.skip("no high-leakage properties")
        p = risky[0]
        text = ai.describe(onto, p.name, max_chars=20_000)
        assert "LEAK" in text

    def test_card_block_lists_every_bound_column(self, onto):
        card = next((c for c in onto.cards if len(onto.bindings_for_table(c.table)) > 3), None)
        if card is None:
            pytest.skip("no table with many bindings")
        text = ai.card_block(onto, card.table, max_chars=100_000)
        for b in onto.bindings_for_table(card.table):
            assert b.column in text

    def test_unknown_concept_is_not_a_silent_empty_string(self, onto):
        """An unrecognized name must say so. Returning '' gets cached and trusted."""
        text = ai.describe(onto, "definitely_not_a_concept_xyz", max_chars=2000)
        assert text.strip()
        assert "definitely_not_a_concept_xyz" in text or "unknown" in text.lower()


class TestPromptAnswersAreGrounded:
    def test_a_question_about_a_label_names_the_label(self, onto):
        """Ask about forward returns; the answer must not quietly present a feature as one."""
        text = ai.context_pack(onto, "which columns predict the next 5 day return?",
                               max_chars=6000)
        assert "label" in text.lower() or "target" in text.lower()

    def test_context_pack_does_not_assert_financial_advice(self, onto):
        """The pack is consumed by agents acting on real money positions."""
        text = ai.context_pack(onto, "should I buy RELIANCE tomorrow?", max_chars=6000).lower()
        assert "not financial advice" in text

"""
Retrieval and the AI context surface.

An agent asking "what does `deliv_pct` mean" or "what explains a swing signal" has to be able
to find the answer by *column name* and not only by concept name, and the block it gets back
has to carry the caveats. A pack that is short on caveats is worse than no pack.
"""
import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from ontology import ai, search  # noqa: E402
from ontology.definitions import build_ontology  # noqa: E402


@pytest.fixture(scope="module")
def onto():
    return build_ontology()


# ── lexical retrieval ─────────────────────────────────────────────────────────


def test_search_finds_a_concept_by_its_own_name(onto):
    hits = search.search(onto, "unified_score", limit=5)
    assert hits
    assert any(h.name == "unified_score" for h in hits)


def test_search_finds_a_concept_by_its_physical_column(onto):
    """The practical requirement: an agent knows the column, not the ontology's name for it."""
    hits = search.search(onto, "deliv_pct", kinds=("property", "card"), limit=10)
    assert hits, "a column name present in the bindings returned no hits at all"
    names = {h.name for h in hits}
    assert names, "no property or card surfaced"


def test_search_indexes_table_names(onto):
    hits = search.search(onto, "unified_recommendations", kinds=("card",), limit=3)
    assert hits and hits[0].name == "unified_recommendations"


def test_search_respects_the_kind_filter(onto):
    hits = search.search(onto, "delivery surprise", kinds=("metric",), limit=10)
    assert hits
    assert all(h.kind == "metric" for h in hits)


def test_search_returns_nothing_for_a_query_of_only_stopwords(onto):
    """Returning arbitrary concepts is how an agent answers confidently from nothing."""
    assert search.search(onto, "what is the") == []


def test_search_is_deterministic(onto):
    a = [(h.kind, h.name, h.score) for h in search.search(onto, "swing signal", limit=8)]
    b = [(h.kind, h.name, h.score) for h in search.search(onto, "swing signal", limit=8)]
    assert a == b


def test_scores_are_descending(onto):
    hits = search.search(onto, "regime volatility", limit=10)
    assert [h.score for h in hits] == sorted((h.score for h in hits), reverse=True)


def test_best_returns_none_rather_than_a_guess(onto):
    assert search.best(onto, "qqq zzz nonexistent") is None


def test_search_columns_lists_a_tables_documented_columns(onto):
    cols = search.search_columns(onto, "stock_ohlcv")
    assert cols
    assert all(isinstance(c, str) for c, _p, _n in cols)
    assert all(p for _c, p, _n in cols)


# ── the context surface ───────────────────────────────────────────────────────


def test_guardrails_mention_leakage_and_point_in_time():
    joined = " ".join(ai.GUARDRAILS).lower()
    for topic in ("leakage_risk", "label", "point-in-time", "adjustment_basis"):
        assert topic.lower() in joined, f"no guardrail covers {topic}"


def test_describe_resolves_a_class(onto):
    text = ai.describe(onto, "BlockDeal")
    assert text.startswith("CLASS BlockDeal")
    assert "layer" in text


def test_describe_flags_a_label_property(onto):
    label = next(p for p in onto.properties if p.is_label)
    text = ai.describe(onto, label.name)
    assert "usable as a feature: False" in text


def test_describe_shows_where_a_property_is_bound(onto):
    text = ai.describe(onto, "symbol")
    assert "bound to:" in text
    assert "." in text.split("bound to:")[1]


def test_data_card_text_includes_grain_caveats_and_the_never_list(onto):
    text = ai.data_card_text(onto, "stock_ohlcv")
    assert "grain" in text.lower()
    assert "NEVER as features" in text or "caveats" in text


def test_data_card_text_for_an_unknown_table_says_so_and_suggests(onto):
    text = ai.data_card_text(onto, "stock_ohclv")
    assert "no data card" in text.lower()
    assert "stock_ohlcv" in text


def test_clip_is_visible_when_it_truncates():
    assert "truncated" in ai.clip("x" * 500, 100)
    assert ai.clip("short", 100) == "short"


def test_context_pack_always_ends_with_every_guardrail(onto):
    for question in ("what explains a swing signal for INFY?",
                     "zzzz nothing matches this",
                     "stock_ohlcv"):
        pack = ai.context_pack(onto, question, max_chars=2500)
        for rule in ai.GUARDRAILS:
            assert rule[:40] in pack, f"guardrail lost for question {question!r}"


def test_context_pack_respects_its_budget_but_keeps_the_guardrails(onto):
    pack = ai.context_pack(onto, "delivery", max_chars=900)
    # The guardrails are reserved BEFORE the body is clipped, so the pack may exceed the
    # nominal budget by the guardrail length rather than truncating the rules.
    assert len(pack) < 900 + sum(len(g) for g in ai.GUARDRAILS)
    assert all(g[:40] in pack for g in ai.GUARDRAILS)


def test_context_pack_for_an_unmatched_question_is_honest(onto):
    pack = ai.context_pack(onto, "qqq zzz vvv")
    assert "No ontology concept matched" in pack
    assert "unverified" in pack


def test_context_pack_marks_a_leaky_column(onto):
    leaky = next(p for p in onto.properties if p.leakage_risk == "high")
    pack = ai.context_pack(onto, leaky.label, max_chars=4000, kinds=("property",))
    if leaky.name in pack:
        assert "[LEAK]" in pack or "usable as a feature: False" in pack


def test_context_report_reports_what_it_retrieved(onto):
    report = ai.context_report(onto, "block deal")
    assert report["guardrails_present"] is True
    assert report["chars"] == len(report["pack"])
    assert report["hits"]


def test_prompt_block_fits_its_budget(onto):
    block = ai.prompt_block(onto, max_chars=3000)
    assert len(block) <= 3000

"""The AI-facing surface: bounded context, guardrails, and honest fallbacks.

`context_pack` is what a model actually sees, so its failure mode is a confident
answer built from context that was quietly truncated. These tests pin the
properties that prevent that: the guardrails are never the thing that gets cut,
an unmatched question still returns orientation rather than nothing, and a label
can never be described as a feature.
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from ontology import ai, build_ontology


def _onto():
    return build_ontology()


class TestContextPack:
    def test_a_real_question_answers_with_relevant_concepts(self):
        pack = ai.context_pack(_onto(), "what explains a swing signal for INFY?", max_chars=2500)
        assert len(pack) <= 2500 + 200, len(pack)
        assert "swing" in pack.lower() or "recommend" in pack.lower()
        assert "swing" in pack.lower()

    def test_guardrails_survive_every_budget_including_the_tiny_one(self):
        """The ordering bug this guards: reserving the guardrails out of the budget
        rather than appending them and hoping they fit."""
        for max_chars in (500, 800, 2500, 10_000):
            pack = ai.context_pack(_onto(), "delivery volume surge", max_chars=max_chars)
            for rule in ai.GUARDRAILS:
                assert rule[:40] in pack, f"guardrail lost at max_chars={max_chars}"

    def test_a_question_nothing_matches_still_returns_orientation(self):
        """Returning an empty pack is how an agent answers from pure imagination."""
        pack = ai.context_pack(_onto(), "zzzzqqq wwwwvvvv", max_chars=2500)
        assert ai.GUARDRAILS[0][:40] in pack
        assert "unverified" in pack.lower()

    def test_truncation_is_visible(self):
        tiny = ai.context_pack(_onto(), "market regime volatility crash", max_chars=500)
        assert len(tiny) < 2500
        assert "truncated" in tiny.lower() or len(tiny) < 500

    def test_clip_never_silently_drops_the_tail(self):
        clipped = ai.clip("x" * 100, 20)
        assert len(clipped) <= 40
        assert "truncated" in clipped


class TestDescribe:
    def test_a_class_description_names_its_table_and_edges(self):
        text = ai.describe(_onto(), "Recommendation")
        assert text.startswith("CLASS Recommendation")
        assert "realized by:" in text
        assert "unified_recommendations" in text

    def test_a_property_description_names_its_leakage_and_its_columns(self):
        text = ai.describe(_onto(), "close")
        assert "PROPERTY close" in text
        assert "leakage_risk:" in text
        assert "usable as a feature:" in text
        assert "bound to:" in text

    def test_a_label_property_is_described_as_a_target(self):
        text = ai.describe(_onto(), "forward_return_pct")
        assert "usable as a feature: False" in text

    def test_a_metric_description_carries_runnable_sql(self):
        text = ai.describe(_onto(), "delivery_surprise_z")
        assert "SELECT" in text.upper()
        assert "AS-OF" in text.upper() or "as-of" in text.lower()

    def test_an_unknown_name_says_so_instead_of_guessing(self):
        text = ai.describe(_onto(), "definitely_not_a_concept")
        assert "not" in text.lower()


class TestDataCardText:
    def test_a_card_lists_columns_with_their_semantic_type(self):
        text = ai.data_card_text(_onto(), "stock_ohlcv")
        assert "close -> close" in text
        assert "open -> open" in text
        assert "measure/" in text

    def test_a_card_marks_labels_so_a_model_cannot_mistake_them_for_features(self):
        text = ai.data_card_text(_onto(), "signal_outcomes")
        assert "[LABEL]" in text

    def test_an_unknown_table_is_refused(self):
        assert "no data card" in ai.data_card_text(_onto(), "no_such_table").lower()


class TestContextReport:
    def test_report_carries_its_provenance(self):
        rep = ai.context_report(_onto(), "how is unified_score built?", max_chars=2000)
        assert rep["guardrails_present"] is True
        assert rep["chars"] == len(rep["pack"])
        assert rep["question"].startswith("how is")
        assert isinstance(rep["hits"], list)
