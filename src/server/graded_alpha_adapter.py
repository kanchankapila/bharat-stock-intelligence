"""Grade any call source under the frozen forward-test rules (spec 2026-10-08, section 2.C.4).

Built for `bharat_alpha` predictions, which live in a separate database this module must never query: the caller
loads them and passes a DataFrame (symbol, generated_at, score). Everything else is forward_test_report's frozen
machinery, imported, never copied: publication -> session mapping, next-open entry, Rs 1cr ADT floor, per-date
winsorisation, 25 bps per side, equal-weight benchmark, dates/h independent windows.

Three blocks per horizon:
  net      the frozen protocol as published (cost charged)
  gross    the same with no cost: is there ranking information at all
  control  the score shuffled within each date, graded gross. A negative control: |t_eff| should stay under 1.
           (Graded gross on purpose: net of cost a no-information pick reads -cost, which is a t-stat about the cost.)
"""
from __future__ import annotations

import numpy as np
import pandas as pd

import forward_test_report as F

COST = 2 * F.PROTOCOL["cost_per_side"]


def to_sessions(calls: pd.DataFrame, sessions: pd.DatetimeIndex, since: str | None = None) -> pd.DataFrame:
    out = F.latest_call_per_session(calls, sessions)
    return F.apply_protocol_start(out, since) if since else out


def shuffled(panel: pd.DataFrame, seed: int = 0) -> pd.DataFrame:
    rng = np.random.default_rng(seed)
    p = panel.copy()
    p["score"] = p.groupby("date")["score"].transform(lambda s: rng.permutation(s.to_numpy(copy=True)))
    return p


def grade_panel(panel: pd.DataFrame, horizon: int, seed: int = 0) -> dict:
    """panel: date, symbol, score, fwd (forward return fraction at `horizon`)."""
    return {"net": F.selective_accuracy(panel, horizon, cost=COST),
            "gross": F.selective_accuracy(panel, horizon, cost=0.0),
            "control": F.selective_accuracy(shuffled(panel, seed), horizon, cost=0.0)}


def grade_calls(con, calls: pd.DataFrame, since: str | None = None, seed: int = 0) -> dict:
    """con: the MAIN platform database (stock_ohlcv), read only. calls: symbol, generated_at (tz-aware), score."""
    sessions = F.load_sessions(con)
    c = to_sessions(calls, sessions, since)
    if c.empty:
        return {"calls": 0, "horizons": {}}
    panel = F.build_panel(con, c, sessions, F.PROTOCOL["horizons"], F.PROTOCOL["min_adt"])
    res = {str(h): grade_panel(panel.rename(columns={f"fwd_{h}": "fwd"}), h, seed) for h in F.PROTOCOL["horizons"]}
    return {"calls": int(len(c)), "sessions": int(c["session"].nunique()), "protocol_hash": F.protocol_hash(F.PROTOCOL),
            "horizons": res}
