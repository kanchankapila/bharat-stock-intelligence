"""factor_edge.py must not stamp USABLE on a panel that cannot support the estimate.

Measured live 2026-09-12 against factor_edge_history: of 895 current readings, 24 read USABLE.
Every one of those 24 failed at least one of two panel preconditions the harness never checked.

1. CROSS-SECTIONAL WIDTH. `pledge_chg_qoq`/`pledge_pct` read rank_IC +0.19 / AUC 0.605 on a
   universe of 26 SYMBOLS. `min_per_date` defaults to 10, so a 26-name panel sails through it.
   A rank IC across 26 names is not a cross-sectional factor reading, and factor_backtest.py --
   this repo's own arbiter -- forms top-50 portfolios, which that universe cannot fill.

2. OVERLAPPING FORWARD WINDOWS. `mf_big_fund_flow` read AUC 0.6203 on "33 dates" at h=21.
   Consecutive dates share 20 of their 21 forward days, so those 33 dates carry ~33/21 = 1.6
   INDEPENDENT observations, not 33. MIN_DATES_RELIABLE=20 was applied to the raw count, so the
   reading cleared a reliability bar it missed by more than a factor of ten. This is exactly why
   the same column reads AUC 0.4682 at h=10 and 0.6203 at h=21: the h=21 panel is noise with
   fewer effective points, not a longer-horizon signal.

Under the corrected count, 1 of those 24 survives -- `movement_probability`, which
ml-model-bugs.md already documents as a train/serve-skew artifact (AUC 0.894). So no legitimate
USABLE reading has ever been produced by this harness.

Negative control is the third test: a genuinely wide, genuinely long panel must STILL read
USABLE, or the guard is just a mute button (recurring-bugs.md: "a gate firing on ~100% of its
population carries zero information" -- an earlier draft of this guard keyed on within-symbol
variance and flagged 159 of ~165 columns, which is that defect).
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import factor_edge as fe


def test_narrow_cross_section_is_not_usable():
    """26 symbols cannot produce a cross-sectional verdict, however good the numbers look."""
    vd = fe._verdict(mic=0.1915, auc=0.6051, dates=45, symbols=26, horizon=21)
    assert vd != "USABLE", (
        f"a 26-symbol panel read {vd!r}; pledge_chg_qoq's real 2026-09-11 reading"
    )


def test_overlapping_windows_do_not_count_as_independent_dates():
    """33 daily dates at h=21 is ~1.6 independent observations, not 33."""
    vd = fe._verdict(mic=0.1877, auc=0.6203, dates=33, symbols=1005, horizon=21)
    assert vd != "USABLE", (
        f"33 dates at h=21 read {vd!r}; that is 1.6 independent periods "
        f"against MIN_DATES_RELIABLE={fe.MIN_DATES_RELIABLE}"
    )
    assert fe._effective_dates(33, 21) < 2.0


def test_a_genuinely_powered_panel_still_reads_usable():
    """Non-vacuity control: the guard must not swallow a real result.

    500 daily dates at h=5 is 100 independent periods across 200 names -- if this reads
    anything but USABLE the guard has stopped discriminating and is a mute button.
    """
    vd = fe._verdict(mic=0.08, auc=0.58, dates=500, symbols=200, horizon=5)
    assert vd == "USABLE", f"a well-powered panel read {vd!r}"


def test_raw_date_count_alone_no_longer_clears_the_bar():
    """The exact shape of the bug: enough raw dates, nowhere near enough independent ones."""
    powered = fe._verdict(mic=0.08, auc=0.58, dates=500, symbols=200, horizon=5)
    same_dates_long_horizon = fe._verdict(mic=0.08, auc=0.58, dates=25, symbols=200, horizon=21)
    assert powered == "USABLE"
    assert same_dates_long_horizon == "LOW-DATA"
