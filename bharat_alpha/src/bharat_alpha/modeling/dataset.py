"""Training/evaluation dataset: point-in-time features joined to forward labels."""
from __future__ import annotations

import datetime as dt
from dataclasses import dataclass

import pandas as pd
import psycopg

from bharat_alpha.config import get_settings
from bharat_alpha.features import FeatureFrame, build_features
from bharat_alpha.labels import Labels, forward_returns, rank_gauss_target
from bharat_alpha.marketdata import Panel, load_panel


@dataclass
class Dataset:
    horizon: int
    X: pd.DataFrame                 # index (date, instrument_id)
    y: pd.Series                    # rank-gauss target of winsorised forward return
    fwd: pd.Series                  # winsorised forward return
    excess: pd.Series               # fwd minus per-date universe mean
    features: FeatureFrame
    labels: Labels
    panel: Panel

    @property
    def dates(self) -> pd.DatetimeIndex:
        return pd.DatetimeIndex(self.X.index.get_level_values("date").unique()).sort_values()


def build_dataset(conn: psycopg.Connection, start: dt.date, end: dt.date, horizon: int) -> Dataset:
    s = get_settings()
    p = load_panel(conn, start, end)
    ff = build_features(conn, p)
    lab = forward_returns(p, horizon, s.winsor_pct)
    target = rank_gauss_target(lab.fwd_w, ff.universe)
    exc = lab.excess(ff.universe, "mean")

    def long(w: pd.DataFrame) -> pd.Series:
        x = w.stack(future_stack=True)
        x.index.names = ["date", "instrument_id"]
        return x

    y = long(target).reindex(ff.data.index)
    keep = y.notna()
    X = ff.data[keep]
    return Dataset(horizon, X[ff.columns], y[keep], long(lab.fwd_w).reindex(X.index), long(exc).reindex(X.index),
                   ff, lab, p)
