"""Fast learning loops driven by realised outcomes — "learn from mistakes" without retraining.

1. Ensemble weights (Hedge / exponentiated gradient on each member's realised rank IC).
   A member that keeps ranking wrong loses weight; shrinkage toward uniform stops one lucky
   streak from zeroing the others. The step is divided by the horizon because consecutive
   resolved dates overlap and are not independent evidence.
2. Adaptive conformal inference (Gibbs & Candès 2021): the interval level alpha_t moves
   up when realised coverage exceeds target and down when it misses, so the published
   intervals stay honest as the market's noise level changes.
3. Recalibration: once enough outcomes exist, the score->expected-excess mapping is re-fit
   on REALISED ledger outcomes instead of the training-time OOF estimate.

Point-in-time: every state row for date D uses only outcomes whose exit date is <= D.
"""
from __future__ import annotations

import datetime as dt
from pathlib import Path

import joblib
import numpy as np
import pandas as pd
import psycopg
from psycopg.types.json import Jsonb
from sklearn.isotonic import IsotonicRegression

from bharat_alpha.config import get_settings
from bharat_alpha.db import jsonable, read_df, upsert
from bharat_alpha.modeling.registry import lineage_ids

MIN_RECALIBRATION_DATES = 20


def _resolved_evals(conn, model_id: str, as_of: dt.date) -> pd.DataFrame:
    ids = lineage_ids(conn, model_id)
    df = read_df(conn, """
        SELECT e.model_id, e.as_of_date, e.member, e.rank_ic, e.interval_cover, x.exit_date
        FROM alpha.realized_eval e
        JOIN (SELECT model_id, as_of_date, max(exit_date) AS exit_date FROM alpha.outcome
              WHERE model_id = ANY(%s) GROUP BY 1,2) x USING (model_id, as_of_date)
        WHERE e.model_id = ANY(%s) AND x.exit_date <= %s ORDER BY e.as_of_date""", (ids, ids, as_of))
    # one grade per decision date: if two lineage members predicted the same date, keep the newer model's
    order = {m: i for i, m in enumerate(ids)}
    df["o"] = df.model_id.map(order)
    return df.sort_values(["as_of_date", "member", "o"]).drop_duplicates(["as_of_date", "member"], keep="last")


def hedge_weights(ic_by_date: pd.DataFrame, eta: float, shrink: float, horizon: int) -> dict[str, float]:
    members = list(ic_by_date.columns)
    w = np.full(len(members), 1.0 / len(members))
    step = eta / max(horizon, 1)
    for _, row in ic_by_date.iterrows():
        g = row.to_numpy(dtype=float)
        g = np.where(np.isfinite(g), g, 0.0)
        w = w * np.exp(step * g)
        w = w / w.sum()
        w = (1 - shrink) * w + shrink / len(members)
    return dict(zip(members, map(float, w)))


def aci_alpha(covers: pd.Series, target_coverage: float, gamma: float) -> float:
    target_alpha = 1 - target_coverage
    a = target_alpha
    for c in covers.dropna():
        miss = 1.0 - float(c)
        a = a + gamma * (target_alpha - miss)
        a = float(np.clip(a, 0.001, 0.999))
    return a


def update_adaptive_state(conn: psycopg.Connection, model_id: str, horizon: int, as_of: dt.date) -> dict:
    s = get_settings()
    ev = _resolved_evals(conn, model_id, as_of)
    out: dict = {"resolved_dates": 0}
    if ev.empty:
        return out
    ic = ev[ev.member != "ensemble"].pivot(index="as_of_date", columns="member", values="rank_ic").sort_index()
    out["resolved_dates"] = int(len(ic))
    if not ic.empty:
        w = hedge_weights(ic, s.hedge_eta, s.hedge_shrink, horizon)
        upsert(conn, "alpha.ensemble_weight", [{"model_id": model_id, "as_of_date": as_of, "weights": Jsonb(jsonable(w))}],
               key=("model_id", "as_of_date"))
        out["weights"] = w
    cov = ev[ev.member == "ensemble"].set_index("as_of_date")["interval_cover"].sort_index()
    a = aci_alpha(cov, s.conformal_target_coverage, s.conformal_gamma)
    upsert(conn, "alpha.conformal_state", [{"model_id": model_id, "as_of_date": as_of, "alpha_t": a}],
           key=("model_id", "as_of_date"))
    out["alpha_t"] = a
    out["recalibrated"] = recalibrate(conn, model_id, horizon, as_of)
    conn.commit()
    return out


def calibrator_path(model_id: str, as_of: dt.date) -> Path:
    return Path(get_settings().artifacts_dir) / "calibration" / model_id / f"{as_of:%Y%m%d}.joblib"


def recalibrate(conn: psycopg.Connection, model_id: str, horizon: int, as_of: dt.date) -> bool:
    df = read_df(conn, """
        SELECT p.as_of_date, p.rank_pct, o.excess_mean FROM alpha.prediction p
        JOIN alpha.outcome o USING (model_id, as_of_date, instrument_id)
        WHERE p.model_id = ANY(%s) AND o.exit_date <= %s""", (lineage_ids(conn, model_id), as_of))
    if df.empty or df.as_of_date.nunique() < MIN_RECALIBRATION_DATES:
        return False
    ce = IsotonicRegression(out_of_bounds="clip").fit(df.rank_pct, df.excess_mean)
    cp = IsotonicRegression(out_of_bounds="clip", y_min=0, y_max=1).fit(df.rank_pct, (df.excess_mean > 0).astype(float))
    resid = np.sort(np.abs(df.excess_mean.to_numpy() - ce.predict(df.rank_pct.to_numpy())))
    path = calibrator_path(model_id, as_of)
    path.parent.mkdir(parents=True, exist_ok=True)
    joblib.dump({"excess": ce, "prob": cp, "abs_residuals": resid, "n_dates": int(df.as_of_date.nunique())}, path)
    return True


def latest_calibrator(model_ids: list[str], as_of: dt.date) -> dict | None:
    """Newest realised-outcome calibrator fitted on or before `as_of` across a model lineage."""
    root = Path(get_settings().artifacts_dir) / "calibration"
    files = [f for m in model_ids if (root / m).exists() for f in (root / m).glob("*.joblib")
             if f.stem <= f"{as_of:%Y%m%d}"]
    return joblib.load(max(files, key=lambda f: f.stem)) if files else None
