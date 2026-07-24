"""
Enforces the single most important anti-look-ahead-bias rule for this codebase: every
"give me the most recent snapshot row as of a target date" join goes through the shared
as_of_join_sql()/read_as_of_history() helpers in src/server/as_of.py -- never a second,
independently hand-rolled implementation. "Mostly as-of, one exception" is exactly the leak
class that has bitten this codebase before (see docs/NEW_SYSTEM_MASTER_PROMPT_INPLACE.md).

fundamentals_snapshot.py is explicitly excluded: its own `as_of_date = (SELECT MAX(...))`
self-join has no `<= target_date` bound at all -- it is the snapshot *writer's* own
dedup/lookback logic (grabbing a symbol's single latest snapshot row, or a 90-day-back
snapshot for delta computation), not a "read this table as of an external target date"
consumer join. Excluding it here is a documented decision, not an oversight.
"""
import re
from pathlib import Path

import pytest

SERVER_DIR = Path(__file__).resolve().parent.parent

# The correlated-subquery shape every real consumer join used to hand-roll:
#   ... as_of_date = (SELECT MAX(...) ...)
HAND_ROLLED_PATTERN = re.compile(r"as_of_date\s*=\s*\(\s*SELECT\s+MAX\b", re.IGNORECASE)

EXCLUDED_FILES = {
    "as_of.py",           # the helper itself (pattern appears in its own docstring)
    "fundamentals_snapshot.py",  # snapshot writer's own dedup self-join, different semantics
}


def _python_files():
    for path in SERVER_DIR.glob("*.py"):
        if path.name in EXCLUDED_FILES:
            continue
        yield path


def test_no_hand_rolled_as_of_joins_outside_helper():
    offenders = []
    for path in _python_files():
        text = path.read_text(encoding="utf-8", errors="ignore")
        if HAND_ROLLED_PATTERN.search(text):
            offenders.append(path.name)
    assert not offenders, (
        "Found a hand-rolled 'as_of_date = (SELECT MAX ...)' join outside as_of.py: "
        f"{offenders}. Use as_of_join_sql()/read_as_of_history() from src/server/as_of.py "
        "instead of re-implementing the point-in-time join."
    )


def test_lint_pattern_actually_detects_a_reintroduced_hand_rolled_join(tmp_path):
    """Sanity-check the detector itself: a deliberately reintroduced hand-rolled join in a
    throwaway file must be caught, so the test above isn't a false negative."""
    bad_file = tmp_path / "would_be_offender.py"
    bad_file.write_text(
        "q = f'''\n"
        "    LEFT JOIN fundamentals_history fh\n"
        "           ON fh.symbol = so.symbol\n"
        "          AND fh.as_of_date = (\n"
        "              SELECT MAX(fh2.as_of_date) FROM fundamentals_history fh2\n"
        "              WHERE fh2.symbol = so.symbol AND fh2.as_of_date <= so.signal_date\n"
        "          )\n"
        "'''\n"
    )
    assert HAND_ROLLED_PATTERN.search(bad_file.read_text())


def test_excluded_files_still_exist():
    """If fundamentals_snapshot.py is ever renamed/removed, this should fail loudly rather
    than silently stop excluding a file that no longer exists (or silently start excluding
    nothing useful)."""
    for name in EXCLUDED_FILES:
        if name == "as_of.py":
            assert (SERVER_DIR / name).exists()
        else:
            # fundamentals_snapshot.py is expected to exist; if it's gone, the exclusion
            # entry is dead weight and should be removed from EXCLUDED_FILES.
            assert (SERVER_DIR / name).exists(), (
                f"{name} no longer exists -- remove it from EXCLUDED_FILES in this test."
            )
