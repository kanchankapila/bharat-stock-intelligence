"""High-realized-vol veto (2026-08-10).

Guards the only cross-sectionally significant factor found in 4.5 years of this platform's
own price history: the top realized-vol decile underperformed the universe by -0.949%/month
(t=-3.00) over 67 monthly rebalances. See HIGH_VOL_VETO_PCTILE's comment in unified_ranker.py
for the full measurement and, critically, for why this must read the point-in-time hv_20d and
NOT quant_scores.annualized_vol (253-day window, corr 0.366, REVERSES the sign to t=-2.41).
"""
import math
import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from unified_ranker import (  # noqa: E402
    HIGH_VOL_VETO_MULT,
    HIGH_VOL_VETO_PCTILE,
    high_vol_cutoff,
    veto_classification,
)


class TestHighVolCutoff:
    def test_returns_the_requested_percentile(self):
        vols = list(range(1, 101))          # 1..100
        cut = high_vol_cutoff(vols, pctile=0.80)
        assert cut == 81                    # index int(0.8*100)=80 -> value 81

    def test_none_when_universe_too_thin_to_define_a_percentile(self):
        # Fails OPEN: vetoing off a 10-name cross-section would be noise, not a filter.
        assert high_vol_cutoff([1.0] * 49) is None

    def test_ignores_none_nan_and_nonpositive(self):
        vols = [None, float('nan'), 0.0, -3.0] + [float(i) for i in range(1, 60)]
        cut = high_vol_cutoff(vols, pctile=0.80)
        assert cut is not None and math.isfinite(cut)
        # only the 59 clean positives should have counted
        assert cut == float(sorted(range(1, 60))[int(0.80 * 59)])

    def test_cutoff_is_cross_sectional_not_absolute(self):
        """A calm tape and a wild tape must yield different cutoffs from the same percentile.

        This is the property that stops the veto from nuking the entire buy pool in a
        HIGH_VOL regime and vetoing nobody in a quiet one.
        """
        calm = high_vol_cutoff([float(i) / 10 for i in range(1, 101)], pctile=0.80)
        wild = high_vol_cutoff([float(i) * 10 for i in range(1, 101)], pctile=0.80)
        assert wild > calm * 50

    def test_default_percentile_is_the_validated_one(self):
        # Pinned: the 4.5-year test measured the top decile/quintile, not an arbitrary cut.
        assert HIGH_VOL_VETO_PCTILE == 0.80
        assert 0 < HIGH_VOL_VETO_MULT < 1


class TestVetoApplication:
    """Mirrors the run() wiring: cutoff -> compare -> veto_classification + score demotion."""

    @staticmethod
    def _apply(classification, score, sym_vol, hv_cut):
        if hv_cut is not None and sym_vol is not None and sym_vol >= hv_cut:
            return veto_classification(classification), score * HIGH_VOL_VETO_MULT
        return classification, score

    def test_high_vol_buy_is_demoted_to_hold_and_score_cut(self):
        cls, score = self._apply('Strong Buy', 90.0, sym_vol=60.0, hv_cut=50.0)
        assert cls == 'Hold'
        assert score < 90.0

    def test_low_vol_buy_survives_untouched(self):
        cls, score = self._apply('Buy', 80.0, sym_vol=20.0, hv_cut=50.0)
        assert cls == 'Buy'
        assert score == 80.0

    def test_missing_vol_fails_open(self):
        """No hv_20d row must never silently remove a name from the buy pool."""
        cls, score = self._apply('Strong Buy', 90.0, sym_vol=None, hv_cut=50.0)
        assert cls == 'Strong Buy'
        assert score == 90.0

    def test_inactive_cutoff_fails_open(self):
        cls, score = self._apply('Buy', 80.0, sym_vol=999.0, hv_cut=None)
        assert cls == 'Buy'
        assert score == 80.0

    def test_sell_side_is_not_touched(self):
        """The veto removes names from the BUY pool only -- it is not a directional signal."""
        for c in ('Sell', 'Strong Sell', 'Hold'):
            cls, _ = self._apply(c, 20.0, sym_vol=60.0, hv_cut=50.0)
            assert cls == c

    def test_boundary_is_inclusive(self):
        cls, _ = self._apply('Buy', 80.0, sym_vol=50.0, hv_cut=50.0)
        assert cls == 'Hold'


class TestGetterUsesPortableSqlAndTheRightColumn:
    """Two mistakes this veto is specifically exposed to, pinned by source inspection.

    Both are cheap to reintroduce and neither would fail loudly: DISTINCT ON silently breaks
    only on the SQLite fallback, and swapping in annualized_vol silently inverts the edge.
    """

    @staticmethod
    def _src():
        p = os.path.join(os.path.dirname(__file__), '..', 'unified_ranker.py')
        with open(p, encoding='utf-8') as fh:
            return fh.read()

    @classmethod
    def _getter_code(cls):
        """_get_realized_vol's body with comment lines stripped.

        Comments must be excluded or these assertions fire on the very comment that documents
        why the anti-pattern is banned -- which is exactly what happened when this test was
        first written.
        """
        src = cls._src()
        body = src[src.index('def _get_realized_vol'):src.index('def _get_cs_scores')]
        return '\n'.join(ln for ln in body.splitlines() if not ln.strip().startswith('#'))

    def test_reads_hv_20d_not_annualized_vol(self):
        code = self._getter_code()
        assert 'hv_20d' in code
        assert 'annualized_vol' not in code, (
            'annualized_vol is a 253-day window (corr 0.366 with 21d realized vol) and '
            'REVERSES this veto to t=-2.41. Must stay on the point-in-time hv_20d.'
        )

    def test_uses_row_number_not_distinct_on(self):
        code = self._getter_code()
        assert 'ROW_NUMBER()' in code
        assert 'DISTINCT ON' not in code, 'DISTINCT ON is Postgres-only; breaks SQLite fallback.'

    def test_veto_is_wired_into_the_scoring_loop(self):
        src = self._src()
        assert '_get_realized_vol()' in src
        assert 'high_vol_cutoff(' in src
        assert 'HIGH_VOL_VETO_MULT' in src.split('def run')[-1] or 'HIGH_VOL_VETO_MULT' in src




# ── Zero-dispersion engine guard ────────────────────────────────────────────────
from unified_ranker import (  # noqa: E402
    ZERO_DISPERSION_MIN_SYMBOLS,
    drop_zero_dispersion_engines,
    _blend,
)


class TestDropZeroDispersionEngines:
    def test_drops_a_fully_constant_engine(self):
        n = ZERO_DISPERSION_MIN_SYMBOLS + 10
        maps = {'ml': {f'S{i}': 59.89 for i in range(n)},
                'screener': {f'S{i}': float(i) for i in range(n)}}
        kept, dropped = drop_zero_dispersion_engines(maps)
        assert dropped == ['ml']
        assert set(kept) == {'screener'}

    def test_keeps_an_engine_with_any_real_spread(self):
        n = ZERO_DISPERSION_MIN_SYMBOLS + 10
        vals = {f'S{i}': 50.0 for i in range(n)}
        vals['S0'] = 50.5                       # one symbol differs -> still informative
        kept, dropped = drop_zero_dispersion_engines({'ml': vals})
        assert dropped == []
        assert 'ml' in kept

    def test_thin_coverage_is_not_treated_as_a_dead_engine(self):
        """A flat map over 5 symbols is sparse coverage, not a collapsed model."""
        maps = {'smart_money': {f'S{i}': 70.0 for i in range(5)}}
        kept, dropped = drop_zero_dispersion_engines(maps)
        assert dropped == []
        assert 'smart_money' in kept

    def test_empty_engine_passes_through(self):
        kept, dropped = drop_zero_dispersion_engines({'dl': {}})
        assert dropped == []

    def test_dropping_redistributes_weight_rather_than_deflating_the_score(self):
        """The point of the fix: removing a constant must not drag every score down."""
        weights = {'screener': 0.32, 'ml': 0.144}
        scores = {'screener': 80.0, 'ml': 59.89}
        with_ml = _blend(scores, {'screener', 'ml'}, weights)
        without = _blend(scores, {'screener'}, weights)
        assert without == pytest.approx(80.0)       # pure screener, fully renormalized
        assert with_ml < without                    # the constant was dragging it down

    def test_removes_the_coverage_dependent_offset(self):
        """The real defect: a constant shifts scores DIFFERENTLY per coverage group.

        Two symbols with identical screener scores but different engine coverage must not
        end up ranked apart purely because a constant engine's renormalized share differs.
        """
        weights = {'screener': 0.32, 'ml': 0.144, 'dl': 0.072}
        s = {'screener': 80.0, 'ml': 59.89, 'dl': 80.0}
        broad = _blend(s, {'screener', 'ml', 'dl'}, weights)
        narrow = _blend(s, {'screener', 'ml'}, weights)
        assert broad != pytest.approx(narrow)       # constant injects a coverage artefact
        # with ml dropped, both coverage groups agree again
        assert _blend(s, {'screener', 'dl'}, weights) == pytest.approx(
            _blend(s, {'screener'}, weights))

    def test_wired_into_run(self):
        p = os.path.join(os.path.dirname(__file__), '..', 'unified_ranker.py')
        with open(p, encoding='utf-8') as fh:
            src = fh.read()
        assert 'drop_zero_dispersion_engines(engine_maps)' in src



class TestDroppedEngineStillReports:
    """Regression: the first live run of the dispersion guard crashed with KeyError: 'ml'.

    engine_scores was being built from the POST-drop map, so `engine_scores['ml']` in the
    output-row dict exploded the moment ml collapsed. The blend and the reporting view must
    come from different maps.
    """

    def test_run_builds_engine_scores_from_the_full_map(self):
        p = os.path.join(os.path.dirname(__file__), '..', 'unified_ranker.py')
        with open(p, encoding='utf-8') as fh:
            src = fh.read()
        assert 'engine_maps_all = engine_maps' in src
        assert 'engine_scores = {e: m.get(sym, 0.0) for e, m in engine_maps_all.items()}' in src, (
            "engine_scores must be built from engine_maps_all (pre-drop) or a dropped engine "
            "KeyErrors on engine_scores['ml'] in the output row."
        )

    def test_reporting_columns_use_has_data_not_present(self):
        p = os.path.join(os.path.dirname(__file__), '..', 'unified_ranker.py')
        with open(p, encoding='utf-8') as fh:
            src = fh.read()
        for eng in ('cs', 'breakout', 'smart_money'):
            assert f"if '{eng}' in has_data" in src, (
                f"{eng}_score must report on has_data; using `present` would NULL the column "
                "for a dropped engine and hide the collapse in the table you'd debug from."
            )

    def test_simulated_drop_does_not_keyerror(self):
        """Directly reproduces the crash shape against the real helper."""
        n = ZERO_DISPERSION_MIN_SYMBOLS + 5
        all_maps = {'ml': {f'S{i}': 59.89 for i in range(n)},
                    'screener': {f'S{i}': float(i) for i in range(n)}}
        blend_maps, dropped = drop_zero_dispersion_engines(all_maps)
        assert dropped == ['ml']
        sym = 'S3'
        engine_scores = {e: m.get(sym, 0.0) for e, m in all_maps.items()}   # reporting view
        present = {e for e, m in blend_maps.items() if sym in m}            # blend view
        assert engine_scores['ml'] == 59.89     # would have raised KeyError pre-fix
        assert 'ml' not in present              # but excluded from the blend


if __name__ == '__main__':
    raise SystemExit(pytest.main([__file__, '-q']))
