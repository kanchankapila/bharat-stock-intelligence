"""Direction/label/score invariants for unified_ranker (2026-08-10 trading-logic review).

Every test here pins a defect that was live in production, and each is negative-controlled:
reverting the corresponding source change makes exactly the named test fail. These are pure
functions, so no DB, no fixtures.
"""
import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from unified_ranker import (  # noqa: E402
    CONVICTION_TIERS,
    DIRECTIONAL_AGREEMENT_FLOOR,
    FULL_ENGINE_COVERAGE,
    SIZE_CONFIDENCE_FLOOR,
    _classify,
    _conviction,
    _directional_strength,
    size_confidence_multiplier,
)


class TestConvictionIsDirectionAware:
    def test_the_exact_reported_contradiction_is_gone(self):
        """(90,1,2) used to be Sell/S_ELITE while (20,0,2) was Strong Sell/D_MARGINAL --
        the tiers ran backwards on every short.

        MERGED 2026-08-10: the resolution changed but the invariant did not. Screener bias no
        longer sets direction (it measured -0.440%/21d, t=-5.14, and score>=70 with NET
        BEARISH screeners is the best-performing group at +3.015%, t=+3.60 -- a rule that
        required screeners to agree discarded exactly those). So a 90-score name with a
        bearish vote is now a Strong Buy on its score, not a Hold. What still must hold is
        that conviction mirrors the row's OWN direction."""
        strong_short = _classify(20, 0, 2)
        long_call = _classify(90, 1, 2)
        assert strong_short == 'Strong Sell'
        assert long_call == 'Strong Buy'          # screeners do not veto a strong score
        tiers = [t for t, _ in CONVICTION_TIERS]
        # both are strong calls in their own direction -- neither outranks on a bullish scale
        assert tiers.index(_conviction(20, strong_short)) == tiers.index(
            _conviction(90, long_call))

    def test_bearish_strength_is_the_mirror_of_bullish(self):
        assert _conviction(15, 'Strong Sell') == _conviction(85, 'Strong Buy')
        assert _conviction(30, 'Sell') == _conviction(70, 'Buy')

    def test_a_high_scoring_sell_is_never_elite(self):
        # The precise shape of the production bug: score high, direction bearish.
        assert _conviction(95, 'Sell') == 'D_MARGINAL'

    def test_hold_has_no_conviction(self):
        assert _conviction(99, 'Hold') == 'D_MARGINAL'
        assert _directional_strength(99, 'Hold') == 0.0

    def test_classification_argument_is_required(self):
        """No default may exist -- a default silently reinstates the bullish-only reading."""
        with pytest.raises(TypeError):
            _conviction(90)


class TestDirectionNeedsCoverageNotAgreement:
    """MERGED RESOLUTION (2026-08-10) of two changes that each measured half of this.

    Screener DIRECTION was measured HARMFUL (-0.440% 21d excess, t=-5.14; net bias monotone
    the wrong way, rank IC -0.0159), so bull/bear no longer vote on direction. Screener
    COVERAGE was measured to MATTER (unified_score ranks returns within covered names at
    IC +0.0241 t=+2.36 and NOT for uncovered ones, -0.0150 t=-1.51; score>=70 with no
    screener opinion returns -0.066%), so a name no screener has surfaced is not labelled.

    DIRECTIONAL_AGREEMENT_FLOOR's intent -- direction and magnitude must never flatly
    contradict -- now holds STRUCTURALLY and with margin, since a Buy always scores >= 70 and
    a Sell <= 30 against that constant's 45/55. Asserted below rather than deleted."""

    def test_score_sets_direction_even_against_the_screener_vote(self):
        assert _classify(98, 1, 5) == 'Strong Buy'    # bearish vote does not veto
        assert _classify(2, 5, 1) == 'Strong Sell'    # bullish vote does not rescue

    def test_a_vote_alone_cannot_label_a_middling_score(self):
        assert _classify(60, 5, 1) == 'Hold'
        assert _classify(40, 1, 5) == 'Hold'

    def test_agreeing_rows_still_label(self):
        assert _classify(80, 5, 1) == 'Strong Buy'
        assert _classify(20, 1, 5) == 'Strong Sell'

    def test_uncovered_names_are_never_labelled(self):
        """The half PR #61 measured correctly: score does not rank the uncovered population,
        so no score however extreme may label a name zero screeners have surfaced."""
        for score in (0.0, 20.0, 50.0, 90.0, 100.0):
            assert _classify(score, 0, 0) == 'Hold'

    def test_agreement_floor_is_satisfied_structurally(self):
        """Whatever label is produced, its direction cannot contradict its magnitude."""
        f = DIRECTIONAL_AGREEMENT_FLOOR
        for score in range(0, 101, 5):
            for bull, bear in ((5, 1), (1, 5), (3, 3)):
                label = _classify(float(score), bull, bear)
                if label in ('Buy', 'Strong Buy'):
                    assert score >= f, f'{label} at score {score} is below the floor {f}'
                if label in ('Sell', 'Strong Sell'):
                    assert score <= 100.0 - f, f'{label} at score {score} is above the ceiling'


class TestSizeConfidenceMultiplier:
    def test_bounded_and_shrink_only(self):
        for strength in (0, 45, 60, 100):
            for cov in (0, 1, 3, 5, 8):
                m = size_confidence_multiplier(strength, cov)
                assert SIZE_CONFIDENCE_FLOOR <= m <= 1.0

    def test_monotonic_in_strength_and_coverage(self):
        assert (size_confidence_multiplier(60, FULL_ENGINE_COVERAGE)
                < size_confidence_multiplier(90, FULL_ENGINE_COVERAGE))
        assert (size_confidence_multiplier(90, 1)
                < size_confidence_multiplier(90, FULL_ENGINE_COVERAGE))

    def test_thin_coverage_is_haircut(self):
        """A 2-engine blend must not be sized like an 8-engine one at the same score."""
        assert size_confidence_multiplier(90, 2) < size_confidence_multiplier(90, 8)

    def test_full_confidence_is_exactly_one(self):
        assert size_confidence_multiplier(100, FULL_ENGINE_COVERAGE) == pytest.approx(1.0)


if __name__ == '__main__':
    raise SystemExit(pytest.main([__file__, '-q']))
