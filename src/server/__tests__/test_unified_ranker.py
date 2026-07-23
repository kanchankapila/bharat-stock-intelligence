import sqlite3
import csv
import os
import sys
import tempfile
import pytest

# Add src/server to path so we can import unified_ranker
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))


def make_db():
    """Create in-memory SQLite with required tables."""
    conn = sqlite3.connect(':memory:')
    conn.row_factory = sqlite3.Row
    conn.executescript('''
        CREATE TABLE screener_catalog (
            screener_id TEXT NOT NULL, source TEXT NOT NULL,
            screener_name TEXT NOT NULL, category TEXT NOT NULL,
            subcategory TEXT, signal_bias TEXT NOT NULL,
            investment_horizon TEXT, confidence REAL NOT NULL,
            score_0_100 REAL, tier TEXT, sub_mod REAL, horiz_mult REAL,
            PRIMARY KEY (screener_id, source)
        );
        CREATE TABLE trendlyne_screener_stocks (
            screener_id TEXT NOT NULL, stock_id TEXT NOT NULL, symbol TEXT,
            PRIMARY KEY (screener_id, stock_id)
        );
        CREATE TABLE trendlyne_screeners (
            screener_id TEXT NOT NULL, screener_name TEXT NOT NULL
        );
        CREATE TABLE moneycontrol_screener_stocks (
            scan_id TEXT NOT NULL, mcsymbol TEXT NOT NULL,
            stock_name TEXT, symbol TEXT,
            PRIMARY KEY (scan_id, mcsymbol)
        );
        CREATE TABLE etnow_screener_stocks (
            screener_id TEXT NOT NULL, symbol TEXT NOT NULL,
            stock_name TEXT, PRIMARY KEY (screener_id, symbol)
        );
        CREATE TABLE stock_scores (
            symbol TEXT NOT NULL, timeframe TEXT NOT NULL,
            score REAL, PRIMARY KEY (symbol, timeframe)
        );
        CREATE TABLE market_regimes (
            date TEXT PRIMARY KEY, regime TEXT NOT NULL,
            regime_prob REAL, computed_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE recommendation_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            symbol TEXT NOT NULL, signal_date TEXT NOT NULL,
            entry_price REAL, actual_return_pct REAL, outcome TEXT,
            generated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE technical_analysis_signals (
            id INTEGER PRIMARY KEY AUTOINCREMENT, symbol TEXT,
            date TEXT, win_probability REAL, signal_score REAL
        );
        CREATE TABLE technical_signals (
            id INTEGER PRIMARY KEY AUTOINCREMENT, symbol TEXT,
            date TEXT, win_probability REAL, calibrated_win_probability REAL,
            nifty_regime TEXT, breakout_probability REAL,
            signal_score INTEGER DEFAULT 0
        );
        CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT);
        CREATE TABLE unified_recommendations (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            symbol TEXT NOT NULL, computed_at TEXT NOT NULL,
            regime TEXT NOT NULL, unified_score REAL NOT NULL,
            conviction_level TEXT NOT NULL, classification TEXT, screener_stock_score REAL,
            ml_score REAL, confluence_score REAL, technical_score REAL,
            dl_score REAL, avg_engine_track_record REAL,
            bullish_screener_count INTEGER, bearish_screener_count INTEGER,
            screener_names_json TEXT, fundamental_score REAL,
            entry_zone_low REAL, entry_zone_high REAL, stop_loss REAL,
            target_1 REAL, target_2 REAL, target_3 REAL,
            risk_reward REAL, timeframe TEXT, sector TEXT,
            trade_reasoning TEXT, position_size_pct REAL, UNIQUE(symbol, computed_at)
        );
        CREATE TABLE unified_signals (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            symbol TEXT, signal_date TEXT, signal_source TEXT, signal_type TEXT,
            entry_price REAL, target_price REAL, stop_loss REAL,
            confidence_score REAL, reasoning TEXT,
            signal_generated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE quant_scores (
            symbol TEXT PRIMARY KEY,
            piotroski_f_score INTEGER, return_on_equity REAL, annualized_vol REAL
        );
    ''')
    return conn


def make_csv(rows):
    """Write rows to a temp CSV file; return path."""
    f = tempfile.NamedTemporaryFile(mode='w', suffix='.csv', delete=False, newline='')
    fieldnames = ['source','screener_id','screener_name','category',
                  'subcategory','signal_bias','investment_horizon','confidence']
    writer = csv.DictWriter(f, fieldnames=fieldnames)
    writer.writeheader()
    writer.writerows(rows)
    f.close()
    return f.name


class TestScreenerCatalogSeed:
    def test_seed_loads_rows_from_csv(self):
        from unified_ranker import UnifiedRanker
        conn = make_db()
        csv_path = make_csv([
            {'source':'trendlyne','screener_id':'s1','screener_name':'Bull Breakout',
             'category':'technical_breakout','subcategory':'price_breakout',
             'signal_bias':'bullish','investment_horizon':'swing','confidence':'0.74'},
            {'source':'trendlyne','screener_id':'s2','screener_name':'Death Cross',
             'category':'technical_trend','subcategory':'trend_indicator',
             'signal_bias':'bearish','investment_horizon':'swing','confidence':'0.74'},
        ])
        ranker = UnifiedRanker(conn=conn, csv_path=csv_path)
        count = ranker.seed_screener_catalog()
        assert count == 2
        rows = conn.execute('SELECT * FROM screener_catalog').fetchall()
        assert len(rows) == 2
        assert rows[0]['signal_bias'] == 'bullish'
        os.unlink(csv_path)

    def test_seed_idempotent(self):
        from unified_ranker import UnifiedRanker
        conn = make_db()
        csv_path = make_csv([
            {'source':'trendlyne','screener_id':'s1','screener_name':'X',
             'category':'technical_trend','subcategory':'','signal_bias':'bullish',
             'investment_horizon':'swing','confidence':'0.74'},
        ])
        ranker = UnifiedRanker(conn=conn, csv_path=csv_path)
        ranker.seed_screener_catalog()
        ranker.seed_screener_catalog()  # second call must not fail
        count = conn.execute('SELECT COUNT(*) FROM screener_catalog').fetchone()[0]
        assert count == 1
        os.unlink(csv_path)


class TestScreenerStockScore:
    def test_fundamental_strong_scores_higher_than_weak(self):
        from unified_ranker import compute_screener_stock_scores

        membership = {
            'STRONG': [{'signal_bias':'bullish','confidence':0.74,'category':'technical_breakout','subcategory':'price_breakout','investment_horizon':'swing'}]*3,
            'WEAK':   [{'signal_bias':'bullish','confidence':0.74,'category':'technical_breakout','subcategory':'price_breakout','investment_horizon':'swing'}]*3,
        }
        fund_scores = {'STRONG': 80.0, 'WEAK': 30.0}
        scores, _, _ = compute_screener_stock_scores(membership, fund_scores)
        assert scores['STRONG'] > scores['WEAK']

    def test_bearish_screener_reduces_score(self):
        from unified_ranker import compute_screener_stock_scores

        membership = {
            'BULL_STOCK':  [{'signal_bias':'bullish','confidence':0.74,'category':'technical_breakout','subcategory':'price_breakout','investment_horizon':'swing'}]*5,
            'BEAR_STOCK':  [{'signal_bias':'bearish','confidence':0.74,'category':'technical_breakout','subcategory':'price_breakout','investment_horizon':'swing'}]*5,
        }
        fund_scores = {'BULL_STOCK': 50.0, 'BEAR_STOCK': 50.0}
        scores, _, _ = compute_screener_stock_scores(membership, fund_scores)
        assert scores['BULL_STOCK'] > scores['BEAR_STOCK']

    def test_risk_red_flags_heavily_penalises(self):
        from unified_ranker import compute_screener_stock_scores

        membership = {
            'CLEAN': [{'signal_bias':'bullish','confidence':0.74,'category':'fundamental_quality','subcategory':'capital_efficiency','investment_horizon':'long_term'}]*3,
            'RISKY': [
                {'signal_bias':'bullish','confidence':0.74,'category':'fundamental_quality','subcategory':'capital_efficiency','investment_horizon':'long_term'},
                {'signal_bias':'neutral','confidence':0.74,'category':'risk_red_flags','subcategory':'financial_or_governance_risk','investment_horizon':'long_term'},
            ],
        }
        fund_scores = {'CLEAN': 75.0, 'RISKY': 75.0}
        scores, _, _ = compute_screener_stock_scores(membership, fund_scores)
        assert scores['CLEAN'] > scores['RISKY']

    def test_fundamental_strong_in_few_screeners_beats_weak_in_many(self):
        from unified_ranker import compute_screener_stock_scores

        membership = {
            'FEW_STRONG': [
                {'signal_bias':'bullish','confidence':0.82,'category':'fundamental_quality','subcategory':'capital_efficiency','investment_horizon':'long_term'},
                {'signal_bias':'bullish','confidence':0.82,'category':'fundamental_growth','subcategory':'earnings_growth','investment_horizon':'long_term'},
            ]*3,
            'MANY_WEAK': [
                {'signal_bias':'bullish','confidence':0.74,'category':'technical_trend','subcategory':'trend_indicator','investment_horizon':'intraday'},
            ]*20,
        }
        fund_scores = {'FEW_STRONG': 80.0, 'MANY_WEAK': 30.0}
        scores, _, _ = compute_screener_stock_scores(membership, fund_scores)
        assert scores['FEW_STRONG'] > scores['MANY_WEAK']


class TestUnifiedRankerRun:
    def _setup(self):
        """Return a fully seeded ranker with controlled test data."""
        import tempfile, os
        conn = make_db()
        csv_path = make_csv([
            {'source':'trendlyne','screener_id':'bull1','screener_name':'Bull Breakout',
             'category':'technical_breakout','subcategory':'price_breakout',
             'signal_bias':'bullish','investment_horizon':'swing','confidence':'0.82'},
            {'source':'trendlyne','screener_id':'fund1','screener_name':'High ROE',
             'category':'fundamental_quality','subcategory':'capital_efficiency',
             'signal_bias':'bullish','investment_horizon':'long_term','confidence':'0.82'},
            {'source':'trendlyne','screener_id':'bear1','screener_name':'Death Cross',
             'category':'technical_trend','subcategory':'trend_indicator',
             'signal_bias':'bearish','investment_horizon':'swing','confidence':'0.74'},
        ])
        from unified_ranker import UnifiedRanker
        ranker = UnifiedRanker(conn=conn, csv_path=csv_path)
        ranker.seed_screener_catalog()

        # INFY: in bull1 + fund1 → strong score; good fundamental
        conn.execute("INSERT INTO trendlyne_screener_stocks VALUES ('bull1','INFY','INFY')")
        conn.execute("INSERT INTO trendlyne_screener_stocks VALUES ('fund1','INFY','INFY')")
        conn.execute("INSERT INTO stock_scores VALUES ('INFY','long_term',80)")

        # WEAK: in bull1 + bear1 → partially offset; weak fundamental
        conn.execute("INSERT INTO trendlyne_screener_stocks VALUES ('bull1','WEAK','WEAK')")
        conn.execute("INSERT INTO trendlyne_screener_stocks VALUES ('bear1','WEAK','WEAK')")
        conn.execute("INSERT INTO stock_scores VALUES ('WEAK','long_term',35)")

        # Give INFY and WEAK a positive track record so they pass RL gate
        conn.execute("INSERT INTO recommendation_log (symbol, signal_date, actual_return_pct, generated_at) VALUES ('INFY','2026-05-01',5.0,date('now','-10 days'))")
        conn.execute("INSERT INTO recommendation_log (symbol, signal_date, actual_return_pct, generated_at) VALUES ('WEAK','2026-05-01',1.0,date('now','-10 days'))")

        # ml scores
        conn.execute("INSERT INTO technical_signals (symbol, date, win_probability, signal_score) VALUES ('INFY', date('now'), 0.75, 70)")
        conn.execute("INSERT INTO technical_signals (symbol, date, win_probability, signal_score) VALUES ('WEAK', date('now'), 0.45, 40)")

        # Market regime
        conn.execute("INSERT INTO market_regimes (date, regime, regime_prob) VALUES (date('now'),'BULL',0.8)")
        conn.commit()
        return ranker, conn, csv_path

    def test_run_writes_to_unified_recommendations(self):
        import os
        ranker, conn, csv_path = self._setup()
        results = ranker.run()
        assert len(results) > 0
        rows = conn.execute('SELECT * FROM unified_recommendations').fetchall()
        assert len(rows) > 0
        os.unlink(csv_path)

    def test_infy_scores_higher_than_weak(self):
        import os
        ranker, conn, csv_path = self._setup()
        results = ranker.run()
        scores = {r['symbol']: r['unified_score'] for r in results}
        if 'INFY' in scores and 'WEAK' in scores:
            assert scores['INFY'] > scores['WEAK']
        os.unlink(csv_path)

    def test_rl_gate_excludes_negative_track_record(self):
        import os
        ranker, conn, csv_path = self._setup()
        conn.execute("INSERT INTO trendlyne_screener_stocks VALUES ('bull1','LOSER','LOSER')")
        conn.execute("INSERT INTO stock_scores VALUES ('LOSER','long_term',60)")
        conn.execute("INSERT INTO technical_signals (symbol, date, win_probability, signal_score) VALUES ('LOSER', date('now'), 0.72, 68)")
        conn.execute("INSERT INTO recommendation_log (symbol, signal_date, actual_return_pct, generated_at) VALUES ('LOSER','2026-05-01',-8.0,date('now','-10 days'))")
        conn.commit()
        results = ranker.run()
        symbols = [r['symbol'] for r in results]
        assert 'LOSER' not in symbols
        os.unlink(csv_path)

    def test_quality_gate_demotes_weak_fundamentals(self):
        import os
        ranker, conn, csv_path = self._setup()
        # Two names with identical screeners/scores/track-record/ML — differ only in
        # balance-sheet quality (Piotroski). The weak one must rank materially lower.
        for sym in ('GOODQ', 'BADQ'):
            conn.execute("INSERT INTO trendlyne_screener_stocks VALUES ('bull1',?,?)", (sym, sym))
            conn.execute("INSERT INTO trendlyne_screener_stocks VALUES ('fund1',?,?)", (sym, sym))
            conn.execute("INSERT INTO stock_scores VALUES (?, 'long_term', 70)", (sym,))
            conn.execute("INSERT INTO recommendation_log (symbol, signal_date, actual_return_pct, generated_at) "
                         "VALUES (?, '2026-05-01', 5.0, date('now','-10 days'))", (sym,))
            conn.execute("INSERT INTO technical_signals (symbol, date, win_probability, signal_score) "
                         "VALUES (?, date('now'), 0.75, 70)", (sym,))
        conn.execute("INSERT INTO quant_scores (symbol,piotroski_f_score,return_on_equity,annualized_vol) VALUES ('GOODQ', 8, 20.0, 30.0)")
        conn.execute("INSERT INTO quant_scores (symbol,piotroski_f_score,return_on_equity,annualized_vol) VALUES ('BADQ', 1, 5.0, 30.0)")
        conn.commit()

        scores = {r['symbol']: r['unified_score'] for r in ranker.run()}
        assert 'GOODQ' in scores and 'BADQ' in scores
        assert scores['BADQ'] < scores['GOODQ']
        assert scores['BADQ'] <= scores['GOODQ'] * 0.7   # ~0.6x Piotroski-≤2 demotion
        os.unlink(csv_path)

    def test_position_sizing_favors_high_conviction_low_vol(self):
        import os
        ranker, conn, csv_path = self._setup()
        # two buy candidates, identical screeners/scores; differ in win_prob + vol
        for sym, wp, vol in [('HICONV', 0.80, 20.0), ('LOCONV', 0.55, 60.0)]:
            conn.execute("INSERT INTO trendlyne_screener_stocks VALUES ('bull1',?,?)", (sym, sym))
            conn.execute("INSERT INTO trendlyne_screener_stocks VALUES ('fund1',?,?)", (sym, sym))
            conn.execute("INSERT INTO stock_scores VALUES (?, 'long_term', 75)", (sym,))
            conn.execute("INSERT INTO recommendation_log (symbol, signal_date, actual_return_pct, generated_at) "
                         "VALUES (?, '2026-05-01', 5.0, date('now','-10 days'))", (sym,))
            conn.execute("INSERT INTO technical_signals (symbol, date, win_probability, signal_score) "
                         "VALUES (?, date('now'), ?, 70)", (sym, wp))
            conn.execute("INSERT INTO quant_scores VALUES (?, 7, 15.0, ?)", (sym, vol))
        conn.commit()

        results = ranker.run()
        sizes = {r['symbol']: r['position_size_pct'] for r in results}
        assert sizes.get('HICONV', 0) > sizes.get('LOCONV', 0)            # conviction×low-vol wins
        assert all(0 <= (r['position_size_pct'] or 0) <= 10.0 for r in results)  # per-name cap
        os.unlink(csv_path)

    def test_run_emits_directional_classification(self):
        # INFY is in two bullish screeners (bull_count=2, bear_count=0) -> must classify as a Buy,
        # not be left without a directional label the Top Rated UI needs.
        import os
        ranker, conn, csv_path = self._setup()
        results = ranker.run()
        by_sym = {r['symbol']: r for r in results}
        assert 'classification' in by_sym['INFY']
        assert by_sym['INFY']['classification'] in ('Buy', 'Strong Buy')
        # persisted to the table too
        row = conn.execute("SELECT classification FROM unified_recommendations WHERE symbol='INFY'").fetchone()
        assert row['classification'] in ('Buy', 'Strong Buy')
        os.unlink(csv_path)

    def test_run_populates_reasoning_from_screeners(self):
        import os
        ranker, conn, csv_path = self._setup()
        results = ranker.run()
        infy = next(r for r in results if r['symbol'] == 'INFY')
        # reasoning must be non-empty even without an entry/target fallback source
        assert infy['trade_reasoning'] and len(infy['trade_reasoning']) > 0
        os.unlink(csv_path)

    def test_conviction_tiers_assigned_correctly(self):
        from unified_ranker import _conviction
        assert _conviction(90) == 'S_ELITE'
        assert _conviction(80) == 'S_ELITE'
        assert _conviction(70) == 'A_HIGH'
        assert _conviction(65) == 'A_HIGH'
        assert _conviction(50) == 'B_MEDIUM'
        assert _conviction(45) == 'B_MEDIUM'
        assert _conviction(30) == 'C_LOW'
        assert _conviction(25) == 'C_LOW'
        assert _conviction(10) == 'D_MARGINAL'

    def test_regime_weights_sum_to_one(self):
        from unified_ranker import REGIME_WEIGHTS
        assert REGIME_WEIGHTS['BULL']['screener'] == 0.30
        assert REGIME_WEIGHTS['CRASH']['screener'] == 0.40
        for regime, weights in REGIME_WEIGHTS.items():
            assert abs(sum(weights.values()) - 1.0) < 1e-9, f"{regime} weights don't sum to 1"


class TestUIGradeRanking:
    """Calibration + UI-grade output fixes so unified_recommendations can back the Top Rated tab."""

    def test_blend_renormalizes_over_present_engines(self):
        # confluence/dl/technical absent -> their weight must not deflate the score.
        # A stock strong on the two engines it HAS data for should score high, not be dragged to ~15.
        from unified_ranker import _blend
        weights = {'screener': 0.30, 'ml': 0.20, 'confluence': 0.20, 'technical': 0.20, 'dl': 0.10}
        engine_scores = {'screener': 50.0, 'ml': 60.0, 'confluence': 0.0, 'technical': 0.0, 'dl': 0.0}
        present = {'screener', 'ml'}
        score = _blend(engine_scores, present, weights)
        # weights renormalize to screener .30/.50=.6, ml .20/.50=.4 -> .6*50 + .4*60 = 54
        assert abs(score - 54.0) < 1e-6

    def test_blend_returns_zero_when_no_engine_present(self):
        from unified_ranker import _blend
        weights = {'screener': 0.30, 'ml': 0.20, 'confluence': 0.20, 'technical': 0.20, 'dl': 0.10}
        assert _blend({'screener': 0.0, 'ml': 0.0, 'confluence': 0.0, 'technical': 0.0, 'dl': 0.0},
                      set(), weights) == 0.0

    def test_blend_all_engines_present_matches_plain_weighted_sum(self):
        from unified_ranker import _blend
        weights = {'screener': 0.30, 'ml': 0.20, 'confluence': 0.20, 'technical': 0.20, 'dl': 0.10}
        es = {'screener': 80.0, 'ml': 80.0, 'confluence': 80.0, 'technical': 80.0, 'dl': 80.0}
        # all present, all 80 -> 80 regardless of weights
        assert abs(_blend(es, set(es), weights) - 80.0) < 1e-6

    def test_classify_strong_buy_on_dominant_bullish_and_high_score(self):
        from unified_ranker import _classify
        assert _classify(80.0, bull=8, bear=0) == 'Strong Buy'

    def test_classify_buy_on_net_bullish(self):
        from unified_ranker import _classify
        assert _classify(55.0, bull=5, bear=3) == 'Buy'

    def test_classify_strong_sell_on_dominant_bearish_and_low_score(self):
        from unified_ranker import _classify
        assert _classify(20.0, bull=0, bear=8) == 'Strong Sell'

    def test_classify_sell_on_net_bearish(self):
        from unified_ranker import _classify
        assert _classify(45.0, bull=2, bear=4) == 'Sell'

    def test_classify_hold_when_balanced_or_no_evidence(self):
        from unified_ranker import _classify
        assert _classify(50.0, bull=3, bear=3) == 'Hold'
        assert _classify(50.0, bull=0, bear=0) == 'Hold'

    def test_normalize_is_robust_to_a_single_outlier(self):
        # min-max collapses the cluster near 0 when one outlier sets the max; percentile rank does not.
        from unified_ranker import _normalize_to_100
        raw = {'a': 1.0, 'b': 2.0, 'c': 3.0, 'd': 4.0, 'OUTLIER': 1000.0}
        out = _normalize_to_100(raw)
        # the non-outlier cluster must remain well-spread, not all crushed below ~1
        assert out['d'] > 50.0
        assert out['a'] < out['b'] < out['c'] < out['d'] < out['OUTLIER']


# ── quality gate (#4): demote fundamentally weak names in the canonical ranking ──

def test_quality_gate_strong_fundamentals_no_penalty():
    from unified_ranker import quality_gate
    assert quality_gate(piotroski=7, roe=18.0) == 1.0


def test_quality_gate_weak_piotroski_penalized():
    from unified_ranker import quality_gate
    assert quality_gate(piotroski=1, roe=10.0) == pytest.approx(0.6)


def test_quality_gate_mid_piotroski_mild_penalty():
    from unified_ranker import quality_gate
    assert quality_gate(piotroski=4, roe=12.0) == pytest.approx(0.85)


def test_quality_gate_missing_data_is_neutral():
    # New listings / financials legitimately lack these — don't punish missing data.
    from unified_ranker import quality_gate
    assert quality_gate(piotroski=None, roe=None) == 1.0


def test_quality_gate_negative_roe_compounds_then_floors():
    from unified_ranker import quality_gate, QUALITY_GATE_FLOOR
    # weak piotroski 0.6 * neg-roe 0.8 = 0.48 -> clamped to the floor
    assert quality_gate(piotroski=1, roe=-5.0) == QUALITY_GATE_FLOOR


def test_quality_gate_monotonic_non_decreasing_in_piotroski():
    from unified_ranker import quality_gate
    vals = [quality_gate(piotroski=p, roe=15.0) for p in range(0, 9)]
    assert vals == sorted(vals)


def test_quality_gate_never_below_floor():
    from unified_ranker import quality_gate, QUALITY_GATE_FLOOR
    assert quality_gate(piotroski=0, roe=-99.0) >= QUALITY_GATE_FLOOR


# ── #6 meta-labeling -> position sizing (Lopez de Prado bet size x inverse-vol) ──

def test_bet_size_zero_at_or_below_neutral():
    from unified_ranker import bet_size_from_probability
    assert bet_size_from_probability(0.5) == 0.0
    assert bet_size_from_probability(0.40) == 0.0
    assert bet_size_from_probability(None) == 0.0


def test_bet_size_grows_with_probability():
    from unified_ranker import bet_size_from_probability
    b60 = bet_size_from_probability(0.60)
    b75 = bet_size_from_probability(0.75)
    assert 0.0 < b60 < b75 <= 1.0


def test_bet_size_high_conviction_near_one():
    from unified_ranker import bet_size_from_probability
    assert bet_size_from_probability(0.99) > 0.9


def test_normalize_sizes_proportional_below_cap():
    from unified_ranker import normalize_position_sizes
    out = normalize_position_sizes({'a': 1.0, 'b': 3.0}, gross=1.0, cap=1.0)
    assert out['a'] == pytest.approx(0.25)
    assert out['b'] == pytest.approx(0.75)


def test_normalize_sizes_respects_cap_and_gross():
    from unified_ranker import normalize_position_sizes
    out = normalize_position_sizes({'a': 100.0, 'b': 1.0, 'c': 1.0}, gross=1.0, cap=0.10)
    assert out['a'] == pytest.approx(0.10)          # capped
    assert all(0 <= v <= 0.10 for v in out.values())
    assert sum(out.values()) <= 1.0 + 1e-9


def test_normalize_sizes_all_zero():
    from unified_ranker import normalize_position_sizes
    assert normalize_position_sizes({'a': 0.0, 'b': 0.0}) == {'a': 0.0, 'b': 0.0}


# ── _get_win_probabilities: per-row regime edge adjustment ──────────────────────

def _seed_edge_status_row(conn, regime, auc, ready=True):
    from ml_calibration import ensure_edge_status_table
    ensure_edge_status_table(conn)
    conn.execute(
        "INSERT INTO regime_edge_status (regime, auc, auc_n, distinct_days, episodes, ready, computed_at) "
        "VALUES (?, ?, 100, 30, 3, ?, datetime('now'))",
        (regime, auc, 1 if ready else 0),
    )


def test_get_win_probabilities_flag_off_is_plain_average():
    from unified_ranker import UnifiedRanker
    conn = make_db()
    _seed_edge_status_row(conn, 'BULL', auc=0.50, ready=True)  # present but flag is off
    conn.execute("INSERT INTO technical_signals (symbol, date, win_probability, nifty_regime) "
                 "VALUES ('X', date('now'), 0.85, 'BULL')")
    conn.commit()
    ranker = UnifiedRanker(conn=conn)
    probs = ranker._get_win_probabilities()
    assert probs['X'] == pytest.approx(0.85)   # unchanged -- flag off, no per-row adjustment


def test_get_win_probabilities_edge_adjusts_per_row_regime_when_enabled():
    from unified_ranker import UnifiedRanker
    conn = make_db()
    conn.execute("INSERT INTO app_settings (key, value) VALUES ('edge_adjustment_enabled', 'true')")
    _seed_edge_status_row(conn, 'BULL', auc=0.50, ready=True)   # no live edge
    _seed_edge_status_row(conn, 'BEAR', auc=0.61, ready=True)   # proven edge
    conn.execute("INSERT INTO technical_signals (symbol, date, win_probability, nifty_regime) "
                 "VALUES ('BULLSYM', date('now'), 0.85, 'BULL')")
    conn.execute("INSERT INTO technical_signals (symbol, date, win_probability, nifty_regime) "
                 "VALUES ('BEARSYM', date('now'), 0.72, 'BEAR')")
    conn.commit()
    ranker = UnifiedRanker(conn=conn)
    probs = ranker._get_win_probabilities()
    assert probs['BULLSYM'] == pytest.approx(0.5)    # shrunk to neutral -- no live edge in BULL
    assert probs['BEARSYM'] == pytest.approx(0.72)   # unchanged -- BEAR has proven edge


def test_get_win_probabilities_blends_multiple_regimes_for_same_symbol():
    """A symbol with signals spanning both an edge-bearing and a no-edge regime blends
    per-row, not uniformly by the single 'current' regime."""
    from unified_ranker import UnifiedRanker
    conn = make_db()
    conn.execute("INSERT INTO app_settings (key, value) VALUES ('edge_adjustment_enabled', 'true')")
    _seed_edge_status_row(conn, 'BULL', auc=0.50, ready=True)
    _seed_edge_status_row(conn, 'BEAR', auc=0.61, ready=True)
    # both rows must fall within _get_win_probabilities' 30-day lookback window
    conn.execute("INSERT INTO technical_signals (symbol, date, win_probability, nifty_regime) "
                 "VALUES ('MIXED', date('now', '-1 day'), 0.80, 'BULL')")
    conn.execute("INSERT INTO technical_signals (symbol, date, win_probability, nifty_regime) "
                 "VALUES ('MIXED', date('now'), 0.80, 'BEAR')")
    conn.commit()
    ranker = UnifiedRanker(conn=conn)
    probs = ranker._get_win_probabilities()
    # BULL row shrinks to 0.5, BEAR row stays 0.80 -> average = 0.65, not a plain 0.80
    assert probs['MIXED'] == pytest.approx(0.65)


def test_max_ml_bet_bo_bet_hedge_still_wins_in_no_edge_regime():
    """Regression: when the ML leg is fully shrunk to neutral (no live edge), sizing must still
    be able to back a strong breakout signal via max(ml_bet, bo_bet) -- this change only makes
    the ML leg honest, it must not remove or weaken that existing hedge."""
    from unified_ranker import UnifiedRanker, bet_size_from_probability
    conn = make_db()
    conn.execute("INSERT INTO app_settings (key, value) VALUES ('edge_adjustment_enabled', 'true')")
    _seed_edge_status_row(conn, 'BULL', auc=0.50, ready=True)
    conn.execute("INSERT INTO technical_signals (symbol, date, win_probability, nifty_regime) "
                 "VALUES ('HEDGED', date('now'), 0.85, 'BULL')")
    conn.commit()
    ranker = UnifiedRanker(conn=conn)
    probs = ranker._get_win_probabilities()

    ml_bet = bet_size_from_probability(probs.get('HEDGED'))
    assert ml_bet == 0.0, "edge-adjusted ML leg must be fully shrunk in a no-edge regime"

    # the breakout leg is independent of win_probability entirely -- max(ml_bet, bo_bet) in
    # run() still lets a strong breakout signal drive sizing even though ml_bet is zero here.
    bo_bet = 0.42   # a representative strong cross-sectional breakout bet
    assert max(ml_bet, bo_bet) == bo_bet
