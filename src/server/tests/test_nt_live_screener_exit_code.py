"""A NiftyTrader live-screener run that captures NOTHING must not exit 0.

AF-20260918-01. `niftytrader_live_screener_job.py` already exits non-zero when the bearer token
is MISSING, with a comment citing `recurring-bugs.md`'s skip-path-stamped-as-success class. The
other half of that same path was unguarded: a token that is PRESENT but no longer entitled makes
every filter return 401 through `fetch_single_filter`'s `(name, [], "unauthorized ...")` branch,
which is an ordinary "failed filter" rather than a missing token. All 45 then land in
`failed_filters`, nothing is written, and the job returned normally and exited 0 -- so the step
recorded success over an empty capture.

Measured live 2026-09-18: `Screener/live-market-filter-data` answers **401** to the exact
production header set (origin + sec-fetch-site: same-origin + content-type + platform_type) with
a JWT still valid until 2026-10-05, while its sibling `advance-eod-screener-filter` answers
**200 / 453KB / 1,032 rows** with the identical headers. The route is Prime-gated, so what would
lapse is the entitlement, not the token -- which is exactly the case the missing-token guard
cannot see.

The bar is "did anything land", not a fail RATE: a filter legitimately matching no stocks is
normal, and failing on that would be the always-fires defect (`ml-model-bugs.md`). A healthy run
writes ~450k rows/day across 45 filters.
"""
import os
import pathlib
import re
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

SRC = pathlib.Path(__file__).resolve().parents[1] / "niftytrader_live_screener_job.py"


def _source() -> str:
    return SRC.read_text(encoding="utf-8", errors="replace")


def test_zero_rows_with_failures_exits_non_zero():
    """The guard must exist and must key on rows-written, not on the failure count alone."""
    src = _source()
    assert "failed_filters and total_written == 0" in src, (
        "the zero-capture guard is gone: a run where every filter fails now writes nothing and "
        "still exits 0, so the step records success over an empty capture (AF-20260918-01)"
    )
    # The guard must actually exit, not just log.
    guard_at = src.index("failed_filters and total_written == 0")
    assert "sys.exit(1)" in src[guard_at:guard_at + 800], (
        "the zero-capture branch logs but does not exit non-zero"
    )


def test_guard_is_not_a_blanket_fail_on_any_failure():
    """Negative control on the GUARD itself: partial failures must still exit 0.

    A bar of `if failed_filters:` would fire on every ordinary run (filters routinely match no
    stocks) -- the always-fires defect. Assert the condition is conjoined with a rows-written
    test rather than standing alone.
    """
    src = _source()
    bare = re.search(r"^\s*if failed_filters:\s*$", src, re.M)
    assert bare is not None, "expected the summary block to still branch on failed_filters"
    # ...but that bare branch must only LOG. The exit must be the conjoined one.
    tail = src[bare.end():bare.end() + 400]
    assert "sys.exit" not in tail, (
        "the bare `if failed_filters:` branch now exits -- that fires on any partial failure, "
        "which is the always-fires defect this guard was written to avoid"
    )


def test_failure_summary_goes_to_stderr_not_stdout():
    """pythonRunner.ts classifies a step from stderr only; stdout is invisible to it."""
    src = _source()
    block = re.search(r'print\("\[NT_LIVE\] Failed filters:".*?\n(.*?\n){0,3}', src, re.S)
    assert block is not None, "failed-filter summary block not found"
    assert 'print("[NT_LIVE] Failed filters:", file=sys.stderr)' in src, (
        "the failed-filter summary prints to stdout, where pythonRunner's stderr-only "
        "classifier cannot see it (recurring-bugs.md, degraded-read print() to stdout)"
    )
    assert 'print(f"  - {fname}: {err}", file=sys.stderr)' in src, (
        "per-filter failure lines still go to stdout"
    )


def test_missing_token_path_still_exits_non_zero():
    """Non-vacuity: the pre-existing half of this guard must not have been traded away."""
    src = _source()
    assert "No bearer token available" in src
    idx = src.index("No bearer token available")
    assert "sys.exit(1)" in src[idx:idx + 400], (
        "the missing-token path no longer exits non-zero"
    )


def test_outside_market_hours_is_still_a_clean_skip():
    """Outside market hours there is genuinely nothing to capture -- that must stay exit 0.

    This is the case the zero-capture guard must NOT catch: it returns before any filter runs,
    so `failed_filters` is empty and the conjoined condition is False by construction.
    """
    src = _source()
    idx = src.index("Outside market hours")
    window = src[idx:idx + 200]
    assert "return" in window, "the market-hours skip should return, not exit"
    assert "sys.exit" not in window, (
        "the market-hours skip now exits non-zero -- a closed market is not a failure"
    )
