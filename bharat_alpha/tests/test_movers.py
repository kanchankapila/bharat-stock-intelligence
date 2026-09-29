"""The separation statistic must tell a volatility detector from a directional signal.

Built as a negative control rather than a smoke test: a synthetic panel carries one
feature that drives |return| with a random SIGN (the detector), one that drives the
signed return (directional), and one pure noise. The detector must light up the
winners-only statistic -- the trap -- while scoring ~0 on separation. If it does not,
the statistic is not measuring what the module claims.
"""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import pandas as pd

from bharat_alpha.evaluation.movers import mover_separation

N_DATES, N_STOCKS, K = 120, 150, 20


@dataclass
class _Ds:
    """Minimal stand-in for Dataset: mover_separation only touches these four."""
    horizon: int
    X: pd.DataFrame
    excess: pd.Series

    @property
    def dates(self) -> pd.DatetimeIndex:
        return pd.DatetimeIndex(self.X.index.get_level_values("date").unique()).sort_values()


def _panel(seed: int = 7) -> _Ds:
    rng = np.random.default_rng(seed)
    dates = pd.bdate_range("2024-01-01", periods=N_DATES)
    idx = pd.MultiIndex.from_product([dates, range(N_STOCKS)], names=["date", "instrument_id"])
    n = len(idx)

    vol = rng.uniform(0, 1, n)          # drives MAGNITUDE only
    direction = rng.uniform(0, 1, n)    # drives SIGN
    noise = rng.uniform(0, 1, n)

    sign = rng.choice([-1.0, 1.0], n)
    excess = vol * sign * 0.05 + (direction - 0.5) * 0.02 + rng.normal(0, 0.002, n)

    X = pd.DataFrame({"vol_detector": vol, "directional": direction, "noise": noise}, index=idx)
    return _Ds(horizon=1, X=X, excess=pd.Series(excess, index=idx))


def test_volatility_detector_is_not_mistaken_for_a_signal():
    df = mover_separation(_panel(), k=K).set_index("feature")
    det = df.loc["vol_detector"]
    # Both tails are drawn from the high end -- that is what a detector looks like.
    assert det.win_rank > 0.6 and det.los_rank > 0.6, (det.win_rank, det.los_rank)
    # The trap fires...
    assert abs(det.t_winners_only) > det.bonferroni_t
    assert det.winners_only_would_clear
    # ...and the honest statistic does not.
    assert not det.directional, f"detector leaked into the directional set (t={det.t_separation})"


def test_directional_feature_is_found():
    df = mover_separation(_panel(), k=K).set_index("feature")
    d = df.loc["directional"]
    assert d.separation > 0, d.separation
    assert d.directional, f"real signal missed (t={d.t_separation}, bar={d.bonferroni_t})"
    assert d.win_rank > d.los_rank


def test_noise_is_flagged_as_neither():
    df = mover_separation(_panel(), k=K).set_index("feature")
    assert not df.loc["noise"].directional


def test_reports_both_tails_for_every_feature():
    df = mover_separation(_panel(), k=K)
    assert set(df.feature) == {"vol_detector", "directional", "noise"}
    assert {"win_rank", "los_rank", "separation", "t_separation", "t_winners_only"} <= set(df.columns)
    assert (df.n_dates == N_DATES).all()
