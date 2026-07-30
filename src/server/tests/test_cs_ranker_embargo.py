"""Finding #20 (2026-07-28 audit): cs_ranker.py's train/test split must embargo the
HORIZON_DAYS_LABEL trading dates immediately before the test window, since cs_percentile
is a 5-day-forward label and a zero-gap split lets training rows near the boundary overlap
the test period's own dates."""
import sys
import os

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from cs_ranker import _compute_date_split, HORIZON_DAYS_LABEL


def _dates(n):
    return [f"2026-{(1 + d // 28):02d}-{(1 + d % 28):02d}" for d in range(n)]


class TestComputeDateSplit:
    def test_train_and_test_are_disjoint(self):
        dates_sorted = _dates(100)
        train_dates, test_dates = _compute_date_split(dates_sorted)
        assert train_dates.isdisjoint(test_dates)

    def test_embargo_zone_excluded_from_both(self):
        dates_sorted = _dates(100)
        train_dates, test_dates = _compute_date_split(dates_sorted)
        n_test_dates = max(1, int(len(dates_sorted) * 0.20))
        test_start_idx = len(dates_sorted) - n_test_dates
        embargo_dates = set(dates_sorted[max(0, test_start_idx - HORIZON_DAYS_LABEL):test_start_idx])
        assert embargo_dates.isdisjoint(train_dates)
        assert embargo_dates.isdisjoint(test_dates)
        assert len(embargo_dates) == HORIZON_DAYS_LABEL

    def test_last_train_date_is_at_least_horizon_before_first_test_date(self):
        dates_sorted = _dates(100)
        train_dates, test_dates = _compute_date_split(dates_sorted)
        last_train_idx = dates_sorted.index(max(train_dates))
        first_test_idx = dates_sorted.index(min(test_dates))
        assert (first_test_idx - last_train_idx) > HORIZON_DAYS_LABEL

    def test_no_holdout_still_produces_something_reasonable_on_tiny_input(self):
        dates_sorted = _dates(5)
        train_dates, test_dates = _compute_date_split(dates_sorted)
        # Even with barely any dates, the function must not crash and must not put a date
        # in both sets.
        assert train_dates.isdisjoint(test_dates)
