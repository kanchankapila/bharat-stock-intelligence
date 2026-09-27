"""Lexical retrieval over the ontology.

The ranking is BM25-ish, which means relevance claims are easy to make and hard
to keep honest, so these tests pin the *decisions* (a delivery query finds the
delivery metric; a column lookup finds the card) and the two behaviours that
matter more than ranking: a nonsense query returns nothing, and kind filters
really filter.
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from ontology import build_ontology, search


def _onto():
    return build_ontology()


class TestSearch:
    def test_a_domain_query_finds_the_right_concept(self):
        hits = search.search(_onto(), "delivery surprise z-score", limit=5)
        assert hits, "a query naming a real concept found nothing"
        assert any(h.name in ("delivery_surprise_z", "eps_surprise") for h in hits), \
            [h.name for h in hits]

    def test_hits_are_ranked_and_carry_a_uri(self):
        hits = search.search(_onto(), "unified score", limit=5)
        scores = [h.score for h in hits]
        assert scores == sorted(scores, reverse=True)
        assert all(h.uri.startswith("https://") for h in hits)
        assert all(h.snippet for h in hits)

    def test_a_query_with_no_usable_terms_returns_nothing(self):
        """Silently returning 'some concepts' for an unparsed question is how an agent
        answers confidently from context it never retrieved."""
        assert search.search(_onto(), "   ") == []
        assert search.search(_onto(), "!!! ???") == []

    def test_nonsense_returns_nothing_rather_than_a_confident_guess(self):
        assert search.search(_onto(), "zzzzqqq wwwwvvvv") == []

    def test_kind_filter_is_real(self):
        onto = _onto()
        cards_only = search.search(onto, "delivery", kinds=("card",), limit=10)
        assert cards_only and all(h.kind == "card" for h in cards_only)
        metrics_only = search.search(onto, "delivery", kinds=("metric",), limit=10)
        assert metrics_only and all(h.kind == "metric" for h in metrics_only)
        assert {h.name for h in cards_only}.isdisjoint({h.name for h in metrics_only})

    def test_limit_is_respected(self):
        assert len(search.search(_onto(), "score", limit=3)) <= 3

    def test_one_hit_per_kind_and_name(self):
        hits = search.search(_onto(), "close", limit=25)
        keys = [(h.kind, h.name) for h in hits]
        assert len(keys) == len(set(keys))

    def test_best_picks_the_top_hit_or_none(self):
        assert search.best(_onto(), "unified score") is not None
        assert search.best(_onto(), "zzz qqq") is None

    def test_column_lookup_maps_every_bound_column_to_a_property(self):
        onto = _onto()
        card = onto.card_by_table("stock_ohlcv")
        assert card is not None
        cols = search.search_columns(onto, "stock_ohlcv")
        assert cols, "stock_ohlcv has no bound columns"
        for column, prop, _note in cols:
            assert onto.property_by_name(prop) is not None
            assert onto.property_at("stock_ohlcv", column) is not None

    def test_unknown_table_has_no_columns_rather_than_inventing_them(self):
        assert search.search_columns(_onto(), "no_such_table") == []
