"""The definitions of a "win" (accuracy program spec 2026-10-08, section 2.C.5; trade win rate added 2026-11-20).

The headline is net_profit_rate(): the share of resolved trades whose net, direction-signed return is above zero
(the market convention; owner decision 2026-11-20). win_rate() below is the resolver-LABEL rate and is kept as a
secondary diagnostic:
A label win rate is WIN / (WIN + LOSS + STOP_LOSS): decisive outcomes only. NEUTRAL is reported separately and never
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


def _side(df: pd.DataFrame, side: str, horizon: int) -> pd.DataFrame:
    long_side = df["target_price"] > df["stop_loss"]
    return df[(df["horizon_days"] == horizon) & (long_side if side == "LONG" else df["target_price"] < df["stop_loss"])]


def net_profit_rate(df: pd.DataFrame, side: str, horizon: int) -> dict:
    """The trade win rate (owner decision 2026-11-20): share of resolved trades that made money.

    `return_pct` is already direction-signed (a short gains when the price falls) and net of the round trip by the
    resolver, so a trade won when it is above zero. Every resolved outcome counts, NEUTRAL included: a flat exit is a
    trade that was taken. The resolver's WIN label (a volatility-scaled threshold) is not consulted."""
    d = _side(df, side, horizon)
    r = d.loc[d["outcome"].isin(DECISIVE + ("NEUTRAL",)) & d["return_pct"].notna(), "return_pct"].astype(float)
    wins, losses = r[r > 0], r[r <= 0]
    return {"side": side, "horizon": horizon, "trades": int(len(r)), "profitable": int(len(wins)),
            "profit_rate": len(wins) / len(r) if len(r) else float("nan"),
            "avg_return_pct": float(r.mean()) if len(r) else float("nan"),
            "avg_win_pct": float(wins.mean()) if len(wins) else float("nan"),
            "avg_loss_pct": float(losses.mean()) if len(losses) else float("nan")}


def win_rate(df: pd.DataFrame, side: str, horizon: int, cost_pct=None) -> dict:
    """Label win rate. df columns: outcome, return_pct, horizon_days, target_price, stop_loss."""
    d = _side(df, side, horizon)
    v = pd.Series([classify_outcome(o, r, cost_pct) for o, r in zip(d["outcome"], d["return_pct"])], index=d.index, dtype=object)
    wins, losses, neutral = int((v == "WIN").sum()), int((v == "LOSS").sum()), int((v == "NEUTRAL").sum())
    decisive = wins + losses
    resolved = d.loc[v.notna(), "return_pct"]
    return {"side": side, "horizon": horizon, "wins": wins, "losses": losses, "decisive": decisive, "neutral": neutral,
            "win_rate": wins / decisive if decisive else float("nan"),
            "avg_return_pct": float(resolved.mean()) if len(resolved) else float("nan")}
