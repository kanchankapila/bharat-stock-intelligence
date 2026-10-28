import math

import numpy as np
import pandas as pd
import pytest

from earnings_preview import (
    PROTOCOL, beat_score, cohort_ic, composite, learned_weights, peer_readthrough,
    reaction_session, robust_z, top_quintile_net, yoy,
)

SESSIONS = pd.DatetimeIndex(pd.to_datetime(['2026-10-19', '2026-10-20', '2026-10-21', '2026-10-23', '2026-10-26']))


def ist(s):
    return pd.Timestamp(s, tz='Asia/Kolkata').tz_convert('UTC')


def test_reaction_session_follows_the_1530_ist_close():
    assert reaction_session(ist('2026-10-20 08:30'), SESSIONS) == pd.Timestamp('2026-10-20')
    assert reaction_session(ist('2026-10-20 13:10'), SESSIONS) == pd.Timestamp('2026-10-20')
    assert reaction_session(ist('2026-10-20 15:30'), SESSIONS) == pd.Timestamp('2026-10-21')
    # 22nd is a holiday: an announcement that evening reacts on the next session
    assert reaction_session(ist('2026-10-21 18:00'), SESSIONS) == pd.Timestamp('2026-10-23')
    assert reaction_session(ist('2026-10-22 11:00'), SESSIONS) == pd.Timestamp('2026-10-23')
    assert reaction_session(ist('2026-10-26 19:00'), SESSIONS) is None


def test_yoy_refuses_zero_or_missing_base_and_winsorises():
    assert yoy(150, 100) == pytest.approx(0.5)
    assert yoy(-50, -100) == pytest.approx(0.5)
    assert yoy(10, 0) is None and yoy(None, 5) is None and yoy(5, float('nan')) is None
    assert yoy(1000, 1) == 3.0


def test_beat_score_uses_only_strictly_earlier_quarters_and_needs_two():
    hist = pd.DataFrame({'period_end': pd.to_datetime(['2025-12-31', '2026-03-31', '2026-06-30', '2026-09-30']),
                         'beat': [1, -1, 1, 1]})
    assert beat_score(hist, pd.Timestamp('2026-09-30')) == pytest.approx(1 / 3)
    assert beat_score(hist, pd.Timestamp('2026-03-31')) is None


def test_peer_readthrough_ignores_peers_not_known_by_the_cutoff():
    cutoff = ist('2026-10-20 15:30')
    peers = pd.DataFrame({
        'symbol': ['A', 'B', 'C', 'D', 'SELF'],
        'broadcast_ts': [ist('2026-10-10 16:00'), ist('2026-10-12 16:00'), ist('2026-10-14 16:00'),
                         ist('2026-10-21 09:00'), ist('2026-10-09 10:00')],
        'pat_yoy': [0.10, 0.20, 0.30, 5.0, 9.0],
    })
    # D is after the cutoff, SELF is the event itself
    assert peer_readthrough(peers, 'SELF', cutoff, 'pat_yoy') == pytest.approx(0.20)
    assert peer_readthrough(peers.iloc[[0, 1, 3]], 'SELF', cutoff, 'pat_yoy') is None


def test_robust_z_is_centred_on_the_reference_and_clipped():
    ref = np.array([1.0, 2.0, 3.0, 4.0, 5.0])
    z = robust_z(np.array([3.0, 100.0, np.nan]), ref)
    assert z[0] == 0 and z[1] == 3.0 and math.isnan(z[2])


def test_composite_needs_min_features_and_renormalises_weights():
    w = {'a': 1.0, 'b': 1.0, 'c': 2.0}
    assert composite({'a': 1.0, 'b': np.nan, 'c': np.nan}, w) is None
    assert composite({'a': 1.0, 'b': np.nan, 'c': -1.0}, w) == pytest.approx((1 - 2) / 3)


def test_learned_weights_only_see_cohorts_closed_before_the_season_and_fall_back_to_equal():
    feats = ['a', 'b']
    ics = pd.DataFrame({
        'feature': ['a', 'b'] * 4,
        'season': pd.to_datetime(['2025-12-31'] * 2 + ['2026-03-31'] * 2 + ['2026-06-30'] * 2 + ['2026-09-30'] * 2),
        'cohort_end': pd.to_datetime(['2026-02-20'] * 2 + ['2026-05-25'] * 2 + ['2026-08-20'] * 2 + ['2026-11-01'] * 2),
        'ic': [0.06, -0.02, 0.04, -0.01, 0.05, -0.03, -0.9, 0.9],
    })
    w, learned = learned_weights(ics, feats, pd.Timestamp('2026-10-08'))
    assert learned and w['a'] == pytest.approx(1.0) and w['b'] == 0.0  # the 2026-09-30 cohort is not closed yet
    w2, learned2 = learned_weights(ics, feats, pd.Timestamp('2026-06-01'))
    assert not learned2 and w2 == {'a': 0.5, 'b': 0.5}


def test_cohort_ic_and_top_quintile_net_charge_costs():
    rng = np.random.default_rng(0)
    n = 40
    score = np.arange(n, dtype=float)
    df = pd.DataFrame({'cohort': ['w1'] * n + ['w2'] * n, 'score': np.r_[score, score],
                       'ret': np.r_[score / 1000, rng.normal(0, 0.01, n)]})
    ic = cohort_ic(df, 'score', 'ret', min_n=15)
    assert ic.loc[ic.cohort == 'w1', 'ic'].iloc[0] == pytest.approx(1.0)
    tq = top_quintile_net(df, 'score', 'ret', cost=0.003, min_n=15)
    w1 = tq.loc[tq.cohort == 'w1', 'net'].iloc[0]
    assert w1 == pytest.approx(np.mean(score[-8:] / 1000) - 0.003)


def test_a_feature_with_fewer_closed_seasons_than_the_learner_needs_gets_no_weight():
    ics = pd.DataFrame({
        'feature': ['a', 'a', 'a', 'young'],
        'season': pd.to_datetime(['2025-12-31', '2026-03-31', '2026-06-30', '2026-06-30']),
        'cohort_end': pd.to_datetime(['2026-02-20', '2026-05-25', '2026-08-20', '2026-08-20']),
        'ic': [0.05, 0.05, 0.05, 0.50],  # one great season is not evidence
    })
    w, learned = learned_weights(ics, ['a', 'young'], pd.Timestamp('2026-10-08'))
    assert learned and w == {'a': 1.0, 'young': 0.0}


def test_protocol_registry_appends_new_versions_and_flags_a_changed_hash():
    from earnings_preview import protocol_registry
    legacy = {'hash': 'aaaa', 'protocol': {'version': 'ep-v2'}}
    reg, drifted = protocol_registry(legacy, 'ep-v3', 'bbbb', {'version': 'ep-v3', 'frozen_on': '2026-10-27'})
    assert not drifted and reg['versions'] == {'ep-v2': {'hash': 'aaaa'},
                                               'ep-v3': {'hash': 'bbbb', 'frozen_on': '2026-10-27'}}
    assert protocol_registry(reg, 'ep-v3', 'bbbb', {}) == (None, False)
    assert protocol_registry(reg, 'ep-v3', 'cccc', {}) == (None, True)
    assert protocol_registry(legacy, 'ep-v2', 'zzzz', {}) == (None, True)
    first, drifted = protocol_registry(None, 'ep-v3', 'bbbb', {'version': 'ep-v3'})
    assert not drifted and first['current'] == 'ep-v3'


def test_protocol_records_the_failed_v1_and_keeps_the_price_lead_forward_only():
    assert PROTOCOL['version'] == 'ep-v3' and {'ep-v1', 'ep-v2'} <= set(PROTOCOL['supersedes'])
    assert PROTOCOL['primary_outcome'] == 'pat_yoy'
    assert set(PROTOCOL['composite_features']).isdisjoint(PROTOCOL['context_features'])
    assert PROTOCOL['price_lead']['forward_from'] > PROTOCOL['frozen_on']


def _week(cohort, start, n, score, ret, extra=None):
    rows = {'cohort': [cohort] * n, 'reaction_session': [pd.Timestamp(start)] * n,
            'z_runup_20d': score, 'abn_5d': ret}
    rows.update(extra or {})
    return pd.DataFrame(rows)


def test_price_lead_grades_only_cohorts_from_the_forward_date():
    from earnings_preview import price_lead
    n = 20
    up = np.arange(n, dtype=float)
    hist = [_week(f'h{i}', '2026-08-03', n, up, up / 100) for i in range(12)]  # perfect, but in-sample
    fwd = [_week(f'f{i}', '2026-10-28', n, up, -up / 100) for i in range(3)]
    out = price_lead(pd.concat(hist + fwd, ignore_index=True))
    assert out['in_sample']['n'] == 12 and out['forward']['n'] == 3
    assert out['forward_state'] == 'LOW-DATA'
    assert out['forward']['mean'] < 0


def test_calibration_deciles_report_what_followed_each_score_band():
    from earnings_preview import calibration
    n = 600
    s = np.linspace(-2, 2, n)
    liq = pd.DataFrame({'score': s, 'pat_yoy': s / 4, 'beat_actual': np.where(s > 0, 1.0, -1.0),
                        'abn_1d': s / 100, 'abn_5d': s / 100})
    c = calibration(liq, 'score')
    assert len(c['edges']) == 9 and len(c['deciles']) == 10
    assert c['deciles'][0]['p_growth_positive'] == 0 and c['deciles'][-1]['p_growth_positive'] == 1
    assert c['deciles'][-1]['p_beat'] == 1 and sum(r['n'] for r in c['deciles']) == n
