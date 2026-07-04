import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import tickertape_scorecard_fetcher as tsf


def _score_category(name, tag):
    return {"name": name, "tag": tag, "type": "score", "score": {"value": None}}


def _non_score_category(name, tag):
    return {"name": name, "tag": tag, "type": "entryPoint"}


class TestComputeOrdinalScores:
    def test_maps_low_avg_high_to_0_1_2(self):
        data = [_score_category("Performance", "Low"), _score_category("Valuation", "Avg"), _score_category("Growth", "High")]
        result = tsf.compute_ordinal_scores(data)

        assert result["performance"] == {"score_value": 0, "score_label": "Low"}
        assert result["valuation"] == {"score_value": 1, "score_label": "Avg"}
        assert result["growth"] == {"score_value": 2, "score_label": "High"}

    def test_ignores_non_score_type_categories(self):
        data = [_score_category("Performance", "Low"), _non_score_category("Entry point", "Good"), _non_score_category("Red flags", "Low")]
        result = tsf.compute_ordinal_scores(data)

        assert "entry point" not in result
        assert "red flags" not in result
        assert "performance" in result

    def test_unrecognized_tag_gets_none_score_value_but_keeps_label(self):
        data = [_score_category("Growth", "Unusual")]
        result = tsf.compute_ordinal_scores(data)

        assert result["growth"] == {"score_value": None, "score_label": "Unusual"}

    def test_empty_input_returns_empty_dict(self):
        assert tsf.compute_ordinal_scores([]) == {}
        assert tsf.compute_ordinal_scores(None) == {}

    def test_category_name_is_lowercased_for_score_type_key(self):
        data = [_score_category("Profitability", "High")]
        result = tsf.compute_ordinal_scores(data)
        assert "profitability" in result
        assert "Profitability" not in result
