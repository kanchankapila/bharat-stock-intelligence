"""Regression test for Finding #51 (2026-07-28 full-stack audit): _compute_max_pain() had
call/put OI swapped -- call writers lose (settlement > strike) was weighted by PUT oi, and
put writers lose (settlement < strike) was weighted by CALL oi, the opposite of a standard
max-pain calculation. Every index_max_pain row for Nifty/BankNifty reported the strike
computed from the wrong OI side.

Both cases below were verified empirically (a standalone reimplementation of both the
correct and pre-fix/buggy formula) to produce DIFFERENT max-pain strikes for the same
input -- not just "a plausible-looking number" -- so these tests would have failed against
the pre-fix code, not merely passed by coincidence.
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from mc_index_oi_fetcher import _compute_max_pain


class TestMaxPainCallPutOrientation:
    def test_pure_call_wall_picks_the_leftmost_zero_loss_settlement(self):
        """A single strike with only CALL OI (no PUT OI anywhere): under the CORRECT
        formula, call-writer loss is zero for any settlement <= 100 (the wall), so the
        leftmost such settlement (50) wins the tie. Under the pre-fix swapped formula,
        that same real ce_oi gets multiplied into the "settlement < strike" (put-shaped)
        term instead, shifting the zero-loss plateau to settlements >= 100, so 100 -- not
        50 -- would win. Verified by direct calculation: correct=50, buggy=100."""
        rows = [
            {"strike": 50,  "ce_oi": 0,       "pe_oi": 0},
            {"strike": 100, "ce_oi": 1000000, "pe_oi": 0},
            {"strike": 150, "ce_oi": 0,       "pe_oi": 0},
        ]
        assert _compute_max_pain(rows) == 50

    def test_pure_put_wall_picks_the_wall_strike_itself(self):
        """Mirror of the call-wall case: a single strike with only PUT OI. Correct formula:
        put-writer loss is zero for any settlement >= 100, and 100 is both the wall's own
        strike and the first candidate (in ascending iteration order) satisfying that, so
        it wins the tie outright. Verified by direct calculation: correct=100, buggy=50 --
        the pre-fix code would have picked the wrong side of the wall entirely."""
        rows = [
            {"strike": 50,  "ce_oi": 0, "pe_oi": 0},
            {"strike": 100, "ce_oi": 0, "pe_oi": 1000000},
            {"strike": 150, "ce_oi": 0, "pe_oi": 0},
        ]
        assert _compute_max_pain(rows) == 100

    def test_no_strikes_returns_none(self):
        assert _compute_max_pain([]) is None
