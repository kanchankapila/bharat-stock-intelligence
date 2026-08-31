"""Date-grouped purged walk-forward splitters for panel time-series ML.

Rows in this codebase are usually a (symbol, date) panel.  A row-count gap can
split a trading day in half; this splitter always treats the date as the unit of
time and excludes a configurable number of whole date groups before validation.
"""
from __future__ import annotations

import math
import sys
from dataclasses import dataclass
from typing import Iterable, Iterator, Sequence

import numpy as np
import pandas as pd


@dataclass
class PurgedGroupTimeSeriesSplit:
    """Expanding-window CV with validation folds made of whole date groups.

    Parameters
    ----------
    n_splits:
        Number of validation folds.
    group_gap:
        Number of distinct groups/dates to exclude immediately before each
        validation fold.  For H-day forward labels this should normally be H.
    groups:
        Optional date/group vector bound to the splitter.  Binding is useful for
        sklearn meta-estimators such as CalibratedClassifierCV, which call
        ``cv.split(X, y)`` without forwarding a ``groups=`` argument.
    min_train_groups:
        Minimum number of date groups required in a training fold.
    """

    n_splits: int = 5
    group_gap: int = 0
    groups: Sequence | None = None
    min_train_groups: int = 1

    def __post_init__(self) -> None:
        self.n_splits = int(self.n_splits)
        self.group_gap = max(0, int(self.group_gap))
        self.min_train_groups = max(1, int(self.min_train_groups))
        if self.n_splits < 2:
            raise ValueError("n_splits must be at least 2")

    def get_n_splits(self, X=None, y=None, groups=None) -> int:
        return self.n_splits

    def split(self, X, y=None, groups: Iterable | None = None) -> Iterator[tuple[np.ndarray, np.ndarray]]:
        group_values = self._resolve_groups(X, groups)
        # SORTED, not insertion-ordered. drop_duplicates() alone preserves first-appearance
        # order, which silently makes every downstream slice wrong when the caller hands over
        # an unsorted panel: unique_groups[:train_end] is treated as 'before' and
        # unique_groups[test_start:test_end] as 'after', so on a rotated 20-date panel 2 of 3
        # folds trained on dates that POST-DATE their own validation fold -- the exact leak this
        # class exists to prevent, with no error raised (measured 2026-08-30 before this fix).
        # Production callers do sort (load_training_data orders by signal_date ASC, and
        # _fit_stack's docstring states the assumption), so this was not live leakage -- but it
        # was an unguarded contract in the one module whose whole purpose is temporal ordering,
        # and any future caller passing a regime subset or a groupby result reintroduces it
        # invisibly. Sorting is a no-op on already-chronological input, so this costs nothing
        # and removes the assumption entirely.
        _uniq = pd.Series(group_values).dropna().drop_duplicates()
        try:
            unique_groups = list(_uniq.sort_values())
        except TypeError as exc:  # mixed date types cannot be ordered -- fail loudly, never guess
            raise ValueError(
                'PurgedGroupTimeSeriesSplit: group/date values are not mutually comparable '
                f'({exc}); pass a single consistent date type.'
            ) from exc
        n_groups = len(unique_groups)
        if n_groups <= self.n_splits:
            raise ValueError(
                f"Cannot make {self.n_splits} splits from only {n_groups} distinct groups"
            )

        indices_by_group: dict[object, list[int]] = {}
        for idx, group in enumerate(group_values):
            if pd.isna(group):
                continue
            indices_by_group.setdefault(group, []).append(idx)

        test_group_size = max(1, n_groups // (self.n_splits + 1))
        for split_no in range(self.n_splits):
            test_start = n_groups - (self.n_splits - split_no) * test_group_size
            test_end = n_groups - (self.n_splits - split_no - 1) * test_group_size
            train_end = max(0, test_start - self.group_gap)
            if train_end < self.min_train_groups:
                continue

            train_groups = unique_groups[:train_end]
            test_groups = unique_groups[test_start:test_end]
            train_idx = self._indices_for_groups(indices_by_group, train_groups)
            test_idx = self._indices_for_groups(indices_by_group, test_groups)
            if len(train_idx) == 0 or len(test_idx) == 0:
                continue
            yield train_idx, test_idx

    def _resolve_groups(self, X, groups: Iterable | None) -> list:
        source = groups if groups is not None else self.groups
        if source is None:
            raise ValueError("PurgedGroupTimeSeriesSplit requires groups/dates")
        out = list(source)
        if len(out) != len(X):
            raise ValueError(f"groups length {len(out)} does not match X length {len(X)}")
        return out

    @staticmethod
    def _indices_for_groups(indices_by_group: dict[object, list[int]], groups: Sequence) -> np.ndarray:
        return np.asarray(
            [idx for group in groups for idx in indices_by_group.get(group, [])],
            dtype=int,
        )


def feasible_n_splits(n_groups: int, requested: int = 5, min_splits: int = 2) -> int:
    """Return a conservative split count for a number of distinct time groups."""
    n_groups = int(n_groups)
    if n_groups <= min_splits:
        return min_splits
    return max(min_splits, min(int(requested), n_groups - 1))


def make_purged_group_time_series_split(
    dates: Sequence,
    horizon_days: int,
    n_splits: int = 5,
    min_train_groups: int = 1,
) -> PurgedGroupTimeSeriesSplit:
    """Build a bound date-grouped splitter for H-day forward labels."""
    date_series = pd.Series(list(dates)).reset_index(drop=True)
    n_groups = int(date_series.dropna().nunique())
    requested = feasible_n_splits(n_groups, requested=n_splits)
    desired_gap = max(0, int(math.ceil(horizon_days)))
    splits = requested
    for candidate in range(requested, 1, -1):
        test_group_size = max(1, n_groups // (candidate + 1))
        first_test_start = n_groups - candidate * test_group_size
        if first_test_start - desired_gap >= min_train_groups:
            splits = candidate
            break
    else:
        splits = 2

    test_group_size = max(1, n_groups // (splits + 1))
    first_test_start = n_groups - splits * test_group_size
    gap = min(desired_gap, max(0, first_test_start - min_train_groups))
    if gap < desired_gap:
        # The panel is too short to purge a full horizon even at the minimum split count, so
        # the gap is being clamped below the label horizon -- i.e. some validation rows overlap
        # training labels. That is a real (if bounded) leak, and it used to happen silently.
        # Measured 2026-08-30: at the production panel size (78 dates) every horizon 1-21 gets
        # its full gap, so this does not fire today; at 40 dates a 21-day horizon clamps to 13.
        # Warn rather than raise: a degraded split is still better than no CV at all, but it
        # must not be invisible -- stderr, because the subprocess wrapper only inspects stderr
        # (recurring-bugs.md, 'degraded-read print() to stdout').
        print(
            f'[PurgedCV] WARNING: only {n_groups} distinct dates -- purge gap clamped to {gap} '
            f'of the {desired_gap} required by the label horizon. Validation labels overlap '
            f'training by up to {desired_gap - gap} day(s); CV AUC is optimistic.',
            file=sys.stderr,
        )
    return PurgedGroupTimeSeriesSplit(
        n_splits=splits,
        group_gap=gap,
        groups=date_series.tolist(),
        min_train_groups=min_train_groups,
    )
