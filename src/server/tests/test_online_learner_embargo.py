"""Finding #21 (2026-07-28 audit): online_learner.py's 80/20 val split gates
register_update()'s is_active decision (per Finding #17's promotion gate) and previously had
zero gap for the outcome horizon."""
import sys
import os

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from online_learner import _embargoed_train_end


class TestEmbargoedTrainEnd:
    def test_shrinks_train_end_below_val_start(self):
        val_start = 800
        train_end = _embargoed_train_end(n_rows=1000, n_dates=50, med_horizon=15, val_start=val_start)
        assert train_end < val_start

    def test_never_goes_below_floor_of_5(self):
        train_end = _embargoed_train_end(n_rows=10, n_dates=1, med_horizon=15, val_start=8)
        assert train_end >= 5

    def test_larger_horizon_embargoes_more_rows(self):
        val_start = 800
        train_end_small_h = _embargoed_train_end(n_rows=1000, n_dates=50, med_horizon=1, val_start=val_start)
        train_end_large_h = _embargoed_train_end(n_rows=1000, n_dates=50, med_horizon=30, val_start=val_start)
        assert train_end_large_h <= train_end_small_h

    def test_embargo_capped_at_ten_percent_of_rows(self):
        # A huge med_horizon shouldn't be able to embargo more than n_rows//10.
        val_start = 800
        train_end = _embargoed_train_end(n_rows=1000, n_dates=2, med_horizon=1000, val_start=val_start)
        assert train_end >= val_start - 100  # n_rows // 10 == 100
