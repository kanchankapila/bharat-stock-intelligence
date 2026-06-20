"""
unified_ranker.py — Regime-gated unified stock recommendation engine.

Run after market close: python unified_ranker.py
"""
import json
import csv
import math
from pathlib import Path
from datetime import date, timedelta

from db_compat import connect

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
    """Percentile-rank normalization (0-100). Robust to outliers, unlike min-max which
    collapses the whole cluster toward 0 when a single extreme value sets the max."""
    if not raw:
        return {}
    n = len(raw)
    if n == 1:
        return {k: 50.0 for k in raw}
    values = list(raw.values())
    out = {}
    for k, v in raw.items():
        less = sum(1 for x in values if x < v)
        equal = sum(1 for x in values if x == v)
        out[k] = (less + 0.5 * equal) / n * 100.0
    return out


def _blend(engine_scores, present_engines, weights):
    """Weighted blend that renormalizes weights over the engines that actually have data
    for this symbol, so missing engines (empty confluence/dl tables) don't deflate the score."""
    active = {e: weights[e] for e in weights if e in present_engines}
    wsum = sum(active.values())
    if wsum <= 0:
        return 0.0
    return sum(active[e] / wsum * engine_scores.get(e, 0.0) for e in active)


# ── Quality gate (#4) ───────────────────────────────────────────────────────────
# AMC overlay: a technical/screener breakout on a fundamentally rotten name is a value
# trap. Demote the unified score by a balance-sheet-quality multiplier so weak names can't
# rank as high-conviction buys. Uses the Piotroski F-score (the canonical cross-sector
# fundamental-strength screen — it already folds in leverage/liquidity trend) plus a
# negative-ROE flag. Missing data is neutral (financials/new listings legitimately lack it).
QUALITY_GATE_FLOOR = 0.5


def quality_gate(piotroski, roe, *, floor: float = QUALITY_GATE_FLOOR) -> float:
    """Fundamental-quality multiplier in [floor, 1.0]. None inputs are treated as neutral."""
    mult = 1.0
    if piotroski is not None:
        if piotroski <= 2:
            mult *= 0.6
        elif piotroski <= 4:
            mult *= 0.85
    if roe is not None and roe < 0:
        mult *= 0.8
    return max(floor, mult)


# ── Position sizing (#6) ────────────────────────────────────────────────────────
# Meta-labeling -> sizing: the ML ensemble's win_probability is a meta-label (P the long
# signal is correct). Instead of only gating it at 0.40, turn it into a bet size (López de
# Prado: z=(p-0.5)/sqrt(p(1-p)), size=2*Phi(z)-1) and weight by inverse volatility
# (vol-target), so high-conviction low-vol names get more capital. Normalized + per-name
# capped into suggested portfolio weights.
GROSS_EXPOSURE = 1.0     # weights sum to at most 100% of the long book
MAX_POSITION = 0.10      # per-name cap
VOL_FLOOR_PCT = 10.0     # don't let an ultra-low-vol name dominate
DEFAULT_VOL_PCT = 30.0   # when annualized_vol is missing


def bet_size_from_probability(p, neutral: float = 0.5) -> float:
    """López de Prado bet size in [0,1] from a win probability (long-only: 0 at/below neutral)."""
    if p is None or p <= neutral:
        return 0.0
    denom = math.sqrt(p * (1.0 - p))
    if denom <= 0:
        return 1.0
    z = (p - neutral) / denom
    cdf = 0.5 * (1.0 + math.erf(z / math.sqrt(2.0)))
    return max(0.0, min(1.0, 2.0 * cdf - 1.0))


def normalize_position_sizes(raw: dict, gross: float = GROSS_EXPOSURE, cap: float = MAX_POSITION) -> dict:
    """Normalize raw conviction×inverse-vol sizes to portfolio weights (sum ≤ gross, each ≤ cap)."""
    total = sum(v for v in raw.values() if v and v > 0)
    if total <= 0:
        return {k: 0.0 for k in raw}
    return {k: round(min(cap, gross * max(0.0, (v or 0.0)) / total), 4) for k, v in raw.items()}


def _classify(score, bull, bear):
    """Directional label (matches stock_scores taxonomy the Top Rated UI renders) from the
    net screener bias balance, with magnitude gating the 'Strong' tiers."""
    bull = bull or 0
    bear = bear or 0
    total = bull + bear
    if total == 0:
        return 'Hold'
    r = (bull - bear) / total
    if r > 0:
        return 'Strong Buy' if (r >= 0.5 and score >= 66.0) else 'Buy'
    if r < 0:
        return 'Strong Sell' if (r <= -0.5 and score <= 34.0) else 'Sell'
    return 'Hold'


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
        self.conn = conn or connect()
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
            '''INSERT INTO screener_catalog
               (screener_id, source, screener_name, category, subcategory,
                signal_bias, investment_horizon, confidence,
                score_0_100, tier, sub_mod, horiz_mult)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
               ON CONFLICT(screener_id, source) DO UPDATE SET
                 screener_name=excluded.screener_name, category=excluded.category,
                 subcategory=excluded.subcategory, signal_bias=excluded.signal_bias,
                 investment_horizon=excluded.investment_horizon, confidence=excluded.confidence,
                 score_0_100=excluded.score_0_100, tier=excluded.tier,
                 sub_mod=excluded.sub_mod, horiz_mult=excluded.horiz_mult''',
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
                    except Exception:
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
            "SELECT symbol, score FROM stock_scores WHERE timeframe = 'long_term'"
        ).fetchall()
        return {r['symbol']: float(r['score'] or 50) for r in rows}

    def _get_quality_metrics(self):
        """Per-symbol quant metrics: balance-sheet quality (#4 gate) + annualized vol (#6 sizing)."""
        rows = self.conn.execute(
            "SELECT symbol, piotroski_f_score, return_on_equity, annualized_vol FROM quant_scores"
        ).fetchall()
        return {
            r['symbol']: {
                'piotroski': r['piotroski_f_score'],
                'roe': float(r['return_on_equity']) if r['return_on_equity'] is not None else None,
                'vol': float(r['annualized_vol']) if r['annualized_vol'] is not None else None,
            }
            for r in rows
        }

    def _get_win_probabilities(self):
        """Raw ML meta-label per symbol: avg win_probability over recent technical signals."""
        cutoff = (date.today() - timedelta(days=30)).isoformat()
        rows = self.conn.execute(
            "SELECT symbol, AVG(win_probability) AS p FROM technical_signals "
            "WHERE date >= ? AND win_probability IS NOT NULL GROUP BY symbol",
            (cutoff,)
        ).fetchall()
        return {r['symbol']: float(r['p']) for r in rows if r['p'] is not None}

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
                self.conn.rollback()

        return membership

    def _get_ml_scores(self):
        # technical_signals.date is a text column; compare against a Python-computed cutoff
        # string (date('now',...) translates to a real date on Postgres -> text>=date error).
        cutoff = (date.today() - timedelta(days=3)).isoformat()
        try:
            rows = self.conn.execute(
                "SELECT symbol, AVG(win_probability) AS p FROM technical_signals WHERE date >= ? GROUP BY symbol",
                (cutoff,),
            ).fetchall()
            return {r['symbol']: float(r['p'] or 0) * 100 for r in rows}
        except Exception:
            self.conn.rollback()
            return {}

    def _get_confluence_scores(self):
        cutoff = (date.today() - timedelta(days=1)).isoformat()
        try:
            rows = self.conn.execute(
                "SELECT symbol, confluence_score FROM confluence_signals WHERE computed_at >= ?",
                (cutoff,),
            ).fetchall()
            return {r['symbol']: float(r['confluence_score'] or 0) for r in rows}
        except Exception:
            self.conn.rollback()
            return {}

    def _get_technical_scores(self):
        cutoff = (date.today() - timedelta(days=3)).isoformat()
        try:
            rows = self.conn.execute(
                "SELECT symbol, AVG(signal_score) AS s FROM technical_signals WHERE date >= ? GROUP BY symbol",
                (cutoff,),
            ).fetchall()
            # signal_score is a 0-10 composite; percentile-normalize to 0-100 so it is on the
            # same scale as the other engines before blending.
            return _normalize_to_100({r['symbol']: float(r['s'] or 0) for r in rows})
        except Exception:
            self.conn.rollback()
            return {}

    def _get_dl_scores(self):
        cutoff = (date.today() - timedelta(days=1)).isoformat()
        try:
            rows = self.conn.execute(
                "SELECT symbol, probability FROM dl_predictions WHERE predicted_at >= ?",
                (cutoff,),
            ).fetchall()
            return {r['symbol']: float(r['probability'] or 0) * 100 for r in rows}
        except Exception:
            self.conn.rollback()
            return {}

    def _get_avg_track_record(self):
        cutoff = (date.today() - timedelta(days=90)).isoformat()
        try:
            row = self.conn.execute(
                "SELECT AVG(actual_return_pct) AS avg_r FROM recommendation_log WHERE generated_at >= ? AND actual_return_pct IS NOT NULL",
                (cutoff,),
            ).fetchone()
            return float(row['avg_r'] or 0)
        except Exception:
            self.conn.rollback()
            return 0.0

    def _passes_rl_gate(self, symbol):
        cutoff = (date.today() - timedelta(days=90)).isoformat()
        try:
            row = self.conn.execute(
                "SELECT AVG(actual_return_pct) AS avg_r, COUNT(*) AS cnt FROM recommendation_log WHERE symbol = ? AND generated_at >= ? AND actual_return_pct IS NOT NULL",
                (symbol, cutoff),
            ).fetchone()
            if row and row['cnt'] and row['cnt'] > 0:
                return float(row['avg_r'] or 0) >= 0
        except Exception:
            self.conn.rollback()
        return True

    def _get_entry_targets(self, symbol):
        # Fallback 1: Query confluence_signals (best source with entry zones, atr, risk-reward, etc.)
        try:
            row = self.conn.execute(
                """SELECT entry_zone_low, entry_zone_high, stop_loss, target_1, target_2, target_3, 
                          risk_reward, suggested_timeframe AS timeframe, trade_reasoning, sector 
                   FROM confluence_signals 
                   WHERE symbol = ? 
                   ORDER BY computed_at DESC 
                   LIMIT 1""",
                (symbol,),
            ).fetchone()
            if row and (row['entry_zone_low'] is not None or row['stop_loss'] is not None):
                return {
                    'entry_zone_low':  float(row['entry_zone_low'])  if row['entry_zone_low']  is not None else None,
                    'entry_zone_high': float(row['entry_zone_high']) if row['entry_zone_high'] is not None else None,
                    'stop_loss':       float(row['stop_loss'])       if row['stop_loss']       is not None else None,
                    'target_1':        float(row['target_1'])        if row['target_1']        is not None else None,
                    'target_2':        float(row['target_2'])        if row['target_2']        is not None else None,
                    'target_3':        float(row['target_3'])        if row['target_3']        is not None else None,
                    'risk_reward':     float(row['risk_reward'])     if row['risk_reward']     is not None else None,
                    'timeframe':       row['timeframe'],
                    'trade_reasoning': row['trade_reasoning'],
                    'sector':          row['sector'],
                }
        except Exception:
            self.conn.rollback()

        # Fallback 2: Query recommendation_log
        try:
            row = self.conn.execute(
                """SELECT entry_price, stop_loss, target_1, target_2, target_3, 
                          timeframe, reasoning AS trade_reasoning, sector 
                   FROM recommendation_log 
                   WHERE symbol = ? 
                   ORDER BY generated_at DESC 
                   LIMIT 1""",
                (symbol,),
            ).fetchone()
            if row and row['entry_price'] is not None:
                ep = float(row['entry_price'])
                sl = float(row['stop_loss']) if row['stop_loss'] is not None else None
                t1 = float(row['target_1']) if row['target_1'] is not None else None
                rr = None
                if sl is not None and ep - sl > 0 and t1 is not None:
                    rr = round((t1 - ep) / (ep - sl), 2)
                return {
                    'entry_zone_low':  round(ep * 0.99, 2),
                    'entry_zone_high': round(ep * 1.01, 2),
                    'stop_loss':       sl,
                    'target_1':        t1,
                    'target_2':        float(row['target_2']) if row['target_2'] is not None else None,
                    'target_3':        float(row['target_3']) if row['target_3'] is not None else None,
                    'risk_reward':     rr,
                    'timeframe':       row['timeframe'],
                    'trade_reasoning': row['trade_reasoning'],
                    'sector':          row['sector'],
                }
        except Exception:
            self.conn.rollback()

        # Fallback 3: Query unified_signals
        try:
            row = self.conn.execute(
                """SELECT entry_price AS entry, target_price AS target,
                          stop_loss AS "stopLoss", reasoning AS trade_reasoning
                   FROM unified_signals
                   WHERE symbol = ?
                   ORDER BY signal_generated_at DESC
                   LIMIT 1""",
                (symbol,),
            ).fetchone()
            if row and row['entry'] is not None:
                ep = float(row['entry'])
                sl = float(row['stopLoss']) if row['stopLoss'] is not None else None
                t1 = float(row['target']) if row['target'] is not None else None
                rr = None
                if sl is not None and ep - sl > 0 and t1 is not None:
                    rr = round((t1 - ep) / (ep - sl), 2)
                
                # Fetch sector from nse_stocks
                sec = None
                try:
                    sec_row = self.conn.execute(
                        "SELECT sector FROM nse_stocks WHERE symbol = ? LIMIT 1", (symbol,)
                    ).fetchone()
                    if sec_row:
                        sec = sec_row['sector']
                except Exception:
                    pass

                return {
                    'entry_zone_low':  round(ep * 0.99, 2),
                    'entry_zone_high': round(ep * 1.01, 2),
                    'stop_loss':       sl,
                    'target_1':        t1,
                    'target_2':        None,
                    'target_3':        None,
                    'risk_reward':     rr,
                    'timeframe':       'SWING',
                    'trade_reasoning': row['trade_reasoning'],
                    'sector':          sec,
                }
        except Exception:
            self.conn.rollback()

        # Fallback 4: Default fallback with sector only
        sec = None
        try:
            sec_row = self.conn.execute(
                "SELECT sector FROM nse_stocks WHERE symbol = ? LIMIT 1", (symbol,)
            ).fetchone()
            if sec_row:
                sec = sec_row['sector']
        except Exception:
            self.conn.rollback()

        return {
            'entry_zone_low':  None,
            'entry_zone_high': None,
            'stop_loss':       None,
            'target_1':        None,
            'target_2':        None,
            'target_3':        None,
            'risk_reward':     None,
            'timeframe':       None,
            'trade_reasoning': None,
            'sector':          sec,
        }

    def run(self):
        today = date.today().isoformat()

        if self.conn.execute('SELECT COUNT(*) FROM screener_catalog').fetchone()[0] == 0:
            self.seed_screener_catalog()

        regime, _conf     = self._get_regime()
        base_weights      = REGIME_WEIGHTS.get(regime, REGIME_WEIGHTS['BULL'])
        fund_scores       = self._get_fundamental_scores()
        quality_metrics   = self._get_quality_metrics()
        win_probs         = self._get_win_probabilities()
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

        engine_maps = {
            'screener':   screener_scores,
            'ml':         ml_scores,
            'confluence': confluence_scores,
            'technical':  technical_scores,
            'dl':         dl_scores,
        }

        results = []
        raw_sizes = {}   # symbol -> conviction×inverse-vol (normalized into weights after the loop)
        for sym in all_symbols:
            if not self._passes_rl_gate(sym):
                continue

            engine_scores = {e: m.get(sym, 0.0) for e, m in engine_maps.items()}
            present = {e for e, m in engine_maps.items() if sym in m}
            # renormalize weights over engines that actually have data for this symbol, so
            # empty confluence/dl tables don't drag every score down to ~15.
            unified = _blend(engine_scores, present, base_weights)
            qm = quality_metrics.get(sym)
            if qm:
                unified *= quality_gate(qm['piotroski'], qm['roe'])
            if unified < 1:
                continue

            bull = bull_counts.get(sym, 0)
            bear = bear_counts.get(sym, 0)
            classification = _classify(unified, bull, bear)

            # #6 position size: bet on the ML meta-label, inverse-vol weighted, longs only.
            bet = bet_size_from_probability(win_probs.get(sym))
            vol = max(VOL_FLOOR_PCT, (qm or {}).get('vol') or DEFAULT_VOL_PCT)
            raw_sizes[sym] = (bet / vol) if classification in ('Strong Buy', 'Buy') else 0.0
            cats = sorted({s.get('category', 'other') for s in membership.get(sym, [])} - {'other', ''})
            screener_summary = (
                f"{bull} bullish / {bear} bearish screener signals ({classification}); "
                f"regime {regime}" + (f"; drivers: {', '.join(cats[:4])}" if cats else "")
            )

            et = self._get_entry_targets(sym)
            if not et.get('trade_reasoning'):
                et['trade_reasoning'] = screener_summary

            results.append({
                'symbol':                  sym,
                'computed_at':             today,
                'regime':                  regime,
                'unified_score':           round(unified, 2),
                'conviction_level':        _conviction(unified),
                'classification':          classification,
                'screener_names_json':     json.dumps(cats),
                'screener_stock_score':    round(engine_scores['screener'], 2),
                'ml_score':                round(engine_scores['ml'], 2),
                'confluence_score':        round(engine_scores['confluence'], 2),
                'technical_score':         round(engine_scores['technical'], 2),
                'dl_score':                round(engine_scores['dl'], 2),
                'avg_engine_track_record': round(avg_track, 2),
                'bullish_screener_count':  bull_counts.get(sym, 0),
                'bearish_screener_count':  bear_counts.get(sym, 0),
                'fundamental_score':       fund_scores.get(sym),
                'entry_zone_low':          None,
                'entry_zone_high':         None,
                'stop_loss':               None,
                'target_1':                None,
                'target_2':                None,
                'target_3':                None,
                'risk_reward':             None,
                'timeframe':               None,
                'trade_reasoning':         None,
                'sector':                  None,
                'position_size_pct':       0.0,
                **et,
            })

        # Normalize conviction×inverse-vol into capped portfolio weights (# 6).
        position_sizes = normalize_position_sizes(raw_sizes)
        for r in results:
            r['position_size_pct'] = round(position_sizes.get(r['symbol'], 0.0) * 100, 2)

        cur = self.conn.cursor()
        for r in results:
            cur.execute('''
                INSERT INTO unified_recommendations
                (symbol, computed_at, regime, unified_score, conviction_level, classification,
                 screener_names_json,
                 screener_stock_score, ml_score, confluence_score, technical_score, dl_score,
                 avg_engine_track_record, bullish_screener_count, bearish_screener_count,
                 fundamental_score, entry_zone_low, entry_zone_high, stop_loss,
                 target_1, target_2, target_3, risk_reward, timeframe, trade_reasoning, sector,
                 position_size_pct)
                VALUES (:symbol, :computed_at, :regime, :unified_score, :conviction_level, :classification,
                        :screener_names_json,
                        :screener_stock_score, :ml_score, :confluence_score, :technical_score,
                        :dl_score, :avg_engine_track_record, :bullish_screener_count,
                        :bearish_screener_count, :fundamental_score, :entry_zone_low,
                        :entry_zone_high, :stop_loss, :target_1, :target_2, :target_3,
                        :risk_reward, :timeframe, :trade_reasoning, :sector,
                        :position_size_pct)
                ON CONFLICT(symbol, computed_at) DO UPDATE SET
                    regime=excluded.regime, unified_score=excluded.unified_score,
                    conviction_level=excluded.conviction_level, classification=excluded.classification,
                    screener_names_json=excluded.screener_names_json,
                    screener_stock_score=excluded.screener_stock_score, ml_score=excluded.ml_score,
                    confluence_score=excluded.confluence_score, technical_score=excluded.technical_score,
                    dl_score=excluded.dl_score, avg_engine_track_record=excluded.avg_engine_track_record,
                    bullish_screener_count=excluded.bullish_screener_count,
                    bearish_screener_count=excluded.bearish_screener_count,
                    fundamental_score=excluded.fundamental_score,
                    entry_zone_low=excluded.entry_zone_low, entry_zone_high=excluded.entry_zone_high,
                    stop_loss=excluded.stop_loss, target_1=excluded.target_1,
                    target_2=excluded.target_2, target_3=excluded.target_3,
                    risk_reward=excluded.risk_reward, timeframe=excluded.timeframe,
                    trade_reasoning=excluded.trade_reasoning, sector=excluded.sector,
                    position_size_pct=excluded.position_size_pct
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
