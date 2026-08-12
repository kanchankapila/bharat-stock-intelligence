"""_z_within (industry-relative construction, 2026-08-12).

Synthetic only -- these pin the helper's semantics, not returns, so they must not touch the
production DB. Negative-controlled: reverting each guard fails the named test.
"""
import os
import sys

import numpy as np
import pandas as pd

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

import factor_backtest as fb  # noqa: E402


def _s(vals):
    return pd.Series(vals, dtype=float)


class TestZWithin:
    def test_demeans_within_sector_not_across_the_whole_date(self):
        """The whole point: a structurally expensive sector must not be penalised wholesale.

        Sector B's raw values are all far below sector A's. A plain cross-sectional z would
        rank every A name above every B name. Within-sector, the best name in each sector
        must score identically -- that is what 'industry-relative' means.
        """
        vals = _s([10, 11, 12, 13, 14, 1, 2, 3, 4, 5])
        sec = pd.Series(['A'] * 5 + ['B'] * 5)
        z = fb._z_within(vals, sec)
        assert np.isclose(z.iloc[4], z.iloc[9])        # top of A == top of B
        assert np.isclose(z.iloc[0], z.iloc[5])        # bottom of A == bottom of B
        # and each sector is individually centred
        assert np.isclose(z[sec == 'A'].mean(), 0.0, atol=1e-9)
        assert np.isclose(z[sec == 'B'].mean(), 0.0, atol=1e-9)

    def test_thin_sector_scores_nan_not_zero(self):
        """A 2-name sector yields +-0.707 regardless of the data -- pure noise at full weight.

        NaN drops those names from selection; 0 would be a real middle-of-the-pack score and
        would silently rank them above every genuinely cheap name with a negative z.
        """
        vals = _s([10, 11, 12, 13, 14, 1, 2])
        sec = pd.Series(['A'] * 5 + ['THIN'] * 2)
        z = fb._z_within(vals, sec)
        assert z[sec == 'THIN'].isna().all()
        assert z[sec == 'A'].notna().all()

    def test_unmapped_sector_is_excluded_rather_than_pooled(self):
        """NaN sector must not become its own implicit peer group."""
        vals = _s([10, 11, 12, 13, 14, 99, 98])
        sec = pd.Series(['A'] * 5 + [np.nan, np.nan])
        z = fb._z_within(vals, sec)
        assert z.iloc[5:].isna().all()

    def test_nan_values_do_not_poison_their_sector(self):
        """One missing B/P must not NaN out the other four names in the sector."""
        vals = _s([10, 11, np.nan, 13, 14, 15])
        sec = pd.Series(['A'] * 6)
        z = fb._z_within(vals, sec)
        assert np.isnan(z.iloc[2])
        assert z.drop(index=2).notna().all()
        # mean/std computed off the 5 finite values only
        finite = vals.dropna()
        assert np.isclose(z.iloc[0], (10 - finite.mean()) / finite.std())

    def test_zero_variance_sector_scores_nan_not_a_divide_by_zero(self):
        vals = _s([7, 7, 7, 7, 7, 1, 2, 3, 4, 5])
        sec = pd.Series(['FLAT'] * 5 + ['B'] * 5)
        z = fb._z_within(vals, sec)
        assert z[sec == 'FLAT'].isna().all()
        assert z[sec == 'B'].notna().all()

    def test_index_is_preserved_so_it_aligns_with_the_panel_slice(self):
        """run_backtest does cur.assign(_s=score_fn(cur)) -- a reset index would misalign
        every score with the wrong symbol and silently score the wrong stocks."""
        idx = [17, 3, 99, 42, 8, 61]
        vals = pd.Series([1.0, 2, 3, 4, 5, 6], index=idx)
        sec = pd.Series(['A'] * 6, index=idx)
        z = fb._z_within(vals, sec)
        assert list(z.index) == idx


class TestRegistration:
    def test_all_four_preregistered_factors_are_registered(self):
        for f in ('value_book_to_price_sn', 'value_earnings_yield_sn',
                  'value_composite_sn', 'momentum_12_1_sn'):
            assert f in fb.FACTORS

    def test_sector_neutral_factors_actually_differ_from_their_raw_parents(self):
        """Guards against the helper degrading to a plain cross-sectional z -- which would
        make every 'sector-neutral' result a silent duplicate of the already-tested raw one."""
        d = pd.DataFrame({
            'book_to_price': [10.0, 11, 12, 13, 14, 1, 2, 3, 4, 5],
            'sector': ['A'] * 5 + ['B'] * 5,
        })
        sn = fb.FACTORS['value_book_to_price_sn'](d)
        raw = d['book_to_price']
        assert not np.allclose(sn.rank().values, raw.rank().values)
