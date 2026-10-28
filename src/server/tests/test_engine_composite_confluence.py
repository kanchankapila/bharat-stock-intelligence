"""AF-20261026-71: confluence_signals.fundamental_score is NULL when a stock has no fundamentals.
engine_composite summed the four sub-scores in SQL, where one NULL nulls the total and silently drops
the stock. Same rule as unified_ranker._get_confluence_scores: a missing component is imputed at its
per-date median; a row with no component is absent."""
import pandas as pd

from engine_composite import _confluence_ns


def test_missing_fundamental_is_imputed_at_the_per_date_median_not_dropped():
    rows = pd.DataFrame([
        ("A", "2026-10-20", 10, 5, 4, None),
        ("B", "2026-10-20", 10, 5, 4, 2.0),
        ("C", "2026-10-20", 10, 5, 4, 6.0),
        ("D", "2026-10-20", 10, 5, 4, 8.0),
        ("E", "2026-10-21", 1, 1, 1, 12.0),
    ], columns=["symbol", "date", "trend_alignment_score", "volume_score",
                "sector_strength_score", "fundamental_score"])
    out = _confluence_ns(rows).set_index("symbol")["confluence_ns"]
    assert out["A"] == 19 + 6.0          # median of {2, 6, 8} on 10-20, not 0 and not dropped
    assert out["B"] == 21.0
    assert out["E"] == 15.0              # 10-21's median comes from 10-21 only


def test_a_row_with_no_component_is_absent():
    rows = pd.DataFrame([("A", "2026-10-20", None, None, None, None),
                         ("B", "2026-10-20", 1, 1, 1, 1)],
                        columns=["symbol", "date", "trend_alignment_score", "volume_score",
                                 "sector_strength_score", "fundamental_score"])
    assert list(_confluence_ns(rows)["symbol"]) == ["B"]
