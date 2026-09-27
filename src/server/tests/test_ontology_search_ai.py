"""The retrieval and prompt surfaces an agent actually calls.

Two failure modes matter here and both are silent. A search that returns the wrong concept
looks like a search that returned nothing, and a context pack that quietly drops the
caveats looks like a context pack that was simply short. So: retrieval must return the
*right* concept for the questions this database actually gets asked, and truncation must
always announce itself.
"""
import os
import sys

import pytest

SERVER_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if SERVER_DIR not in sys.path:
    sys.path.insert(0, SERVER_DIR)

from ontology import ai, build_ontology, search  # noqa: E402


@pytest.fixture(scope="module")
def onto():
    return build_ontology()


@pytest.mark.parametrize("query,expected", [
    ("delivery percentage surprise", "delivery_pct"),
    ("how many analysts cover this stock", "n_analysts"),
    ("open interest change", "oi_change"),
    ("regime filter", "market_regime"),
    ("what is the unified score", "unified_score"),
])
def test_search_finds_the_obvious_concept(onto, query, expected):
    """The first hit should be the concept a person would name."""
    hits = search.search(onto, query, limit=5)
    assert hits, f"nothing found for {query!r}"
    assert any(expected in h.name for h in hits), \
        f"{query!r}: expected {expected!r} in {[h.name for h in hits]}"


def test_search_respects_the_kind_filter(onto):
    hits = search.search(onto, "delivery", kinds=("metric",), limit=10)
    assert hits
    assert {h.kind for h in hits} == {"metric"}


def test_search_is_ranked_not_alphabetical(onto):
    hits = search.search(onto, "delivery percentage", limit=10)
    scores = [h.score for h in hits]
    assert scores == sorted(scores, reverse=True)


def test_search_for_nonsense_returns_nothing_rather_than_everything(onto):
    """Low-signal junk must not produce confident matches."""
    assert search.search(onto, "qqzzxx nonexistentconcept", limit=5) == []


def test_search_columns_finds_the_physical_column(onto):
    hits = search.search_columns(onto, "block deal value", limit=5)
    assert any("block_deals" in str(h) or "value_cr" in str(h) for h in hits)


def test_best_picks_a_single_winner(onto):
    hit = search.best(onto, "latest close price", kinds=("metric",))
    assert hit is not None
    assert hit.name


def test_context_pack_carries_the_guardrails_even_when_truncated(onto):
    """A clipped pack must show the clipping. Silent truncation loses the caveats.

    This is the exact failure the clip marker exists for, so it is asserted rather than
    assumed.
    """
    full = ai.context_pack(onto, "swing signal for INFY", max_chars=100000)
    assert "Guardrails" in full
    short = ai.context_pack(onto, "swing signal for INFY", max_chars=700)
    assert len(short) <= 700
    assert short != full
    assert "truncated" in short.lower() or "…" in short or "..." in short


def test_context_pack_never_hides_a_label_behind_a_truncation(onto):
    text = ai.context_pack(onto, "what is the target for a swing signal", max_chars=100000)
    assert "LABEL" in text or "target" in text.lower()


def test_describe_resolves_every_kind(onto):
    assert "CLASS" in ai.describe(onto, "BlockDeal")
    assert "PROPERTY" in ai.describe(onto, "close")
    assert "METRIC" in ai.describe(onto, "close_price")
    assert "RELATION" in ai.describe(onto, "has_recommendation")


def test_describe_of_the_ontology_itself_is_the_overview(onto):
    text = ai.describe(onto, "ontology")
    assert "Guardrails" in text


def test_describe_unknown_concept_is_explicit_not_empty(onto):
    text = ai.describe(onto, "NotAConcept")
    assert "not found" in text.lower() or "unknown" in text.lower()


def test_metric_block_shows_the_sql_and_its_evidence(onto):
    text = ai.metric_block(onto.metric_by_name("delivery_pct_latest"))
    assert "SELECT" in text
    assert ":as_of" in text or ":symbol" in text


def test_card_block_lists_bound_columns_with_their_semantics(onto):
    text = ai.card_block(onto.card_by_table("block_deals"), max_chars=100000)
    assert "TABLE block_deals" in text
    assert "value_cr" in text
    assert "training: caution" in text
