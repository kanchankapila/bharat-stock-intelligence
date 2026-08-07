"""Findings #27/#28/#30 (2026-07-28 audit): sector-concentration cap on position sizing and
the factor-crowding discount. Pure-function tests, no DB required."""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from unified_ranker import (
    normalize_position_sizes,
    factor_crowding_multiplier,
    cluster_by_correlation,
    apply_correlation_cap,
    MAX_SECTOR_EXPOSURE,
    MAX_POSITION,
    MAX_CORRELATION_CLUSTER_EXPOSURE,
    CORRELATION_CLUSTER_THRESHOLD,
    CORRELATION_MIN_OVERLAP,
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


def _make_returns(n_days=25, start=0):
    """A trading-day-keyed return series 'd0'..'d{n-1}' (start offsets the date labels so two
    series can share only a partial overlap window)."""
    return {f'd{start + i}': 0.0 for i in range(n_days)}


class TestClusterByCorrelation:
    """Findings #27/#30 follow-up (2026-08-05): empirical stock-return correlation clustering,
    the covariance-aware fuller fix the sector cap's own comment flags as still needed. Pure
    function, no DB — mirrors this file's existing convention for the sector cap above."""

    def test_two_perfectly_correlated_series_cluster_together(self):
        dates = [f'd{i}' for i in range(CORRELATION_MIN_OVERLAP)]
        base = [0.01 * (i % 5 - 2) for i in range(len(dates))]   # some variance, not constant
        returns = {
            'A': dict(zip(dates, base)),
            'B': dict(zip(dates, base)),   # identical series -> correlation exactly 1.0
        }
        clusters = cluster_by_correlation(returns)
        assert clusters.get('A') is not None
        assert clusters['A'] == clusters['B']

    def test_uncorrelated_series_not_clustered(self):
        dates = [f'd{i}' for i in range(CORRELATION_MIN_OVERLAP)]
        a = [0.01 * (i % 5 - 2) for i in range(len(dates))]
        b = [-x for x in a]   # perfectly anti-correlated, not >= +threshold
        returns = {'A': dict(zip(dates, a)), 'B': dict(zip(dates, b))}
        clusters = cluster_by_correlation(returns)
        assert 'A' not in clusters and 'B' not in clusters

    def test_insufficient_overlap_excluded_even_if_correlated(self):
        """A recently-listed name or one coming off a long halt can have too little shared
        history to trust a correlation estimate on — must be left OUT of every cluster
        (apply_correlation_cap then leaves it untouched) rather than force-grouped on noise."""
        dates = [f'd{i}' for i in range(CORRELATION_MIN_OVERLAP - 1)]   # one short of the floor
        base = [0.01 * (i % 5 - 2) for i in range(len(dates))]
        returns = {'A': dict(zip(dates, base)), 'B': dict(zip(dates, base))}
        clusters = cluster_by_correlation(returns)
        assert clusters == {}

    def test_transitive_grouping_via_union_find(self):
        """A correlated with B, B correlated with C (but A/C not directly compared above
        threshold in this fixture) -- all three must land in the SAME cluster, not two
        separate pairs, since they share real common risk through B."""
        dates = [f'd{i}' for i in range(CORRELATION_MIN_OVERLAP)]
        a = [0.01 * (i % 5 - 2) for i in range(len(dates))]
        b = list(a)          # identical to a
        c = [x * 0.9 for x in b]   # scaled copy of b -> still corr 1.0 with b (and thus a)
        returns = {'A': dict(zip(dates, a)), 'B': dict(zip(dates, b)), 'C': dict(zip(dates, c))}
        clusters = cluster_by_correlation(returns)
        assert clusters['A'] == clusters['B'] == clusters['C']

    def test_singleton_with_no_correlated_peer_is_omitted(self):
        dates = [f'd{i}' for i in range(CORRELATION_MIN_OVERLAP)]
        a = [0.01 * (i % 5 - 2) for i in range(len(dates))]
        b = [-x for x in a]
        c = [0.01 * ((2 * i) % 7 - 3) for i in range(len(dates))]   # a 3rd, unrelated pattern
        returns = {'A': dict(zip(dates, a)), 'B': dict(zip(dates, b)), 'C': dict(zip(dates, c))}
        clusters = cluster_by_correlation(returns)
        assert 'C' not in clusters   # no peer clears threshold with C

    def test_dates_are_matched_by_key_not_list_position(self):
        """Two symbols missing DIFFERENT trading days (holiday for a recent listing, a circuit
        lock) must be compared only on their shared dates -- comparing by list position would
        silently pair the wrong days and produce a spurious correlation."""
        common = [f'd{i}' for i in range(CORRELATION_MIN_OVERLAP)]
        base = [0.01 * (i % 5 - 2) for i in range(len(common))]
        returns_a = dict(zip(common, base))
        # B has the same values on the common dates but also carries 3 extra distractor
        # dates with wildly different (uncorrelated) values -- if the implementation aligned
        # by position instead of by date key, the extra entries would corrupt the comparison.
        returns_b = dict(zip(common, base))
        returns_b['extra1'] = 999.0
        returns_b['extra2'] = -999.0
        returns_b['extra3'] = 0.0001
        clusters = cluster_by_correlation({'A': returns_a, 'B': returns_b})
        assert clusters.get('A') == clusters.get('B')

    def test_zero_variance_series_never_crashes_and_is_not_clustered(self):
        """A circuit-locked stretch (identical close every day) has zero variance -- Pearson
        correlation is mathematically undefined (0/0), not an error; must degrade to 'not
        clustered', never raise."""
        dates = [f'd{i}' for i in range(CORRELATION_MIN_OVERLAP)]
        flat = {d: 0.0 for d in dates}
        varying = {d: 0.01 * (i % 5 - 2) for i, d in enumerate(dates)}
        clusters = cluster_by_correlation({'A': flat, 'B': varying})
        assert clusters == {}


class TestApplyCorrelationCap:
    def test_no_clusters_is_a_noop(self):
        weights = {'A': 0.1, 'B': 0.1}
        assert apply_correlation_cap(weights, {}) == {'A': 0.1, 'B': 0.1}

    def test_cluster_over_cap_is_scaled_down_to_exactly_cap(self):
        weights = {'A': 0.2, 'B': 0.2, 'C': 0.2}   # 0.6 total, well over the 0.35 default cap
        clusters = {'A': 0, 'B': 0, 'C': 0}
        out = apply_correlation_cap(weights, clusters)
        # output is per-symbol rounded to 4dp (see apply_correlation_cap), so the summed total
        # can be a few units of 1e-4 off the exact cap -- not a bug, a display-precision artifact.
        assert abs(sum(out.values()) - MAX_CORRELATION_CLUSTER_EXPOSURE) < 1e-3

    def test_symbol_not_in_clusters_map_is_left_untouched(self):
        weights = {'A': 0.2, 'B': 0.2, 'Z': 0.25}   # Z has no correlated peer
        clusters = {'A': 0, 'B': 0}   # Z deliberately absent
        out = apply_correlation_cap(weights, clusters)
        assert out['Z'] == 0.25   # untouched even though A+B+Z together would exceed the cap

    def test_cluster_under_cap_is_unchanged(self):
        weights = {'A': 0.05, 'B': 0.05}
        clusters = {'A': 0, 'B': 0}
        out = apply_correlation_cap(weights, clusters)
        assert out == {'A': 0.05, 'B': 0.05}

    def test_multiple_independent_clusters_each_capped_separately(self):
        weights = {'A': 0.25, 'B': 0.25, 'X': 0.25, 'Y': 0.25}
        clusters = {'A': 0, 'B': 0, 'X': 1, 'Y': 1}
        out = apply_correlation_cap(weights, clusters)
        assert out['A'] + out['B'] == MAX_CORRELATION_CLUSTER_EXPOSURE
        assert out['X'] + out['Y'] == MAX_CORRELATION_CLUSTER_EXPOSURE

    def test_never_increases_a_weight(self):
        weights = {'A': 0.05, 'B': 0.05, 'C': 0.5}
        clusters = {'A': 0, 'B': 0, 'C': 0}
        out = apply_correlation_cap(weights, clusters)
        for sym in weights:
            assert out[sym] <= weights[sym] + 1e-9
