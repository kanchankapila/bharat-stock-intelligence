"""Semantic labels describe a condition; they never certify a profitable trade."""
import json
from pathlib import Path

import pytest

from screener_semantics import analyze_screener


@pytest.mark.parametrize('name, expected', [
    ('Bullish Engulfing Pattern (Bullish Reversal)', 'bullish'),
    ('White Marubozu Candlestick (Bullish)', 'bullish'),
    ('Stocks with their EMA10 trading below their EMA100', 'bearish'),
    ('Week MACD Crossover Above Signal Line', 'bullish'),
    ('MACD Crossover Below Signal Line', 'bearish'),
    ('Companies Increasing Debt as per Annual Report', 'bearish'),
    ('Decreasing Promoter Pledge', 'bullish'),
    ('Forecaster: Analysts Estimate Rising Interest Expense (QoQ)', 'bearish'),
    ('Forecaster: Analysts Estimate Falling Interest Expense (QoQ)', 'bullish'),
    ('Strong Earnings QualityFocuses on reduced bankruptcy risk', 'bullish'),
    ('Previous Day Breakout - Down Stocks closed below previous low', 'bearish'),
    ('Previous Month Breakout - UpList of stocks above previous high', 'bullish'),
    ('Altman Z-score - Insolvent Stocks facing solvency problems', 'bearish'),
    ('Altman Z score - Solvent Stocks which are highly solvent', 'bullish'),
    ('Promoters increased pledged shares QoQ', 'bearish'),
    ('Pledges today more than 1% of total shares', 'bearish'),
    ('MF Shareholding- Sold by MF', 'bearish'),
    ('MF Shareholding- Bought by MF', 'bullish'),
    ('ROCE (Return on Capital Employed) higher than Sector ROCE', 'bullish'),
    ('PE higher than Industry PE', 'bearish'),
    ('Price to Book Value (P/BV) higher than Industry Price to Book Value (P/BV)', 'bearish'),
    ('15 min CCI Oversold', 'neutral'),
    ('Close Crossing Last Month Close From Below', 'bullish'),
    ('Williams %R crossed -20 from below', 'bullish'),
    ('Williams %R crossed -80 from above', 'bearish'),
    ('Significant (over 30%) distance from 52 week high', 'neutral'),
    ('Net Profit QoQ Growth %', 'neutral'),
    ('Week Williams %R in Overbought zone', 'neutral'),
    ('ADX Trending Stocks', 'neutral'),
    ('Volume Shockers', 'neutral'),
    ('High Delivery', 'neutral'),
    ('FII Selling, DII Buying', 'neutral'),
    ('Increasing public shareholding over the past two years', 'neutral'),
    ('Highest Promoter Holdings', 'neutral'),
    ('Results declared today', 'neutral'),
    ('Upcoming Bonus/Split', 'neutral'),
    ('High Dividend Yield Stocks', 'neutral'),
    ('Low Volatility Stocks', 'neutral'),
    ('AI stocks in India', 'neutral'),
    ('Debt Free, Pledge Free', 'bullish'),
    ('High debt at low PE', 'bearish'),
    ('Turnaround Opportunities with earnings growth and negative returns', 'neutral'),
    ('Price nearing Supertrend support', 'neutral'),
    ('Sales Decreasing, Price Increasing', 'neutral'),
    ('My private screener', 'neutral'),
    ('Low Price to SalesStocks with price-to-sales ratio of less than', 'bullish'),
    ('Not low debt', 'neutral'),
    ('ASM (Additional Surveillance Measure)/GSM (Graded Surveillance Measure) stock list', 'bearish'),
    ('Low DVM Stocks - Stocks to Exercise Caution On', 'bearish'),
    ('Distressed Operations Track stocks with consistent decline in key business ratios', 'bearish'),
    ('Operations Unsuccessful', 'bearish'),
    ('Increasing Trading Activity with Negative Weekly returns - Large CapDiscovering Momentum', 'bearish'),
    ('Increasing Trading Activity with Negative Weekly returns - Mid CapDiscover mid-cap stocks', 'bearish'),
    ('Increasing Trading Activity with Negative Weekly returns - Micro CapAmidst weekly losses', 'bearish'),
])
def test_semantic_polarity(name, expected):
    assert analyze_screener(name)['semantic_bias'] == expected


def test_policy_is_explicitly_unproven():
    from screener_semantics import analyze_screener
    result = analyze_screener('Bullish Engulfing Pattern (Bullish Reversal)')
    assert result['semantic_bias'] == 'bullish'
    assert result['empirical_direction'] == 'unproven'
    assert result['reason']


def test_python_and_typescript_use_identical_rule_data():
    policy = json.loads((Path(__file__).parents[1] / 'config/screenerSemantics.json').read_text())
    assert policy['version']
    assert len({r['id'] for r in policy['rules']}) == len(policy['rules'])
    assert all(r['bias'] in {'bullish', 'bearish', 'neutral'} for r in policy['rules'])


def test_aliases_cannot_multiply_membership_but_distinct_sources_survive():
    from screener_semantics import deduplicate_membership
    entries = [
        {'source': 'Trendlyne', 'screener_name': 'White Marubozu (Bullish)', 'screener_id': 'a'},
        {'source': 'trendlyne', 'screener_name': 'White Marubozu (Bullish)', 'screener_id': 'b'},
        {'source': 'MoneyControl', 'screener_name': 'White Marubozu (Bullish)', 'screener_id': 'a'},
    ]
    assert len(deduplicate_membership({'ABC': entries})['ABC']) == 2


def test_neutral_membership_has_exactly_zero_directional_contribution():
    from unified_ranker import compute_screener_stock_scores
    entry = {'signal_bias': 'neutral', 'category': 'technical_trend', 'confidence': 0.8}
    scores, bulls, bears = compute_screener_stock_scores({'ONE': [entry], 'MANY': [entry] * 20}, {},
        bias_sign={'bullish': 1, 'bearish': -1, 'neutral': 0})
    assert scores['ONE'] == scores['MANY']
    assert bulls == {'ONE': 0, 'MANY': 0}
    assert bears == {'ONE': 0, 'MANY': 0}


def test_candidate_does_not_override_logged_production_oscillator_policy():
    from screener_catalog_enricher import classify_screener
    assert classify_screener('15 min CCI Oversold') == 'bullish'
    assert analyze_screener('15 min CCI Oversold')['semantic_bias'] == 'neutral'


def test_provider_filters_resolve_ambiguous_titles_only_with_their_source():
    from screener_semantics import analyze_screener
    assert analyze_screener('ROCE Annual %')['semantic_bias'] == 'neutral'
    assert analyze_screener('ROCE Annual %', 'et_marketstats')['semantic_bias'] == 'bullish'
    assert analyze_screener('Net Profit QoQ Growth %', 'et_marketstats')['semantic_basis'] == 'verified_filter'
    assert analyze_screener('Negative Breakout First Support', 'et_marketstats', 'negative-breakout-first-support-e1d50602')['role'] == 'invalid_filter'
    assert analyze_screener('Negative Breakout First Support', 'et_marketstats', 'new-corrected-key')['semantic_bias'] == 'bearish'


def test_bulk_application_refuses_any_unmeasured_risk_veto_removal(monkeypatch):
    import sys
    sys.path.insert(0, str(Path(__file__).resolve().parents[3] / 'scripts'))
    import review_screener_biases as repair
    monkeypatch.setattr(repair, 'risk_analysis', lambda con: {'veto_removals': 1})
    with pytest.raises(RuntimeError, match='existing risk vetoes'):
        repair.apply_review(object(), [])


def test_frozen_review_policy_and_replay_hashes_survive_checkout():
    import hashlib
    root = Path(__file__).resolve().parents[3]
    manifest_path = root / 'research/out/screener-bias-review-20261106-v3.json'
    manifest = json.loads(manifest_path.read_text(encoding='utf-8'))
    replay = json.loads((root / 'docs/audits/2026-11-06-screener-replay-v3.json').read_text(encoding='utf-8'))
    assert replay['manifest_sha256'] == hashlib.sha256(manifest_path.read_bytes()).hexdigest()
    assert manifest['policy_sha256'] == hashlib.sha256(
        (root / 'src/server/config/screenerSemantics.json').read_bytes()).hexdigest()


def test_invalid_capture_evidence_is_refused_even_with_many_graded_dates(monkeypatch, tmp_path):
    import sys
    sys.path.insert(0, str(Path(__file__).resolve().parents[3] / 'scripts'))
    import review_screener_biases as repair

    class Connection:
        def rollback(self):
            pass

        def close(self):
            pass

    evidence = tmp_path / 'invalid-evidence.json'
    evidence.write_text(json.dumps({'graded_dates': 99, 'verdict': 'INVALID-CAPTURE (AF-20261106-04); no promotion'}))
    monkeypatch.setattr(repair, 'connect', Connection)
    monkeypatch.setattr(sys, 'argv', ['review', '--apply', '--report', str(tmp_path / 'manifest.json'),
                                    '--evidence', str(evidence)])
    with pytest.raises(RuntimeError, match='Insufficient promotion evidence'):
        repair.main()
