"""Purged walk-forward splits, grouped by DATE.

Never by row position (legacy's DL "walk-forward" sliced a symbol-major panel by row and
tested on the same calendar dates it trained on — 100% date overlap, AUC 0.65 that was pure
leakage). Never an integer `cv=` to sklearn (silently StratifiedKFold, shuffles time).

Purge: a training decision date t is usable for a test block starting at T0 only if its
label was fully realised by T0, i.e. pos(t) + 1 + horizon <= pos(T0). That is exactly what
the live system would have known on T0, so walk-forward OOF == what live would have done.
"""
from __future__ import annotations

from dataclasses import dataclass

import pandas as pd


@dataclass(frozen=True)
class Fold:
    train: pd.DatetimeIndex
    test: pd.DatetimeIndex


def walk_forward_folds(dates: pd.DatetimeIndex, n_folds: int, horizon: int, min_train: int) -> list[Fold]:
    dates = pd.DatetimeIndex(sorted(set(dates)))
    n = len(dates)
    if n < min_train + horizon + 1 + n_folds:
        raise ValueError(f"{n} dates is too few for min_train={min_train}, {n_folds} folds, h={horizon}")
    first_test = min_train + horizon + 1
    edges = [first_test + round(i * (n - first_test) / n_folds) for i in range(n_folds + 1)]
    folds = []
    for a, b in zip(edges[:-1], edges[1:]):
        if b <= a:
            continue
        train_end = a - horizon - 1               # last usable train position (inclusive)
        folds.append(Fold(dates[: train_end + 1], dates[a:b]))
    return folds


def inner_split(train_dates: pd.DatetimeIndex, horizon: int, frac: float = 0.2) -> tuple[pd.DatetimeIndex, pd.DatetimeIndex]:
    """Time-ordered, purged validation split INSIDE a training window (for early stopping),
    so the outer test block is never used to choose the number of trees."""
    n = len(train_dates)
    v0 = int(n * (1 - frac))
    return train_dates[: max(v0 - horizon - 1, 1)], train_dates[v0:]
