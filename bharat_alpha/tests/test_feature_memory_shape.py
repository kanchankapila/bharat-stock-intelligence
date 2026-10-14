from __future__ import annotations

import numpy as np
import pandas as pd

from bharat_alpha.features import _stack_eligible_features


def test_stack_eligible_features_filters_before_allocating_long_block():
    dates = pd.date_range("2026-01-01", periods=2)
    instruments = pd.Index([1, 2, 3])
    raw = {
        "signal": pd.DataFrame(
            [[10.0, 20.0, 30.0], [40.0, np.nan, 60.0]],
            index=dates,
            columns=instruments,
        ),
        "empty": pd.DataFrame(np.nan, index=dates, columns=instruments),
    }
    mask = pd.DataFrame(
        [[True, False, True], [False, True, True]],
        index=dates,
        columns=instruments,
    )

    long, names = _stack_eligible_features(raw, dates, instruments, dates, mask)

    assert names == ["signal"]
    assert list(long.index) == [
        (dates[0], 1),
        (dates[0], 3),
        (dates[1], 2),
        (dates[1], 3),
    ]
    assert long["signal"].dtype == np.float32
    assert np.isnan(long.loc[(dates[1], 2), "signal"])
