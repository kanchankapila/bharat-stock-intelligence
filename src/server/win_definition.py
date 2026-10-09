"""The single definition of a "win" (accuracy program spec 2026-10-08, section 2.C.5).

A win rate is WIN / (WIN + LOSS + STOP_LOSS): decisive outcomes only. NEUTRAL is reported separately and never
enters the denominator; PENDING (or no outcome) is unresolved and counted nowhere. The side is read from the trade
geometry, never the label: LONG = target above stop, SHORT = target below stop (the resolver's own direction rule).
This is the definition signals.router.ts getAccuracyMetrics uses (LONG, 15d); test_win_definition.py runs that SQL
next to win_rate() so the two cannot drift apart. The frozen forward test (forward_test_report.py) stays the arbiter
of whether the ranking has an edge; a win rate on barrier labels is not an excess return.
"""
from __future__ import annotations

import math

import pandas as pd

DECISIVE = ("WIN", "LOSS", "STOP_LOSS")
ACCURACY_HORIZON = 15


def classify_outcome(outcome, return_pct=None, cost_pct=None):
    """'WIN' | 'LOSS' | 'NEUTRAL' | None (unresolved).

    With `cost_pct` (percent, e.g. 0.30 round trip) a labelled WIN whose return does not clear the cost is a LOSS.
    With no label, a resolved return is graded on its sign net of `cost_pct`."""
    if outcome is None or (isinstance(outcome, float) and math.isnan(outcome)):
        if return_pct is None or return_pct != return_pct:
            return None
        return "WIN" if return_pct - (cost_pct or 0.0) > 0 else "LOSS"
    if outcome == "NEUTRAL":
        return "NEUTRAL"
    if outcome not in DECISIVE:
        return None
    if outcome != "WIN":
        return "LOSS"
    if cost_pct is not None and return_pct is not None and return_pct == return_pct and return_pct - cost_pct <= 0:
        return "LOSS"
    return "WIN"


def win_rate(df: pd.DataFrame, side: str, horizon: int, cost_pct=None) -> dict:
    """df columns: outcome, return_pct, horizon_days, target_price, stop_loss."""
    long_side = df["target_price"] > df["stop_loss"]
    d = df[(df["horizon_days"] == horizon) & (long_side if side == "LONG" else df["target_price"] < df["stop_loss"])]
    v = pd.Series([classify_outcome(o, r, cost_pct) for o, r in zip(d["outcome"], d["return_pct"])], index=d.index, dtype=object)
    wins, losses, neutral = int((v == "WIN").sum()), int((v == "LOSS").sum()), int((v == "NEUTRAL").sum())
    decisive = wins + losses
    resolved = d.loc[v.notna(), "return_pct"]
    return {"side": side, "horizon": horizon, "wins": wins, "losses": losses, "decisive": decisive, "neutral": neutral,
            "win_rate": wins / decisive if decisive else float("nan"),
            "avg_return_pct": float(resolved.mean()) if len(resolved) else float("nan")}
