"""
unified_ranker.py — Regime-gated unified stock recommendation engine.

Run after market close: python unified_ranker.py
"""
import sqlite3
import json
import csv
import sys
import os
from pathlib import Path
from datetime import date


DB_PATH          = Path(__file__).parent.parent.parent / 'database.sqlite'
CSV_PATH         = Path(__file__).parent.parent.parent / 'screener_scoring_v2.csv'
CORRECTIONS_PATH = Path(__file__).parent.parent.parent / 'screener_corrections.csv'

BIAS_SIGN = {'bullish': 1.0, 'bearish': -1.0, 'neutral': 0.3}

CAT_BASE_WT = {
    'composite_strategy':      0.1287,
    'fundamental_quality':     0.1188,
    'fundamental_growth':      0.0990,
    'valuation':               0.0792,
    'technical_breakout':      0.0792,
    'ownership_institutional': 0.0693,
    'technical_momentum':      0.0693,
    'technical_trend':         0.0594,
    'analyst_sentiment':       0.0495,
    'technical_reversal':      0.0396,
    'event_corporate_action':  0.0396,
    'derivatives_positioning': 0.0297,
    'income_dividend':         0.0297,
    'risk_red_flags':          0.0297,
    'volume_liquidity':        0.0297,
    'volatility':              0.0198,
    'sector_theme':            0.0198,
    'market_cap_style':        0.0099,
    'other':                   0.0,
}

SUBCAT_MOD = {
    'multi_factor_strategy':        1.20,
    'earnings_growth':              1.15,
    'institutional_activity':       1.15,
    'capital_efficiency':           1.10,
    'revenue_growth':               1.10,
    'price_leadership':             1.10,
    'relative_strength':            1.10,
    'balance_sheet_quality':        1.05,
    'price_breakout':               1.05,
    'volume_delivery':              1.05,
    'moving_average_trend':         1.00,
    'relative_or_absolute_value':   1.00,
    'trend_indicator':              0.95,
    'earnings_event':               0.95,
    'oscillator_signal':            0.90,
    'broker_forecast':              0.90,
    'open_interest':                0.90,
    'oscillator_reversal':          0.85,
    'dividend_income':              0.85,
    'candlestick_reversal':         0.80,
    'volatility_range':             0.75,
    'sector_or_theme':              0.70,
    'corporate_action':             0.70,
    'financial_or_governance_risk': 0.60,
    'size_style':                   0.60,
}

HORIZON_MULT = {
    'intraday':   0.70,
    'swing':      0.95,
    'positional': 1.05,
    'long_term':  1.10,
}

REGIME_WEIGHTS = {
    'BULL':     {'screener': 0.30, 'ml': 0.25, 'confluence': 0.20, 'technical': 0.15, 'dl': 0.10},
    'BEAR':     {'screener': 0.35, 'ml': 0.25, 'confluence': 0.20, 'technical': 0.10, 'dl': 0.10},
    'HIGH_VOL': {'screener': 0.20, 'ml': 0.20, 'confluence': 0.15, 'technical': 0.30, 'dl': 0.15},
    'CRASH':    {'screener': 0.40, 'ml': 0.25, 'confluence': 0.15, 'technical': 0.10, 'dl': 0.10},
}

CONVICTION_TIERS = [
    ('S_ELITE',    80),
    ('A_HIGH',     65),
    ('B_MEDIUM',   45),
    ('C_LOW',      25),
    ('D_MARGINAL',  1),
]


def _fund_mult(score):
    if score is None:
        return 1.0
    if score > 70:
        return 1.3
    if score < 40:
        return 0.7
    return 1.0


def _normalize_to_100(raw):
    if not raw:
        return {}
    values = list(raw.values())
    lo, hi = min(values), max(values)
    span = hi - lo
    if span == 0:
        return {k: 50.0 for k in raw}
    return {k: (v - lo) / span * 100 for k, v in raw.items()}


def _conviction(score):
    for tier, threshold in CONVICTION_TIERS:
        if score >= threshold:
            return tier
    return 'D_MARGINAL'


def compute_screener_stock_scores(membership, fundamental_scores):
    """
    Pure function — no DB access.
    membership: {symbol: [{signal_bias, confidence, category, subcategory, investment_horizon}]}
    Returns: (normalized_scores_0_100, bullish_counts, bearish_counts)
    """
    raw = {}
    bullish_counts = {}
    bearish_counts = {}

    for sym, screeners in membership.items():
        fm = _fund_mult(fundamental_scores.get(sym))
        contrib = sum(
            BIAS_SIGN.get(s['signal_bias'], 0.0)
            * CAT_BASE_WT.get(s['category'], 0.0)
            * SUBCAT_MOD.get(s.get('subcategory', ''), 1.0)
            * HORIZON_MULT.get(s.get('investment_horizon', 'swing'), 0.95)
            * float(s.get('confidence', 0.74))
            for s in screeners
        )
        raw[sym] = contrib * fm
        bullish_counts[sym] = sum(1 for s in screeners if s['signal_bias'] == 'bullish')
        bearish_counts[sym] = sum(1 for s in screeners if s['signal_bias'] == 'bearish')

    return _normalize_to_100(raw), bullish_counts, bearish_counts


class UnifiedRanker:
    def __init__(self, conn=None, csv_path=None, corrections_path=None):
        self.conn = conn or sqlite3.connect(str(DB_PATH))
        self.conn.row_factory = sqlite3.Row
        self.csv_path = Path(csv_path) if csv_path else CSV_PATH
        self.corrections_path = Path(corrections_path) if corrections_path else CORRECTIONS_PATH

    def seed_screener_catalog(self):
        """Load screener_scoring_v2.csv into screener_catalog + apply corrections. Idempotent."""
        import re

        def slugify(s):
            return re.sub(r'[^a-z0-9]+', '-', s.lower().strip())[:120]

        rows = []
        with open(self.csv_path, newline='', encoding='utf-8') as f:
            for row in csv.DictReader(f):
                try:
                    name = row['screener_name'].strip()
                    # Handle both test CSV format (has screener_id column) and
                    # production CSV format (screener_scoring_v2.csv, no screener_id column)
                    screener_id = row.get('screener_id', '').strip() or slugify(name)
                    rows.append((
                        screener_id,
                        row['source'].strip(),
                        name,
                        row['category'].strip(),
                        row.get('subcategory', '').strip(),
                        row['signal_bias'].strip(),
                        row.get('investment_horizon', '').strip(),
                        float(row['confidence']),
                        float(row.get('score_0_100') or 0),
                        row.get('tier', '').strip(),
                        float(row.get('sub_mod') or 1.0),
                        float(row.get('horiz_mult') or 0.95),
                    ))
                except (KeyError, ValueError):
                    continue

        self.conn.executemany(
            '''INSERT OR REPLACE INTO screener_catalog
               (screener_id, source, screener_name, category, subcategory,
                signal_bias, investment_horizon, confidence,
                score_0_100, tier, sub_mod, horiz_mult)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?)''',
            rows,
        )

        if self.corrections_path.exists():
            with open(self.corrections_path, newline='', encoding='utf-8') as f:
                for corr in csv.DictReader(f):
                    name = corr.get('screener_name', '').strip()
                    if not name:
                        continue
                    try:
                        if corr.get('type') == 'bias':
                            self.conn.execute(
                                'UPDATE screener_catalog SET signal_bias=? WHERE screener_name=?',
                                (corr['corrected'], name),
                            )
                        elif corr.get('type') == 'subcategory':
                            self.conn.execute(
                                'UPDATE screener_catalog SET subcategory=? WHERE screener_name=?',
                                (corr['corrected'], name),
                            )
                    except (KeyError, sqlite3.Error):
                        pass
        self.conn.commit()
        return len(rows)

    def _get_regime(self):
        row = self.conn.execute(
            'SELECT regime, regime_prob FROM market_regimes ORDER BY date DESC LIMIT 1'
        ).fetchone()
        if row:
            return row['regime'], float(row['regime_prob'] or 0.5)
        return 'BULL', 0.5

    def _get_fundamental_scores(self):
        rows = self.conn.execute(
            "SELECT symbol, composite_score FROM stock_scores WHERE timeframe = 'medium'"
        ).fetchall()
        return {r['symbol']: float(r['composite_score'] or 50) for r in rows}

    def _get_screener_membership(self):
        membership = {}

        def _add(sym, bias, conf, cat, subcat, horizon):
            if not sym:
                return
            membership.setdefault(sym, []).append({
                'signal_bias': bias or 'neutral',
                'confidence': float(conf or 0.74),
                'category': cat or 'other',
                'subcategory': subcat or '',
                'investment_horizon': horizon or 'swing',
            })

        for source_query in [
            ("SELECT ss.symbol, sc.signal_bias, sc.confidence, sc.category, sc.subcategory, sc.investment_horizon FROM trendlyne_screener_stocks ss JOIN screener_catalog sc ON sc.screener_id = ss.screener_id AND sc.source = 'trendlyne'", []),
            ("SELECT ss.symbol, sc.signal_bias, sc.confidence, sc.category, sc.subcategory, sc.investment_horizon FROM moneycontrol_screener_stocks ss JOIN screener_catalog sc ON sc.screener_id = ss.scan_id AND sc.source = 'moneycontrol'", []),
            ("SELECT ss.symbol, sc.signal_bias, sc.confidence, sc.category, sc.subcategory, sc.investment_horizon FROM etnow_screener_stocks ss JOIN screener_catalog sc ON sc.screener_id = ss.screener_id AND sc.source = 'etnow'", []),
        ]:
            try:
                for r in self.conn.execute(source_query[0]).fetchall():
                    _add(r['symbol'], r['signal_bias'], r['confidence'],
                         r['category'], r['subcategory'], r['investment_horizon'])
            except Exception:
                pass

        return membership

    def _get_ml_scores(self):
        rows = self.conn.execute(
            "SELECT symbol, AVG(win_probability) AS p FROM technical_analysis_signals WHERE date >= date('now', '-3 days') GROUP BY symbol"
        ).fetchall()
        return {r['symbol']: float(r['p'] or 0) * 100 for r in rows}

    def _get_confluence_scores(self):
        try:
            rows = self.conn.execute(
                "SELECT symbol, confluence_score FROM confluence_signals WHERE computed_at >= date('now', '-1 day')"
            ).fetchall()
            return {r['symbol']: float(r['confluence_score'] or 0) for r in rows}
        except Exception:
            return {}

    def _get_technical_scores(self):
        rows = self.conn.execute(
            "SELECT symbol, AVG(signal_score) AS s FROM technical_analysis_signals WHERE date >= date('now', '-3 days') GROUP BY symbol"
        ).fetchall()
        return {r['symbol']: float(r['s'] or 0) for r in rows}

    def _get_dl_scores(self):
        try:
            rows = self.conn.execute(
                "SELECT symbol, probability FROM dl_predictions WHERE predicted_at >= date('now', '-1 day')"
            ).fetchall()
            return {r['symbol']: float(r['probability'] or 0) * 100 for r in rows}
        except Exception:
            return {}

    def _get_avg_track_record(self):
        try:
            row = self.conn.execute(
                "SELECT AVG(actual_return_pct) AS avg_r FROM recommendation_log WHERE generated_at >= date('now', '-90 days') AND actual_return_pct IS NOT NULL"
            ).fetchone()
            return float(row['avg_r'] or 0)
        except Exception:
            return 0.0

    def _passes_rl_gate(self, symbol):
        try:
            row = self.conn.execute(
                "SELECT AVG(actual_return_pct) AS avg_r, COUNT(*) AS cnt FROM recommendation_log WHERE symbol = ? AND generated_at >= date('now', '-90 days') AND actual_return_pct IS NOT NULL",
                (symbol,),
            ).fetchone()
            if row and row['cnt'] and row['cnt'] > 0:
                return float(row['avg_r'] or 0) >= 0
        except Exception:
            pass
        return True

    def _get_entry_targets(self, symbol):
        try:
            row = self.conn.execute(
                "SELECT entry_price, stop_loss, target_1, target_2, target_3, risk_reward, timeframe, trade_reasoning, sector FROM signals WHERE symbol = ? ORDER BY created_at DESC LIMIT 1",
                (symbol,),
            ).fetchone()
        except Exception:
            return {}
        if not row:
            return {}
        ep = row['entry_price']
        return {
            'entry_zone_low':  round(ep * 0.99, 2) if ep else None,
            'entry_zone_high': round(ep * 1.01, 2) if ep else None,
            'stop_loss':       float(row['stop_loss'])   if row['stop_loss']   else None,
            'target_1':        float(row['target_1'])    if row['target_1']    else None,
            'target_2':        float(row['target_2'])    if row['target_2']    else None,
            'target_3':        float(row['target_3'])    if row['target_3']    else None,
            'risk_reward':     float(row['risk_reward']) if row['risk_reward'] else None,
            'timeframe':       row['timeframe'],
            'trade_reasoning': row['trade_reasoning'],
            'sector':          row['sector'],
        }

    def run(self):
        today = date.today().isoformat()

        if self.conn.execute('SELECT COUNT(*) FROM screener_catalog').fetchone()[0] == 0:
            self.seed_screener_catalog()

        regime, _conf     = self._get_regime()
        base_weights      = REGIME_WEIGHTS.get(regime, REGIME_WEIGHTS['BULL'])
        fund_scores       = self._get_fundamental_scores()
        membership        = self._get_screener_membership()

        screener_scores, bull_counts, bear_counts = compute_screener_stock_scores(
            membership, fund_scores
        )
        ml_scores         = self._get_ml_scores()
        confluence_scores = self._get_confluence_scores()
        technical_scores  = self._get_technical_scores()
        dl_scores         = self._get_dl_scores()
        avg_track         = self._get_avg_track_record()

        all_symbols = set(screener_scores) | set(ml_scores) | set(confluence_scores) | set(technical_scores) | set(dl_scores)

        results = []
        for sym in all_symbols:
            if not self._passes_rl_gate(sym):
                continue

            engine_scores = {
                'screener':   screener_scores.get(sym, 0.0),
                'ml':         ml_scores.get(sym, 0.0),
                'confluence': confluence_scores.get(sym, 0.0),
                'technical':  technical_scores.get(sym, 0.0),
                'dl':         dl_scores.get(sym, 0.0),
            }
            unified = sum(base_weights[e] * engine_scores[e] for e in base_weights)
            if unified < 1:
                continue

            et = self._get_entry_targets(sym)
            results.append({
                'symbol':                  sym,
                'computed_at':             today,
                'regime':                  regime,
                'unified_score':           round(unified, 2),
                'conviction_level':        _conviction(unified),
                'screener_stock_score':    round(engine_scores['screener'], 2),
                'ml_score':                round(engine_scores['ml'], 2),
                'confluence_score':        round(engine_scores['confluence'], 2),
                'technical_score':         round(engine_scores['technical'], 2),
                'dl_score':                round(engine_scores['dl'], 2),
                'avg_engine_track_record': round(avg_track, 2),
                'bullish_screener_count':  bull_counts.get(sym, 0),
                'bearish_screener_count':  bear_counts.get(sym, 0),
                'fundamental_score':       fund_scores.get(sym),
                **et,
            })

        cur = self.conn.cursor()
        for r in results:
            cur.execute('''
                INSERT OR REPLACE INTO unified_recommendations
                (symbol, computed_at, regime, unified_score, conviction_level,
                 screener_stock_score, ml_score, confluence_score, technical_score, dl_score,
                 avg_engine_track_record, bullish_screener_count, bearish_screener_count,
                 fundamental_score, entry_zone_low, entry_zone_high, stop_loss,
                 target_1, target_2, target_3, risk_reward, timeframe, trade_reasoning, sector)
                VALUES (:symbol, :computed_at, :regime, :unified_score, :conviction_level,
                        :screener_stock_score, :ml_score, :confluence_score, :technical_score,
                        :dl_score, :avg_engine_track_record, :bullish_screener_count,
                        :bearish_screener_count, :fundamental_score, :entry_zone_low,
                        :entry_zone_high, :stop_loss, :target_1, :target_2, :target_3,
                        :risk_reward, :timeframe, :trade_reasoning, :sector)
            ''', r)
        self.conn.commit()

        breakdown = {}
        for r in results:
            c = r['conviction_level']
            breakdown[c] = breakdown.get(c, 0) + 1

        output = {'success': True, 'stocks_scored': len(results),
                  'conviction_breakdown': breakdown, 'regime': regime}
        print(json.dumps(output))
        return results


if __name__ == '__main__':
    ranker = UnifiedRanker()
    ranker.run()
