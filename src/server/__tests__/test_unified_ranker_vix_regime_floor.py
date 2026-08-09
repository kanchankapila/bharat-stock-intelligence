"""Tests for UnifiedRanker._effective_regime_for_weights (2026-08-09 live audit).

regime_detector.py's HIGH_VOL/CRASH names are assigned purely by relative rank among whichever
5 clusters a given retrain discovers -- live-confirmed this session, HIGH_VOL was assigned to an
8-day window with real India VIX 12.16-13.27, the platform's own bottom quartile of VIX history
(median~14.0, p75~17.2 over 1170 rows). Since REGIME_WEIGHTS/regime_cat_weights key purely off
the string name, that silently applied "reduce risk" weight tilts to a genuinely calm market.
This is a downstream safety net on the WEIGHT-SELECTION consumption of the label, not a fix to
regime_detector.py's labeling itself.
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from unified_ranker import UnifiedRanker


class _FakeConn:
    def __init__(self, vix=None):
        self._vix = vix

    def execute(self, sql, params=()):
        return self

    def fetchone(self):
        if self._vix is None:
            return None
        return {"close": self._vix}


class TestEffectiveRegimeForWeights:
    def test_high_vol_downgraded_when_vix_below_median_floor(self):
        r = UnifiedRanker(conn=_FakeConn(vix=12.16))
        assert r._effective_regime_for_weights("HIGH_VOL") == "SIDEWAYS"

    def test_high_vol_kept_when_vix_genuinely_elevated(self):
        r = UnifiedRanker(conn=_FakeConn(vix=18.5))
        assert r._effective_regime_for_weights("HIGH_VOL") == "HIGH_VOL"

    def test_high_vol_kept_exactly_at_floor(self):
        r = UnifiedRanker(conn=_FakeConn(vix=UnifiedRanker._HIGH_VOL_VIX_FLOOR))
        assert r._effective_regime_for_weights("HIGH_VOL") == "HIGH_VOL"

    def test_crash_downgraded_when_vix_below_p75_floor(self):
        r = UnifiedRanker(conn=_FakeConn(vix=14.0))
        assert r._effective_regime_for_weights("CRASH") == "BEAR"

    def test_crash_kept_when_vix_genuinely_extreme(self):
        r = UnifiedRanker(conn=_FakeConn(vix=28.0))
        assert r._effective_regime_for_weights("CRASH") == "CRASH"

    def test_bull_sideways_bear_never_touched(self):
        r = UnifiedRanker(conn=_FakeConn(vix=9.0))
        for regime in ("BULL", "SIDEWAYS", "BEAR"):
            assert r._effective_regime_for_weights(regime) == regime

    def test_missing_vix_data_trusts_the_label(self):
        r = UnifiedRanker(conn=_FakeConn(vix=None))
        assert r._effective_regime_for_weights("HIGH_VOL") == "HIGH_VOL"
        assert r._effective_regime_for_weights("CRASH") == "CRASH"

    def test_query_failure_trusts_the_label(self):
        class _BrokenConn:
            def execute(self, sql, params=()):
                raise RuntimeError("no macro_asset_prices table")

        r = UnifiedRanker(conn=_BrokenConn())
        assert r._effective_regime_for_weights("HIGH_VOL") == "HIGH_VOL"
