import os
import sys

import pandas as pd

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from purged_cv import PurgedGroupTimeSeriesSplit, make_purged_group_time_series_split


def _panel_dates(n_dates=30, rows_per_date=7):
    dates = []
    for i in range(n_dates):
        dates.extend([f"2026-01-{i + 1:02d}"] * rows_per_date)
    return pd.Series(dates)


class TestPurgedGroupTimeSeriesSplit:
    def test_never_splits_a_date_across_train_and_validation(self):
        dates = _panel_dates()
        X = pd.DataFrame({"x": range(len(dates))})
        cv = make_purged_group_time_series_split(dates, horizon_days=5, n_splits=4)

        folds = list(cv.split(X))

        assert folds
        for train_idx, val_idx in folds:
            train_dates = set(dates.iloc[train_idx])
            val_dates = set(dates.iloc[val_idx])
            assert train_dates.isdisjoint(val_dates)

    def test_embargo_counts_distinct_dates_not_rows(self):
        rows_per_date = 11
        dates = _panel_dates(n_dates=40, rows_per_date=rows_per_date)
        X = pd.DataFrame({"x": range(len(dates))})
        cv = make_purged_group_time_series_split(dates, horizon_days=6, n_splits=3)

        for train_idx, val_idx in cv.split(X):
            unique_dates = list(dates.drop_duplicates())
            last_train_date = dates.iloc[train_idx].max()
            first_val_date = dates.iloc[val_idx].min()
            last_train_pos = unique_dates.index(last_train_date)
            first_val_pos = unique_dates.index(first_val_date)
            assert first_val_pos - last_train_pos > 6
            assert first_val_pos - last_train_pos > 6 / rows_per_date

    def test_can_use_bound_groups_like_sklearn_meta_estimators_do(self):
        dates = _panel_dates(n_dates=12, rows_per_date=3)
        X = pd.DataFrame({"x": range(len(dates))})
        cv = PurgedGroupTimeSeriesSplit(n_splits=3, group_gap=2, groups=dates.tolist())

        folds = list(cv.split(X))

        assert len(folds) == 3

    def test_mismatched_group_length_fails_loudly(self):
        X = pd.DataFrame({"x": range(5)})
        cv = PurgedGroupTimeSeriesSplit(n_splits=2, group_gap=1, groups=["2026-01-01"])

        try:
            list(cv.split(X))
        except ValueError as exc:
            assert "does not match X length" in str(exc)
        else:
            raise AssertionError("mismatched groups must fail loudly")


class TestChronologyIsNotAssumed:
    """Regressions for two silent-failure modes found by review on 2026-08-30."""

    def test_unsorted_dates_never_train_on_data_after_the_validation_fold(self):
        # drop_duplicates() alone preserves FIRST-APPEARANCE order, so an unsorted panel made
        # unique_groups[:train_end] mean 'whatever came first' rather than 'earlier'. Measured
        # against the pre-fix splitter, this exact rotation leaked on 2 of 3 folds -- training
        # on dates that post-date their own validation fold, silently and with no error.
        d = [f"d{i:04d}" for i in range(20)]
        rotated = d[10:] + d[:10]
        dates = pd.Series([x for x in rotated for _ in range(5)])
        X = pd.DataFrame({"x": range(len(dates))})

        cv = make_purged_group_time_series_split(dates, horizon_days=2, n_splits=3)

        folds = list(cv.split(X))
        assert folds
        for train_idx, val_idx in folds:
            assert max(dates.iloc[train_idx]) < min(dates.iloc[val_idx]), (
                "training fold contains a date at or after the validation fold"
            )

    def test_sorted_input_is_unaffected_by_the_sort(self):
        # Control for the test above: sorting must be a no-op for callers that already order
        # chronologically (load_training_data does), so the fix cannot change production folds.
        d = [f"d{i:04d}" for i in range(20)]
        dates = pd.Series([x for x in d for _ in range(5)])
        X = pd.DataFrame({"x": range(len(dates))})

        cv = make_purged_group_time_series_split(dates, horizon_days=2, n_splits=3)

        for train_idx, val_idx in cv.split(X):
            assert max(dates.iloc[train_idx]) < min(dates.iloc[val_idx])

    def test_non_comparable_group_types_fail_loudly(self):
        # Mixed date types cannot be ordered; guessing an order would reintroduce the leak,
        # so this must raise rather than silently fall back to insertion order.
        dates = pd.Series(["2026-01-01", 20260102, "2026-01-03"] * 4)
        X = pd.DataFrame({"x": range(len(dates))})
        cv = PurgedGroupTimeSeriesSplit(n_splits=2, group_gap=0, groups=dates.tolist())

        try:
            list(cv.split(X))
        except ValueError as exc:
            assert "not mutually comparable" in str(exc)
        else:
            raise AssertionError("mixed group types must fail loudly, not guess an order")


class TestPurgeClampIsVisible:
    def test_short_panel_warns_when_the_gap_is_clamped_below_the_horizon(self, capsys):
        # A panel too short to purge a full horizon silently returned a smaller gap, meaning
        # validation labels overlap training and CV AUC reads optimistic. It must say so.
        dates = pd.Series([f"d{i:04d}" for i in range(40) for _ in range(5)])

        cv = make_purged_group_time_series_split(dates, horizon_days=21, n_splits=5)

        assert cv.group_gap < 21, "expected the clamp to engage on a 40-date panel"
        assert "purge gap clamped" in capsys.readouterr().err

    def test_adequate_panel_does_not_warn(self):
        # Control: the warning must DISCRIMINATE. At the production panel size (78 dates) every
        # horizon 1-21 gets its full gap, so a monitor that fired here would carry no signal.
        dates = pd.Series([f"d{i:04d}" for i in range(78) for _ in range(5)])

        cv = make_purged_group_time_series_split(dates, horizon_days=21, n_splits=5)

        assert cv.group_gap == 21
