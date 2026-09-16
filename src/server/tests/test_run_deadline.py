"""Time-boxing for resumable fetcher slices.

cap_to_run_budget() caps a slice by REQUEST COUNT, which is the right constraint for
Trendlyne's WAF allowance (a per-session count, not a rate). Nothing enforced the separate
JOB budget, though: trendlyne-catchup's 110-request slice is sized for ~2-4 min against a
10-minute runPython budget, and that budget is deliberately below the 20-minute cadence so two
catch-up runs can never overlap and double-spend the shared allowance. So the budget cannot
simply be raised. When upstream slows to ~6s/request the slice overruns and the run is KILLED
mid-slice -- 5 kills in 30 days, the most frequent timeout on the platform.

A deadline lets the loop stop cleanly and let the next scheduled run resume from the DB, which
is what cap_to_run_budget's own docstring already calls normal ("a partial run here is normal,
not a failure"). Monotonic on purpose: a wall-clock jump must not extend or collapse the window.
"""
import time
import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
from fetch_utils import run_deadline, past_deadline


def test_a_fresh_deadline_has_not_passed():
    assert past_deadline(run_deadline(60)) is False


def test_a_zero_second_deadline_is_immediately_past():
    assert past_deadline(run_deadline(0)) is True


def test_none_means_no_deadline_so_the_loop_is_never_cut_short():
    # Callers that do not opt in must behave exactly as before.
    assert past_deadline(None) is False


def test_deadline_is_monotonic_not_wall_clock():
    # A deadline built on time.time() would move if the system clock were adjusted mid-run.
    before = time.monotonic()
    d = run_deadline(30)
    assert before + 29 <= d <= time.monotonic() + 31
