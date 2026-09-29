"""Next-session (open->close) model: same ensemble, CV and gate as the multi-day engine, graded
day-level against the capitulation rule on the same sessions.

The rule is the benchmark to beat, compared as BOOKS over every out-of-fold session: the rule's
day is its basket's net spread when it fires and 0 (cash) when it does not; the model's day is
its top-k basket's net spread. A model that only matches the rule on the days it fires, and
loses money on the rest, fails.
"""
from __future__ import annotations

import datetime as dt
from dataclasses import dataclass
from pathlib import Path

import joblib
import numpy as np
import pandas as pd
import psycopg
from psycopg.types.json import Jsonb
from sklearn.isotonic import IsotonicRegression

from bharat_alpha.config import get_settings
from bharat_alpha.db import jsonable
from bharat_alpha.evaluation.metrics import evaluate_scores
from bharat_alpha.features import cs_rank_gauss
from bharat_alpha.labels import winsorize_rows
from bharat_alpha.marketdata import Panel, load_panel
from bharat_alpha.modeling.members import combine, default_members
from bharat_alpha.modeling.train import ModelBundle, config_hash, walk_forward_oof
from bharat_alpha.session import (
    capitulation, day_flags, day_level, next_session_oc, preopen_features, session_features, session_universe,
    top_k_selection,
)

SESSION_HORIZON = 1
SESSION_TOP_K = 10
FEATURE_SET = "session1"
LABEL = "next_session_open_to_close"
FLAG_PREFIX = "flag_"


def session_frame(conn: psycopg.Connection, p: Panel, dates: pd.DatetimeIndex | None = None):
    """Long feature frame (date, instrument_id) on the session universe. Continuous features are
    rank->Gaussian per date; flags stay 0/1. One builder for training and serving."""
    uni = session_universe(p)
    flags = day_flags(p, uni)
    raw = session_features(p, flags)
    raw.update(preopen_features(conn, p))
    sel = dates if dates is not None else p.dates
    m = uni.loc[sel]
    cols = {}
    for name, w in raw.items():
        w = w.reindex(index=p.dates, columns=p.close.columns).loc[sel]
        z = w.where(m) if name.startswith(FLAG_PREFIX) else cs_rank_gauss(w, m)
        if z.notna().to_numpy().sum() == 0:
            continue
        cols[name] = z.stack(future_stack=True)
    X = pd.DataFrame(cols)
    X.index.names = ["date", "instrument_id"]
    elig = m.stack(future_stack=True)
    X = X.loc[elig[elig].index.intersection(X.index)].sort_index()
    return X, uni, flags


@dataclass
class SessionDataset:
    horizon: int
    X: pd.DataFrame
    y: pd.Series
    fwd: pd.Series
    fwd_oc: pd.DataFrame
    universe: pd.DataFrame
    flags: dict
    panel: Panel

    @property
    def dates(self) -> pd.DatetimeIndex:
        return pd.DatetimeIndex(self.X.index.get_level_values("date").unique()).sort_values()


def build_session_dataset(conn: psycopg.Connection, start: dt.date, end: dt.date) -> SessionDataset:
    s = get_settings()
    p = load_panel(conn, start, end)
    X, uni, flags = session_frame(conn, p)
    fwd = next_session_oc(p)
    fwd_w = winsorize_rows(fwd.where(uni), s.winsor_pct)
    target = cs_rank_gauss(fwd_w, uni & fwd_w.notna())

    def long(w):
        x = w.stack(future_stack=True)
        x.index.names = ["date", "instrument_id"]
        return x

    y = long(target).reindex(X.index)
    keep = y.notna()
    return SessionDataset(SESSION_HORIZON, X[keep], y[keep], long(fwd_w).reindex(X.index[keep]), fwd, uni, flags, p)


def evaluate_session_oof(ds: SessionDataset, oof: pd.DataFrame, weights: dict[str, float]) -> dict:
    s = get_settings()
    ens = combine(oof, weights).unstack("instrument_id")
    dates = ens.index
    fwd_w = ds.fwd.reindex(oof.index).unstack("instrument_id")
    uni = ds.universe.loc[dates]
    report: dict = {"horizon": SESSION_HORIZON, "members": {}}
    for col in oof.columns:
        report["members"][col] = evaluate_scores(oof[col].unstack("instrument_id"), fwd_w, 1, SESSION_TOP_K,
                                                 s.min_effective_dates)
    report["ensemble"] = evaluate_scores(ens, fwd_w, 1, SESSION_TOP_K, s.min_effective_dates)
    model_dl = day_level(top_k_selection(ens.where(uni), SESSION_TOP_K), ds.fwd_oc.loc[dates], uni, ds.panel)
    rule_dl = day_level(capitulation({k: v.loc[dates] for k, v in ds.flags.items()}), ds.fwd_oc.loc[dates], uni, ds.panel)
    report["backtest"] = {"mean_net_excess": model_dl.mean_net_spread, "t_net_excess": model_dl.t,
                          "n_periods": model_dl.n_days, "avg_turnover": None, **model_dl.summary()}
    report["backtest_periods"] = {str(d.date()): float(v) for d, v in model_dl.daily["net_spread"].items()} \
        if model_dl.n_days else {}
    # the rule as a BOOK: net spread on signal days, cash (0) otherwise
    rule_book = pd.Series(0.0, index=dates)
    if rule_dl.n_days:
        rule_book.loc[rule_dl.daily.index] = rule_dl.daily["net_spread"]
    report["benchmark"] = {"factor": "capitulation_rule", "day_level": rule_dl.summary(),
                           "backtest_periods": {str(d.date()): float(v) for d, v in rule_book.items()}}
    report["corr_score_same_day_return"] = None   # day-d return is a legitimate input here, not a leak tell
    report["oof_dates"] = [str(dates.min().date()), str(dates.max().date())]
    return report


def train_session_model(conn: psycopg.Connection, ds: SessionDataset, register: bool = True):
    s = get_settings()
    factory = lambda: default_members(s.seeds)  # noqa: E731
    uniform = {m.name: 1.0 for m in factory()}
    oof = walk_forward_oof(ds, factory, s.cv_folds, s.train_min_dates)
    report = evaluate_session_oof(ds, oof, uniform)
    final = factory()
    for m in final:
        m.fit(ds.X, ds.y, SESSION_HORIZON)
    ens = combine(oof, uniform)
    rank_pct = ens.groupby(level="date").rank(pct=True)
    exc = (ds.fwd - ds.fwd.groupby(level="date").transform("mean")).reindex(oof.index)
    ok = exc.notna()
    ce = IsotonicRegression(out_of_bounds="clip").fit(rank_pct[ok], exc[ok])
    cp = IsotonicRegression(out_of_bounds="clip", y_min=0, y_max=1).fit(rank_pct[ok], (exc[ok] > 0).astype(float))
    resid = np.sort(np.abs(exc[ok].to_numpy() - ce.predict(rank_pct[ok].to_numpy())))
    bundle = ModelBundle(SESSION_HORIZON, list(ds.X.columns), final, uniform, ce, cp, resid)
    chash = config_hash(final, list(ds.X.columns) + [FEATURE_SET])
    end = ds.dates.max().date()
    model_id = f"s1-{end:%Y%m%d}-{chash}"
    report.update({"config_hash": chash, "n_rows": int(len(ds.X)), "features": list(ds.X.columns)})
    if register:
        path = Path(s.artifacts_dir) / "models" / f"{model_id}.joblib"
        path.parent.mkdir(parents=True, exist_ok=True)
        joblib.dump(bundle, path)
        with conn.cursor() as cur:
            cur.execute("""INSERT INTO alpha.model(model_id, horizon, feature_set, label, params, train_start, train_end,
                                                   cv_report, status, artifact_path)
                           VALUES (%s,%s,%s,%s,%s,%s,%s,%s,'candidate',%s) ON CONFLICT (model_id) DO NOTHING""",
                        (model_id, SESSION_HORIZON, FEATURE_SET, LABEL, Jsonb({"config_hash": chash}),
                         ds.dates.min().date(), end, Jsonb(jsonable(report)), str(path)))
        conn.commit()
    return model_id, report, bundle, oof
