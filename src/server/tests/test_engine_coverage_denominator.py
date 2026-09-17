"""FULL_ENGINE_COVERAGE must equal the number of engines that can actually contribute.

AF-20260916-08's fix narrowed `present` (the coverage count feeding
size_confidence_multiplier) from "engines with a row" to "engines with a row AND a
nonzero weight in the active regime". Only 4 of the 8 engines carry nonzero weight in
any regime (screener/cs/dl/smart_money are all pinned to 0.0), so after that change
coverage can never exceed 4 -- while the denominator was left at 5.

Measured live on the 2026-09-17 grid (1,893 rows): 1,698 of them (89.7%) carry all four
active engines, so they capped at c = 4/5 = 0.80 and a multiplier of 0.900 where they
should reach 1.000. Mean size multiplier across the book fell 9.6% with no one intending
a sizing change and no measurement recorded -- the "restricting a universe upstream
re-tunes every absolute threshold downstream" class from recurring-bugs.md.

Deriving the constant from REGIME_WEIGHTS rather than hardcoding it means re-enabling a
paused engine (dl is paused, not retired) cannot silently reintroduce the same skew.
"""
import sys, pathlib
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

from unified_ranker import (
    FULL_ENGINE_COVERAGE, REGIME_WEIGHTS, SIZE_CONFIDENCE_FLOOR,
    size_confidence_multiplier,
)


def _active(regime: str) -> int:
    return sum(1 for w in REGIME_WEIGHTS[regime].values() if w > 0.0)


def test_denominator_matches_the_contributing_engine_count():
    counts = {r: _active(r) for r in REGIME_WEIGHTS}
    assert FULL_ENGINE_COVERAGE == max(counts.values()), (
        f"FULL_ENGINE_COVERAGE={FULL_ENGINE_COVERAGE} but nonzero-weight engines per "
        f"regime are {counts} -- a symbol carrying every engine that can contribute "
        f"would never reach full coverage"
    )


def test_a_fully_covered_symbol_reaches_multiplier_one():
    """Negative control: with the denominator at 5 this returns 0.9, not 1.0."""
    full = max(_active(r) for r in REGIME_WEIGHTS)
    assert size_confidence_multiplier(100.0, full) == 1.0


def test_multiplier_still_shrinks_for_partial_coverage():
    """Non-vacuity: the shrink must still bite below full coverage."""
    full = max(_active(r) for r in REGIME_WEIGHTS)
    assert size_confidence_multiplier(100.0, 1) < size_confidence_multiplier(100.0, full)
    assert size_confidence_multiplier(100.0, 0) == SIZE_CONFIDENCE_FLOOR


def test_no_regime_can_exceed_the_denominator():
    for r in REGIME_WEIGHTS:
        assert _active(r) <= FULL_ENGINE_COVERAGE
