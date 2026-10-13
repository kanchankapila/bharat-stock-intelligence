"""screener_tenure_mover_analysis.winsorize must actually clip a lone outlier (AF-20260928-09).

The reversed form -- quantile(pct, 'lower') / quantile(1-pct, 'higher') -- returns the outlier
itself as the cutoff and clips nothing (ml-model-bugs.md, "Quantile-based winsorization...").
"""
import os
import sys

import numpy as np
import pandas as pd
from types import SimpleNamespace

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

import screener_tenure_mover_analysis as tenure  # noqa: E402
from screener_tenure_mover_analysis import winsorize  # noqa: E402


def test_lone_high_outlier_is_clipped():
    s = pd.Series(np.r_[np.zeros(99), 1279.0])        # the +127,900% RELIANCE-style bar
    assert winsorize(s, 0.01).max() == 0.0


def test_lone_low_outlier_is_clipped():
    s = pd.Series(np.r_[np.zeros(99), -1279.0])
    assert winsorize(s, 0.01).min() == 0.0


def test_interior_values_untouched():
    s = pd.Series(np.linspace(-1, 1, 101))
    w = winsorize(s, 0.01)
    assert (w.iloc[2:-2] == s.iloc[2:-2]).all()


def test_catalog_tags_are_provider_scoped_with_honest_legacy_fallback(monkeypatch):
    catalog = pd.DataFrame([
        {"screener_id": "173", "source": "MoneyControl", "screener_name": "MC"},
        {"screener_id": "173", "source": "ETnow", "screener_name": "ET"},
    ])
    monkeypatch.setattr(tenure, "read_df", lambda *_: catalog)
    monkeypatch.setattr(
        tenure,
        "decompose",
        lambda name: SimpleNamespace(
            signal_tags=("mc_tag",) if name == "MC" else ("et_tag",),
            same_day_relevant=name == "MC",
        ),
    )

    tags = tenure.load_catalog_tags()

    assert tags[("moneycontrol", "173")] == (["mc_tag"], True)
    assert tags[("etnow", "173")] == (["et_tag"], False)
    # Old rows cannot be attributed after the fact: preserve both possible tags and use the
    # conservative all-sources relevance verdict rather than guessing a provider.
    assert tags[("legacy_unknown", "173")] == (["et_tag", "mc_tag"], False)
