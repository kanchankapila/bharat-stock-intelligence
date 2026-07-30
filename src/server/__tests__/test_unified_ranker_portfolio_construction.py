"""Findings #27/#28/#30 (2026-07-28 audit): sector-concentration cap on position sizing and
the factor-crowding discount. Pure-function tests, no DB required."""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from unified_ranker import (
    normalize_position_sizes,
    factor_crowding_multiplier,
    MAX_SECTOR_EXPOSURE,
    MAX_POSITION,
    FACTOR_CROWDING_THRESHOLD,
    FACTOR_CROWDING_DISCOUNT,
)


class TestSectorExposureCap:
    def test_no_sectors_passed_is_unchanged_behavior(self):
        raw = {'A': 1.0, 'B': 1.0}
        assert normalize_position_sizes(raw) == normalize_position_sizes(raw, sectors=None)

    def test_single_sector_capped_at_sector_cap(self):
        # 5 equally-sized IT names would each hit MAX_POSITION (10%) = 50% of the book —
        # all in one sector. Must be scaled down to MAX_SECTOR_EXPOSURE (30%) in aggregate.
        raw = {f'IT{i}': 1.0 for i in range(5)}
        sectors = {f'IT{i}': 'IT Services' for i in range(5)}
        sizes = normalize_position_sizes(raw, sectors=sectors)
        assert sum(sizes.values()) <= MAX_SECTOR_EXPOSURE + 1e-6

    def test_diversified_sectors_not_capped(self):
        raw = {'A': 1.0, 'B': 1.0, 'C': 1.0}
        sectors = {'A': 'IT', 'B': 'Banking', 'C': 'Pharma'}
        sizes = normalize_position_sizes(raw, sectors=sectors)
        uncapped = normalize_position_sizes(raw)
        assert sizes == uncapped  # no sector exceeds its own cap, so nothing scales

    def test_per_name_cap_still_applies_independently(self):
        raw = {'A': 100.0, 'B': 1.0}
        sectors = {'A': 'IT', 'B': 'Banking'}
        sizes = normalize_position_sizes(raw, sectors=sectors)
        assert sizes['A'] <= MAX_POSITION + 1e-6

    def test_only_positive_positions_count_toward_sector_total(self):
        raw = {'A': 1.0, 'B': 0.0, 'C': -1.0}
        sectors = {'A': 'IT', 'B': 'IT', 'C': 'IT'}
        sizes = normalize_position_sizes(raw, sectors=sectors)
        assert sizes['B'] == 0.0 and sizes['C'] == 0.0


class TestFactorCrowdingDiscount:
    def test_no_data_no_discount(self):
        mult, factor = factor_crowding_multiplier({})
        assert mult == 1.0 and factor is None

    def test_pure_neutral_scores_no_discount(self):
        mult, factor = factor_crowding_multiplier({
            'mf_quality_score': 50, 'mf_momentum_score': 50, 'mf_value_score': 50,
            'mf_risk_adj_score': 50, 'mf_macro_score': 50,
        })
        assert mult == 1.0 and factor is None

    def test_single_dominant_factor_triggers_discount(self):
        # Momentum maxed out, everything else neutral — should dominate and trigger discount.
        mult, factor = factor_crowding_multiplier({
            'mf_quality_score': 50, 'mf_momentum_score': 100, 'mf_value_score': 50,
            'mf_risk_adj_score': 50, 'mf_macro_score': 50,
        })
        assert mult == FACTOR_CROWDING_DISCOUNT
        assert factor == 'mf_momentum_score'

    def test_genuinely_diversified_high_score_no_discount(self):
        # High across the board but no single factor dominates the deviation-from-neutral.
        mult, factor = factor_crowding_multiplier({
            'mf_quality_score': 85, 'mf_momentum_score': 85, 'mf_value_score': 85,
            'mf_risk_adj_score': 85, 'mf_macro_score': 85,
        })
        assert mult == 1.0 and factor is None

    def test_two_factors_one_dominant_still_discounted(self):
        mult, factor = factor_crowding_multiplier({
            'mf_quality_score': 50, 'mf_momentum_score': 100, 'mf_value_score': 60,
            'mf_risk_adj_score': 50, 'mf_macro_score': 50,
        })
        assert mult == FACTOR_CROWDING_DISCOUNT
        assert factor == 'mf_momentum_score'
