"""Ensemble members. Each maps a feature frame to a per-row score; only the per-date ORDER of
scores is used downstream, so members on different scales combine cleanly."""
from __future__ import annotations

from dataclasses import dataclass, field

import lightgbm as lgb
import numpy as np
import pandas as pd
from sklearn.linear_model import Ridge

from bharat_alpha.modeling.cv import inner_split

LGB_BASE = dict(
    learning_rate=0.03, num_leaves=31, max_depth=-1, min_child_samples=200, subsample=0.7, subsample_freq=1,
    colsample_bytree=0.7, reg_lambda=5.0, n_estimators=600, verbose=-1,
)


def _lgb(**kw) -> dict:
    from bharat_alpha.config import get_settings

    return {**LGB_BASE, "n_jobs": get_settings().model_threads, **kw}


def _dates(X: pd.DataFrame) -> pd.Index:
    return X.index.get_level_values("date")


def recency_weights(X: pd.DataFrame) -> np.ndarray:
    """Exponential decay by age within the training window: newer regimes (including the most
    recent graded mistakes) count more, older ones still count."""
    from bharat_alpha.config import get_settings

    d = pd.DatetimeIndex(_dates(X))
    age = (d.max() - d).days.to_numpy(dtype=float)
    return 0.5 ** (age / get_settings().recency_halflife_days)


@dataclass
class LgbmRegressorMember:
    name: str = "lgbm_reg"
    seeds: tuple[int, ...] = (11, 23, 47)
    params: dict = field(default_factory=dict)
    models: list = field(default_factory=list)

    def fit(self, X: pd.DataFrame, y: pd.Series, horizon: int) -> "LgbmRegressorMember":
        tr_d, va_d = inner_split(pd.DatetimeIndex(sorted(_dates(X).unique())), horizon)
        tr, va = _dates(X).isin(tr_d), _dates(X).isin(va_d)
        self.models = []
        for s in self.seeds:
            m = lgb.LGBMRegressor(**_lgb(**self.params, random_state=s))
            w = recency_weights(X)
            m.fit(X[tr], y[tr], sample_weight=w[np.asarray(tr)], eval_set=[(X[va], y[va])],
                  callbacks=[lgb.early_stopping(50, verbose=False)])
            # refit on the full window at the chosen size so the most recent data is used
            best = max(int(m.best_iteration_ or LGB_BASE["n_estimators"]), 20)
            full = lgb.LGBMRegressor(**_lgb(**{**self.params, "random_state": s, "n_estimators": best}))
            full.fit(X, y, sample_weight=w)
            self.models.append(full)
        return self

    def predict(self, X: pd.DataFrame) -> np.ndarray:
        return np.mean([m.predict(X) for m in self.models], axis=0)


@dataclass
class LgbmRankerMember:
    name: str = "lgbm_rank"
    seeds: tuple[int, ...] = (11, 23, 47)
    params: dict = field(default_factory=dict)
    models: list = field(default_factory=list)
    n_grades: int = 5

    def _grades(self, X: pd.DataFrame, y: pd.Series) -> np.ndarray:
        g = y.groupby(level="date").transform(
            lambda s: pd.qcut(s.rank(method="first"), self.n_grades, labels=False) if len(s) >= self.n_grades else 0)
        return g.fillna(0).astype(int).to_numpy()

    @staticmethod
    def _groups(X: pd.DataFrame) -> np.ndarray:
        d = _dates(X)
        return pd.Series(1, index=d).groupby(level=0, sort=False).size().to_numpy()

    def fit(self, X: pd.DataFrame, y: pd.Series, horizon: int) -> "LgbmRankerMember":
        X = X.sort_index(level="date")
        y = y.reindex(X.index)
        tr_d, va_d = inner_split(pd.DatetimeIndex(sorted(_dates(X).unique())), horizon)
        tr, va = _dates(X).isin(tr_d), _dates(X).isin(va_d)
        grades = self._grades(X, y)
        self.models = []
        for s in self.seeds:
            kw = _lgb(**{**self.params, "random_state": s, "objective": "lambdarank",
                         "lambdarank_truncation_level": 30})
            m = lgb.LGBMRanker(**kw)
            m.fit(X[tr], grades[tr], group=self._groups(X[tr]), eval_set=[(X[va], grades[va])],
                  eval_group=[self._groups(X[va])], eval_at=[20],
                  callbacks=[lgb.early_stopping(50, verbose=False)])
            best = max(int(m.best_iteration_ or LGB_BASE["n_estimators"]), 20)
            full = lgb.LGBMRanker(**{**kw, "n_estimators": best})
            full.fit(X, grades, group=self._groups(X))
            self.models.append(full)
        return self

    def predict(self, X: pd.DataFrame) -> np.ndarray:
        return np.mean([m.predict(X) for m in self.models], axis=0)


@dataclass
class RidgeMember:
    """Linear baseline on rank-Gaussian features. Missing = cross-sectional median (0)."""
    name: str = "ridge"
    alpha: float = 50.0
    model: Ridge | None = None
    cols: list[str] = field(default_factory=list)

    def fit(self, X: pd.DataFrame, y: pd.Series, horizon: int) -> "RidgeMember":
        self.cols = list(X.columns)
        self.model = Ridge(alpha=self.alpha).fit(X.fillna(0.0).to_numpy(), y.to_numpy(), sample_weight=recency_weights(X))
        return self

    def predict(self, X: pd.DataFrame) -> np.ndarray:
        return self.model.predict(X[self.cols].fillna(0.0).to_numpy())


def default_members(seeds: tuple[int, ...]) -> list:
    return [LgbmRegressorMember(seeds=seeds), LgbmRankerMember(seeds=seeds), RidgeMember()]


def per_date_rank_gauss(scores: pd.Series) -> pd.Series:
    from scipy.special import ndtri

    r = scores.groupby(level="date").rank(method="average")
    n = scores.groupby(level="date").transform("count")
    return pd.Series(ndtri(((r - 0.5) / n).clip(1e-6, 1 - 1e-6)), index=scores.index)


def combine(member_scores: pd.DataFrame, weights: dict[str, float]) -> pd.Series:
    z = member_scores.apply(per_date_rank_gauss)
    w = pd.Series(weights).reindex(z.columns).fillna(0.0)
    w = w / w.sum() if w.sum() > 0 else pd.Series(1.0 / len(z.columns), index=z.columns)
    return z.mul(w, axis=1).sum(axis=1)
