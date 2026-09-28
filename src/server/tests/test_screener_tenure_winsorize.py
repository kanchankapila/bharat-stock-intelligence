"""screener_tenure_mover_analysis.winsorize must actually clip a lone outlier (AF-20260928-01).

The reversed form -- quantile(pct, 'lower') / quantile(1-pct, 'higher') -- returns the outlier
itself as the cutoff and clips nothing (ml-model-bugs.md, "Quantile-based winsorization...").
"""
import os
import sys

import numpy as np
import pandas as pd

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

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
