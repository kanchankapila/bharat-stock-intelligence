import sqlite3
import csv
import os
import sys
import tempfile
import pytest

# Add src/server to path so we can import unified_ranker
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
from pg_test_support import pg_memory_conn  # noqa: E402


def make_db():
    """Create in-memory SQLite with required tables."""
    conn = pg_memory_conn()
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
            stop_loss REAL, target_1 REAL, target_2 REAL, target_3 REAL,
            timeframe TEXT, reasoning TEXT, sector TEXT,
            generated_at DATETIME DEFAULT CURRENT_TIMESTAMP
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
            -- Wall-clock instant of the producing run (2026-08-10). computed_at is a bare
            -- DATE and the upsert key is (symbol, computed_at), so without this a post-close
            -- re-run is indistinguishable from the 07:30 IST cron row it replaced.
            generated_at TEXT,
            regime TEXT NOT NULL, unified_score REAL NOT NULL,
            conviction_level TEXT NOT NULL, classification TEXT, screener_stock_score REAL,
            ml_score REAL, confluence_score REAL, technical_score REAL,
            dl_score REAL, cs_score REAL, breakout_score REAL, smart_money_score REAL,
            avg_engine_track_record REAL, engine_coverage_count INTEGER,
            bullish_screener_count INTEGER, bearish_screener_count INTEGER,
            screener_names_json TEXT, fundamental_score REAL,
            entry_zone_low REAL, entry_zone_high REAL, stop_loss REAL,
            target_1 REAL, target_2 REAL, target_3 REAL,
            risk_reward REAL, timeframe TEXT, sector TEXT,
            trade_reasoning TEXT, position_size_pct REAL, UNIQUE(symbol, computed_at)
        );
        -- Append-only point-in-time snapshot: keyed on generated_at, so a re-run adds a row
        -- rather than replacing the previous run's ranking (which the table above does).
        CREATE TABLE unified_recommendations_history (
            symbol TEXT NOT NULL, computed_at TEXT NOT NULL, generated_at TEXT NOT NULL,
            regime TEXT, unified_score REAL, conviction_level TEXT, classification TEXT,
            screener_stock_score REAL, ml_score REAL, confluence_score REAL,
            technical_score REAL, cs_score REAL, breakout_score REAL, smart_money_score REAL,
            fundamental_score REAL, engine_coverage_count INTEGER, entry_zone_low REAL,
            stop_loss REAL, target_1 REAL, position_size_pct REAL, sector TEXT,
            PRIMARY KEY (symbol, generated_at)
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
        CREATE TABLE confluence_signals (
            symbol TEXT NOT NULL, computed_at DATETIME NOT NULL,
            confluence_score REAL, entry_zone_low REAL, entry_zone_high REAL,
            stop_loss REAL, target_1 REAL, target_2 REAL, target_3 REAL,
            risk_reward REAL, suggested_timeframe TEXT, trade_reasoning TEXT, sector TEXT,
            trend_alignment_score REAL, volume_score REAL,
            sector_strength_score REAL, fundamental_score REAL
        );
        CREATE TABLE stock_ohlcv (
            symbol TEXT NOT NULL, date TEXT NOT NULL, close REAL, is_suspect INTEGER,
            PRIMARY KEY (symbol, date)
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

    def test_engine_score_columns_null_not_zero_when_engine_has_no_row(self):
        """AF-20260818-31/39 (unified_ranker.py has_data guard). INFY has a technical_signals
        row (feeds ml_score/technical_score) but no confluence_signals row and no dl-feeding
        data at all in this fixture -- confluence_score/dl_score must be NULL, not the engine's
        absent-default 0.0, or the frontend's null-vs-zero display fix has nothing to key off
        and a genuinely-uncovered engine looks identical to a real score of 0."""
        import os
        ranker, conn, csv_path = self._setup()
        try:
            results = ranker.run()
            by_sym = {r['symbol']: r for r in results}
            assert 'INFY' in by_sym
            row = by_sym['INFY']
            assert row['confluence_score'] is None, row['confluence_score']
            assert row['dl_score'] is None, row['dl_score']
            # sanity: engines that DO have a row for INFY must still be populated, not blanked
            assert row['ml_score'] is not None
            assert row['technical_score'] is not None
            assert row['screener_stock_score'] is not None
        finally:
            os.unlink(csv_path)

    def test_history_snapshot_is_append_only_across_reruns(self):
        """A re-run must ADD a snapshot, never replace the previous run's.

        unified_recommendations is keyed (symbol, computed_at) on a bare DATE, so the second run
        below correctly overwrites the first in that table. That is what destroyed the evidence:
        measured 2026-08-12, 37 computed_at dates existed and exactly ONE was provably
        pre-market, leaving the canonical ranker ungradeable against forward returns.
        unified_recommendations_history is keyed on generated_at so both runs survive.
        """
        import os
        ranker, conn, csv_path = self._setup()
        try:
            ranker.run()
            live_after_first = conn.execute(
                'SELECT COUNT(*) FROM unified_recommendations').fetchone()[0]
            hist_after_first = conn.execute(
                'SELECT COUNT(*) FROM unified_recommendations_history').fetchone()[0]
            assert live_after_first > 0
            assert hist_after_first == live_after_first

            ranker.run()   # same session date, a second generation event

            live_after_second = conn.execute(
                'SELECT COUNT(*) FROM unified_recommendations').fetchone()[0]
            runs = conn.execute(
                'SELECT COUNT(DISTINCT generated_at) FROM unified_recommendations_history'
            ).fetchone()[0]
            hist_after_second = conn.execute(
                'SELECT COUNT(*) FROM unified_recommendations_history').fetchone()[0]

            # the live table still holds exactly one row per symbol for the session...
            assert live_after_second == live_after_first
            # ...while history now records BOTH runs
            assert runs == 2, f'expected 2 distinct generated_at, got {runs}'
            assert hist_after_second == 2 * live_after_first
        finally:
            os.unlink(csv_path)

    def test_infy_scores_higher_than_weak(self):
        import os
        ranker, conn, csv_path = self._setup()
        results = ranker.run()
        scores = {r['symbol']: r['unified_score'] for r in results}
        if 'INFY' in scores and 'WEAK' in scores:
            assert scores['INFY'] > scores['WEAK']
        os.unlink(csv_path)

    def test_rl_gate_excludes_negative_track_record_with_enough_samples(self):
        """A REAL track record of losing money -- MIN_RL_GATE_SAMPLES-or-more resolved
        outcomes, consistently negative -- still excludes a symbol."""
        import os
        ranker, conn, csv_path = self._setup()
        conn.execute("INSERT INTO trendlyne_screener_stocks VALUES ('bull1','LOSER','LOSER')")
        conn.execute("INSERT INTO stock_scores VALUES ('LOSER','long_term',60)")
        conn.execute("INSERT INTO technical_signals (symbol, date, win_probability, signal_score) VALUES ('LOSER', date('now'), 0.72, 68)")
        for i in range(ranker.MIN_RL_GATE_SAMPLES):
            conn.execute(
                "INSERT INTO recommendation_log (symbol, signal_date, actual_return_pct, generated_at) "
                "VALUES ('LOSER', ?, -8.0, date('now','-10 days'))",
                (f'2026-05-{i+1:02d}',))
        conn.commit()
        results = ranker.run()
        symbols = [r['symbol'] for r in results]
        assert 'LOSER' not in symbols
        os.unlink(csv_path)

    def test_rl_gate_does_not_veto_on_a_thin_sample(self):
        """2026-08-06 fix: a negative average on FEWER than MIN_RL_GATE_SAMPLES resolved
        outcomes is noise, not a track record, and must not permanently exclude a symbol.
        Live-confirmed this was NOT the prior behavior: 825 symbols platform-wide were
        excluded, 352 of them (43%) on fewer than 5 samples -- e.g. KECL, gated out on exactly
        2 stale technical_scan misses from 2026-05 despite strong current scores everywhere
        else (cs_ranker 84.5, confluence 97.8, breakout 74.7)."""
        import os
        ranker, conn, csv_path = self._setup()
        conn.execute("INSERT INTO trendlyne_screener_stocks VALUES ('bull1','THINLOSS','THINLOSS')")
        conn.execute("INSERT INTO stock_scores VALUES ('THINLOSS','long_term',60)")
        conn.execute("INSERT INTO technical_signals (symbol, date, win_probability, signal_score) VALUES ('THINLOSS', date('now'), 0.72, 68)")
        assert ranker.MIN_RL_GATE_SAMPLES > 1, "test assumes 1 sample is below the floor"
        conn.execute("INSERT INTO recommendation_log (symbol, signal_date, actual_return_pct, generated_at) VALUES ('THINLOSS','2026-05-01',-8.0,date('now','-10 days'))")
        conn.commit()
        results = ranker.run()
        symbols = [r['symbol'] for r in results]
        assert 'THINLOSS' in symbols, (
            "a single old loss must not permanently veto a symbol -- MIN_RL_GATE_SAMPLES floor "
            "not applied"
        )
        os.unlink(csv_path)

    def test_rl_gate_does_not_veto_on_an_insignificant_negative(self):
        """2026-08-10 fix: MIN_RL_GATE_SAMPLES alone left `avg_r < 0` as a bare SIGN test, so a
        symbol whose trailing average is negative-but-indistinguishable-from-zero was excluded
        exactly as hard as one losing 8% a trade.

        Modelled on the live case that motivated the fix: SBCL, 22 resolved outcomes averaging
        -0.174% (t=-0.45), gated out of the ranked universe from 2026-07-10 -- then the top
        liquid gainer on 2026-08-10 at +19.08%. Platform-wide this excluded 519 of 958 eligible
        symbols, 359 (69%) of them on noise, while the excluded set did not underperform the
        kept set at any horizon tested (37 dates, point-in-time: +0.098%, t=1.22)."""
        import os
        ranker, conn, csv_path = self._setup()
        conn.execute("INSERT INTO trendlyne_screener_stocks VALUES ('bull1','NOISYLOSS','NOISYLOSS')")
        conn.execute("INSERT INTO stock_scores VALUES ('NOISYLOSS','long_term',60)")
        conn.execute("INSERT INTO technical_signals (symbol, date, win_probability, signal_score) VALUES ('NOISYLOSS', date('now'), 0.72, 68)")
        # Mean is negative but tiny relative to the spread: mean -0.25%, sd ~2.4%, n=8 -> t~-0.3.
        returns = [-3.0, 2.5, -2.0, 3.0, -2.5, 1.5, -1.5, 0.0]
        assert sum(returns) / len(returns) < 0, "fixture must have a NEGATIVE mean to be a valid test"
        assert len(returns) >= ranker.MIN_RL_GATE_SAMPLES, "fixture must clear the sample floor"
        for i, r in enumerate(returns):
            conn.execute(
                "INSERT INTO recommendation_log (symbol, signal_date, actual_return_pct, generated_at) "
                "VALUES ('NOISYLOSS', ?, ?, date('now','-10 days'))",
                (f'2026-05-{i+1:02d}', r))
        conn.commit()
        results = ranker.run()
        symbols = [r['symbol'] for r in results]
        assert 'NOISYLOSS' in symbols, (
            "a negative average that is statistical noise (t > RL_GATE_MAX_T) must not exclude "
            "a symbol from the ranked universe"
        )
        os.unlink(csv_path)

    def test_rl_gate_still_excludes_a_consistent_zero_variance_loser(self):
        """Guards the significance test's own edge case: every resolved outcome identical and
        negative gives stddev == 0. That is maximally significant (t -> -inf), NOT untestable,
        and must still exclude -- reading a zero stddev as 'cannot establish significance'
        would silently disable the gate for its most clear-cut case."""
        import os
        ranker, conn, csv_path = self._setup()
        conn.execute("INSERT INTO trendlyne_screener_stocks VALUES ('bull1','FLATLOSER','FLATLOSER')")
        conn.execute("INSERT INTO stock_scores VALUES ('FLATLOSER','long_term',60)")
        conn.execute("INSERT INTO technical_signals (symbol, date, win_probability, signal_score) VALUES ('FLATLOSER', date('now'), 0.72, 68)")
        for i in range(ranker.MIN_RL_GATE_SAMPLES):
            conn.execute(
                "INSERT INTO recommendation_log (symbol, signal_date, actual_return_pct, generated_at) "
                "VALUES ('FLATLOSER', ?, -8.0, date('now','-10 days'))",
                (f'2026-05-{i+1:02d}',))
        conn.commit()
        results = ranker.run()
        assert 'FLATLOSER' not in [r['symbol'] for r in results]
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
        """run() sizes a long as bet/vol, bet = max(ml_bet, breakout_bet). That ordering is a
        property of the sizing math, so it is asserted on the math directly.

        It used to be asserted through a full run(), which stopped working when direction
        moved from screeners to the score (2026-08-10): the low-conviction name's win_prob
        also feeds ml_score, so it now scores below the Buy floor and is legitimately unsized
        -- and with only two sized names the 10% per-name cap flattens both to 10.0 anyway,
        so the end-to-end vehicle could not see the ordering even when it was correct. The
        cap/sector behaviour it was confounded by is covered in
        test_unified_ranker_portfolio_construction.py; the run() wiring is covered below.
        """
        from unified_ranker import bet_size_from_probability, VOL_FLOOR_PCT
        hi = bet_size_from_probability(0.80) / max(VOL_FLOOR_PCT, 20.0)
        lo = bet_size_from_probability(0.55) / max(VOL_FLOOR_PCT, 60.0)
        assert hi > lo, 'higher win-prob on lower vol must size larger'
        # each leg independently, so a change that breaks only one is not masked by the other
        same_vol_hi = bet_size_from_probability(0.80) / 30.0
        same_vol_lo = bet_size_from_probability(0.60) / 30.0
        assert same_vol_hi > same_vol_lo, 'conviction leg inert'
        same_conv_lowvol = bet_size_from_probability(0.70) / max(VOL_FLOOR_PCT, 20.0)
        same_conv_hivol = bet_size_from_probability(0.70) / max(VOL_FLOOR_PCT, 60.0)
        assert same_conv_lowvol > same_conv_hivol, 'inverse-vol leg inert'

    def test_win_prob_and_vol_actually_reach_the_sizing_path(self):
        """The wiring half of the test above: a buy candidate really is sized from win_prob
        and quant_scores vol inside run(), and stays inside the per-name cap."""
        import os
        ranker, conn, csv_path = self._setup()
        for i in range(6):                       # weak fillers: keep the buy genuinely top-ranked
            f = f'FILL{i}'
            conn.execute("INSERT INTO stock_scores VALUES (?, 'long_term', 20)", (f,))
            conn.execute("INSERT INTO technical_signals (symbol, date, win_probability, signal_score) "
                         "VALUES (?, date('now'), 0.45, 20)", (f,))
            conn.execute("INSERT INTO recommendation_log (symbol, signal_date, actual_return_pct, generated_at) "
                         "VALUES (?, '2026-05-01', 1.0, date('now','-10 days'))", (f,))
        conn.execute("INSERT INTO trendlyne_screener_stocks VALUES ('bull1','HICONV','HICONV')")
        conn.execute("INSERT INTO trendlyne_screener_stocks VALUES ('fund1','HICONV','HICONV')")
        conn.execute("INSERT INTO stock_scores VALUES ('HICONV', 'long_term', 95)")
        conn.execute("INSERT INTO recommendation_log (symbol, signal_date, actual_return_pct, generated_at) "
                     "VALUES ('HICONV', '2026-05-01', 5.0, date('now','-10 days'))")
        conn.execute("INSERT INTO technical_signals (symbol, date, win_probability, signal_score) "
                     "VALUES ('HICONV', date('now'), 0.80, 95)")
        conn.execute("INSERT INTO quant_scores VALUES ('HICONV', 7, 15.0, 20.0)")
        conn.commit()

        results = ranker.run()
        by_sym = {r['symbol']: r for r in results}
        assert by_sym['HICONV']['classification'] in ('Buy', 'Strong Buy')
        assert by_sym['HICONV']['position_size_pct'] > 0, 'buy candidate never got sized'
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
        """classification is REQUIRED since 2026-08-10 -- conviction is a tier of the row's
        OWN direction, and a bullish-only reading ran the ladder backwards on every short."""
        from unified_ranker import _conviction
        assert _conviction(90, 'Buy') == 'S_ELITE'
        assert _conviction(80, 'Buy') == 'S_ELITE'
        assert _conviction(70, 'Buy') == 'A_HIGH'
        assert _conviction(65, 'Buy') == 'A_HIGH'
        assert _conviction(50, 'Buy') == 'B_MEDIUM'
        assert _conviction(45, 'Buy') == 'B_MEDIUM'
        assert _conviction(30, 'Buy') == 'C_LOW'
        assert _conviction(25, 'Buy') == 'C_LOW'
        assert _conviction(10, 'Buy') == 'D_MARGINAL'
        # the mirror: a short's strength is 100-score
        assert _conviction(10, 'Sell') == 'S_ELITE'
        assert _conviction(90, 'Sell') == 'D_MARGINAL'

    def test_regime_weights_sum_to_one(self):
        from unified_ranker import REGIME_WEIGHTS
        assert REGIME_WEIGHTS['BULL']['screener'] == 0.30
        assert REGIME_WEIGHTS['CRASH']['screener'] == 0.40
        for regime, weights in REGIME_WEIGHTS.items():
            assert abs(sum(weights.values()) - 1.0) < 1e-9, f"{regime} weights don't sum to 1"


class TestSellRowGeometryBackstop:
    """Regression test for a live-confirmed bug: `_get_entry_targets`'s confluence_signals
    fallback is keyed by bare symbol only, with no awareness of THIS row's own `classification`
    -- so a stock this ranker classifies Sell/Strong Sell (net-bearish screener membership)
    could still inherit a long-only entry/stop/target setup from a confluence_signals row.
    Live production data showed 630 Sell/Strong-Sell unified_recommendations rows carrying
    long-style stop-below-entry/target-above-entry geometry, with position_size_pct correctly
    zeroed alongside it -- i.e. the sizing logic already knew these weren't actionable long
    entries, but the geometry fields didn't follow. Fixed with a write-time backstop that nulls
    entry/stop/target/risk_reward/timeframe for any row not classified Buy/Strong Buy,
    independent of which upstream source populated `et`."""

    def _setup_with_bearish_confluence_row(self):
        from unified_ranker import UnifiedRanker
        ranker, conn, csv_path = TestUnifiedRankerRun()._setup()

        # SHORT: only in the bearish screener (bear_count=1, bull_count=0) -> must classify
        # Sell/Strong Sell. Despite that, give it a confluence_signals row carrying a
        # fully-populated LONG-style setup (stop below the zone, targets above) -- exactly the
        # shape confluenceEngine.ts's buildTradeSetup() used to attach regardless of direction,
        # and exactly what a stale pre-fix row already sitting in production would still look
        # like even after the source-side fix ships. The backstop must strip this at write time
        # regardless of where it came from.
        conn.execute("INSERT INTO trendlyne_screener_stocks VALUES ('bear1','SHORT','SHORT')")
        conn.execute("INSERT INTO recommendation_log (symbol, signal_date, actual_return_pct, generated_at) "
                      "VALUES ('SHORT','2026-05-01',5.0,date('now','-10 days'))")
        conn.execute("INSERT INTO technical_signals (symbol, date, win_probability, signal_score) "
                      "VALUES ('SHORT', date('now'), 0.50, 50)")
        conn.execute("""
            INSERT INTO confluence_signals
            (symbol, computed_at, confluence_score, entry_zone_low, entry_zone_high,
             stop_loss, target_1, target_2, target_3, risk_reward, suggested_timeframe,
             trade_reasoning, sector)
            VALUES ('SHORT', date('now'), 40, 100.0, 105.0, 90.0, 120.0, 130.0, 140.0,
                    2.5, 'SWING', 'stale long setup', 'IT')
        """)
        conn.commit()
        return ranker, conn, csv_path

    def test_sell_classified_row_has_no_long_geometry(self):
        import os
        ranker, conn, csv_path = self._setup_with_bearish_confluence_row()
        results = ranker.run()
        by_sym = {r['symbol']: r for r in results}
        assert 'SHORT' in by_sym, "SHORT must still be scored/present, just not carry a trade plan"
        row = by_sym['SHORT']
        # The backstop's contract is "not a long", not "specifically Sell". Since 2026-08-10
        # direction comes from the score, so this fixture's low-scoring name lands in Hold
        # rather than Sell -- same requirement, and asserting the contract instead of one
        # label stops this test breaking again on an unrelated threshold change.
        assert row['classification'] not in ('Buy', 'Strong Buy'), row['classification']
        for field in ('entry_zone_low', 'entry_zone_high', 'stop_loss',
                      'target_1', 'target_2', 'target_3', 'risk_reward', 'timeframe'):
            assert row[field] is None, f"{field} leaked long-side geometry into a Sell row: {row[field]}"
        # position sizing already zeroed sells -- confirm the two invariants now agree
        assert row['position_size_pct'] == 0.0
        # informational fields are NOT stripped -- only the trade-geometry fields are
        assert row['trade_reasoning'] is not None
        assert row['sector'] == 'IT'
        os.unlink(csv_path)

    def test_sell_classified_row_persisted_without_geometry(self):
        import os
        ranker, conn, csv_path = self._setup_with_bearish_confluence_row()
        ranker.run()
        db_row = conn.execute(
            "SELECT classification, entry_zone_low, stop_loss, target_1, risk_reward "
            "FROM unified_recommendations WHERE symbol='SHORT'"
        ).fetchone()
        assert db_row is not None
        assert db_row['classification'] not in ('Buy', 'Strong Buy')
        assert db_row['entry_zone_low'] is None
        assert db_row['stop_loss'] is None
        assert db_row['target_1'] is None
        assert db_row['risk_reward'] is None
        os.unlink(csv_path)

    def test_buy_classified_row_still_gets_geometry(self):
        # Guard against the backstop over-nulling: a genuine Buy candidate with a real
        # confluence_signals setup must still carry its entry/stop/target through untouched.
        import os
        ranker, conn, csv_path = TestUnifiedRankerRun()._setup()
        conn.execute("""
            INSERT INTO confluence_signals
            (symbol, computed_at, confluence_score, entry_zone_low, entry_zone_high,
             stop_loss, target_1, target_2, target_3, risk_reward, suggested_timeframe,
             trade_reasoning, sector)
            VALUES ('INFY', date('now'), 75, 1500.0, 1520.0, 1450.0, 1600.0, 1650.0, 1700.0,
                    2.0, 'SWING', 'clean long setup', 'IT')
        """)
        conn.commit()
        results = ranker.run()
        by_sym = {r['symbol']: r for r in results}
        assert by_sym['INFY']['classification'] in ('Buy', 'Strong Buy')
        assert by_sym['INFY']['entry_zone_low'] == 1500.0
        assert by_sym['INFY']['stop_loss'] == 1450.0
        assert by_sym['INFY']['target_1'] == 1600.0
        os.unlink(csv_path)


class TestUnifiedSignalsDirectionFilter:
    """`_get_entry_targets`'s 3rd fallback (unified_signals) is only ever attached as a
    long-entry-style setup (entry_zone_low/high around `entry`, target above, stop below) --
    but unified_signals carries a real `signal_type` (BUY/SELL) with an inverted convention
    for SELL rows (signals.ts's own exit logic treats them oppositely). Unfiltered, a Buy-
    classified unified_recommendations row could inherit a SELL signal's short-style geometry
    for the same symbol. _get_unified_signals_latest_map must only ever surface BUY rows."""

    def test_only_buy_type_rows_surface(self):
        from unified_ranker import UnifiedRanker
        conn = make_db()
        ranker = UnifiedRanker(conn=conn, csv_path=None)

        conn.execute("""
            INSERT INTO unified_signals
            (symbol, signal_date, signal_source, signal_type, entry_price, target_price,
             stop_loss, reasoning, signal_generated_at)
            VALUES ('SELLONLY', '2026-08-05', 'test', 'SELL', 500.0, 450.0, 550.0,
                    'short-style: stop above entry, target below', datetime('now'))
        """)
        conn.execute("""
            INSERT INTO unified_signals
            (symbol, signal_date, signal_source, signal_type, entry_price, target_price,
             stop_loss, reasoning, signal_generated_at)
            VALUES ('BUYONLY', '2026-08-05', 'test', 'BUY', 100.0, 120.0, 90.0,
                    'long-style: stop below entry, target above', datetime('now'))
        """)
        conn.commit()

        m = ranker._get_unified_signals_latest_map()
        assert 'BUYONLY' in m
        assert 'SELLONLY' not in m, "a SELL-type row must never surface as an entry-targets fallback"

    def test_newer_sell_row_does_not_shadow_older_buy_row(self):
        # Guards the exact inversion scenario: if the latest signal for a symbol happens to be
        # a SELL, a naive "most recent row regardless of direction" would either surface the
        # SELL's inverted geometry or (if filtered wrong) drop the symbol entirely instead of
        # falling back to its own most recent BUY row.
        from unified_ranker import UnifiedRanker
        conn = make_db()
        ranker = UnifiedRanker(conn=conn, csv_path=None)

        conn.execute("""
            INSERT INTO unified_signals
            (symbol, signal_date, signal_source, signal_type, entry_price, target_price,
             stop_loss, reasoning, signal_generated_at)
            VALUES ('FLIP', '2026-08-01', 'test', 'BUY', 100.0, 120.0, 90.0, 'older buy',
                    '2026-08-01 09:00:00')
        """)
        conn.execute("""
            INSERT INTO unified_signals
            (symbol, signal_date, signal_source, signal_type, entry_price, target_price,
             stop_loss, reasoning, signal_generated_at)
            VALUES ('FLIP', '2026-08-05', 'test', 'SELL', 500.0, 450.0, 550.0, 'newer sell',
                    '2026-08-05 09:00:00')
        """)
        conn.commit()

        m = ranker._get_unified_signals_latest_map()
        assert 'FLIP' in m
        assert float(m['FLIP']['entry']) == 100.0, "must fall back to the latest BUY row, not the newer SELL"


class TestRiskRewardFloor:
    """Regression test for a live-confirmed bug: unlike confluence_signals (fallback 1, whose
    own buildTradeSetup() can only ever produce risk_reward in {2,3,4} by construction),
    fallback 2 (recommendation_log) and fallback 3 (unified_signals) read a genuinely
    independent entry/stop/target triple and can legitimately compute risk_reward < 1. Live
    production had 17 Buy/Strong-Buy unified_recommendations rows since 2026-07-01 presenting
    a sub-1 R:R (e.g. 0.69) as an actionable long setup -- all traceable to fallback 3 via its
    hardcoded 'SWING' timeframe literal. _get_entry_targets must fall through to the next
    source (and ultimately the geometry-free default) rather than accept a sub-1 R:R."""

    def test_recommendation_log_sub_one_rr_falls_through(self):
        from unified_ranker import UnifiedRanker
        conn = make_db()
        ranker = UnifiedRanker(conn=conn, csv_path=None)

        # entry=100, stop=90 (risk=10), target=105 (reward=5) -> rr=0.5, must be rejected
        conn.execute("INSERT INTO recommendation_log (symbol, signal_date, entry_price, generated_at) "
                     "VALUES ('BADRR', '2026-08-01', 100.0, datetime('now'))")
        conn.execute("UPDATE recommendation_log SET stop_loss=90.0, target_1=105.0 WHERE symbol='BADRR'")
        conn.commit()

        rec_log_map = ranker._get_rec_log_latest_map()
        et = ranker._get_entry_targets('BADRR', {}, rec_log_map, {}, {})
        assert et['entry_zone_low'] is None
        assert et['stop_loss'] is None
        assert et['target_1'] is None
        assert et['risk_reward'] is None

    def test_recommendation_log_healthy_rr_still_returned(self):
        # Guard against over-rejecting: a genuine >=1 R:R from this same source must pass
        # through unchanged.
        from unified_ranker import UnifiedRanker
        conn = make_db()
        ranker = UnifiedRanker(conn=conn, csv_path=None)

        # entry=100, stop=90 (risk=10), target=120 (reward=20) -> rr=2.0
        conn.execute("INSERT INTO recommendation_log (symbol, signal_date, entry_price, generated_at) "
                     "VALUES ('GOODRR', '2026-08-01', 100.0, datetime('now'))")
        conn.execute("UPDATE recommendation_log SET stop_loss=90.0, target_1=120.0 WHERE symbol='GOODRR'")
        conn.commit()

        rec_log_map = ranker._get_rec_log_latest_map()
        et = ranker._get_entry_targets('GOODRR', {}, rec_log_map, {}, {})
        assert et['stop_loss'] == 90.0
        assert et['target_1'] == 120.0
        assert et['risk_reward'] == 2.0

    def test_unified_signals_sub_one_rr_falls_through_to_default(self):
        # Matches the live PAR row exactly: production stored entry_zone_low=89.46,
        # entry_zone_high=91.26, stop_loss=87.18, target_1=92.54, risk_reward=0.69 -- the raw
        # entry_price is entry_zone_high/1.01 (entry_zone_* is ep*0.99/ep*1.01), not the zone
        # bound itself. rr = (92.54-90.356)/(90.356-87.18) = 2.184/3.176 = 0.6877 -> 0.69.
        from unified_ranker import UnifiedRanker
        conn = make_db()
        ranker = UnifiedRanker(conn=conn, csv_path=None)

        conn.execute("""
            INSERT INTO unified_signals
            (symbol, signal_date, signal_source, signal_type, entry_price, target_price,
             stop_loss, reasoning, signal_generated_at)
            VALUES ('PAR', '2026-07-05', 'test', 'BUY', 90.356, 92.54, 87.18, 'weak setup',
                    datetime('now'))
        """)
        conn.commit()

        unified_map = ranker._get_unified_signals_latest_map()
        et = ranker._get_entry_targets('PAR', {}, {}, unified_map, {'PAR': 'Financials'})
        # falls all the way through to fallback 4 -- no geometry, but sector is preserved
        assert et['entry_zone_low'] is None
        assert et['stop_loss'] is None
        assert et['risk_reward'] is None
        assert et['sector'] == 'Financials'

    def test_recommendation_log_bad_rr_falls_through_to_unified_signals(self):
        # A sub-1 R:R at fallback 2 must not stop the search -- a healthy fallback 3 row for
        # the same symbol should still be used.
        from unified_ranker import UnifiedRanker
        conn = make_db()
        ranker = UnifiedRanker(conn=conn, csv_path=None)

        conn.execute("INSERT INTO recommendation_log (symbol, signal_date, entry_price, generated_at) "
                     "VALUES ('CASCADE', '2026-08-01', 100.0, datetime('now'))")
        conn.execute("UPDATE recommendation_log SET stop_loss=90.0, target_1=105.0 WHERE symbol='CASCADE'")
        conn.execute("""
            INSERT INTO unified_signals
            (symbol, signal_date, signal_source, signal_type, entry_price, target_price,
             stop_loss, reasoning, signal_generated_at)
            VALUES ('CASCADE', '2026-08-01', 'test', 'BUY', 50.0, 60.0, 45.0, 'healthy setup',
                    datetime('now'))
        """)
        conn.commit()

        rec_log_map = ranker._get_rec_log_latest_map()
        unified_map = ranker._get_unified_signals_latest_map()
        et = ranker._get_entry_targets('CASCADE', {}, rec_log_map, unified_map, {})
        assert et['stop_loss'] == 45.0
        assert et['target_1'] == 60.0
        assert et['risk_reward'] == 2.0


class TestConfluenceUrlSymbolGuard:
    """Regression test: confluence_signals briefly accumulated rows where `symbol`
    was a raw Trendlyne URL (root cause: a since-fixed trendlyne_screener_discovery.py
    bug). Those rows fed straight into unified_recommendations via the union of engine
    score-map keys in run() — ~67% of daily output was corrupted by this. Both
    _get_confluence_scores and _get_confluence_latest_map must reject URL-shaped
    symbols so a URL-keyed row can never again reach unified_recommendations, even
    if a legacy row lingers in confluence_signals."""

    def _setup_with_confluence(self, rows):
        conn = make_db()
        csv_path = make_csv([
            {'source': 'trendlyne', 'screener_id': 'bull1', 'screener_name': 'Bull Breakout',
             'category': 'technical_breakout', 'subcategory': 'price_breakout',
             'signal_bias': 'bullish', 'investment_horizon': 'swing', 'confidence': '0.82'},
        ])
        from unified_ranker import UnifiedRanker
        ranker = UnifiedRanker(conn=conn, csv_path=csv_path)
        ranker.seed_screener_catalog()
        conn.execute("INSERT INTO market_regimes (date, regime, regime_prob) VALUES (date('now'),'BULL',0.8)")
        for symbol, score in rows:
            conn.execute(
                "INSERT INTO confluence_signals (symbol, computed_at, confluence_score) VALUES (?, datetime('now'), ?)",
                (symbol, score),
            )
        conn.commit()
        return ranker, conn, csv_path

    def test_url_shaped_symbol_excluded_from_scores_map(self):
        ranker, conn, csv_path = self._setup_with_confluence([
            ('https://trendlyne.com/equity/108994/541945/RANJEET-MECHATRONICS-LTD/', 22),
            ('INFY', 45),
        ])
        scores = ranker._get_confluence_scores()
        assert 'INFY' in scores
        assert not any('://' in s for s in scores)
        os.unlink(csv_path)

    def test_url_shaped_symbol_excluded_from_latest_map(self):
        ranker, conn, csv_path = self._setup_with_confluence([
            ('https://trendlyne.com/equity/929/NESCO/NESCO-LTD/', 3),
            ('INFY', 45),
        ])
        latest = ranker._get_confluence_latest_map()
        assert 'INFY' in latest
        assert not any('://' in s for s in latest)
        os.unlink(csv_path)

    def test_url_shaped_symbol_never_reaches_unified_recommendations(self):
        ranker, conn, csv_path = self._setup_with_confluence([
            ('https://trendlyne.com/equity/144996/13520889/BMW-INDUSTRIES-LTD/', 3),
        ])
        ranker.run()
        rows = conn.execute('SELECT symbol FROM unified_recommendations').fetchall()
        assert not any('://' in r['symbol'] for r in rows)
        os.unlink(csv_path)


class TestConfluenceScoresDecorrelation:
    """2026-08-05 fix (screener double-counting finding): the 'confluence' engine used to read
    confluence_signals.confluence_score directly -- screenerComponent(0-60) + trend(0-15) +
    volume(0-10) + sector(0-8) + fundamental(0-12) (confluenceEngine.ts's scoreStock()) -- up
    to 60 of its own ~105 raw points is the SAME screener membership the separate 'screener'
    engine (20-40% weight) already counts in full. It must now read only the four persisted
    non-screener sub-score columns, so the 8-engine blend has one fewer correlated pair."""

    def _seed(self, conn, symbol, confluence_score, trend=0, vol=0, sector=0, fund=0):
        conn.execute(
            "INSERT INTO confluence_signals "
            "(symbol, computed_at, confluence_score, trend_alignment_score, volume_score, "
            " sector_strength_score, fundamental_score) VALUES (?, datetime('now'), ?, ?, ?, ?, ?)",
            (symbol, confluence_score, trend, vol, sector, fund),
        )
        conn.commit()

    def test_ignores_the_screener_driven_total_score(self):
        """A stock whose confluence_score is almost entirely the screener component must NOT
        score near the top once that component is excluded -- its real non-screener
        confirmation (trend+vol+sector+fund) is tiny."""
        from unified_ranker import UnifiedRanker
        conn = make_db()
        ranker = UnifiedRanker(conn=conn)
        # A: confluence_score is almost entirely screener-driven (60 of 62 raw points).
        self._seed(conn, 'A', confluence_score=62, trend=1, vol=1, sector=0, fund=0)
        # B: LOWER overall confluence_score, but its non-screener confirmation is much
        # stronger (real trend/volume/sector/fundamental evidence, little screener credit).
        self._seed(conn, 'B', confluence_score=40, trend=15, vol=10, sector=8, fund=12)

        scores = ranker._get_confluence_scores()
        assert scores['B'] > scores['A']

    def test_sums_exactly_the_four_non_screener_columns(self):
        from unified_ranker import UnifiedRanker
        conn = make_db()
        ranker = UnifiedRanker(conn=conn)
        self._seed(conn, 'A', confluence_score=999, trend=5, vol=3, sector=2, fund=1)  # 999 ignored
        self._seed(conn, 'B', confluence_score=0,   trend=0, vol=0, sector=0, fund=0)
        scores = ranker._get_confluence_scores()
        # _normalize_to_100's percentile-rank formula (less + 0.5*equal)/n*100 -- for 2 distinct
        # values that's 75/25, not a naive 100/0 -- what matters here is A's real sub-score sum
        # (11) ranks ABOVE B's (0) despite A's wildly larger (and ignored) confluence_score.
        assert scores['A'] == pytest.approx(75.0)
        assert scores['B'] == pytest.approx(25.0)
        assert scores['A'] > scores['B']

    def test_null_sub_score_columns_treated_as_zero_not_excluded(self):
        """A row written before this fix (or by any writer that only ever sets
        confluence_score) has NULL sub-score columns -- these must be treated as zero
        contribution, not silently dropped or crash the query."""
        from unified_ranker import UnifiedRanker
        conn = make_db()
        ranker = UnifiedRanker(conn=conn)
        conn.execute(
            "INSERT INTO confluence_signals (symbol, computed_at, confluence_score) "
            "VALUES ('LEGACY', datetime('now'), 50)"
        )
        self._seed(conn, 'REAL', confluence_score=20, trend=15, vol=10, sector=8, fund=12)
        conn.commit()
        scores = ranker._get_confluence_scores()
        assert 'LEGACY' in scores and 'REAL' in scores
        assert scores['REAL'] > scores['LEGACY']  # REAL's real sub-scores beat LEGACY's all-NULL 0


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

    def test_classify_direction_comes_from_score_not_screeners(self):
        """The retirement, pinned. Screener imbalance measured -0.440% t=-5.14 excess at 21d
        as a direction source; it no longer votes. Identical score => identical label no
        matter how lopsided the screener opinion is."""
        from unified_ranker import _classify
        # (0, 0) is deliberately absent: an UNCOVERED name is Hold at any score -- that is the
        # coverage half of the merged rule, pinned separately below.
        for bull, bear in [(8, 0), (0, 8), (3, 3), (5, 1), (1, 5)]:
            assert _classify(85.0, bull, bear) == 'Strong Buy'
            assert _classify(75.0, bull, bear) == 'Buy'
            assert _classify(50.0, bull, bear) == 'Hold'
            assert _classify(25.0, bull, bear) == 'Sell'
            assert _classify(15.0, bull, bear) == 'Strong Sell'

    def test_classify_never_buys_a_bottom_ranked_score(self):
        """The specific old defect: a net-bullish screener count made a score of 5 a 'Buy'
        because the score only gated the Strong tier. That is how a 'Buy' label ended up
        underperforming the universe by 1.7pp over 21 days."""
        from unified_ranker import _classify
        assert _classify(5.0, bull=9, bear=0) == 'Strong Sell'
        assert _classify(95.0, bull=0, bear=9) == 'Strong Buy'

    def test_classify_thresholds_are_pinned(self):
        """Thresholds asserted on a COVERED name (1, 1): coverage is required to label at
        all, so (0, 0) would be Hold at every score and pin nothing."""
        from unified_ranker import (_classify, DIRECTIONLESS_STRONG_BUY_FLOOR,
                                    DIRECTIONLESS_BUY_FLOOR, DIRECTIONLESS_SELL_CEIL,
                                    DIRECTIONLESS_STRONG_SELL_CEIL)
        assert _classify(DIRECTIONLESS_STRONG_BUY_FLOOR, 1, 1) == 'Strong Buy'
        assert _classify(DIRECTIONLESS_BUY_FLOOR, 1, 1) == 'Buy'
        assert _classify(DIRECTIONLESS_BUY_FLOOR - 0.01, 1, 1) == 'Hold'
        assert _classify(DIRECTIONLESS_SELL_CEIL, 1, 1) == 'Sell'
        assert _classify(DIRECTIONLESS_SELL_CEIL + 0.01, 1, 1) == 'Hold'
        assert _classify(DIRECTIONLESS_STRONG_SELL_CEIL, 1, 1) == 'Strong Sell'

    def test_uncovered_name_is_hold_at_any_score(self):
        """The coverage half of the merged rule: unified_score ranks returns within the
        screener-covered population (IC +0.0241, t=+2.36) and NOT outside it (-0.0150,
        t=-1.51), so a name no screener surfaced is not labelled on score alone."""
        from unified_ranker import _classify
        for score in (0.0, 25.0, 50.0, 75.0, 100.0):
            assert _classify(score, 0, 0) == 'Hold'

    def test_screener_direction_machinery_is_gone_not_just_bypassed(self):
        """A dormant flag reads as if it still works. The whole directionless-fallback
        mechanism is retired, so nothing should be able to switch screener direction back on."""
        import unified_ranker as ur
        import inspect
        assert not hasattr(ur, 'is_directionless_fallback_enabled')
        assert 'directionless_fallback' not in inspect.signature(ur._classify).parameters



class TestIsEngineEdgeAdjustmentEnabled:
    """Separate flag from is_directionless_fallback_enabled/is_edge_adjustment_enabled --
    same off-by-default convention, different mechanism (engine blend-weight shrinkage)."""

    class _FakeConn:
        def __init__(self, value=None):
            self._value = value
        def execute(self, sql, params=()):
            return self
        def fetchone(self):
            return None if self._value is None else {'value': self._value}

    def test_missing_row_is_disabled(self):
        from unified_ranker import is_engine_edge_adjustment_enabled
        assert is_engine_edge_adjustment_enabled(self._FakeConn(None)) is False

    def test_explicit_true_value_is_enabled(self):
        from unified_ranker import is_engine_edge_adjustment_enabled
        assert is_engine_edge_adjustment_enabled(self._FakeConn('true')) is True

    def test_query_failure_defaults_to_disabled(self):
        from unified_ranker import is_engine_edge_adjustment_enabled
        class _BrokenConn:
            def execute(self, sql, params=()):
                raise RuntimeError('no app_settings table')
        assert is_engine_edge_adjustment_enabled(_BrokenConn()) is False


class TestLoadEngineEdgeVerdicts:
    """load_engine_edge_verdicts reads the latest factor_edge_history run per engine,
    falling back from the regime-specific row to 'ALL' when no regime-specific row exists."""

    class _FakeConn:
        def __init__(self, run_at, rows: dict):
            self._run_at = run_at
            self._rows = rows   # (score_col, horizon, regime) -> verdict
            self._pending = None

        def execute(self, sql, params=()):
            if 'MAX(run_at)' in sql:
                self._pending = ('run_at',)
            elif "regime = 'ALL'" in sql:
                # ALL-fallback query: params = (run_at, score_col, horizon)
                self._pending = ('verdict', params[1], params[2], 'ALL')
            elif 'score_col' in sql:
                # regime-specific query: params = (run_at, score_col, horizon, regime)
                self._pending = ('verdict', params[1], params[2], params[3])
            return self

        def fetchone(self):
            if self._pending == ('run_at',):
                return {'r': self._run_at}
            _, col, horizon, regime = self._pending
            v = self._rows.get((col, horizon, regime))
            return {'verdict': v} if v is not None else None

    def test_no_history_returns_empty(self):
        from unified_ranker import load_engine_edge_verdicts
        conn = self._FakeConn(None, {})
        assert load_engine_edge_verdicts(conn, 'BULL') == {}

    def test_reads_regime_specific_verdict(self):
        from unified_ranker import load_engine_edge_verdicts
        conn = self._FakeConn('2026-08-09T00:00:00', {
            ('screener_stock_score', 5, 'BULL'): 'USABLE',
        })
        out = load_engine_edge_verdicts(conn, 'BULL')
        assert out['screener'] == 'USABLE'

    def test_falls_back_to_all_when_regime_row_missing(self):
        from unified_ranker import load_engine_edge_verdicts
        conn = self._FakeConn('2026-08-09T00:00:00', {
            ('ml_score', 5, 'ALL'): 'no edge',
        })
        out = load_engine_edge_verdicts(conn, 'CRASH')
        assert out['ml'] == 'no edge'

    def test_missing_everywhere_is_none(self):
        from unified_ranker import load_engine_edge_verdicts
        conn = self._FakeConn('2026-08-09T00:00:00', {})
        out = load_engine_edge_verdicts(conn, 'BULL')
        assert out['dl'] is None

    def test_query_failure_returns_empty(self):
        from unified_ranker import load_engine_edge_verdicts
        class _BrokenConn:
            def execute(self, sql, params=()):
                raise RuntimeError('no factor_edge_history table')
        assert load_engine_edge_verdicts(_BrokenConn(), 'BULL') == {}


class TestEdgeAdjustedWeights:
    """Pure function: shrinks only 'no edge' engines, leaves LOW-DATA/USABLE/unmeasured
    untouched, and always renormalizes back to the base weights' original sum."""

    def test_no_edge_engine_shrunk(self):
        from unified_ranker import edge_adjusted_weights, ENGINE_EDGE_SHRINK
        base = {'screener': 0.4, 'ml': 0.3, 'technical': 0.3}
        out = edge_adjusted_weights(base, {'ml': 'no edge'})
        # ml's raw share shrinks by ENGINE_EDGE_SHRINK before renormalization
        assert out['ml'] < base['ml']
        assert out['screener'] > base['screener']   # absorbs the freed-up share

    def test_low_data_and_usable_untouched_relative_to_each_other(self):
        from unified_ranker import edge_adjusted_weights
        base = {'screener': 0.5, 'ml': 0.5}
        out = edge_adjusted_weights(base, {'screener': 'LOW-DATA', 'ml': 'USABLE'})
        assert out == base   # neither is 'no edge' -> pure no-op, no renormalization drift

    def test_none_verdict_is_untouched(self):
        from unified_ranker import edge_adjusted_weights
        base = {'screener': 0.6, 'ml': 0.4}
        assert edge_adjusted_weights(base, {}) == base

    def test_renormalizes_to_original_sum(self):
        from unified_ranker import edge_adjusted_weights
        base = {'a': 0.3, 'b': 0.3, 'c': 0.2, 'd': 0.2}
        out = edge_adjusted_weights(base, {'a': 'no edge', 'b': 'no edge'})
        assert abs(sum(out.values()) - sum(base.values())) < 1e-9

    def test_all_engines_no_edge_falls_back_to_base(self):
        from unified_ranker import edge_adjusted_weights
        base = {'a': 0.5, 'b': 0.5}
        out = edge_adjusted_weights(base, {'a': 'no edge', 'b': 'no edge'})
        # shrinking everyone equally is a no-op after renormalization -- shape preserved
        assert out == base


class TestEngineEdgeAdjustmentDisabledByDefault:
    """Regression for the incident this whole mechanism responds to: shipping the
    measurement (factor_edge.py against unified_recommendations) must never, by itself,
    change a live run's blend weights. Only an explicit opt-in flag can."""

    def test_run_never_calls_edge_adjusted_weights_without_the_flag(self, monkeypatch):
        import unified_ranker as ur
        monkeypatch.setattr(ur, 'is_engine_edge_adjustment_enabled', lambda conn: False)
        called = {'n': 0}
        monkeypatch.setattr(ur, 'edge_adjusted_weights', lambda *a, **k: called.__setitem__('n', called['n'] + 1) or a[0])
        # Exercise the exact guard line in run() in isolation, mirroring how it's written there.
        if ur.is_engine_edge_adjustment_enabled(None):
            ur.edge_adjusted_weights({}, {})
        assert called['n'] == 0


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


# ── Correlation-cluster exposure cap (#27/#30 follow-up, 2026-08-05) ────────────────────

def _dates(n):
    return [f"2026-06-{d:02d}" for d in range(1, n + 1)]


class TestPearson:
    def test_perfect_positive_correlation(self):
        from unified_ranker import _pearson
        a = [1.0, 2.0, 3.0, 4.0, 5.0]
        b = [2.0, 4.0, 6.0, 8.0, 10.0]  # pure positive scaling of a
        assert _pearson(a, b) == pytest.approx(1.0)

    def test_perfect_negative_correlation(self):
        from unified_ranker import _pearson
        a = [1.0, 2.0, 3.0, 4.0, 5.0]
        b = [5.0, 4.0, 3.0, 2.0, 1.0]
        assert _pearson(a, b) == pytest.approx(-1.0)

    def test_zero_variance_series_returns_none(self):
        from unified_ranker import _pearson
        # A circuit-locked/flat stretch has zero variance -- correlation is undefined, not 0.
        assert _pearson([1.0, 1.0, 1.0], [1.0, 2.0, 3.0]) is None

    def test_mismatched_length_returns_none(self):
        from unified_ranker import _pearson
        assert _pearson([1.0, 2.0], [1.0, 2.0, 3.0]) is None


class TestClusterByCorrelation:
    def test_groups_highly_correlated_symbols(self):
        from unified_ranker import cluster_by_correlation
        dates = _dates(25)
        base = [((-1) ** i) * (i % 5 + 1) * 0.01 for i in range(25)]
        returns = {
            'A': dict(zip(dates, base)),
            'B': dict(zip(dates, [v * 1.5 for v in base])),  # scaled copy of A -> corr 1.0
            'C': dict(zip(dates, [(-1) ** (i + 1) for i in range(25)])),  # unrelated pattern
        }
        clusters = cluster_by_correlation(returns, threshold=0.65, min_overlap=10)
        assert clusters.get('A') == clusters.get('B')
        assert clusters.get('A') is not None
        # C's pattern is deliberately uncorrelated with A/B and must not be swept in.
        assert 'C' not in clusters

    def test_respects_min_overlap_even_with_matching_values(self):
        from unified_ranker import cluster_by_correlation
        # A and B share only 5 overlapping dates -- below min_overlap=20 -- even though those
        # shared points would otherwise look perfectly correlated.
        shared = dict(zip(_dates(5), [0.01, 0.02, -0.01, 0.03, -0.02]))
        a = dict(shared)
        b = dict(shared)
        for i, d in enumerate(_dates(30)[5:25]):
            a[d] = 0.001 * i
        clusters = cluster_by_correlation({'A': a, 'B': b}, min_overlap=20)
        assert clusters == {}

    def test_ignores_positionally_similar_but_date_disjoint_series(self):
        """Two symbols with IDENTICAL return sequences but on completely disjoint calendar
        dates must not be clustered -- proves alignment is by date, not by list position.
        A naive positional zip() of the two series would report correlation 1.0."""
        from unified_ranker import cluster_by_correlation
        values = [0.01, -0.02, 0.03, 0.015, -0.01, 0.02, -0.015, 0.01, 0.005, -0.02,
                  0.01, -0.02, 0.03, 0.015, -0.01, 0.02, -0.015, 0.01, 0.005, -0.02]
        a_dates = _dates(20)                    # 2026-06-01 .. 2026-06-20
        b_dates = [f"2026-07-{d:02d}" for d in range(1, 21)]  # 2026-07-01 .. 2026-07-20
        clusters = cluster_by_correlation(
            {'A': dict(zip(a_dates, values)), 'B': dict(zip(b_dates, values))},
            min_overlap=10,
        )
        assert clusters == {}

    def test_below_threshold_correlation_not_clustered(self):
        from unified_ranker import cluster_by_correlation
        dates = _dates(25)
        a = dict(zip(dates, [0.01 * ((i % 7) - 3) for i in range(25)]))
        b = dict(zip(dates, [0.01 * (((i * 3) % 7) - 3) for i in range(25)]))
        clusters = cluster_by_correlation({'A': a, 'B': b}, threshold=0.99, min_overlap=10)
        assert clusters == {}


class TestApplyCorrelationCap:
    def test_scales_down_over_cap_cluster_proportionally(self):
        from unified_ranker import apply_correlation_cap
        weights = {'A': 0.10, 'B': 0.10, 'C': 0.10}
        clusters = {'A': 0, 'B': 0, 'C': 0}  # all one correlated cluster, total 0.30
        out = apply_correlation_cap(weights, clusters, cap=0.15)
        assert sum(out.values()) == pytest.approx(0.15)
        # proportional: each started equal, so each still ends up equal post-scale
        assert out['A'] == pytest.approx(out['B']) == pytest.approx(out['C'])

    def test_leaves_ungrouped_symbols_untouched(self):
        from unified_ranker import apply_correlation_cap
        weights = {'A': 0.10, 'B': 0.10, 'Z': 0.09}
        clusters = {'A': 0, 'B': 0}  # Z has no correlated peer -> absent from clusters
        out = apply_correlation_cap(weights, clusters, cap=0.15)
        assert out['Z'] == pytest.approx(0.09)  # unchanged

    def test_never_increases_weight(self):
        from unified_ranker import apply_correlation_cap
        weights = {'A': 0.05, 'B': 0.05}
        clusters = {'A': 0, 'B': 0}  # total 0.10, under the 0.35 default cap
        out = apply_correlation_cap(weights, clusters)
        assert out['A'] == pytest.approx(0.05)
        assert out['B'] == pytest.approx(0.05)

    def test_under_cap_cluster_is_a_no_op(self):
        from unified_ranker import apply_correlation_cap
        weights = {'A': 0.05, 'B': 0.05, 'C': 0.05}
        clusters = {'A': 0, 'B': 0, 'C': 0}
        out = apply_correlation_cap(weights, clusters, cap=0.35)
        assert out == {'A': 0.05, 'B': 0.05, 'C': 0.05}


class TestGetRecentReturns:
    def _seed_ohlcv(self, conn, symbol, closes, start_day=1, suspect_days=()):
        for i, c in enumerate(closes):
            day = start_day + i
            conn.execute(
                "INSERT INTO stock_ohlcv (symbol, date, close, is_suspect) VALUES (?, ?, ?, ?)",
                (symbol, f"2026-06-{day:02d}", c, 1 if day in suspect_days else 0),
            )
        conn.commit()

    def test_computes_day_over_day_pct_returns_keyed_by_date(self):
        from unified_ranker import UnifiedRanker
        conn = make_db()
        self._seed_ohlcv(conn, 'A', [100.0, 110.0, 99.0])
        ranker = UnifiedRanker(conn=conn)
        out = ranker._get_recent_returns(['A'])
        assert out['A']['2026-06-02'] == pytest.approx(0.10)
        assert out['A']['2026-06-03'] == pytest.approx((99.0 - 110.0) / 110.0)
        # first day has no prior close, so it never appears as a return date
        assert '2026-06-01' not in out['A']

    def test_excludes_suspect_bars(self):
        """A flagged impossible-move bar (2026-07-30/31 bad-bar-quarantine convention) must
        not be able to manufacture a spurious return -- neither as the return INTO it nor as
        the base a later return is computed FROM."""
        from unified_ranker import UnifiedRanker
        conn = make_db()
        self._seed_ohlcv(conn, 'A', [100.0, 100.0, 5000.0, 101.0], suspect_days=[3])
        ranker = UnifiedRanker(conn=conn)
        out = ranker._get_recent_returns(['A'])
        # the suspect day (2026-06-03, close=5000.0) never appears as a return date at all --
        # a naive impl would report a fabricated +4900% move into it.
        assert '2026-06-03' not in out['A']
        # the next good bar's return is computed against the last known-GOOD close (day 2,
        # 100.0), not against the excluded suspect close -- (101-100)/100, not (101-5000)/5000.
        assert out['A']['2026-06-04'] == pytest.approx(0.01)

    def test_missing_symbol_returns_empty_dict(self):
        from unified_ranker import UnifiedRanker
        conn = make_db()
        ranker = UnifiedRanker(conn=conn)
        assert ranker._get_recent_returns(['NOPE']) == {}

    def test_no_symbols_short_circuits_without_query(self):
        from unified_ranker import UnifiedRanker
        conn = make_db()
        ranker = UnifiedRanker(conn=conn)
        assert ranker._get_recent_returns([]) == {}


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


# ── _get_ml_scores: per-row regime edge adjustment (2026-08-10) ─────────────────
# Live-traced finding: HIGH_VOL's own isotonic calibrator collapsed calibrated_win_probability
# to a near-constant ~0.78 for 90% of the universe -- correctly reflecting HIGH_VOL's own live
# AUC of ~0.518 (no real edge). _get_win_probabilities (sizing) already shrank this correctly;
# _get_ml_scores (feeding the canonical RANKING/CLASSIFICATION blend) did not. Same fixture
# pattern as _get_win_probabilities' own tests above.

def test_get_ml_scores_flag_off_is_plain_average():
    from unified_ranker import UnifiedRanker
    conn = make_db()
    _seed_edge_status_row(conn, 'BULL', auc=0.50, ready=True)  # present but flag is off
    conn.execute("INSERT INTO technical_signals (symbol, date, win_probability, nifty_regime) "
                 "VALUES ('X', date('now'), 0.85, 'BULL')")
    conn.commit()
    ranker = UnifiedRanker(conn=conn)
    scores = ranker._get_ml_scores()
    assert scores['X'] == pytest.approx(85.0)   # unchanged -- flag off, no per-row adjustment


def test_get_ml_scores_edge_adjusts_per_row_regime_when_enabled():
    from unified_ranker import UnifiedRanker
    conn = make_db()
    conn.execute("INSERT INTO app_settings (key, value) VALUES ('edge_adjustment_enabled', 'true')")
    # 0.518 is the live-measured HIGH_VOL AUC (2026-08-09) -- essentially chance (AUC_RANDOM=0.50),
    # so this is PARTIAL trust (weight=(0.518-0.50)/(0.55-0.50)=0.36), not a full shrink to 50.
    _seed_edge_status_row(conn, 'HIGH_VOL', auc=0.518, ready=True)
    _seed_edge_status_row(conn, 'BEAR', auc=0.61, ready=True)       # proven edge
    conn.execute("INSERT INTO technical_signals (symbol, date, win_probability, nifty_regime) "
                 "VALUES ('HVSYM', date('now'), 0.78, 'HIGH_VOL')")
    conn.execute("INSERT INTO technical_signals (symbol, date, win_probability, nifty_regime) "
                 "VALUES ('BEARSYM', date('now'), 0.72, 'BEAR')")
    conn.commit()
    ranker = UnifiedRanker(conn=conn)
    scores = ranker._get_ml_scores()
    assert scores['HVSYM'] == pytest.approx(60.08)   # 0.5 + 0.36*(0.78-0.5) = 0.6008, ×100
    assert scores['BEARSYM'] == pytest.approx(72.0)  # unchanged -- BEAR has proven edge


def test_get_ml_scores_high_vol_uses_its_own_auc_not_bears():
    """Live bug, 2026-08-10 (regime_edge_weight): HIGH_VOL used to collapse straight to BEAR's
    key BEFORE ever checking edge_status, so it silently borrowed BEAR's proven edge instead of
    its own. With BEAR's AUC clearly above the trust floor and HIGH_VOL's clearly at/below the
    random baseline, this proves HIGH_VOL's OWN (no-edge) row is what actually gets used."""
    from unified_ranker import UnifiedRanker
    conn = make_db()
    conn.execute("INSERT INTO app_settings (key, value) VALUES ('edge_adjustment_enabled', 'true')")
    _seed_edge_status_row(conn, 'HIGH_VOL', auc=0.50, ready=True)  # exactly chance -> weight=0
    _seed_edge_status_row(conn, 'BEAR', auc=0.65, ready=True)      # strong proven edge
    conn.execute("INSERT INTO technical_signals (symbol, date, win_probability, nifty_regime) "
                 "VALUES ('HVSYM', date('now'), 0.90, 'HIGH_VOL')")
    conn.commit()
    ranker = UnifiedRanker(conn=conn)
    scores = ranker._get_ml_scores()
    # If HIGH_VOL still collapsed to BEAR's key, weight would be 1.0 and this would read 90.0.
    assert scores['HVSYM'] == pytest.approx(50.0), (
        "HIGH_VOL must use its own AUC (weight=0, full shrink to neutral), "
        "not silently borrow BEAR's proven-edge weight"
    )


def test_get_ml_scores_nan_guard_still_applies_with_edge_adjustment():
    """The per-row NaN guard (matching _get_win_probabilities' identical one) must still fire
    even when edge-adjustment is enabled -- a NaN calibrated_win_probability must never reach
    edge_adjusted_probability() or the acc[] accumulator."""
    from unified_ranker import UnifiedRanker
    conn = make_db()
    conn.execute("INSERT INTO app_settings (key, value) VALUES ('edge_adjustment_enabled', 'true')")
    _seed_edge_status_row(conn, 'HIGH_VOL', auc=0.518, ready=True)
    conn.execute("INSERT INTO technical_signals (symbol, date, win_probability, nifty_regime) "
                 "VALUES ('NANSYM', date('now'), 'NaN', 'HIGH_VOL')")
    conn.commit()
    ranker = UnifiedRanker(conn=conn)
    scores = ranker._get_ml_scores()
    assert 'NANSYM' not in scores


class TestBuyFloorSelectivityReporting:
    """The Buy floor is an ABSOLUTE cut on a score scale that is demonstrably not
    stationary: live 2026-08-09 -> 08-10 the same floor selected 15.6% then 1.2% of the
    universe, a 13x swing caused entirely by two unrelated engine fixes landing that day
    (LSTM v4->v3 rollback, ml edge adjustment), not by anything in the Buy rule.

    No score cut has measurable edge over the 30 dates with forward returns, so the floor
    is deliberately NOT recalibrated -- but the drift is made visible so the next such
    shift is caught on the day it happens rather than weeks later."""

    @staticmethod
    def _ur():
        import unified_ranker as ur
        return ur

    def _rows(self, n_buy, n_other):
        return ([{'classification': 'Buy'}] * n_buy) + ([{'classification': 'Hold'}] * n_other)

    def test_reports_fraction_and_warns_when_far_too_few_buys(self, capsys):
        # The real 2026-08-10 shape: 22 of 1842 cleared the floor.
        frac = self._ur()._report_buy_floor_selectivity(self._rows(22, 1820))
        out = capsys.readouterr().out
        assert abs(frac - 22 / 1842) < 1e-9
        assert 'buy-floor selectivity' in out
        assert 'WARNING' in out, "a 1.2% selectivity must trip the tripwire"

    def test_no_warning_inside_the_expected_band(self, capsys):
        # The pre-drift shape: ~33% of the universe actionable.
        frac = self._ur()._report_buy_floor_selectivity(self._rows(600, 1200))
        out = capsys.readouterr().out
        assert 0.32 < frac < 0.34
        assert 'buy-floor selectivity' in out
        assert 'WARNING' not in out

    def test_warns_when_far_too_many_buys(self, capsys):
        self._ur()._report_buy_floor_selectivity(self._rows(900, 100))
        assert 'WARNING' in capsys.readouterr().out

    def test_empty_result_set_is_a_clean_no_op(self, capsys):
        assert self._ur()._report_buy_floor_selectivity([]) is None
        assert capsys.readouterr().out == ''

    def test_is_pure_reporting_and_never_mutates_rows(self):
        rows = self._rows(5, 5)
        before = [dict(r) for r in rows]
        self._ur()._report_buy_floor_selectivity(rows)
        assert rows == before, "reporting must never change a score, label or size"
