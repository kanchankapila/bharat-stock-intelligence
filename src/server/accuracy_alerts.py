"""Alerts evaluated from an accuracy_scorecard snapshot (spec 2026-10-08, section 2.C.3). Pure functions.

Each alert is {"code", "severity", "message", "detail"}. Nothing here reads the database or sends anything; a job
that wants to notify passes the result of evaluate() to its own sender.

  published_lift_ci      published-tier hit lift's 95% band includes zero (or is negative) on each of the last 3 weekly
                         snapshots, counted only once the tier has >= MIN_DATES_RELIABLE independent windows
  brier_worse_than_base  calibrated_win_probability scores worse than predicting the constant base rate
  dispersion_collapse    the published top decile's distinct-value share collapses vs its trailing median
  ic_sign_change         an arm's rolling IC over 20 independent windows changes sign vs the 20 before
  feature_collapse       a ranker input's non-null share or distinct count collapses, or one value takes over the
                         column (the forward-filled countdown class: 92% of stored values had no source row)
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from factor_edge import MIN_DATES_RELIABLE

COLLAPSE_RATIO = 0.5       # a share/count below half its trailing median
MODAL_FLOOR = 0.5          # one value on more than half the rows ...
MODAL_RATIO = 2.0          # ... and at least double its trailing median share
TRAILING = 20


def _alert(code, message, severity="warn", **detail):
    return {"code": code, "severity": severity, "message": message, "detail": detail}


def _row(sc, arm, tier, horizon, floor, regime):
    return next((r for r in sc.get("rows", []) if r["arm"] == arm and r["tier"] == tier and r["horizon"] == horizon
                 and r["floor"] == floor and r["regime"] == regime), None)


def lift_ci_alert(snapshots, arm="published", tier="published", horizon=5, floor=1e8, regime="ALL", runs=3):
    last = snapshots[-runs:]
    if len(last) < runs:
        return None
    rows = [_row(s, arm, tier, horizon, floor, regime) for s in last]
    if any(r is None or not (r["eff_dates"] >= MIN_DATES_RELIABLE) for r in rows):
        return None
    if all(r["hit_lift"] - r["hit_ci95"] <= 0 for r in rows):
        return _alert("published_lift_ci", f"published {tier} lift CI includes zero on {runs} consecutive snapshots "
                      f"({horizon}d, floor {floor:.0e}, {regime})", "fail",
                      lifts=[r["hit_lift"] for r in rows], ci95=[r["hit_ci95"] for r in rows])
    return None


def brier_alert(sc):
    bad = {h: c for h, c in (sc.get("calibration") or {}).items()
           if c.get("n") and c.get("brier") is not None and c["brier"] > c["brier_base"]}
    if bad:
        return _alert("brier_worse_than_base", "calibrated_win_probability scores worse than the constant base rate "
                      "at horizon(s) " + ",".join(bad), horizons=bad)
    return None


def _collapsed_below(series):
    s = pd.Series(series, dtype=float).dropna()
    if len(s) < 6:
        return None
    med = s.iloc[-TRAILING - 1:-1].median()
    return (float(s.iloc[-1]), float(med)) if med > 0 and s.iloc[-1] < COLLAPSE_RATIO * med else None


def dispersion_alert(sc):
    d = sc.get("dispersion") or {}
    hit = _collapsed_below(d.get("top_decile_distinct_share", []))
    if hit:
        return _alert("dispersion_collapse", f"published top-decile distinct-value share {hit[0]:.2f} vs trailing "
                      f"median {hit[1]:.2f}", latest=hit[0], trailing_median=hit[1], date=str((d.get("dates") or [None])[-1]))
    return None


def rolling_ic_sign_change(ics, horizon, window=TRAILING):
    """True when the mean IC of the last `window` independent (every h-th date) windows has the opposite sign of the
    `window` before it. Needs 2 x window independent windows; anything shorter is not evidence."""
    sub = np.asarray([x for x in ics if x == x], dtype=float)[::max(int(horizon), 1)]
    if len(sub) < 2 * window:
        return False
    now, before = sub[-window:].mean(), sub[-2 * window:-window].mean()
    return bool(now * before < 0)


def ic_sign_alerts(sc):
    out = []
    for arm, by_h in (sc.get("ic_series") or {}).items():
        for h, s in by_h.items():
            if rolling_ic_sign_change(s["ic"], int(h)):
                out.append(_alert("ic_sign_change", f"{arm} rolling {h}d IC changed sign over {TRAILING}+ windows",
                                  arm=arm, horizon=int(h)))
    return out


def feature_collapse(df: pd.DataFrame, col: str, date_col: str = "date"):
    """Latest date vs the trailing median of the prior TRAILING dates, on non-null share, distinct count and the
    share held by the single most common value."""
    g = df.groupby(date_col)[col]
    stats = pd.DataFrame({
        "non_null_share": g.apply(lambda s: s.notna().mean()),
        "distinct": g.nunique(),
        "modal_share": g.apply(lambda s: s.value_counts(normalize=True).iloc[0] if s.notna().any() else 0.0),
    }).sort_index()
    if len(stats) < 6:
        return None
    last, prior = stats.iloc[-1], stats.iloc[-TRAILING - 1:-1].median()
    tripped = [k for k in ("non_null_share", "distinct") if prior[k] > 0 and last[k] < COLLAPSE_RATIO * prior[k]]
    if last["modal_share"] > max(MODAL_FLOOR, MODAL_RATIO * prior["modal_share"]):
        tripped.append("modal_share")
    if not tripped:
        return None
    return _alert("feature_collapse", f"{col} collapsed on {stats.index[-1]}: " + ", ".join(tripped), column=col,
                  tripped=tripped, latest={k: float(v) for k, v in last.items()},
                  trailing_median={k: float(v) for k, v in prior.items()})


def evaluate(sc, history=(), feature_frames=None):
    """sc: the newest scorecard; history: earlier weekly snapshots, oldest first; feature_frames: {col: df}."""
    out = [a for a in (lift_ci_alert(list(history) + [sc]), brier_alert(sc), dispersion_alert(sc)) if a]
    out += ic_sign_alerts(sc)
    out += [a for col, df in (feature_frames or {}).items() if (a := feature_collapse(df, col))]
    return out
