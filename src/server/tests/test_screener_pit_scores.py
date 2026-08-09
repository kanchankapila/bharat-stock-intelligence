"""Point-in-time screener scoring (screener_performance.phase_f_pit).

The defect: screener_performance_v2.bayesian_score is ONE current, full-sample value per
screener, computed from realized forward returns (screener_appearances.return_20d /
outcome_20d). screener_features_fetcher.py uses it as the WEIGHT in
screener_momentum_score, which lands in technical_signals and feeds ml_ensemble.py and
unified_ranker.py's screener block. Applying a full-sample score to a historical feature row
means the row embeds knowledge of how the screener performed AFTER that date -- a leak no
purged CV, embargo or holdout can detect, because it is identical in train and test.
"""
import datetime
import os
import sqlite3
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

import screener_performance as sp


DEFAULT_SOURCE = 'trendlyne'  # matches this file's screener_master inserts elsewhere


class FakeConn:
    """Minimal ConnWrapper stand-in over sqlite3 (the module only needs execute/commit)."""

    def __init__(self):
        self._c = sqlite3.connect(':memory:')
        self._c.execute("""
            CREATE TABLE screener_appearances (
                screener_id TEXT, source TEXT, symbol TEXT, appeared_date TEXT,
                return_20d REAL, nifty_ret_20d REAL, outcome_20d TEXT
            )""")
        # 2026-08-04: compute_pit_scores now sign-adjusts a bearish screener's return (see
        # _sign_for_sentiment). Empty here -- every screener_id in this file (GOOD/BAD/etc.) is
        # untagged, which defaults to sign=+1, i.e. unchanged behavior for these tests.
        self._c.execute("CREATE TABLE screener_master (scan_id TEXT, source TEXT, inferred_sentiment TEXT)")

    def execute(self, sql, params=()):
        # the production SQL uses `appeared_date::text`; sqlite has no cast syntax
        return self._c.execute(sql.replace('::text', ''), params)

    def commit(self):
        self._c.commit()

    def close(self):
        self._c.close()


def _add(conn, screener_id, appeared, ret20, outcome='WIN', nifty=0.0, source=DEFAULT_SOURCE):
    conn.execute(
        "INSERT INTO screener_appearances "
        "(screener_id, source, symbol, appeared_date, return_20d, nifty_ret_20d, outcome_20d) "
        "VALUES (?,?,?,?,?,?,?)",
        (screener_id, source, 'SYM', appeared, ret20, nifty, outcome))
    conn.commit()


def _key(screener_id, source=DEFAULT_SOURCE):
    """compute_pit_scores (2026-08-06, source-scoped) keys its output by (source, screener_id),
    matching screener_appearances' own (source, screener_id) key and the live
    screener_performance_history PK migration -- MC/ETnow independently issue overlapping
    scan_ids, confirmed live (scan_id 173 is both ETnow's and MoneyControl's)."""
    return (source, screener_id)


@pytest.fixture
def conn():
    c = FakeConn()
    yield c
    c.close()


class TestResolutionLag:
    def test_lag_covers_twenty_trading_days(self):
        """20 trading days is ~28 calendar days; the cutoff must not be shorter."""
        assert sp.RESOLUTION_LAG_DAYS >= 28

    def test_future_appearances_are_excluded(self, conn):
        """An appearance whose 20d outcome could not yet be observed must not score."""
        as_of = '2026-07-01'
        # appeared 5 days before as_of -> its 20-day outcome is still in the future
        _add(conn, 'S1', '2026-06-26', 10.0)
        assert sp.compute_pit_scores(conn, as_of) == {}

    def test_resolved_appearances_are_included(self, conn):
        as_of = '2026-07-01'
        _add(conn, 'S1', '2026-05-01', 10.0)      # long resolved
        scores = sp.compute_pit_scores(conn, as_of)
        assert _key('S1') in scores
        assert scores[_key('S1')]['resolved_count'] == 1


class TestNoLookAhead:
    def test_score_does_not_change_when_the_future_is_appended(self, conn):
        """THE regression test: adding outcomes that resolve AFTER as_of must not move the
        score computed at as_of. Under the old full-sample bayesian_score it always did."""
        as_of = '2026-06-01'
        for i in range(12):
            _add(conn, 'S1', f'2026-04-{i+1:02d}', 5.0, 'WIN')
        before = sp.compute_pit_scores(conn, as_of)[_key('S1')]['bayesian_score']

        # a run of later losses -- known only after as_of
        for i in range(12):
            _add(conn, 'S1', f'2026-06-{i+10:02d}', -8.0, 'LOSS')
        after = sp.compute_pit_scores(conn, as_of)[_key('S1')]['bayesian_score']

        assert before == after, "future outcomes leaked into a point-in-time score"

    def test_later_as_of_does_see_the_new_outcomes(self, conn):
        """Sanity check the test above isn't passing because the filter drops everything."""
        for i in range(12):
            _add(conn, 'S1', f'2026-04-{i+1:02d}', 5.0, 'WIN')
        early = sp.compute_pit_scores(conn, '2026-06-01')[_key('S1')]
        for i in range(12):
            _add(conn, 'S1', f'2026-06-{i+10:02d}', -8.0, 'LOSS')
        late = sp.compute_pit_scores(conn, '2026-09-01')[_key('S1')]

        assert late['resolved_count'] > early['resolved_count']
        assert late['bayesian_score'] < early['bayesian_score'], \
            "a screener that started losing must score worse once those losses are known"

    def test_scores_are_monotonic_in_information(self, conn):
        """Each successive as_of may only ever gain resolved observations, never lose them."""
        for i in range(1, 28):
            _add(conn, 'S1', f'2026-04-{i:02d}', 3.0, 'WIN')
        counts = [
            sp.compute_pit_scores(conn, d).get(_key('S1'), {}).get('resolved_count', 0)
            for d in ('2026-05-01', '2026-05-15', '2026-06-01', '2026-07-01')
        ]
        assert counts == sorted(counts)


class TestScoreShape:
    def test_score_is_a_bounded_probability_like_composite(self, conn):
        for i in range(1, 20):
            _add(conn, 'S1', f'2026-04-{i:02d}', 4.0, 'WIN')
        s = sp.compute_pit_scores(conn, '2026-07-01')[_key('S1')]
        assert 0.0 <= s['bayesian_score'] <= 1.0
        assert 0.0 <= s['wr_20d'] <= 1.0
        assert s['tier'] in ('A', 'B', 'C', 'D', 'Unranked')

    def test_thin_history_is_unranked(self, conn):
        _add(conn, 'S1', '2026-04-01', 4.0, 'WIN')
        assert sp.compute_pit_scores(conn, '2026-07-01')[_key('S1')]['tier'] == 'Unranked'

    def test_losing_screener_scores_below_winning_screener(self, conn):
        for i in range(1, 15):
            _add(conn, 'GOOD', f'2026-04-{i:02d}', 6.0, 'WIN')
            _add(conn, 'BAD', f'2026-04-{i:02d}', -6.0, 'LOSS')
        s = sp.compute_pit_scores(conn, '2026-07-01')
        assert s[_key('GOOD')]['bayesian_score'] > s[_key('BAD')]['bayesian_score']


class TestSignAwareness:
    """2026-08-04: compute_pit_scores must sign-adjust a bearish-tagged screener's return, the
    same fix applied to phase_c_bayesian (screener_performance.py's primary pipeline) -- a
    bearish screener whose stocks subsequently FALL is doing its job and must score as
    reliable, not as a loser. See test_screener_performance.py for the phase_c equivalent."""

    def test_bearish_screener_that_predicted_correctly_scores_as_winning(self, conn):
        conn.execute(
            "INSERT INTO screener_master (scan_id, source, inferred_sentiment) "
            "VALUES ('BEARISH1', 'trendlyne', 'bearish')"
        )
        for i in range(1, 15):
            # raw outcome/return stamped as if price fell (matching a bearish call) --
            # outcome_20d itself is still direction-blind ('WIN' here just means "resolved"
            # for the purposes of this fixture's _add helper), the sign fix operates on ret20d.
            _add(conn, 'BEARISH1', f'2026-04-{i:02d}', -6.0, 'LOSS')
        s = sp.compute_pit_scores(conn, '2026-07-01')[_key('BEARISH1')]
        assert s['wr_20d'] == 1.0, "a bearish screener whose stocks fell must score as a WIN"

    def test_bullish_and_correctly_predicting_bearish_screener_score_equivalently(self, conn):
        """A bullish screener whose stocks rose 6% and a bearish screener whose stocks fell 6%
        are both performing exactly as claimed -- they must land at the same bayesian_score."""
        conn.execute(
            "INSERT INTO screener_master (scan_id, source, inferred_sentiment) "
            "VALUES ('BEARISH2', 'trendlyne', 'bearish')"
        )
        for i in range(1, 15):
            _add(conn, 'BULL1', f'2026-04-{i:02d}', 6.0, 'WIN')
            _add(conn, 'BEARISH2', f'2026-04-{i:02d}', -6.0, 'LOSS')
        s = sp.compute_pit_scores(conn, '2026-07-01')
        assert s[_key('BULL1')]['bayesian_score'] == s[_key('BEARISH2')]['bayesian_score']
