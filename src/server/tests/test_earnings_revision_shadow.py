from datetime import datetime, timezone

from earnings_revision_shadow import build_shadow


NOW = datetime(2026, 10, 24, 12, tzinfo=timezone.utc)


def observation(day, avg, *, actual=None, symbol='REV', period='Mar 2027'):
    return {'symbol': symbol, 'observed_at': f'2026-10-{day:02d}T10:00:00+00:00',
            'values_json': {'date': period, 'metric_type': 'eps', 'avg': avg,
                            'high': avg + 2, 'low': avg - 2, 'actual': actual}}


def test_future_observation_and_different_period_cannot_become_a_revision():
    rows = [observation(1, 10), observation(20, 12), observation(25, 99),
            observation(20, 50, period='Mar 2028')]
    out = build_shadow(rows, NOW, lookback_days=10)
    assert out['state'] == 'RESEARCH_ONLY'
    assert len(out['revisions']) == 1
    assert out['revisions'][0]['revision_pct'] == 20
    assert out['revisions'][0]['period'] == 'Mar 2027'


def test_actual_is_compared_only_with_a_strictly_earlier_forecast():
    rows = [observation(1, 10), observation(20, 99, actual=12), observation(21, 99)]
    out = build_shadow(rows, NOW, lookback_days=10)
    assert out['surprises'][0]['surprise_pct'] == 20
    assert out['surprises'][0]['estimate'] == 10
    assert out['revisions'] == []


def test_baseline_with_actual_cannot_fabricate_preannouncement_consensus():
    out = build_shadow([observation(20, 10, actual=12)], NOW)
    assert out['revisions'] == []
    assert out['surprises'] == []
    assert out['missing_preannouncement_estimate'] == 1


def test_zero_consensus_and_same_day_refresh_do_not_fabricate_revision_history():
    out = build_shadow([observation(20, 10), observation(20, 12), observation(1, 0, symbol='ZERO'),
                        observation(20, 4, symbol='ZERO')], NOW, lookback_days=10)
    assert out['revisions'] == []
