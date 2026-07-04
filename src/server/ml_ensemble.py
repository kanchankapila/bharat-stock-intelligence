"""
ML Ensemble Signal Confidence Scorer
======================================
Trains an ensemble of classifiers on historical signal_outcomes and uses the
combined probability estimate as win_probability for new signals.

Models:
  - LGBMClassifier              (GPU-accelerated, replaces GradientBoostingClassifier)
  - XGBClassifier               (GPU-accelerated, 5th base model)
  - RandomForestClassifier
  - ExtraTreesClassifier
  - LogisticRegression          (linear baseline)
  Meta-learner: LogisticRegression on out-of-fold base model probabilities (stacking)

All models are calibrated with CalibratedClassifierCV (isotonic for tree models,
sigmoid for logistic).

Features:
  - signal_score, rsi, adx, volume_ratio, sma200_dist
  - nifty_regime (encoded: BULL=1, SIDEWAYS=0, BEAR=-1)
  - horizon_days
  - signal type one-hot (17 types)
  - score × regime interaction

Requirements:
    pip install scikit-learn pandas numpy lightgbm xgboost

Run:  python ml_ensemble.py
      python ml_ensemble.py --train
      python ml_ensemble.py --score
      python ml_ensemble.py --retrain-full      # discard saved model, retrain from scratch
      python ml_ensemble.py --min-samples 30
"""

import os, sys, json, math, datetime, argparse, pickle, warnings
warnings.filterwarnings('ignore')

import numpy as np
import pandas as pd

from db_compat import connect, read_df, use_postgres, ConnWrapper

MODELS_DIR  = os.path.join(os.getcwd(), 'src', 'server', 'ml_models')
ENSEMBLE_PATH = os.path.join(MODELS_DIR, 'ensemble.pkl')

REGIME_MAP   = {'BULL': 1.0, 'SIDEWAYS': 0.0, 'BEAR': -1.0}
SIGNAL_TYPES = [
    'RSI_DIVERGENCE', 'HIDDEN_DIVERGENCE', 'RESISTANCE_BREAKOUT',
    'MACD_CROSSOVER', 'BB_COMPRESSION', 'GOLDEN_CROSS', 'OVERSOLD_RECOVERY',
    'EMA_BULL_STACK', 'WEEK_52_BREAKOUT', 'BULLISH_ENGULFING', 'SUPERTREND_CROSS',
    'NR7_COMPRESSION', 'VOLUME_ACCUMULATION', 'NEAR_52W_HIGH',
    'CONSECUTIVE_STRENGTH', 'ATR_CONTRACTION', 'PCR_EXTREME',
]

_REGIME_THRESHOLDS: dict[str, float] = {
    'BULL':     0.40,
    'BEAR':     0.36,
    'HIGH_VOL': 0.38,
    'CRASH':    0.42,
    'SIDEWAYS': 0.40,
}


# ── Feature Engineering ──────────────────────────────────────────────────────

def _parse_signal_types(signals_json) -> set[str]:
    if signals_json is None:
        return set()
    try:
        return {s.get('type', '') for s in json.loads(signals_json) if isinstance(s, dict)}
    except Exception:
        return set()


def _days_to_fno_expiry(dates: pd.Series) -> pd.Series:
    """Calendar days from each date to the NSE monthly F&O expiry (last Thursday of the
    month). If the date is past this month's last Thursday, roll to next month's. Expiry
    week pins price to max-pain and inflates gamma — a real, leak-free timing feature."""
    def _last_thursday(year: int, month: int):
        if month == 12:
            nxt = datetime.date(year + 1, 1, 1)
        else:
            nxt = datetime.date(year, month + 1, 1)
        last = nxt - datetime.timedelta(days=1)
        # Thursday == weekday 3
        last -= datetime.timedelta(days=(last.weekday() - 3) % 7)
        return last

    def _dte(ts):
        if pd.isna(ts):
            return np.nan
        d = ts.date()
        exp = _last_thursday(d.year, d.month)
        if d > exp:
            ny, nm = (d.year + 1, 1) if d.month == 12 else (d.year, d.month + 1)
            exp = _last_thursday(ny, nm)
        return (exp - d).days

    return dates.apply(_dte)


def _results_season_flag(dates: pd.Series) -> pd.Series:
    """1 during Indian quarterly earnings season (results cluster in Jan/Apr/Jul/Oct), else 0.
    An entry inside results season carries idiosyncratic earnings-gap risk the price features
    can't see."""
    return dates.apply(lambda ts: 0.0 if pd.isna(ts) else (1.0 if ts.month in (1, 4, 7, 10) else 0.0))


def build_features(df: pd.DataFrame) -> pd.DataFrame:
    X = pd.DataFrame(index=df.index)

    def num(col, default):
        """Numeric Series for `col`, robust to the column being absent entirely. Production SQL
        always supplies it (Series); tests / partial joins may not, where df.get(col, scalar)
        would yield a scalar and break .fillna()."""
        s = df[col] if col in df.columns else pd.Series(default, index=df.index)
        if isinstance(s, pd.DataFrame):
            s = s.iloc[:, 0]
        return pd.to_numeric(s, errors='coerce').fillna(default)

    X['signal_score']  = num('signal_score', 5)
    X['rsi']           = num('rsi', 50)
    X['adx']           = num('adx', 20)
    X['volume_ratio']  = num('volume_ratio', 1.0)
    X['horizon_days']  = num('horizon_days', 15)

    regime_raw  = df['nifty_regime'] if 'nifty_regime' in df.columns else pd.Series(['UNKNOWN'] * len(df), index=df.index)
    X['regime'] = regime_raw.map(REGIME_MAP).fillna(0.0)

    cmp_   = num('cmp', np.nan)
    sma200 = num('sma200', np.nan)
    X['sma200_dist'] = ((cmp_ - sma200) / sma200.replace(0, np.nan) * 100).fillna(0)

    # Interaction: score strength in current regime
    X['score_x_regime'] = X['signal_score'] * X['regime']
    # Rsi deviation from neutral zone
    X['rsi_deviation']  = (X['rsi'] - 50).abs()

    # Market breadth — used as interaction term only (standalone was noise, tested 2026-06)
    X['breadth_x_score'] = (
        num('pct_above_200dma', 0.5).clip(0, 1) * X['signal_score']
    )
    X['breadth_thrust'] = num('adv_decline_ratio', 0.5).clip(0, 1)

    # FII flow — normalized (Cr), negative = selling pressure
    X['fii_3d_net'] = num('fii_3d_net', 0) / 10000.0

    # Above SMA200 binary flag
    X['above_sma200'] = num('above_sma200', 0).clip(0, 1)

    # Distance from 52-week high (as % — negative means below the high)
    hi52 = num('fifty_two_week_high', np.nan)
    X['dist_52w_high'] = ((cmp_ - hi52) / hi52.replace(0, np.nan) * 100).fillna(0)

    # PCR — put/call ratio (stock level and market level)
    X['pcr_oi']  = num('pcr_oi', 1.0)
    X['pcr_vol'] = num('pcr_vol', 1.0)

    # Extended FII/DII flows (normalized to 10K Cr scale)
    X['fii_10d_net'] = num('fii_10d_net', 0) / 10000.0
    X['dii_3d_net']  = num('dii_3d_net', 0) / 10000.0

    # Delivery % (institutional conviction proxy, normalized to 0-1)
    X['delivery_pct'] = num('delivery_pct', 50) / 100.0

    # Mutual fund holding — AMFI monthly disclosures via ET Markets
    # High MF ownership = institutional validation; rising MF holding = accumulation signal
    X['mf_holding_pct']    = num('mf_holding_pct', 5.0).clip(0, 60) / 60.0
    X['mf_fund_count_log'] = np.log1p(num('mf_fund_count', 0).clip(lower=0))
    X['mf_chg_vs_prev']    = num('mf_chg_vs_prev', 0.0).clip(-5, 5)
    X['mf_x_score']        = X['mf_holding_pct'] * X['signal_score']

    # Sector relative momentum
    X['sector_ret_5d']  = num('sector_ret_5d', 0)
    X['sector_ret_21d'] = num('sector_ret_21d', 0)

    # Sector-global benchmark correlation (sector return vs SP500/GOLD/CRUDE/DXY rolling 21d)
    X['sector_global_corr_21d'] = num('sector_global_corr_21d', 0.0).clip(-1, 1)
    X['corr_x_sector_ret']      = X['sector_global_corr_21d'] * X['sector_ret_5d']

    # ── Fundamental factors: Quality / Value / Growth / Size (from stock_fundamentals) ──
    # Point-in-time caveat: stock_fundamentals is a current snapshot keyed by symbol (same
    # join as fifty_two_week_high above), so historical training rows see latest fundamentals
    # — mild look-ahead for slow quarterly metrics, fully leak-free at predict time. Price-
    # derived/fast fields are deliberately excluded (those would be real leakage).
    X['piotroski']         = num('piotroski_f_score', 4)
    X['debt_to_equity']    = num('debt_to_equity', 0.5).clip(0, 10)
    X['operating_margins'] = num('operating_margins', 0)
    X['return_on_equity']  = num('return_on_equity', 0)
    X['revenue_growth']    = num('revenue_growth', 0)
    X['earnings_growth']   = num('earnings_growth', 0)
    X['earnings_yield']    = num('earnings_yield', 0)
    X['price_to_book']     = num('price_to_book', 3).clip(0, 50)
    X['log_market_cap']    = np.log1p(num('market_cap', 0).clip(lower=0))

    # Interaction: delivery conviction × signal score
    X['delivery_x_score'] = X['delivery_pct'] * X['signal_score']

    # ── Options-implied volatility (from stock_options_oi → iv_features.py) ──
    # iv_rank: where today's ATM IV sits in its trailing 252d range (0-1). Low IV-rank on a
    # breakout = cheap optionality / coiled move; high IV-rank = priced-in / fade risk.
    # iv_skew: put_iv − call_iv at ~25-delta. Positive = downside fear (crash hedging bid).
    X['iv_rank'] = num('iv_rank', 0.5).clip(0, 1)
    X['iv_skew'] = num('iv_skew', 0.0)
    # Interaction: a strong signal into cheap IV is the highest-quality entry
    X['score_x_low_iv'] = X['signal_score'] * (1.0 - X['iv_rank'])

    # Max pain distance: how far spot is from max pain strike
    # Negative = below max pain (put writers dominate → likely support)
    # Positive = above max pain (call writers dominate → likely resistance)
    cmp_vals = df['cmp'].where(df['cmp'] > 0, np.nan) if 'cmp' in df.columns else pd.Series(np.nan, index=df.index)
    max_pain_vals = num('max_pain', np.nan)
    X['max_pain_dist_pct'] = ((cmp_vals - max_pain_vals) / max_pain_vals.replace(0, np.nan) * 100).fillna(0).clip(-20, 20)
    X['below_max_pain'] = (X['max_pain_dist_pct'] < 0).astype(np.float32)

    # ── Cross-sectional relative strength (from relative_strength.py) ──
    # Universe percentile of trailing return (0=worst, 1=best). Absolute momentum (sector_ret)
    # can't tell a stock leading the tape from one merely floating up with it; rank can.
    X['rs_rank_21d'] = num('rs_rank_21d', 0.5).clip(0, 1)
    X['rs_rank_63d'] = num('rs_rank_63d', 0.5).clip(0, 1)

    # 12-1 momentum (12-month return minus last month — academia-validated factor)
    X['ret_12m_ex1m']    = num('ret_12m_ex1m', 0.0).clip(-60, 60)
    X['momentum_x_score'] = X['ret_12m_ex1m'].clip(-30, 30) * X['signal_score'] / 10.0

    # ── Analyst consensus (from analyst_estimates_history, AS-OF join) ──
    # analyst_buy_pct: fraction of bullish (BUY+OUTPERFORM) ratings — neutral default 0.5.
    # n_analysts_log:  log-scale analyst coverage (more coverage = more liquid/followed).
    # target_upside_pct: consensus price target vs current price — forward-return signal.
    n_analysts = num('n_analysts', 0)
    n_buy      = num('buy_count', 0)
    X['n_analysts_log']    = np.log1p(n_analysts)
    X['analyst_buy_pct']   = (n_buy / n_analysts.replace(0, np.nan)).fillna(0.5).clip(0, 1)
    X['target_upside_pct'] = ((num('target_mean', np.nan) - cmp_) / cmp_.replace(0, np.nan) * 100).fillna(0)

    # ── MC Vitals: financial distress scores (AS-OF from proprietary_scores_history) ──
    # Altman Z-Score: > 2.99 = safe zone, 1.23–2.99 = grey zone, < 1.23 = distress zone.
    # Neutral default 2.0 = mid-grey (avoids penalising stocks not yet in 150-stock batch).
    X['altman_z']        = num('altman_z', 2.0).clip(-5, 15)
    X['altman_distress'] = (num('altman_z', 2.0) < 1.23).astype(np.float32)
    # Ohlson O-Score: log-odds of failure; negative = lower failure probability.
    # Neutral default -2.0 (moderate safety, representative of a typical listed company).
    X['ohlson_o']        = num('ohlson_o', -2.0).clip(-10, 5)

    # ── Insider activity (from insider_features.py → technical_signals) ──
    # > 0.5 = promoters/directors accumulating (strong India signal: insider buying rarely occurs
    # without conviction). Neutral 0.5 = no data; never penalises uncovered stocks.
    X['insider_buy_pct_90d'] = num('insider_buy_pct_90d', 0.5).clip(0, 1)
    X['insider_x_score']     = X['insider_buy_pct_90d'] * X['signal_score']

    # ── Intraday microstructure (from intraday_features.py → technical_signals) ──
    # opening_range_break: trend direction relative to first 30-min range.
    # 1.0 = upside breakout; -1.0 = breakdown; 0.0 = no data or inside range.
    X['opening_range_break']  = num('opening_range_break',  0.0).clip(-1, 1)
    # vwap_deviation_pct: close vs session VWAP. Positive = institutional demand bid.
    X['vwap_deviation_pct']   = num('vwap_deviation_pct',   0.0).clip(-10, 10)
    # first_hour_vol_share: front-loaded volume (institutional activity at the open).
    X['first_hour_vol_share'] = num('first_hour_vol_share', 0.5).clip(0, 1)

    # ── Anchored VWAP (from avwap_features.py) ──
    # avwap_deviation_pct: (close − 20d rolling VWAP) / vwap * 100.
    # Positive = price above multi-day supply/demand equilibrium (bullish structure).
    # Neutral default 0.0 (at equilibrium); capped at ±15% (extreme overextension).
    X['avwap_deviation_pct'] = num('avwap_deviation_pct', 0.0).clip(-15, 15)
    # Interaction: strong signal with price already extended above AVWAP → mean-reversion risk
    X['avwap_x_score'] = X['avwap_deviation_pct'] * X['signal_score'] / 10.0

    # ── OI-change delta (from oi_delta_features.py) ──
    # oi_net_change_pct: day-over-day % change in total open interest (calls + puts).
    # > 0 = OI building (new directional positions) → confirms the current move.
    # < 0 = OI unwinding (covering) → potential reversal / reduced conviction.
    # Neutral default 0.0; capped at ±30% (1 SD ≈ 5%, rare spikes excluded).
    X['oi_net_change_pct'] = num('oi_net_change_pct', 0.0).clip(-30, 30)

    # ── Earnings beat/miss history (from earnings_beat_features.py) ──
    # eps_beat_last_q: most recent quarter result vs consensus (+1 beat / 0 inline / -1 miss).
    # Neutral default 0 (inline/unknown). Sustained beats signal management credibility.
    X['eps_beat_last_q']    = num('eps_beat_last_q',    0.0).clip(-1, 1)
    # eps_beat_streak_4q: consecutive beats over last 4 quarters (0-4).
    X['eps_beat_streak_4q'] = num('eps_beat_streak_4q', 0.0).clip(0, 4)
    # eps_miss_streak_4q: consecutive misses over last 4 quarters (0-4).
    X['eps_miss_streak_4q'] = num('eps_miss_streak_4q', 0.0).clip(0, 4)
    # eps_surprise_last_yr: actual EPS vs consensus for most recent annual period (%).
    # Positive = beat; negative = miss. Neutral default 0 (no data / inline).
    # Capped at ±30% (larger moves are typically data anomalies or tiny-cap stocks).
    X['eps_surprise_last_yr'] = num('eps_surprise_last_yr', 0.0).clip(-30, 30)
    # eps_estimate_dispersion: (high − low) / avg for most recent annual EPS estimate.
    # Low = tight analyst consensus (high conviction); high = wide disagreement (uncertain).
    # Neutral default 0.2 (typical mid-cap dispersion); capped at 1.0.
    X['eps_estimate_dispersion'] = num('eps_estimate_dispersion', 0.2).clip(0, 1)

    # ── F&O Rollover (from fno_rollover_fetcher.py → technical_signals) ──
    # rollover_pct: next_month_OI / (near + next) × 100.
    # High rollover (>55%) near expiry = institutions staying long → bullish continuation.
    # cost_of_carry_ann: annualised futures basis (%). Positive = contango; negative = backwardation.
    X['rollover_pct']      = num('rollover_pct',      40.0).clip(0, 100) / 100.0
    X['cost_of_carry_ann'] = num('cost_of_carry_ann',  0.0).clip(-30, 30)
    # High rollover + strong upward carry → smart money positioned bullish
    X['rollover_x_score']  = X['rollover_pct'] * X['signal_score']

    # ── Block Deals (from block_deal_fetcher.py → technical_signals) ──
    # block_deal_net_qty: buy_qty − sell_qty on NSE block-deal window.
    # Positive = accumulation; negative = distribution. Log-scaled to handle outliers.
    block_raw = df.get('block_deal_net_qty', pd.Series(0, index=df.index)).fillna(0).astype(float)
    X['block_deal_net_log']   = np.sign(block_raw) * np.log1p(block_raw.abs())
    X['block_deal_value_cr']  = num('block_deal_value_cr', 0.0).clip(0, 500) / 500.0

    # ── Trendlyne EPS TTM + DVM (from trendlyne_fundamentals_fetcher.py → technical_signals) ──
    # EPS growth is the single strongest fundamental momentum signal in literature.
    # YoY: consistent improvement in earnings power; QoQ: short-term acceleration.
    # Acceleration (delta-of-delta) captures inflection points missed by level/growth alone.
    X['eps_ttm']          = num('eps_ttm',         5.0).clip(0, 500) / 500.0  # normalised level
    X['eps_growth_yoy']   = num('eps_growth_yoy',  0.0).clip(-100, 200)       # %
    X['eps_growth_qoq']   = num('eps_growth_qoq',  0.0).clip(-50, 100)        # %
    X['eps_acceleration'] = num('eps_acceleration', 0.0).clip(-100, 100)       # Δ%YoY
    # EPS momentum × signal conviction interaction
    X['eps_yoy_x_score']  = X['eps_growth_yoy'].clip(-50, 100) * X['signal_score'] / 50.0

    # Trendlyne DVM scores (0–100, higher = better on each dimension):
    #   dvm_durability = business quality / consistency
    #   dvm_valuation  = cheapness vs fair value (high = cheap)
    #   dvm_momentum   = price + earnings momentum
    X['dvm_durability'] = num('dvm_durability', 50.0).clip(0, 100) / 100.0
    X['dvm_valuation']  = num('dvm_valuation',  50.0).clip(0, 100) / 100.0
    X['dvm_momentum']   = num('dvm_momentum',   50.0).clip(0, 100) / 100.0
    # High durability + high signal = confirmation from fundamentals
    X['dvm_dur_x_score'] = X['dvm_durability'] * X['signal_score']

    # PE TTM: valuation context — high P/E means market priced-in growth (risk of miss)
    X['pe_ttm'] = num('pe_ttm', 25.0).clip(0, 100) / 100.0  # normalised; >100 capped

    # ── PE/PB percentile ranks (from trendlyne_fundamentals_fetcher.py) ──
    # Percentile rank vs own 252d history is more predictive than raw P/E — it captures
    # whether the stock is cheap/expensive relative to its own historical norm.
    X['pe_pct_rank_252d']  = num('pe_pct_rank_252d', 50.0).clip(0, 100) / 100.0
    X['pe_vs_median_1yr']  = num('pe_vs_median_1yr', 0.0).clip(-50, 100)
    X['pb_pct_rank_252d']  = num('pb_pct_rank_252d', 50.0).clip(0, 100) / 100.0
    X['div_yield_ttm']     = num('div_yield_ttm', 1.0).clip(0, 10)
    # Valuation headroom × conviction: cheap PE percentile + strong signal = better odds
    X['pe_rank_x_score']   = (1.0 - X['pe_pct_rank_252d']) * X['signal_score']

    # ── Trendlyne Advanced Technical (from trendlyne_adv_tech_fetcher.py) ──
    # MA and oscillator consensus from Trendlyne's computed signals (16 MAs, 9 oscillators).
    X['ma_bull_frac']       = num('ma_bull_frac', 0.5).clip(0, 1)
    X['osc_bull_frac']      = num('osc_bull_frac', 0.5).clip(0, 1)
    X['adx_tl']             = num('adx_tl', 25.0).clip(0, 100) / 100.0
    X['atr_pct_tl']         = num('atr_pct_tl', 2.0).clip(0, 10) / 10.0
    X['mfi_tl']             = num('mfi_tl', 50.0).clip(0, 100) / 100.0
    X['pivot_dist_pct_tl']  = num('pivot_dist_pct_tl', 0.0).clip(-10, 10)
    X['delivery_avg_1m_tl'] = num('delivery_avg_1m_tl', 50.0).clip(0, 100) / 100.0
    X['beta_1y_tl']         = num('beta_1y_tl', 1.0).clip(0, 3)
    # Price momentum by horizon (Trendlyne computes vs Nifty-adjusted)
    X['ret_1m_tl']          = num('ret_1m_tl', 0.0).clip(-30, 50)
    X['ret_3m_tl']          = num('ret_3m_tl', 0.0).clip(-40, 80)
    X['ret_6m_tl']          = num('ret_6m_tl', 0.0).clip(-50, 100)
    X['ret_1y_tl']          = num('ret_1y_tl', 0.0).clip(-60, 150)
    # Strong trend + high MA alignment = momentum confirmation
    X['ma_x_adx']           = X['ma_bull_frac'] * X['adx_tl']

    # ── Analyst Consensus (from trendlyne_overview_fetcher.py) ──
    # Broker target upside is a direct measure of fundamental analyst conviction.
    # analyst_upside_pct > 20% = strong buy zone; < 0 = overvalued per consensus.
    X['analyst_upside_pct'] = num('analyst_upside_pct', 0.0).clip(-50, 100)
    X['analyst_count_log']  = np.log1p(num('analyst_count', 0).clip(lower=0))
    # NOTE: distinct from analyst_buy_pct above (MC's analyst_estimates_history AS-OF join) —
    # this is Trendlyne's own reported consensus, a different source. Was accidentally assigned
    # the SAME column name as the MC feature, silently overwriting it (the MC value was computed
    # then immediately discarded on every row, since Trendlyne coverage is close to universal and
    # this line always ran last) — that bug meant the MC AS-OF analyst_buy_pct never reached the
    # model despite the E1 data-gap program shipping it. Keep both as separate features.
    X['analyst_buy_pct_tl'] = num('analyst_buy_pct', 50.0).clip(0, 100) / 100.0
    # Upside × signal conviction: high analyst target + strong signal = high-confidence entry
    X['analyst_x_score']    = X['analyst_upside_pct'].clip(0, 100) * X['signal_score'] / 100.0

    # ── Fundamental Profile (from trendlyne_overview_fetcher.py) ──
    # Quality factors: ROE/ROCE capture returns on capital; margins capture pricing power.
    X['roe_annual']      = num('roe_annual', 15.0).clip(0, 100) / 100.0
    X['roce_annual']     = num('roce_annual', 15.0).clip(0, 100) / 100.0
    X['ebitda_margin']   = num('ebitda_margin', 15.0).clip(0, 60) / 60.0
    X['np_margin']       = num('np_margin', 8.0).clip(-20, 40) / 40.0
    X['promoter_pct']    = num('promoter_pct', 50.0).clip(0, 100) / 100.0
    X['fii_pct_tl']      = num('fii_pct', 10.0).clip(0, 80) / 80.0
    X['pledge_pct']      = num('pledge_pct', 5.0).clip(0, 100) / 100.0
    # Revenue and profit growth (quarterly YoY)
    X['rev_growth_yoy_q'] = num('rev_growth_yoy_q', 0.0).clip(-50, 100)
    X['np_growth_yoy_q']  = num('np_growth_yoy_q', 0.0).clip(-100, 200)
    # Quality × price: high-ROE stock with bullish signal = higher success probability
    X['roe_x_score']     = X['roe_annual'] * X['signal_score']
    # Days since last dividend (freshness of income signal)
    X['div_recency']     = np.log1p(num('days_since_dividend', 90).clip(0, 365))
    X['last_div_log']    = np.log1p(num('last_dividend_amt', 0.0).clip(lower=0))
    # Forward-looking: ex-div in <7 days → mechanical price drop risk; board meeting soon → pre-earnings drift.
    X['near_ex_div']     = (num('days_to_ex_div', 999).clip(0, 30) < 3).astype(float)
    X['days_to_ex_div']  = num('days_to_ex_div', 30).clip(0, 30) / 30.0     # 0=today, 1=30d+
    X['upcoming_div_yield'] = num('upcoming_div_pct', 0.0).clip(0, 15)      # % yield (attractive if >2%)
    X['near_board_mtg']  = (num('days_to_board_meeting', 999).clip(0, 30) <= 5).astype(float)

    # ── MC Pricefeed (from mc_pricefeed_fetcher.py) ──
    # 52-week position: near 52w high = momentum; near 52w low = reversal candidate
    X['mc_52w_high_dist'] = num('mc_52w_high_dist_pct', -10.0).clip(-60, 0)      # dist from 52wH (≤0)
    X['mc_52w_low_dist']  = num('mc_52w_low_dist_pct',  20.0).clip(0, 100)       # dist from 52wL (≥0)
    X['mc_days_from_52wh']= np.log1p(num('mc_days_from_52wh', 90).clip(0, 365))  # log-days since peak
    # CAGR: long-run price trend (quality of business compound growth)
    X['mc_cagr_3y']       = num('mc_cagr_3y', 10.0).clip(-30, 100)
    X['mc_cagr_5y']       = num('mc_cagr_5y', 10.0).clip(-30, 100)
    # Industry P/E and relative valuation (IND_PE = avg PE of entire sector)
    X['mc_ind_pe']        = num('mc_ind_pe', 30.0).clip(5, 100) / 100.0
    X['mc_pe_vs_ind']     = num('mc_pe_vs_ind', 0.0).clip(-0.5, 1.0)   # PE/IND_PE - 1
    X['mc_consensus_pe']  = num('mc_consensus_pe', 25.0).clip(0, 100) / 100.0
    # MA distance: price above/below 50 and 200 DMA
    X['mc_ma50_dist']     = num('mc_ma50_dist_pct', 0.0).clip(-20, 20)
    X['mc_ma200_dist']    = num('mc_ma200_dist_pct', 0.0).clip(-30, 30)
    # Delivery % 20-day average (institutional quality of trading)
    X['mc_del_pct_20d']   = num('mc_del_pct_20d', 50.0).clip(0, 100) / 100.0
    # Volume ratio (today vs 20d avg): >1 = unusual activity
    X['mc_vol_ratio_log'] = np.log1p(num('mc_vol_ratio', 1.0).clip(lower=0))
    # Distance to upper circuit limit: near circuit = high volatility risk
    X['mc_circuit_dist']  = num('mc_circuit_dist_pct', 10.0).clip(0, 20)
    # MA golden/death cross indicator: both above 200DMA = uptrend confirmation
    X['mc_above_200dma']  = (X['mc_ma200_dist'] > 0).astype(float)
    X['mc_above_50dma']   = (X['mc_ma50_dist'] > 0).astype(float)
    # 30DMA and 150DMA fill the gap between 50DMA and 200DMA (trend regime)
    X['mc_ma30_dist']     = num('mc_ma30_dist_pct',  0.0).clip(-15, 15)
    X['mc_ma150_dist']    = num('mc_ma150_dist_pct', 0.0).clip(-25, 25)
    X['mc_above_150dma']  = (X['mc_ma150_dist'] > 0).astype(float)

    # Delivery % at 3d vs 20d baseline: rising = institutional accumulation accelerating
    X['mc_del_pct_3d']     = num('mc_del_pct_3d',    50.0).clip(0, 100) / 100.0
    X['mc_del_acceleration']= num('mc_del_acceleration', 0.0).clip(-0.5, 1.0)  # (d3/d20-1)
    # F&O eligibility proxy: indices/large-cap = higher liquidity + institutional tracking
    X['mc_fno_eligible']   = num('mc_fno_eligible', 0).clip(0, 1)

    # 3-day and YTD returns: very recent price action + calendar momentum
    X['mc_3d_return']      = num('mc_3d_return',  0.0).clip(-15, 15)
    X['mc_ytd_return']     = num('mc_ytd_return', 0.0).clip(-50, 100)

    # Consensus earnings vs actual: positive = stock beating analyst consensus EPS (key signal)
    X['mc_eps_vs_cons']    = num('mc_eps_vs_cons', 0.0).clip(-30, 30)       # % beat/miss
    # Forward PE discount: negative = analysts expect earnings growth (price looks cheap fwd)
    X['mc_pe_fwd_discount']= num('mc_pe_fwd_discount', 0.0).clip(-0.5, 0.5)
    # Consensus P/B: analyst-mean book value ratio (smoother than trailing PB)
    X['mc_consensus_pb']   = num('mc_consensus_pb', 3.0).clip(0, 20) / 20.0
    # 10-year CAGR: very long-run quality signal (compound machines vs mean-reversion candidates)
    X['mc_cagr_10y']       = num('mc_cagr_10y', 10.0).clip(-10, 50)
    # P/Cash earnings: less distorted by depreciation than P/E (capex-heavy sector signal)
    X['mc_price_cash']     = num('mc_price_cash', 25.0).clip(0, 100) / 100.0
    # Interaction: EPS beat × signal score → conviction amplifier
    X['mc_eps_x_score']    = X['mc_eps_vs_cons'].clip(0, 30) / 30.0 * X['signal_score']
    # Consensus EPS (level): lower-than-market consensus = low bar to beat
    X['mc_consensus_eps']  = num('mc_consensus_eps', 20.0).clip(0.1, 500)
    X['mc_consensus_eps_log'] = np.log1p(X['mc_consensus_eps'])

    # ── MC Chart Patterns (from mc_chart_patterns_fetcher.py) ──
    # MC's professional pattern analysis: bullish/bearish count from technical charts.
    # bull_count=3 means 3 active buy-side patterns; net_score=bull-bear.
    X['mc_cp_bull_count'] = num('mc_cp_bull_count', 0).clip(0, 12) / 12.0    # normalised
    X['mc_cp_bear_count'] = num('mc_cp_bear_count', 0).clip(0, 12) / 12.0
    X['mc_cp_net_score']  = num('mc_cp_net_score', 0).clip(-12, 12) / 12.0
    X['mc_cp_target_pct'] = num('mc_cp_avg_target_pct', 0.0).clip(0, 30)     # avg upside %
    # Pattern conviction × signal conviction: overlapping bull signals
    X['mc_cp_x_score']    = X['mc_cp_net_score'].clip(lower=0) * X['signal_score']

    # ── Trendlyne Price Analysis (from trendlyne_price_analysis_fetcher.py) ──
    # Cross-sectional alpha: outperforming Nifty suggests stock-specific momentum
    X['tl_alpha_nifty_1m'] = num('tl_vs_nifty_1m', 0.0).clip(-20, 30)
    X['tl_alpha_nifty_3m'] = num('tl_vs_nifty_3m', 0.0).clip(-30, 50)
    X['tl_alpha_nifty_6m'] = num('tl_vs_nifty_6m', 0.0).clip(-40, 70)
    X['tl_alpha_ind_1m']   = num('tl_vs_ind_1m',   0.0).clip(-20, 30)
    X['tl_alpha_ind_3m']   = num('tl_vs_ind_3m',   0.0).clip(-30, 50)
    # Monthly seasonality: 5-year avg return for current calendar month
    X['tl_seasonality']   = num('tl_seasonal_month_5y', 0.0).clip(-10, 20)
    # Distance from quarterly high/low
    X['tl_3m_high_dist']  = num('tl_dist_3m_high_pct', -5.0).clip(-40, 0)   # ≤0
    X['tl_3m_low_dist']   = num('tl_dist_3m_low_pct',  10.0).clip(0, 80)    # ≥0
    # Alpha persistence: positive 3M alpha + positive seasonal = sustained momentum
    X['tl_alpha_x_season'] = X['tl_alpha_nifty_3m'].clip(0, 50) * X['tl_seasonality'].clip(0, 20) / 50.0

    # ── NiftyTrader F&O Dashboard (from nt_dashboard_fetcher.py) ──
    # Max pain: price gravitates toward max_pain near expiry (market-maker pinning effect).
    # Negative dist = price below max pain = upward pull; large positive = sell pressure expected.
    X['nt_max_pain_dist'] = num('nt_max_pain_dist_pct', 0.0).clip(-15, 15)
    X['nt_near_max_pain'] = (X['nt_max_pain_dist'].abs() < 3.0).astype(float)  # within 3% = gravitational zone
    # OI direction: (puts_Δoi - calls_Δoi) / total_oi. Positive = put side building (bearish).
    # Negative = calls unwound faster than puts (bullish smart-money signal).
    X['nt_oi_direction']  = num('nt_oi_direction', 0.0).clip(-0.3, 0.3)
    # PCR: <1 = more call OI than put OI (often contrarian bullish when extreme)
    X['nt_pcr']           = num('nt_pcr', 1.0).clip(0, 3)
    # Option volume: log-scaled activity — high volume = event anticipation / institutional move
    X['nt_option_vol']    = num('nt_option_volume_log', 0.0).clip(0, 25)
    # Interaction: bearish OI direction weakening an already-low signal score = conviction short
    X['nt_oi_x_score']    = X['nt_oi_direction'] * X['signal_score']  # negative = bearish pile-on

    # ── Historical Volatility (from hv_features.py, computed on stock_ohlcv) ──
    # Low HV = calm stock, fewer false breakouts. iv_hv_ratio > 1 = options overpriced vs realized.
    X['hv_20d']           = num('hv_20d', 20.0).clip(5, 80) / 80.0
    X['hv_60d']           = num('hv_60d', 22.0).clip(5, 80) / 80.0
    X['hv_ratio_60_20']   = (num('hv_60d', 22.0) / num('hv_20d', 20.0).replace(0, np.nan)).fillna(1.0).clip(0.5, 2.0)
    X['iv_hv_ratio']      = num('iv_hv_ratio', 1.0).clip(0, 5) / 5.0

    # ── Analyst estimate revision (from analyst_revision.py) ──
    # Upward EPS revisions predict sustained demand (institutional mandate buying). Top quant factor.
    X['eps_rev_3m']       = num('eps_revision_3m_pct', 0.0).clip(-30, 30)
    X['target_rev_3m']    = num('target_revision_3m_pct', 0.0).clip(-20, 20)
    X['analyst_chg']      = num('analyst_count_chg', 0).clip(-5, 5) / 5.0
    # Interaction: rising estimates + strong score = high-conviction long
    X['eps_rev_x_score']  = X['eps_rev_3m'].clip(0, 30) / 30.0 * X['signal_score']

    # ── Sector-relative RS (from relative_strength.py extension) ──
    # Distinguishes sector leaders from laggards — absolute RS can't see this.
    X['rs_vs_sector_21d'] = num('rs_vs_sector_21d', 0.0).clip(-15, 15)
    X['rs_vs_sector_63d'] = num('rs_vs_sector_63d', 0.0).clip(-20, 20)
    X['sector_leader']    = (X['rs_vs_sector_21d'] > 2.0).astype(float)

    # ── Surveillance risk flags (from asm_gsm_fetcher.py) ──
    # ASM = 100% margin → institutional forced selling; GSM stage 5-6 = near-untradeable.
    X['asm_flag']         = num('asm_flag', 0).clip(0, 1)
    X['gsm_severity']     = num('gsm_stage', 0).clip(0, 6) / 6.0
    X['surveillance_risk'] = X['asm_flag'] + X['gsm_severity']  # 0=clean, >0=risk

    # ── Commodity / FX sensitivity (from commodity_sensitivity.py) ──
    # Sector-routing signal: crude_corr>0.4 = oil/aviation; dxy_corr<-0.3 = IT exporters.
    X['crude_corr']       = num('crude_corr_90d', 0.0).clip(-1, 1)
    X['gold_corr']        = num('gold_corr_90d', 0.0).clip(-1, 1)
    X['dxy_corr']         = num('dxy_corr_90d', 0.0).clip(-1, 1)
    X['sp500_corr']       = num('sp500_corr_90d', 0.0).clip(-1, 1)

    # ── Broker recommendation events (from mc_broker_reco_fetcher.py) ──
    # Fresh named-broker BUY initiations drive institutional mandate demand for 2-4 weeks.
    X['broker_buy_7d']    = num('mc_broker_buy_7d', 0).clip(0, 10) / 10.0
    X['broker_sell_7d']   = num('mc_broker_sell_7d', 0).clip(0, 10) / 10.0
    X['broker_net_7d']    = X['broker_buy_7d'] - X['broker_sell_7d']
    X['broker_upside']    = num('mc_broker_upside', 0.0).clip(0, 60) / 60.0
    # Interaction: high upside target + good signal score = conviction
    X['broker_x_score']   = X['broker_upside'] * X['signal_score']

    # ── Market-level macro regime (from global_macro_fetcher + preopen_fetcher) ──
    # These are cross-sectional constants (same for all stocks) but encode the risk regime.
    X['gift_nifty_pct']   = num('gift_nifty_pct', 0.0).clip(-3, 3)
    X['nifty_gex']        = num('nifty_gex', 0.0).clip(-50, 50) / 50.0  # dealer GEX in ₹B
    X['nifty_long_gamma'] = (X['nifty_gex'] > 0).astype(float)  # 1=mean-rev, 0=trend
    X['india_10y']        = num('india_10y', 6.5).clip(5, 9) / 9.0
    X['india_us_spread']  = num('india_us_spread', 2.0).clip(0, 5) / 5.0
    X['high_impact_3d']   = num('high_impact_3d', 0).clip(0, 5) / 5.0  # macro event risk
    X['asia_sentiment']   = num('asia_sentiment', 0.0).clip(-3, 3)
    X['global_risk']      = num('global_risk', 0.0).clip(-3, 3)
    X['risk_on']          = (X['global_risk'] > 0).astype(float)  # 1=global risk-on
    # Interaction: risk-on regime × bullish signal = higher conviction
    X['risk_x_score']     = X['global_risk'].clip(0, 3) / 3.0 * X['signal_score']
    # Indian ADR overnight bullishness (0-100 → 0-1). >60 = institutional risk-on for India.
    X['adrs_bullish']     = num('adrs_bullish_pct', 50.0).clip(0, 100) / 100.0
    # USD/INR daily return — negative = INR strengthening (bullish for importers, bearish for IT).
    X['usdinr_ret']       = num('usdinr_ret_1d', 0.0).clip(-2, 2)
    # Leading Asian indices (close before India opens) — strongest same-day predictor.
    X['nikkei_ret']       = num('nikkei_ret_1d', 0.0).clip(-8, 8)
    X['hangseng_ret']     = num('hangseng_ret_1d', 0.0).clip(-8, 8)
    # Composite Asia+ADR risk signal
    X['asia_adr_risk']    = (X['asia_sentiment'] + X['adrs_bullish'] * 2 - 1).clip(-3, 3)

    # ── Earnings calendar & PEAD (from mc_earnings_fetcher.py) ──
    # Pre-earnings: stocks drift up avg 2-3% in 5 days before results (Jegadeesh-Livnat).
    # Post-earnings PEAD: BP category stocks drift up 60 days; NT drift down (Bernard 1992).
    X['days_to_results']    = num('days_to_next_results', 30).clip(0, 30) / 30.0
    X['near_results']       = (num('days_to_next_results', 30) <= 5).astype(float)
    X['cat_yoy']            = num('earnings_category_yoy', 0).clip(-2, 2) / 2.0
    X['cat_qoq']            = num('earnings_category_qoq', 0).clip(-2, 2) / 2.0
    X['np_growth_yoy']      = num('earnings_np_growth_yoy', 0.0).clip(-50, 100) / 100.0
    X['np_growth_qoq']      = num('earnings_np_growth_qoq', 0.0).clip(-50, 100) / 100.0
    X['shocker_flag']       = num('earnings_shocker_flag', 0).clip(0, 1)
    X['shocker_gain']       = num('earnings_shocker_gain', 0.0).clip(0, 200) / 200.0
    # beat_pct: % above/below analyst consensus. Positive=beat, negative=miss.
    X['mc_beat_pct']        = num('mc_eps_vs_cons', 0.0).clip(-100, 200) / 100.0
    X['beat_magnitude']     = X['mc_beat_pct'].clip(0, 2)  # how much beat (0 if miss)
    X['miss_magnitude']     = (-X['mc_beat_pct']).clip(0, 1)  # how much miss (0 if beat)
    # Turnaround stocks: high volatility + mean-reversion opportunity
    X['positive_turnaround'] = num('positive_turnaround', 0).clip(0, 1)
    X['negative_turnaround'] = num('negative_turnaround', 0).clip(0, 1)
    # Market earnings breadth: below 0.5 means majority of stocks disappointing
    X['earnings_breadth']   = num('high_impact_3d', 0.5).clip(0, 1)  # reuse macro slot if needed
    # Interaction: BP category + strong signal = highest PEAD conviction
    X['pead_signal']        = X['cat_yoy'].clip(0, 1) * X['signal_score']

    # ── Sector earnings quality (from mc_sector_earnings via JOIN) ──
    # Stock in sector where NP growing >15% YoY = earnings tailwind for all stocks in that sector.
    X['sector_np_yoy']      = num('sector_np_growth_yoy', 0.0).clip(-20, 40) / 40.0
    X['sector_np_qoq']      = num('sector_np_growth_qoq', 0.0).clip(-20, 30) / 30.0
    X['sector_rev_yoy']     = num('sector_rev_growth_yoy', 0.0).clip(-10, 20) / 20.0
    X['sector_earnings_up'] = (X['sector_np_yoy'] > 0.25).astype(float)  # sector NP>10% tailwind

    # ── Market-level earnings breadth (from macro_snap + mc_earnings_fetcher dashboard) ──
    X['mkt_np_yoy']         = num('market_np_yoy', 10.0).clip(-10, 40) / 40.0
    X['earnings_breadth_m'] = num('earnings_breadth_mkt', 0.5).clip(0, 1)  # >0.5 = majority positive

    # ── Index membership (passive ETF flow signal) ──
    X['is_nifty50']   = num('is_nifty50',  0.0).clip(0, 1)
    X['is_nifty100']  = num('is_nifty100', 0.0).clip(0, 1)
    X['nifty_tier']   = num('nifty_tier',  0.0).clip(0, 250) / 250.0  # 50=top→0.2, 0=none→0

    # ── Promoter pledge trend (deleveraging = bullish, increasing = distress) ──
    X['pledge_chg_90d']    = num('pledge_chg_90d', 0.0).clip(-10, 10) / 10.0
    X['pledge_deleveraging'] = (X['pledge_chg_90d'] < -0.2).astype(float)
    X['pledge_distress']     = (X['pledge_chg_90d'] > 0.2).astype(float)

    # ── Pre-open IEP signal (gap-up/gap-down expected at open) ──
    X['iep_gap_pct']      = num('iep_gap_pct', 0.0).clip(-5, 5) / 5.0
    X['preopen_imbalance']= num('preopen_imbalance', 0.0).clip(-1, 1)
    X['gap_up_open']      = (X['iep_gap_pct'] > 0.1).astype(float)

    # ── Per-stock option chain (expected move + GEX proxy) ──
    X['expected_move_pct'] = num('expected_move_pct', 3.0).clip(0.5, 15) / 15.0
    X['stock_gex_proxy']   = num('stock_gex_proxy', 0.0).clip(-1, 1)  # >0=mean-rev, <0=trending
    X['low_expected_move'] = (X['expected_move_pct'] < 0.15).astype(float)  # cheap options

    # ── Provisional FII flow (T+0, available by 6 PM same day) ──
    X['fii_net_today']  = num('fii_net_today', 0.0).clip(-5000, 5000) / 5000.0
    X['fii_buying']     = (X['fii_net_today'] > 0.1).astype(float)
    X['fii_selling']    = (X['fii_net_today'] < -0.1).astype(float)

    # ── India VIX (from macro_asset_prices — used in regime detection only) ──
    # Normalised to [0,1] over the 8-35 observable range. Used for regime-conditional
    # scoring layer; not fed to the per-stock classifier (tested, hurt held-out AUC).
    # X['india_vix'] = num('india_vix', 15.0).clip(8, 35) / 35.0
    # X['high_vix']  = (X['india_vix'] > 0.57).astype(float)  # > 20 normalised

    # ── Second-order interactions (cross-signal alpha) ──────────────────────────
    # Analyst upgrade × sector RS: double-confirmation of institutional interest
    X['eps_rev_x_rs']    = X['eps_rev_3m'].clip(-1, 1) * X.get('rs_vs_sector_21d', pd.Series(0.0, index=X.index)).clip(-1, 1)

    # Broker buy × IEP gap-up: institutional recommendation + pre-market momentum
    broker_buy_norm = num('mc_broker_buy_7d', 0.0).clip(0, 5) / 5.0
    X['broker_x_iep']    = broker_buy_norm * X['iep_gap_pct'].clip(0, 1)

    # EPS beat streak × near results: strongest PEAD setup
    X['pead_confirmed']  = X.get('eps_beat_streak', pd.Series(0.0, index=X.index)).clip(0, 1) * X['near_results']

    # Low expected move × high RS: options cheap on a relative strength leader
    X['cheap_opts_rs']   = X['low_expected_move'] * X.get('sector_leader', pd.Series(0.0, index=X.index))

    # FII buying × gift nifty positive: double market-risk-on confirmation
    X['risk_on_confirm'] = X['fii_buying'] * (X['gift_nifty_pct'] > 0.1).astype(float)

    # High IV × earnings near: expensive options near results (sell premium signal)
    X['iv_near_results'] = (num('iv_hv_ratio', 1.0) > 1.5).astype(float) * X['near_results']

    # Nifty50 index member × bull GEX: passive flow + mean-reverting gamma environment
    X['index_bull_gex']  = X['is_nifty50'] * (1 - X['nifty_long_gamma'])  # nifty50 in long-gamma = flow support

    # Pledge improving × strong FCF: deleveraging + cash generation = quality compound
    # TODO: enable once there's enough live fcf_yield_approx history to validate this interaction
    # (financial_ratios_fetcher.py now populates it via ET_Stats; was previously always 0 rows)
    # X['quality_compound'] = X['pledge_deleveraging'] * num('fcf_yield', 0.0).clip(0, 0.2) / 0.2

    # ── EPS surprise streak (from eps_surprise_fetcher.py) ──────────────────
    # TODO: enable once eps_surprise_fetcher populates eps_surprise_q1/q2 (currently 0 rows)
    # X['eps_surprise_q1']      = num('eps_surprise_q1', 0.0).clip(-20, 20) / 20.0
    # X['eps_surprise_q2']      = num('eps_surprise_q2', 0.0).clip(-20, 20) / 20.0
    X['eps_beat_streak_norm'] = num('eps_beat_streak', 0.0).clip(0, 8) / 8.0
    X['eps_miss_after_run']   = num('eps_miss_after_streak', 0.0).clip(0, 1)
    X['rev_surprise_q1']      = num('rev_surprise_q1', 0.0).clip(-10, 10) / 10.0
    # X['eps_momentum']         = X['eps_surprise_q1'] * X['eps_beat_streak_norm']  # streak × size — disabled: eps_surprise_q1 unpopulated

    # ── Financial quality: FCF + interest coverage (financial_ratios_fetcher.py) ──
    X['fcf_yield_norm']    = num('fcf_yield', 0.0).clip(-5, 20) / 20.0
    X['interest_cov']      = num('interest_coverage', 5.0).clip(0, 20) / 20.0
    X['fcf_positive']      = num('fcf_positive', 0.0).clip(0, 1)
    X['debt_risk']         = num('debt_coverage_risk', 0.0).clip(0, 1)
    X['quality_score']     = X['fcf_positive'] * (1 - X['debt_risk'])  # FCF+safe = quality

    # ── Delivery % trend + block deals + short proxy (delivery_trend_fetcher.py) ──
    X['delivery_trend']   = num('delivery_trend_30d', 0.0).clip(-20, 20) / 20.0
    X['block_deal']       = num('block_deal_flag', 0.0).clip(0, 1)
    X['block_sell']       = (num('block_deal_direction', 0.0) < -0.5).astype(float)
    X['short_proxy']      = num('short_interest_proxy', 0.3).clip(0, 1)
    X['high_short']       = (X['short_proxy'] > 0.55).astype(float)  # put-heavy = crowded short

    # ── Promoter insider transactions (insider_transactions_fetcher.py) ──────
    X['promoter_net']      = num('promoter_net_90d', 0.0).clip(-50, 50) / 50.0
    # TODO: enable once insider_transactions_fetcher populates insider_buy_flag (currently 0 rows)
    # X['insider_buy']       = num('insider_buy_flag', 0.0).clip(0, 1)
    X['insider_sell']      = num('insider_sell_flag', 0.0).clip(0, 1)

    # ── Credit rating events (credit_rating_fetcher.py) ──────────────────────
    X['rating_up']         = num('rating_upgrade_180d', 0.0).clip(0, 1)
    X['rating_down']       = num('rating_downgrade_180d', 0.0).clip(0, 1)
    X['rating_recency']    = (365.0 - num('days_since_upgrade', 365.0).clip(0, 365)) / 365.0

    # ── MF sector flow (mf_sector_flow_fetcher.py) ──────────────────────────
    X['mf_sector_flow']    = num('mf_sector_flow_pct', 0.0).clip(-2, 2) / 2.0
    X['mf_inflow']         = (X['mf_sector_flow'] > 0.1).astype(float)

    # ── Working capital cycle (working_capital_fetcher.py) ───────────────────
    X['ccc_ttm_norm']      = num('ccc_ttm', 40.0).clip(0, 180) / 180.0
    X['ccc_trend_norm']    = num('ccc_trend', 0.0).clip(-30, 30) / 30.0
    X['wc_bad']            = num('wc_deteriorating', 0.0).clip(0, 1)
    X['wc_good']           = num('wc_improving', 0.0).clip(0, 1)

    # ── Screener features (screener_features_fetcher.py) ─────────────────────
    # Aggregated signal from 1521 screeners: how many bullish/bearish, quality-weighted momentum,
    # category diversity, persistence (streak), and alpha of screeners that flag this stock.
    X['screener_bull']     = num('screener_bull_count', 0).clip(0, 50) / 50.0
    X['screener_bear']     = num('screener_bear_count', 0).clip(0, 20) / 20.0
    X['screener_breadth']  = num('screener_cat_breadth', 0).clip(0, 19) / 19.0   # distinct categories
    X['screener_tier1']    = num('screener_tier1_count', 0).clip(0, 20) / 20.0   # A/B tier only
    X['screener_momentum'] = num('screener_momentum_score', 0).clip(0, 30) / 30.0  # bayesian-weighted
    X['screener_streak']   = num('screener_streak_days', 0).clip(0, 60) / 60.0   # persistence days
    X['screener_name_sig'] = num('screener_name_signal', 1.0).clip(0, 2) / 2.0   # 0=bear,1=neutral,2=bull
    X['screener_alpha']    = num('screener_alpha_score', 0.0).clip(-10, 20) / 20.0
    X['screener_net_bias'] = (X['screener_bull'] - X['screener_bear']).clip(-1, 1)  # directional
    # Cross-signal: screener bull + good breadth + persistence = high conviction
    X['screener_conviction'] = (
        X['screener_momentum'] * X['screener_breadth'] * (1 + X['screener_streak'])
    ).clip(0, 2)

    # ── Currency + futures basis (market_regime_fetcher.py) ──────────────────
    X['usdinr_chg']        = num('usdinr_chg_pct', 0.0).clip(-2, 2) / 2.0
    X['nifty_basis']       = num('nifty_basis_pct', 1.0).clip(-3, 5) / 5.0
    X['nifty_contango']    = num('nifty_contango', 1.0).clip(0, 1)

    # NOTE: market-level India VIX + breadth were tested as ensemble features (raw and as
    # cross-sectional interactions) and BOTH hurt held-out AUC vs omitting them entirely
    # (baseline cv 0.651/held-out 0.543; interactions 0.640/0.531; raw 0.606/0.493). They add
    # no cross-sectional signal to this per-stock classifier, so they are deliberately NOT fed
    # here. The INDIAVIX series still feeds regime_detector (a separate model) and market_breadth
    # remains available for a future regime-conditional model.

    # ── Event-proximity calendar features (pure functions of signal_date, leak-free) ──
    if len(df) == 0:
        # Empty input (e.g. zero pending signals): the calendar helpers below divide an
        # empty datetime-typed Series, which raises. Emit empty float columns instead.
        X['days_to_fno_expiry'] = pd.Series(dtype='float64')
        X['results_season']     = pd.Series(dtype='float64')
    else:
        sd = pd.to_datetime(df['signal_date'], errors='coerce') if 'signal_date' in df.columns else \
            pd.Series(pd.NaT, index=df.index)
        X['days_to_fno_expiry'] = _days_to_fno_expiry(sd).fillna(15) / 30.0
        X['results_season']     = _results_season_flag(sd).fillna(0)

    # ── Timing & momentum signals (from existing populated columns) ──────────────
    rsi_v       = num('rsi', 50)
    vol_r       = num('volume_ratio', 1.0)
    adx_v       = num('adx', 20)
    pcr         = num('pcr_oi', 1.0)
    iv_r        = num('iv_rank', 50)
    sent        = num('news_sentiment_score', 0)
    fii_3       = num('fii_3d_net', 0)
    fii_10      = num('fii_10d_net', 0)
    dii_3       = num('dii_3d_net', 0)
    sec_5       = num('sector_ret_5d', 0)
    sec_21      = num('sector_ret_21d', 0)
    above_200   = num('above_sma200', 0)

    # RSI zone signals
    X['rsi_oversold']      = (rsi_v < 35).astype(float)
    X['rsi_momentum_zone'] = ((rsi_v >= 50) & (rsi_v <= 70)).astype(float)
    X['rsi_overbought']    = (rsi_v > 75).astype(float)

    # Volume confirmation
    X['vol_spike']         = (vol_r > 2.0).astype(float)
    X['vol_above_avg']     = (vol_r > 1.3).astype(float)

    # Trend strength
    X['adx_strong']        = (adx_v > 25).astype(float)
    X['above_200_vol']     = (above_200 * (vol_r > 1.2)).astype(float)

    # Options/PCR signals
    X['pcr_bullish']       = (pcr < 0.75).astype(float)
    X['pcr_bearish']       = (pcr > 1.2).astype(float)
    X['iv_low_entry']      = (iv_r < 30).astype(float)

    # News sentiment
    X['sentiment_pos']     = (sent > 0.3).astype(float)
    X['sentiment_neg']     = (sent < -0.3).astype(float)
    X['sentiment_score']   = sent.clip(-1, 1)

    # FII/DII flow (raw units from fii_dii_fetcher, not normalised)
    X['fii_buying_flow']   = ((fii_3 > 0) & (fii_10 > 0)).astype(float)
    X['fii_selling_flow']  = ((fii_3 < 0) & (fii_10 < 0)).astype(float)
    X['dii_buying_flow']   = (dii_3 > 0).astype(float)
    X['fii_dii_agree']     = (((fii_3 > 0) & (dii_3 > 0)) | ((fii_3 < 0) & (dii_3 < 0))).astype(float)

    # Sector momentum
    X['sector_strong']     = ((sec_5 > 1.5) & (sec_21 > 3)).astype(float)
    X['sector_weak']       = ((sec_5 < -1.5) & (sec_21 < -3)).astype(float)

    # Compound conviction signals
    X['bull_trifecta']     = (X['rsi_momentum_zone'] * X['vol_above_avg'] * X['fii_buying_flow'])
    X['trend_vol_confirm'] = (X['adx_strong'] * X['above_200_vol'])

    # ── PEAD + Event signals ─────────────────────────────────────────────────────
    X['pead_score']        = num('pead_score', 0).clip(-1, 1)
    X['event_score']       = num('event_signal_score', 0).clip(-3, 3) / 3.0
    X['event_positive']    = (num('event_signal_score', 0) > 1.0).astype(float)
    X['event_negative']    = (num('event_signal_score', 0) < -1.0).astype(float)
    X['pead_x_event']      = (X['pead_score'] * X['event_score']).clip(-1, 1)

    # Signal type one-hot
    sig_col = df['signals_json'] if 'signals_json' in df.columns else pd.Series(['[]'] * len(df), index=df.index)
    type_sets = sig_col.apply(_parse_signal_types)
    for t in SIGNAL_TYPES:
        X[f'sig_{t}'] = type_sets.apply(lambda s: 1 if t in s else 0).astype(np.int8)

    # Signal count (complexity)
    X['signal_count'] = type_sets.apply(len)

    return X.astype(np.float32)


# ── Regime Thresholding ──────────────────────────────────────────────────────

# Requires: app_settings key 'current_nifty_regime' to be written by the
# technical-signals scan pipeline (e.g. technicalSignalsService). Until that
# writer is wired, this function returns the BULL default (0.40).
def regime_threshold(conn: ConnWrapper) -> float:
    """Return the win_probability gate calibrated to the current Nifty regime."""
    row = conn.execute(
        "SELECT value FROM app_settings WHERE key = 'current_nifty_regime'"
    ).fetchone()
    if row is None:
        print("[Ensemble] WARNING: 'current_nifty_regime' not set in app_settings — defaulting to BULL threshold (0.40). Wire a writer in the technical-signals scan to activate regime-adaptive gating.")
    regime = row[0] if row else 'BULL'
    return _REGIME_THRESHOLDS.get(regime, 0.40)


# ── Data Loading ─────────────────────────────────────────────────────────────

def _table_columns(conn: ConnWrapper, table: str) -> list:
    """Engine-aware column list (replaces sqlite-only PRAGMA table_info)."""
    if use_postgres():
        rows = conn.execute(
            "SELECT column_name FROM information_schema.columns WHERE table_name = ?",
            (table,),
        ).fetchall()
        return [r[0] for r in rows]
    rows = conn.execute(f"PRAGMA table_info({table})").fetchall()
    return [r[1] for r in rows]


def load_training_data(label: str = 'horizon') -> pd.DataFrame:
    """Load labeled training rows. `label`:
      - 'horizon'        → so.outcome ∈ {WIN,LOSS} thresholded at the horizon (default).
      - 'triple_barrier' → se.tb_label (vol-scaled first-touch label from signal_excursions).
    """
    if label == 'triple_barrier':
        label_select = "se.tb_label AS outcome"
        label_join = (
            "LEFT JOIN signal_excursions se "
            "ON se.symbol = so.symbol AND se.signal_date = so.signal_date "
            "AND se.horizon_days = so.horizon_days"
        )
        label_where = "se.tb_label IS NOT NULL"
    else:
        label_select = "so.outcome"
        label_join = ""
        label_where = "so.outcome IN ('WIN','LOSS','STOP_LOSS')\n          AND so.return_pct IS NOT NULL"

    q = f"""
        SELECT so.symbol, so.signal_date, so.horizon_days, {label_select},
               so.signal_score, so.signals_json, so.return_pct,
               ts.rsi, ts.adx, ts.nifty_regime, ts.cmp, ts.sma200, ts.volume_ratio,
               ts.fii_3d_net,
               ts.above_sma200,
               ts.pcr_oi, ts.pcr_vol,
               ts.fii_10d_net, ts.dii_3d_net,
               ts.delivery_pct,
               ts.sector_ret_5d, ts.sector_ret_21d,
               ts.sector_global_corr_21d,
               ts.iv_rank, ts.iv_skew,
               ts.rs_rank_21d, ts.rs_rank_63d,
               ts.insider_buy_pct_90d,
               ts.opening_range_break,
               ts.vwap_deviation_pct,
               ts.first_hour_vol_share,
               ts.avwap_deviation_pct,
               ts.oi_net_change_pct,
               ts.eps_beat_last_q,
               ts.eps_beat_streak_4q,
               ts.eps_miss_streak_4q,
               ts.eps_surprise_last_yr,
               ts.eps_estimate_dispersion,
               fs.ret_12m_ex1m,
               mb.pct_above_200dma, mb.adv_decline_ratio, mb.net_highs_lows,
               hfs.max_pain,
               ts.mf_holding_pct, ts.mf_fund_count, ts.mf_chg_vs_prev,
               ts.rollover_pct, ts.cost_of_carry_ann,
               ts.block_deal_net_qty, ts.block_deal_value_cr,
               ts.eps_ttm, ts.eps_growth_yoy, ts.eps_growth_qoq, ts.eps_acceleration,
               ts.pe_ttm, ts.dvm_durability, ts.dvm_valuation, ts.dvm_momentum,
               ts.pe_pct_rank_252d, ts.pe_vs_median_1yr, ts.pb_pct_rank_252d, ts.div_yield_ttm,
               ts.ma_bull_frac, ts.osc_bull_frac, ts.adx_tl, ts.atr_pct_tl, ts.mfi_tl,
               ts.pivot_dist_pct_tl, ts.delivery_avg_1m_tl, ts.beta_1y_tl,
               ts.ret_1m_tl, ts.ret_3m_tl, ts.ret_6m_tl, ts.ret_1y_tl,
               ts.analyst_upside_pct, ts.analyst_count, ts.analyst_buy_pct,
               ts.roe_annual, ts.roce_annual, ts.ebitda_margin, ts.np_margin,
               ts.promoter_pct, ts.fii_pct, ts.pledge_pct,
               ts.rev_growth_yoy_q, ts.np_growth_yoy_q,
               ts.days_since_dividend, ts.last_dividend_amt,
               ts.days_to_ex_div, ts.days_to_board_meeting, ts.upcoming_div_pct,
               ts.mc_52w_high_dist_pct, ts.mc_52w_low_dist_pct, ts.mc_days_from_52wh,
               ts.mc_cagr_3y, ts.mc_cagr_5y, ts.mc_cagr_10y, ts.mc_ind_pe, ts.mc_pe_vs_ind,
               ts.mc_consensus_pe, ts.mc_consensus_pb,
               ts.mc_ma30_dist_pct, ts.mc_ma50_dist_pct, ts.mc_ma150_dist_pct, ts.mc_ma200_dist_pct,
               ts.mc_del_pct_3d, ts.mc_del_pct_5d, ts.mc_del_pct_20d, ts.mc_del_acceleration,
               ts.mc_vol_ratio, ts.mc_circuit_dist_pct, ts.mc_fno_eligible,
               ts.mc_3d_return, ts.mc_ytd_return,
               ts.mc_price_cash, ts.mc_consensus_eps, ts.mc_eps_vs_cons, ts.mc_pe_fwd_discount,
               ts.mc_cp_bull_count, ts.mc_cp_bear_count, ts.mc_cp_net_score, ts.mc_cp_avg_target_pct,
               ts.tl_vs_nifty_1m, ts.tl_vs_nifty_3m, ts.tl_vs_nifty_6m,
               ts.tl_vs_ind_1m, ts.tl_vs_ind_3m,
               ts.tl_seasonal_month_5y, ts.tl_dist_3m_high_pct, ts.tl_dist_3m_low_pct,
               ts.nt_max_pain_dist_pct, ts.nt_oi_direction, ts.nt_pcr, ts.nt_option_volume_log,
               ts.hv_10d, ts.hv_20d, ts.hv_30d, ts.hv_60d, ts.iv_hv_ratio,
               ts.pead_score, ts.event_signal_score,
               ts.eps_revision_3m_pct, ts.target_revision_3m_pct, ts.analyst_count_chg,
               ts.rs_vs_sector_21d, ts.rs_vs_sector_63d,
               ts.asm_flag, ts.gsm_stage,
               ts.crude_corr_90d, ts.gold_corr_90d, ts.dxy_corr_90d, ts.sp500_corr_90d,
               ts.mc_broker_buy_7d, ts.mc_broker_sell_7d, ts.mc_broker_upside,
               ts.days_to_next_results, ts.earnings_category_yoy, ts.earnings_category_qoq,
               ts.earnings_np_growth_yoy, ts.earnings_np_growth_qoq,
               ts.mc_eps_vs_cons, ts.positive_turnaround, ts.negative_turnaround,
               ts.earnings_shocker_flag, ts.earnings_shocker_gain,
               ts.is_nifty50, ts.is_nifty100, ts.nifty_tier,
               ts.pledge_chg_90d,
               ts.iep_gap_pct, ts.preopen_imbalance,
               ts.expected_move_pct, ts.stock_gex_proxy,
               ts.eps_surprise_q1, ts.eps_surprise_q2, ts.eps_beat_streak,
               ts.eps_miss_after_streak, ts.rev_surprise_q1,
               ts.fcf_yield_approx AS fcf_yield, ts.interest_coverage, ts.fcf_positive, ts.debt_coverage_risk,
               ts.delivery_trend_30d, ts.block_deal_flag, ts.block_deal_direction,
               ts.short_interest_proxy,
               ts.promoter_buy_90d_cr, ts.promoter_sell_90d_cr, ts.promoter_net_90d,
               ts.insider_buy_flag, ts.insider_sell_flag,
               ts.rating_upgrade_180d, ts.rating_downgrade_180d, ts.days_since_upgrade,
               ts.mf_sector_flow_pct,
               ts.receivables_days_ttm, ts.ccc_ttm, ts.ccc_trend,
               ts.wc_deteriorating, ts.wc_improving,
               ts.screener_bull_count, ts.screener_bear_count, ts.screener_cat_breadth,
               ts.screener_tier1_count, ts.screener_momentum_score, ts.screener_streak_days,
               ts.screener_name_signal, ts.screener_alpha_score,
               macro_snap.gift_nifty_pct, macro_snap.nifty_gex,
               macro_snap.india_10y, macro_snap.india_us_spread,
               macro_snap.high_impact_3d, macro_snap.asia_sentiment, macro_snap.global_risk,
               macro_snap.market_np_yoy, macro_snap.earnings_breadth_mkt,
               macro_snap.fii_net_today,
               macro_snap.usdinr_chg_pct, macro_snap.nifty_basis_pct, macro_snap.nifty_contango,
               macro_snap.india_vix,
               macro_snap.adrs_bullish_pct, macro_snap.usdinr_ret_1d,
               macro_snap.nikkei_ret_1d, macro_snap.hangseng_ret_1d,
               mse.np_growth_yoy AS sector_np_growth_yoy, mse.np_growth_qoq AS sector_np_growth_qoq,
               mse.rev_growth_yoy AS sector_rev_growth_yoy,
               COALESCE(fh.fifty_two_week_high, sf.fifty_two_week_high) AS fifty_two_week_high,
               COALESCE(fh.piotroski_f_score, sf.piotroski_f_score)     AS piotroski_f_score,
               COALESCE(fh.debt_to_equity, sf.debt_to_equity)           AS debt_to_equity,
               COALESCE(fh.operating_margins, sf.operating_margins)     AS operating_margins,
               COALESCE(fh.return_on_equity, sf.return_on_equity)       AS return_on_equity,
               COALESCE(fh.revenue_growth, sf.revenue_growth)           AS revenue_growth,
               COALESCE(fh.earnings_growth, sf.earnings_growth)         AS earnings_growth,
               COALESCE(fh.earnings_yield, sf.earnings_yield)           AS earnings_yield,
               COALESCE(fh.price_to_book, sf.price_to_book)             AS price_to_book,
               COALESCE(fh.market_cap, sf.market_cap)                   AS market_cap,
               aeh.n_analysts, aeh.buy_count, aeh.target_mean,
               psh_az.score_value AS altman_z,
               psh_oo.score_value AS ohlson_o
        FROM signal_outcomes so
        -- Use nearest prior ts row within 3 days to recover ~26% more training rows
        -- that had no exact-date ts entry (scanner runs on sparse schedule).
        LEFT JOIN LATERAL (
            SELECT * FROM technical_signals ts2
            WHERE ts2.symbol = so.symbol
              AND ts2.date <= so.signal_date
              AND ts2.date >= (so.signal_date::date - interval '3 days')::text
            ORDER BY ts2.date DESC
            LIMIT 1
        ) ts ON TRUE
        -- Point-in-time fundamentals: the latest snapshot taken on/before the signal date
        -- (leak-free). Falls back to the current stock_fundamentals snapshot when no history
        -- has accumulated yet — same mild look-ahead as before, never worse.
        LEFT JOIN fundamentals_history fh
               ON fh.symbol = so.symbol
              AND fh.as_of_date = (
                  SELECT MAX(fh2.as_of_date) FROM fundamentals_history fh2
                  WHERE fh2.symbol = so.symbol AND fh2.as_of_date <= so.signal_date
              )
        LEFT JOIN stock_fundamentals sf
               ON sf.symbol = so.symbol
        -- AS-OF analyst consensus: latest snapshot on/before signal date (no look-ahead)
        LEFT JOIN analyst_estimates_history aeh
               ON aeh.symbol = so.symbol
              AND aeh.as_of_date = (
                  SELECT MAX(aeh2.as_of_date) FROM analyst_estimates_history aeh2
                  WHERE aeh2.symbol = so.symbol AND aeh2.as_of_date <= so.signal_date
              )
        -- AS-OF Altman Z Score (financial distress indicator; > 2.99 safe, < 1.23 distress)
        LEFT JOIN proprietary_scores_history psh_az
               ON psh_az.symbol = so.symbol
              AND psh_az.source = 'moneycontrol'
              AND psh_az.score_type = 'altman_z_score'
              AND psh_az.date = (
                  SELECT MAX(p2.date) FROM proprietary_scores_history p2
                  WHERE p2.symbol = so.symbol AND p2.source = 'moneycontrol'
                    AND p2.score_type = 'altman_z_score'
                    AND p2.date <= so.signal_date
              )
        -- AS-OF Ohlson O-Score (log-odds of failure; negative = safer)
        LEFT JOIN proprietary_scores_history psh_oo
               ON psh_oo.symbol = so.symbol
              AND psh_oo.source = 'moneycontrol'
              AND psh_oo.score_type = 'ohlson_o_score'
              AND psh_oo.date = (
                  SELECT MAX(p2.date) FROM proprietary_scores_history p2
                  WHERE p2.symbol = so.symbol AND p2.source = 'moneycontrol'
                    AND p2.score_type = 'ohlson_o_score'
                    AND p2.date <= so.signal_date
              )
        LEFT JOIN feature_store fs
               ON fs.symbol = so.symbol AND fs.date::text = so.signal_date AND fs.timeframe = 'D'
        LEFT JOIN market_breadth mb ON mb.date = so.signal_date
        LEFT JOIN historical_fno_sentiment hfs
               ON hfs.symbol = so.symbol AND hfs.date = so.signal_date
        LEFT JOIN (
            SELECT
                date::text AS snap_date,
                MAX(CASE WHEN symbol='GIFT_NIFTY_CHG_PCT'   THEN close END) AS gift_nifty_pct,
                MAX(CASE WHEN symbol='NIFTY_GEX'             THEN close END) AS nifty_gex,
                MAX(CASE WHEN symbol='INDIA_10Y'             THEN close END) AS india_10y,
                MAX(CASE WHEN symbol='INDIA_US_SPREAD'       THEN close END) AS india_us_spread,
                MAX(CASE WHEN symbol='HIGH_IMPACT_EVENTS_3D' THEN close END) AS high_impact_3d,
                MAX(CASE WHEN symbol='ASIA_SENTIMENT'        THEN close END) AS asia_sentiment,
                MAX(CASE WHEN symbol='GLOBAL_RISK_SCORE'     THEN close END) AS global_risk,
                MAX(CASE WHEN symbol='ADRS_BULLISH_PCT'      THEN close END) AS adrs_bullish_pct,
                MAX(CASE WHEN symbol='USDINR'                THEN ret_1d  END) AS usdinr_ret_1d,
                MAX(CASE WHEN symbol='NIKKEI'                THEN ret_1d  END) AS nikkei_ret_1d,
                MAX(CASE WHEN symbol='HANGSENG'              THEN ret_1d  END) AS hangseng_ret_1d,
                MAX(CASE WHEN symbol='MARKET_NP_GROWTH_YOY'  THEN close END) AS market_np_yoy,
                MAX(CASE WHEN symbol='EARNINGS_BREADTH'       THEN close END) AS earnings_breadth_mkt,
                MAX(CASE WHEN symbol='FII_NET_TODAY'           THEN close END) AS fii_net_today,
                MAX(CASE WHEN symbol='INDIA_VIX'              THEN close END) AS india_vix,
                MAX(CASE WHEN symbol='USDINR_CHG_PCT'          THEN close END) AS usdinr_chg_pct,
                MAX(CASE WHEN symbol='NIFTY_BASIS_PCT'          THEN close END) AS nifty_basis_pct,
                MAX(CASE WHEN symbol='NIFTY_CONTANGO'           THEN close END) AS nifty_contango
            FROM macro_asset_prices
            GROUP BY date
        ) macro_snap ON macro_snap.snap_date = so.signal_date
        LEFT JOIN mc_sector_earnings mse ON mse.sector_name = (
            SELECT ns.sector FROM nse_stocks ns WHERE ns.symbol = so.symbol LIMIT 1
        )
        {label_join}
        WHERE {label_where}
    """
    df = read_df(q)
    if label == 'triple_barrier':
        df['outcome'] = pd.to_numeric(df['outcome'], errors='coerce').astype('Int64')
        df = df[df['outcome'].notna()].copy()
        df['outcome'] = df['outcome'].astype(int)
    else:
        df['outcome'] = df['outcome'].map({'WIN': 1, 'LOSS': 0, 'STOP_LOSS': 0})
    return df


def load_pending_signals() -> pd.DataFrame:
    q = """
        SELECT ts.symbol, ts.date AS signal_date, ts.signal_score, ts.signals_json,
               ts.rsi, ts.adx, ts.nifty_regime, ts.cmp, ts.sma200, ts.volume_ratio,
               ts.fii_3d_net,
               ts.above_sma200,
               ts.pcr_oi, ts.pcr_vol,
               ts.fii_10d_net, ts.dii_3d_net,
               ts.delivery_pct,
               ts.sector_ret_5d, ts.sector_ret_21d,
               ts.sector_global_corr_21d,
               ts.iv_rank, ts.iv_skew,
               ts.rs_rank_21d, ts.rs_rank_63d,
               ts.insider_buy_pct_90d,
               ts.opening_range_break,
               ts.vwap_deviation_pct,
               ts.first_hour_vol_share,
               ts.avwap_deviation_pct,
               ts.oi_net_change_pct,
               ts.eps_beat_last_q,
               ts.eps_beat_streak_4q,
               ts.eps_miss_streak_4q,
               ts.eps_surprise_last_yr,
               ts.eps_estimate_dispersion,
               fs.ret_12m_ex1m,
               mb.pct_above_200dma, mb.adv_decline_ratio, mb.net_highs_lows,
               hfs.max_pain,
               ts.mf_holding_pct, ts.mf_fund_count, ts.mf_chg_vs_prev,
               ts.rollover_pct, ts.cost_of_carry_ann,
               ts.block_deal_net_qty, ts.block_deal_value_cr,
               ts.eps_ttm, ts.eps_growth_yoy, ts.eps_growth_qoq, ts.eps_acceleration,
               ts.pe_ttm, ts.dvm_durability, ts.dvm_valuation, ts.dvm_momentum,
               ts.pe_pct_rank_252d, ts.pe_vs_median_1yr, ts.pb_pct_rank_252d, ts.div_yield_ttm,
               ts.ma_bull_frac, ts.osc_bull_frac, ts.adx_tl, ts.atr_pct_tl, ts.mfi_tl,
               ts.pivot_dist_pct_tl, ts.delivery_avg_1m_tl, ts.beta_1y_tl,
               ts.ret_1m_tl, ts.ret_3m_tl, ts.ret_6m_tl, ts.ret_1y_tl,
               ts.analyst_upside_pct, ts.analyst_count, ts.analyst_buy_pct,
               ts.roe_annual, ts.roce_annual, ts.ebitda_margin, ts.np_margin,
               ts.promoter_pct, ts.fii_pct, ts.pledge_pct,
               ts.rev_growth_yoy_q, ts.np_growth_yoy_q,
               ts.days_since_dividend, ts.last_dividend_amt,
               ts.days_to_ex_div, ts.days_to_board_meeting, ts.upcoming_div_pct,
               ts.mc_52w_high_dist_pct, ts.mc_52w_low_dist_pct, ts.mc_days_from_52wh,
               ts.mc_cagr_3y, ts.mc_cagr_5y, ts.mc_cagr_10y, ts.mc_ind_pe, ts.mc_pe_vs_ind,
               ts.mc_consensus_pe, ts.mc_consensus_pb,
               ts.mc_ma30_dist_pct, ts.mc_ma50_dist_pct, ts.mc_ma150_dist_pct, ts.mc_ma200_dist_pct,
               ts.mc_del_pct_3d, ts.mc_del_pct_5d, ts.mc_del_pct_20d, ts.mc_del_acceleration,
               ts.mc_vol_ratio, ts.mc_circuit_dist_pct, ts.mc_fno_eligible,
               ts.mc_3d_return, ts.mc_ytd_return,
               ts.mc_price_cash, ts.mc_consensus_eps, ts.mc_eps_vs_cons, ts.mc_pe_fwd_discount,
               ts.mc_cp_bull_count, ts.mc_cp_bear_count, ts.mc_cp_net_score, ts.mc_cp_avg_target_pct,
               ts.tl_vs_nifty_1m, ts.tl_vs_nifty_3m, ts.tl_vs_nifty_6m,
               ts.tl_vs_ind_1m, ts.tl_vs_ind_3m,
               ts.tl_seasonal_month_5y, ts.tl_dist_3m_high_pct, ts.tl_dist_3m_low_pct,
               ts.nt_max_pain_dist_pct, ts.nt_oi_direction, ts.nt_pcr, ts.nt_option_volume_log,
               ts.hv_10d, ts.hv_20d, ts.hv_30d, ts.hv_60d, ts.iv_hv_ratio,
               ts.pead_score, ts.event_signal_score,
               ts.eps_revision_3m_pct, ts.target_revision_3m_pct, ts.analyst_count_chg,
               ts.rs_vs_sector_21d, ts.rs_vs_sector_63d,
               ts.asm_flag, ts.gsm_stage,
               ts.crude_corr_90d, ts.gold_corr_90d, ts.dxy_corr_90d, ts.sp500_corr_90d,
               ts.mc_broker_buy_7d, ts.mc_broker_sell_7d, ts.mc_broker_upside,
               ts.days_to_next_results, ts.earnings_category_yoy, ts.earnings_category_qoq,
               ts.earnings_np_growth_yoy, ts.earnings_np_growth_qoq,
               ts.mc_eps_vs_cons, ts.positive_turnaround, ts.negative_turnaround,
               ts.earnings_shocker_flag, ts.earnings_shocker_gain,
               ts.is_nifty50, ts.is_nifty100, ts.nifty_tier,
               ts.pledge_chg_90d,
               ts.iep_gap_pct, ts.preopen_imbalance,
               ts.expected_move_pct, ts.stock_gex_proxy,
               ts.eps_surprise_q1, ts.eps_surprise_q2, ts.eps_beat_streak,
               ts.eps_miss_after_streak, ts.rev_surprise_q1,
               ts.fcf_yield_approx AS fcf_yield, ts.interest_coverage, ts.fcf_positive, ts.debt_coverage_risk,
               ts.delivery_trend_30d, ts.block_deal_flag, ts.block_deal_direction,
               ts.short_interest_proxy,
               ts.promoter_buy_90d_cr, ts.promoter_sell_90d_cr, ts.promoter_net_90d,
               ts.insider_buy_flag, ts.insider_sell_flag,
               ts.rating_upgrade_180d, ts.rating_downgrade_180d, ts.days_since_upgrade,
               ts.mf_sector_flow_pct,
               ts.receivables_days_ttm, ts.ccc_ttm, ts.ccc_trend,
               ts.wc_deteriorating, ts.wc_improving,
               ts.screener_bull_count, ts.screener_bear_count, ts.screener_cat_breadth,
               ts.screener_tier1_count, ts.screener_momentum_score, ts.screener_streak_days,
               ts.screener_name_signal, ts.screener_alpha_score,
               macro_snap.gift_nifty_pct, macro_snap.nifty_gex,
               macro_snap.india_10y, macro_snap.india_us_spread,
               macro_snap.high_impact_3d, macro_snap.asia_sentiment, macro_snap.global_risk,
               macro_snap.market_np_yoy, macro_snap.earnings_breadth_mkt,
               macro_snap.fii_net_today,
               macro_snap.usdinr_chg_pct, macro_snap.nifty_basis_pct, macro_snap.nifty_contango,
               macro_snap.india_vix,
               macro_snap.adrs_bullish_pct, macro_snap.usdinr_ret_1d,
               macro_snap.nikkei_ret_1d, macro_snap.hangseng_ret_1d,
               mse.np_growth_yoy AS sector_np_growth_yoy, mse.np_growth_qoq AS sector_np_growth_qoq,
               mse.rev_growth_yoy AS sector_rev_growth_yoy,
               sf.fifty_two_week_high,
               sf.piotroski_f_score, sf.debt_to_equity, sf.operating_margins,
               sf.return_on_equity, sf.revenue_growth, sf.earnings_growth,
               sf.earnings_yield, sf.price_to_book, sf.market_cap,
               aeh.n_analysts, aeh.buy_count, aeh.target_mean,
               psh_az.score_value AS altman_z,
               psh_oo.score_value AS ohlson_o
        FROM technical_signals ts
        LEFT JOIN stock_fundamentals sf ON sf.symbol = ts.symbol
        LEFT JOIN feature_store fs
               ON fs.symbol = ts.symbol AND fs.date::text = ts.date AND fs.timeframe = 'D'
        LEFT JOIN market_breadth mb ON mb.date = ts.date
        LEFT JOIN historical_fno_sentiment hfs
               ON hfs.symbol = ts.symbol AND hfs.date = ts.date
        -- Latest analyst snapshot on/before today
        LEFT JOIN analyst_estimates_history aeh
               ON aeh.symbol = ts.symbol
              AND aeh.as_of_date = (
                  SELECT MAX(aeh2.as_of_date) FROM analyst_estimates_history aeh2
                  WHERE aeh2.symbol = ts.symbol AND aeh2.as_of_date <= ts.date
              )
        LEFT JOIN proprietary_scores_history psh_az
               ON psh_az.symbol = ts.symbol
              AND psh_az.source = 'moneycontrol'
              AND psh_az.score_type = 'altman_z_score'
              AND psh_az.date = (
                  SELECT MAX(p2.date) FROM proprietary_scores_history p2
                  WHERE p2.symbol = ts.symbol AND p2.source = 'moneycontrol'
                    AND p2.score_type = 'altman_z_score'
                    AND p2.date <= ts.date
              )
        LEFT JOIN proprietary_scores_history psh_oo
               ON psh_oo.symbol = ts.symbol
              AND psh_oo.source = 'moneycontrol'
              AND psh_oo.score_type = 'ohlson_o_score'
              AND psh_oo.date = (
                  SELECT MAX(p2.date) FROM proprietary_scores_history p2
                  WHERE p2.symbol = ts.symbol AND p2.source = 'moneycontrol'
                    AND p2.score_type = 'ohlson_o_score'
                    AND p2.date <= ts.date
              )
        LEFT JOIN (
            SELECT
                MAX(CASE WHEN symbol='GIFT_NIFTY_CHG_PCT'   THEN close END) AS gift_nifty_pct,
                MAX(CASE WHEN symbol='NIFTY_GEX'             THEN close END) AS nifty_gex,
                MAX(CASE WHEN symbol='INDIA_10Y'             THEN close END) AS india_10y,
                MAX(CASE WHEN symbol='INDIA_US_SPREAD'       THEN close END) AS india_us_spread,
                MAX(CASE WHEN symbol='HIGH_IMPACT_EVENTS_3D' THEN close END) AS high_impact_3d,
                MAX(CASE WHEN symbol='ASIA_SENTIMENT'        THEN close END) AS asia_sentiment,
                MAX(CASE WHEN symbol='GLOBAL_RISK_SCORE'     THEN close END) AS global_risk,
                MAX(CASE WHEN symbol='ADRS_BULLISH_PCT'      THEN close END) AS adrs_bullish_pct,
                MAX(CASE WHEN symbol='USDINR'                THEN ret_1d  END) AS usdinr_ret_1d,
                MAX(CASE WHEN symbol='NIKKEI'                THEN ret_1d  END) AS nikkei_ret_1d,
                MAX(CASE WHEN symbol='HANGSENG'              THEN ret_1d  END) AS hangseng_ret_1d,
                MAX(CASE WHEN symbol='MARKET_NP_GROWTH_YOY'  THEN close END) AS market_np_yoy,
                MAX(CASE WHEN symbol='EARNINGS_BREADTH'       THEN close END) AS earnings_breadth_mkt,
                MAX(CASE WHEN symbol='FII_NET_TODAY'           THEN close END) AS fii_net_today,
                MAX(CASE WHEN symbol='INDIA_VIX'              THEN close END) AS india_vix,
                MAX(CASE WHEN symbol='USDINR_CHG_PCT'          THEN close END) AS usdinr_chg_pct,
                MAX(CASE WHEN symbol='NIFTY_BASIS_PCT'          THEN close END) AS nifty_basis_pct,
                MAX(CASE WHEN symbol='NIFTY_CONTANGO'           THEN close END) AS nifty_contango
            FROM macro_asset_prices
            WHERE date::text = (SELECT MAX(date)::text FROM macro_asset_prices)
        ) macro_snap ON 1=1
        LEFT JOIN mc_sector_earnings mse ON mse.sector_name = (
            SELECT ns.sector FROM nse_stocks ns WHERE ns.symbol = ts.symbol LIMIT 1
        )
        WHERE ts.win_probability IS NULL
          AND ts.signals_json IS NOT NULL
        ORDER BY ts.date DESC
        LIMIT 10000
    """
    df = read_df(q)
    df['horizon_days'] = 15
    return df


# ── Model Building ────────────────────────────────────────────────────────────

def _gpu_device() -> str:
    """Return 'cuda' if GPU is available AND LightGBM was built with CUDA, else 'cpu'."""
    try:
        import torch
        if not torch.cuda.is_available():
            return 'cpu'
    except ImportError:
        return 'cpu'
    # Verify LightGBM CUDA support with a minimal probe
    try:
        from lightgbm import LGBMClassifier
        import numpy as np
        _probe = LGBMClassifier(n_estimators=1, device='cuda', verbose=-1)
        _probe.fit(np.array([[0], [1]]), np.array([0, 1]))
        return 'cuda'
    except Exception:
        return 'cpu'


def _base_models(scale_pos_weight: float = 1.0, tuned_params: dict | None = None):
    from sklearn.ensemble import RandomForestClassifier, ExtraTreesClassifier
    from sklearn.linear_model import LogisticRegression
    from sklearn.calibration import CalibratedClassifierCV
    from lightgbm import LGBMClassifier
    from xgboost import XGBClassifier

    tp = tuned_params or {}
    _dev = _gpu_device()

    lgbm_params = {
        'n_estimators': 300, 'max_depth': 4, 'learning_rate': 0.04,
        'subsample': 0.8, 'min_child_samples': 5, 'random_state': 42,
        'device': _dev, 'verbose': -1, 'class_weight': 'balanced',
    }
    lgbm_params.update(tp.get('lgbm', {}))
    lgbm = CalibratedClassifierCV(
        LGBMClassifier(**lgbm_params),
        method='isotonic', cv=3,
    )

    xgb_params = {
        'n_estimators': 300, 'max_depth': 4, 'learning_rate': 0.04,
        'subsample': 0.8, 'random_state': 42, 'scale_pos_weight': scale_pos_weight,
        'device': _dev, 'eval_metric': 'logloss', 'verbosity': 0,
    }
    xgb_params.update(tp.get('xgb', {}))
    xgb_model = CalibratedClassifierCV(
        XGBClassifier(**xgb_params),
        method='isotonic', cv=3,
    )

    rf = CalibratedClassifierCV(
        RandomForestClassifier(
            n_estimators=300, max_depth=6, min_samples_leaf=5,
            n_jobs=-1, random_state=42, class_weight='balanced',
        ),
        method='isotonic', cv=3,
    )
    et = CalibratedClassifierCV(
        ExtraTreesClassifier(
            n_estimators=300, max_depth=6, min_samples_leaf=5,
            n_jobs=-1, random_state=42, class_weight='balanced',
        ),
        method='isotonic', cv=3,
    )
    lr = CalibratedClassifierCV(
        LogisticRegression(C=1.0, max_iter=1000, random_state=42),
        method='sigmoid', cv=3,
    )

    models = [('lgbm', lgbm), ('xgb', xgb_model), ('rf', rf), ('et', et), ('lr', lr)]

    try:
        from catboost import CatBoostClassifier
        cb_params = {
            'iterations': 300, 'depth': 4, 'learning_rate': 0.04,
            'subsample': 0.8, 'random_seed': 42, 'verbose': False,
            'thread_count': -1, 'auto_class_weights': 'Balanced',
        }
        cb_params.update(tp.get('catboost', {}))
        cb = CalibratedClassifierCV(
            CatBoostClassifier(**cb_params),
            method='isotonic', cv=3,
        )
        models.append(('catboost', cb))
        print("[Ensemble] CatBoostClassifier successfully integrated into base model stack.")
    except ImportError:
        pass

    return models


def tune_hyperparameters(X: pd.DataFrame, y: pd.Series, weights: np.ndarray | None,
                          spw: float, embargo: int, n_splits: int = 5, n_trials: int = 20) -> dict:
    """Run Optuna Bayesian hyperparameter search to find best parameters for LightGBM, XGBoost, and CatBoost."""
    import optuna
    from sklearn.model_selection import TimeSeriesSplit
    from sklearn.metrics import roc_auc_score
    from lightgbm import LGBMClassifier
    from xgboost import XGBClassifier

    optuna.logging.set_verbosity(optuna.logging.WARNING)

    n_eff = n_splits
    if embargo > 0:
        n_eff = max(2, min(n_splits, len(X) // max(1, embargo + 1) - 1))
    skf = TimeSeriesSplit(n_splits=n_eff, gap=embargo)
    sw = weights if weights is not None else None

    def objective(trial):
        lgbm_lr = trial.suggest_float('lgbm_lr', 0.01, 0.1, log=True)
        lgbm_depth = trial.suggest_int('lgbm_depth', 3, 6)
        lgbm_sub = trial.suggest_float('lgbm_sub', 0.6, 0.9)

        xgb_lr = trial.suggest_float('xgb_lr', 0.01, 0.1, log=True)
        xgb_depth = trial.suggest_int('xgb_depth', 3, 6)
        xgb_sub = trial.suggest_float('xgb_sub', 0.6, 0.9)

        scores = []
        for train_idx, val_idx in skf.split(X, y):
            X_tr, y_tr = X.iloc[train_idx], y.iloc[train_idx]
            X_val, y_val = X.iloc[val_idx], y.iloc[val_idx]
            sw_tr = sw[train_idx] if sw is not None else None

            m_lgbm = LGBMClassifier(
                n_estimators=100, max_depth=lgbm_depth, learning_rate=lgbm_lr,
                subsample=lgbm_sub, random_state=42, verbose=-1, class_weight='balanced'
            )
            m_lgbm.fit(X_tr, y_tr, sample_weight=sw_tr)
            p_lgbm = m_lgbm.predict_proba(X_val)[:, 1]

            m_xgb = XGBClassifier(
                n_estimators=100, max_depth=xgb_depth, learning_rate=xgb_lr,
                subsample=xgb_sub, random_state=42, scale_pos_weight=spw,
                eval_metric='logloss', verbosity=0
            )
            m_xgb.fit(X_tr, y_tr, sample_weight=sw_tr)
            p_xgb = m_xgb.predict_proba(X_val)[:, 1]

            p_blend = 0.5 * p_lgbm + 0.5 * p_xgb
            if y_val.nunique() > 1:
                scores.append(roc_auc_score(y_val, p_blend))
            else:
                scores.append(0.5)
        return float(np.mean(scores))

    print(f"[Ensemble] Running hyperparameter tuning with Optuna ({n_trials} trials)...")
    study = optuna.create_study(direction='maximize')
    study.optimize(objective, n_trials=n_trials)

    best = study.best_params
    print(f"[Ensemble] Best trial validation AUC: {study.best_value:.4f}")
    print(f"[Ensemble] Best tuned params: {best}")

    return {
        'lgbm': {
            'learning_rate': best['lgbm_lr'],
            'max_depth': best['lgbm_depth'],
            'subsample': best['lgbm_sub'],
        },
        'xgb': {
            'learning_rate': best['xgb_lr'],
            'max_depth': best['xgb_depth'],
            'subsample': best['xgb_sub'],
        },
        'catboost': {
            'learning_rate': best['lgbm_lr'],
            'depth': best['lgbm_depth'],
            'subsample': best['lgbm_sub'],
        }
    }


def average_uniqueness(start_days, horizons) -> list:
    """López de Prado average uniqueness per label. A label spans [start, start+horizon)
    days; concurrency at a day = number of spans covering it; uniqueness = mean(1/concurrency)
    over the span. Overlapping (crowded) periods — where outcomes share the same forward
    market window and are thus correlated — get lower weight, so the non-IID overcounting
    that inflates CV-vs-holdout is corrected. Returns weights aligned to input order."""
    n = len(start_days)
    starts = [int(s) for s in start_days]
    ends = [starts[i] + max(1, int(horizons[i])) for i in range(n)]
    conc: dict[int, int] = {}
    for i in range(n):
        for d in range(starts[i], ends[i]):
            conc[d] = conc.get(d, 0) + 1
    out = []
    for i in range(n):
        span = ends[i] - starts[i]
        out.append(sum(1.0 / conc[d] for d in range(starts[i], ends[i])) / span)
    return out


def _fit_stack(X: pd.DataFrame, y: pd.Series, spw: float, embargo: int, n_splits: int = 5,
               sample_weight=None, tuned_params: dict | None = None):
    """
    Fit OOF-stacked base models + meta-learner on (X, y), purging `embargo` samples
    between each train/validation fold so overlapping forward-return windows cannot
    leak across the boundary. Returns (fitted_base, meta, oof_auc, oof_acc, importances).
    Assumes X is already sorted chronologically.
    """
    from sklearn.model_selection import TimeSeriesSplit
    from sklearn.base import clone as _sklearn_clone
    from sklearn.linear_model import LogisticRegression
    from sklearn.preprocessing import StandardScaler
    from sklearn.pipeline import Pipeline
    from sklearn.metrics import roc_auc_score

    base = _base_models(scale_pos_weight=spw, tuned_params=tuned_params)
    sw = np.asarray(sample_weight, dtype=float) if sample_weight is not None else None
    n_eff = n_splits
    if embargo > 0:
        n_eff = max(2, min(n_splits, len(X) // max(1, embargo + 1) - 1))
    skf = TimeSeriesSplit(n_splits=n_eff, gap=embargo)

    oof     = np.zeros((len(X), len(base)))
    covered = np.zeros(len(X), dtype=bool)
    fitted  = []

    for j, (name, model) in enumerate(base):
        print(f"[Ensemble]   Training base model: {name}...")
        oof_preds = np.zeros(len(X))
        for train_idx, val_idx in skf.split(X, y):
            m_clone = _sklearn_clone(base[j][1].estimator)
            m_clone.fit(X.iloc[train_idx], y.iloc[train_idx],
                        **({'sample_weight': sw[train_idx]} if sw is not None else {}))
            oof_preds[val_idx] = m_clone.predict_proba(X.iloc[val_idx])[:, 1]
            covered[val_idx] = True
        oof[:, j] = oof_preds
        model.fit(X, y, **({'sample_weight': sw} if sw is not None else {}))   # full calibrated fit
        fitted.append((name, model))

    meta = Pipeline([
        ('scaler', StandardScaler()),
        ('lr', LogisticRegression(C=0.5, max_iter=500, random_state=42)),
    ])
    yc = y[covered]
    meta.fit(oof[covered], yc,
             **({'lr__sample_weight': sw[covered]} if sw is not None else {}))
    meta_proba = meta.predict_proba(oof[covered])[:, 1]
    auc = roc_auc_score(yc, meta_proba) if yc.nunique() > 1 else 0.5
    acc = float(((meta_proba > 0.5) == yc).mean())

    imp = None
    try:
        gb_cal = fitted[0][1]  # CalibratedClassifierCV for LGBM
        if hasattr(gb_cal, 'calibrated_classifiers_') and gb_cal.calibrated_classifiers_:
            inner = gb_cal.calibrated_classifiers_[0].estimator
            imp = getattr(inner, 'feature_importances_', None)
    except Exception:
        pass

    return fitted, meta, float(auc), acc, imp


def train_ensemble(X: pd.DataFrame, y: pd.Series, dates: pd.Series | None = None,
                   horizon_days: int = 15, min_samples: int = 30, tuned_params: dict | None = None):
    from sklearn.metrics import roc_auc_score, precision_score, recall_score, f1_score

    print(f"[Ensemble] Training on {len(X)} samples  (win_rate={y.mean():.1%})")
    spw = float((y == 0).sum()) / max(1, (y == 1).sum())

    # Embargo in samples ≈ one horizon's worth of rows. Prevents overlapping forward
    # windows leaking across train/val/test boundaries (purged walk-forward).
    embargo = 0
    if dates is not None and dates.nunique() > 1:
        samples_per_day = max(1.0, len(X) / dates.nunique())
        embargo = int(min(len(X) // 10, samples_per_day * horizon_days))

    # Sample weights: López de Prado average uniqueness — down-weight overlapping/crowded
    # label windows (correlated outcomes) so they aren't overcounted as independent. Directly
    # targets the CV-vs-holdout overfit gap. Weights align row-for-row with the sorted X.
    weights = None
    if dates is not None and len(dates) == len(X):
        starts = pd.to_datetime(pd.Series(list(dates)), errors='coerce')
        starts = starts.map(lambda d: d.toordinal() if pd.notna(d) else 0).to_numpy()
        horizons = pd.to_numeric(X['horizon_days'], errors='coerce').fillna(horizon_days).astype(int).to_numpy()
        weights = np.asarray(average_uniqueness(starts, horizons), dtype=float)

    # ── Honest held-out test: last 10% for reporting, prior 10% for threshold selection ──
    # Threshold is found on a dedicated val split (rows [tr_end : tr_end+n_val]), NOT the
    # test set. This keeps F1/Recall metrics unbiased on the held-out test window.
    # NOTE: threshold is found on a separate val split; F1/Recall metrics are honest.
    #
    # n_test/n_val are ROW counts fed to positional slicing below — but sized from unique
    # TRADING DAYS, not raw row percentage. Cross-sectional data (many symbols/day) means a
    # blind "last 10% of rows" split can collapse to almost no calendar coverage whenever
    # row density varies across dates (confirmed live: a 10%-of-rows split landed on exactly
    # 2 trading days out of ~40 in the full history, immediately after a multi-week gap in
    # resolved outcomes — that measures single-day/regime noise, not true held-out
    # generalization, and produced a held-out AUC ~0.20 below the CV/OOF estimate on the very
    # same model). Falls back to the old row-based heuristic when there aren't enough
    # distinct dates to form a meaningful date-based split.
    test = {'auc': None, 'precision': None, 'recall': None, 'f1': None, 'n': 0}
    MIN_SPLIT_DAYS = 15
    unique_dates = sorted(pd.Series(list(dates)).dropna().unique()) if dates is not None and len(dates) == len(X) else []
    if len(unique_dates) >= (2 * MIN_SPLIT_DAYS + 5):
        n_test_days = max(MIN_SPLIT_DAYS, int(len(unique_dates) * 0.10))
        n_val_days  = max(MIN_SPLIT_DAYS, int(len(unique_dates) * 0.10))
        test_start_date = unique_dates[-n_test_days]
        val_start_date  = unique_dates[-(n_test_days + n_val_days)]
        date_arr = pd.Series(list(dates)).reset_index(drop=True)
        # X/dates are sorted ascending by date, so these counts are contiguous row spans.
        n_test = int((date_arr >= test_start_date).sum())
        n_val  = int(((date_arr >= val_start_date) & (date_arr < test_start_date)).sum())
    else:
        n_test = int(len(X) * 0.10)  # last 10% = reporting test set
        n_val  = int(len(X) * 0.10)  # prior 10% = threshold selection val set
    if n_test >= 10 and n_val >= 10 and (len(X) - n_test - n_val - embargo) >= max(min_samples, 100):
        tr_end = len(X) - n_test - n_val - embargo
        fb, mt, _, _, _ = _fit_stack(X.iloc[:tr_end], y.iloc[:tr_end], spw, embargo,
                                     sample_weight=(weights[:tr_end] if weights is not None else None),
                                     tuned_params=tuned_params)
        # Threshold selection on val split (not reused for reporting)
        X_val, y_val = X.iloc[tr_end : tr_end + n_val], y.iloc[tr_end : tr_end + n_val]
        val_proba = mt.predict_proba(
            np.column_stack([m.predict_proba(X_val)[:, 1] for _, m in fb])
        )[:, 1]
        best_t = 0.5
        if y_val.nunique() > 1:
            from sklearn.metrics import f1_score as f1_fn
            thresholds = np.arange(0.25, 0.70, 0.01)
            best_f1 = 0.0
            for t in thresholds:
                p = (val_proba >= t).astype(int)
                f = f1_fn(y_val, p, zero_division=0)
                if f > best_f1:
                    best_f1, best_t = f, t
        # Report metrics on the held-out test set using the val-derived threshold
        X_te, y_te = X.iloc[len(X) - n_test:], y.iloc[len(X) - n_test:]
        te_proba = mt.predict_proba(
            np.column_stack([m.predict_proba(X_te)[:, 1] for _, m in fb])
        )[:, 1]
        if y_te.nunique() > 1:
            te_pred = (te_proba >= best_t).astype(int)
            test = {
                'auc':               float(roc_auc_score(y_te, te_proba)),
                'precision':         float(precision_score(y_te, te_pred, zero_division=0)),
                'recall':            float(recall_score(y_te, te_pred, zero_division=0)),
                'f1':                float(f1_score(y_te, te_pred, zero_division=0)),
                'n':                 int(n_test),
                'optimal_threshold': float(best_t),
            }
            te_days = dates.iloc[len(X) - n_test:].nunique() if dates is not None else '?'
            print(f"[Ensemble]   HELD-OUT TEST (last {n_test} rows / {te_days} trading days, "
                  f"threshold from val {n_val}, embargo={embargo}): "
                  f"AUC={test['auc']:.4f} P={test['precision']:.3f} "
                  f"R={test['recall']:.3f} F1={test['f1']:.3f} "
                  f"threshold={best_t:.2f} (val-derived, unbiased)")
    else:
        print(f"[Ensemble]   Insufficient data for a held-out test (n={len(X)}); reporting CV only.")

    # ── Production model: refit on ALL data; CV metric is the purged-OOF AUC ──
    fitted, meta, auc, acc, imp = _fit_stack(X, y, spw, embargo, sample_weight=weights)
    print(f"[Ensemble]   Stacking purged-OOF AUC={auc:.4f}  Accuracy={acc:.4f}  (embargo={embargo})")

    return {
        'base_models':        fitted,
        'meta':               meta,
        'feature_names':      list(X.columns),
        'feature_importances': imp.tolist() if imp is not None else None,
        'cv_auc':             float(auc),
        'cv_accuracy':        acc,
        'test_auc':           test['auc'],
        'test_precision':     test['precision'],
        'test_recall':        test['recall'],
        'test_f1':            test['f1'],
        'test_samples':       test['n'],
        'optimal_threshold':  test.get('optimal_threshold', 0.45),
        'embargo':            embargo,
        'n_samples':          len(X),
        'trained_at':         datetime.datetime.now().isoformat(),
    }


def predict_proba_ensemble(ensemble: dict, X: pd.DataFrame) -> np.ndarray:
    base_probs = np.column_stack([
        m.predict_proba(X)[:, 1] for _, m in ensemble['base_models']
    ])
    return ensemble['meta'].predict_proba(base_probs)[:, 1]


# ── Model Registry ────────────────────────────────────────────────────────────

def register_model(conn: ConnWrapper, ensemble: dict) -> int:
    version = datetime.datetime.now().strftime('%Y%m%d_%H%M%S')
    top_feats = []
    if ensemble.get('feature_importances') and ensemble.get('feature_names'):
        pairs = sorted(
            zip(ensemble['feature_names'], ensemble['feature_importances']),
            key=lambda x: -x[1],
        )[:15]
        top_feats = [{'feature': f, 'importance': round(i, 6)} for f, i in pairs]

    cur = conn.cursor()
    cur.execute("""
        UPDATE model_registry SET is_active = 0
        WHERE model_name = 'ensemble' AND is_active = 1
    """)
    cur.execute("""
        INSERT INTO model_registry
            (model_name, model_version, model_type, trained_at,
             training_samples, cv_roc_auc, cv_accuracy,
             test_roc_auc, precision_score, recall_score, f1_score,
             feature_count, top_features_json, model_path, is_active, horizon_days, notes)
        VALUES ('ensemble', ?, 'Stacking Ensemble', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 15, ?)
        RETURNING id
    """, (
        version,
        ensemble['trained_at'],
        ensemble['n_samples'],
        ensemble['cv_auc'],
        ensemble['cv_accuracy'],
        ensemble.get('test_auc'),
        ensemble.get('test_precision'),
        ensemble.get('test_recall'),
        ensemble.get('test_f1'),
        len(ensemble['feature_names']),
        json.dumps(top_feats),
        ENSEMBLE_PATH,
        f"label={ensemble.get('label', 'horizon')}",
    ))
    model_id = cur.fetchone()[0]

    # Feature importance log
    if top_feats:
        for rank, ft in enumerate(top_feats, 1):
            cur.execute("""
                INSERT INTO feature_importance_log (model_id, model_name, computed_at, feature_name, importance, rank_position)
                VALUES (?, 'ensemble', ?, ?, ?, ?)
            """, (model_id, ensemble['trained_at'], ft['feature'], ft['importance'], rank))

    conn.commit()
    print(f"[Ensemble] Registered as model_id={model_id} version={version}")
    return model_id


# ── Saving / Loading ──────────────────────────────────────────────────────────

def save_ensemble(ensemble: dict):
    os.makedirs(MODELS_DIR, exist_ok=True)
    with open(ENSEMBLE_PATH, 'wb') as f:
        pickle.dump(ensemble, f, protocol=pickle.HIGHEST_PROTOCOL)
    print(f"[Ensemble] Saved to {ENSEMBLE_PATH}")


_ENSEMBLE_CACHE: dict | None = None
_ENSEMBLE_MTIME: float = 0.0


def load_ensemble() -> dict | None:
    global _ENSEMBLE_CACHE, _ENSEMBLE_MTIME
    if not os.path.exists(ENSEMBLE_PATH):
        _ENSEMBLE_CACHE = None
        _ENSEMBLE_MTIME = 0.0
        return None
    mtime = os.path.getmtime(ENSEMBLE_PATH)
    if _ENSEMBLE_CACHE is not None and mtime == _ENSEMBLE_MTIME:
        return _ENSEMBLE_CACHE
    with open(ENSEMBLE_PATH, 'rb') as f:
        _ENSEMBLE_CACHE = pickle.load(f)
    _ENSEMBLE_MTIME = mtime
    return _ENSEMBLE_CACHE


# ── Regime Detection + Conditional Scoring ───────────────────────────────────

def _get_current_regime(con) -> str:
    """Read current market regime from app_settings or derive from macro data."""
    # Try app_settings first (written by technical-signals scan pipeline)
    try:
        row = con.execute(
            "SELECT value FROM app_settings WHERE key = 'current_regime'"
        ).fetchone()
        if row:
            return row[0]  # 'BULL', 'BEAR', or 'SIDEWAYS'
    except Exception:
        pass
    # Also accept the existing key name used by regime_threshold()
    try:
        row = con.execute(
            "SELECT value FROM app_settings WHERE key = 'current_nifty_regime'"
        ).fetchone()
        if row and row[0] in ('BULL', 'BEAR', 'SIDEWAYS'):
            return row[0]
    except Exception:
        pass
    # Fallback: derive from recent GIFT Nifty + India VIX
    try:
        row = con.execute("""
            SELECT
                MAX(CASE WHEN symbol='GIFT_NIFTY_CHG_PCT' THEN close END) AS gift,
                MAX(CASE WHEN symbol='INDIA_VIX'          THEN close END) AS vix
            FROM macro_asset_prices
            WHERE date >= date('now', '-5 days')
        """).fetchone()
        if row and row[0] is not None:
            gift = float(row[0]) if row[0] is not None else 0.0
            vix  = float(row[1]) if row[1] is not None else 15.0
            if gift > 0.3 and vix < 15:
                return 'BULL'
            elif gift < -0.5 or vix > 25:
                return 'BEAR'
    except Exception:
        pass
    return 'SIDEWAYS'


def _apply_regime_adjustment(df_scores: pd.DataFrame, regime: str) -> pd.DataFrame:
    """Adjust win_probability based on market regime.

    The base ensemble was trained on all-regime data. This layer applies a
    calibrated multiplier post-hoc to reflect regime-specific signal success rates:
      BULL    — boost high-conviction signals with RS + FII confirmation
      BEAR    — dampen weak signals; require higher baseline confidence
      SIDEWAYS — no adjustment (ensemble probabilities used as-is)
    win_probability is capped at 0.95 to preserve gatekeeping integrity.
    """
    if regime == 'BULL':
        # In bull markets momentum and breakout signals perform better when
        # supported by sector RS leadership and FII buying flow.
        bull_mask = (
            (df_scores.get('rs_vs_sector_21d', pd.Series(0.0, index=df_scores.index)) > 0.05) &
            (df_scores.get('fii_buying',        pd.Series(0.0, index=df_scores.index)) > 0.5)
        )
        df_scores.loc[bull_mask, 'win_probability'] = (
            df_scores.loc[bull_mask, 'win_probability'] * 1.08
        ).clip(upper=0.95)
    elif regime == 'BEAR':
        # In bear markets require higher confidence; dampen weak signals harder.
        df_scores['win_probability'] = df_scores['win_probability'].apply(
            lambda p: p * 0.85 if p < 0.55 else p * 0.95
        )
    # SIDEWAYS: no adjustment
    return df_scores


# ── Score Pending Signals ─────────────────────────────────────────────────────

def score_pending(conn: ConnWrapper, ensemble: dict) -> int:
    df = load_pending_signals()
    if df.empty:
        print("[Ensemble] No pending signals to score.")
        return 0

    print(f"[Ensemble] Scoring {len(df)} pending signals...")
    X = build_features(df)

    # Align columns to training feature set
    for col in ensemble['feature_names']:
        if col not in X.columns:
            X[col] = 0.0
    X = X[ensemble['feature_names']].astype(np.float32)

    probs = predict_proba_ensemble(ensemble, X)
    threshold = ensemble.get('optimal_threshold', 0.45)
    print(f"[Ensemble] Using optimal_threshold={threshold:.2f} for win_probability gate.")

    # ── Regime-conditional probability adjustment ──────────────────────────────
    regime = _get_current_regime(conn)
    df_scores = pd.DataFrame({
        'win_probability':  probs,
        'rs_vs_sector_21d': X.get('rs_vs_sector_21d', pd.Series(0.0, index=X.index)).values,
        'fii_buying':       X.get('fii_buying',        pd.Series(0.0, index=X.index)).values,
        'date':             df['signal_date'].values,
    }, index=X.index)
    df_scores = _apply_regime_adjustment(df_scores, regime)

    # ── Cross-sectional rank-scaling per day ──
    # Apply a gentle boost/penalty of up to +/- 7.5% based on cross-sectional rank
    def _rank_scale(group):
        if len(group) <= 1:
            return group['win_probability']
        ranks = group['win_probability'].rank(pct=True)  # 0 to 1
        median_prob = group['win_probability'].median()
        return median_prob + (ranks - 0.5) * 0.15

    df_scores['win_probability'] = df_scores.groupby('date', group_keys=False).apply(_rank_scale)
    probs = df_scores['win_probability'].clip(0, 0.95).values
    print(f"[Ensemble] Regime={regime}; regime-conditional and cross-sectional rank scaling applied.")

    cur = conn.cursor()
    cur.executemany(
        "UPDATE technical_signals SET win_probability = ? WHERE symbol = ? AND date = ?",
        [(round(float(prob), 4), row['symbol'], row['signal_date'])
         for (_, row), prob in zip(df.iterrows(), probs)],
    )
    updated = len(df)
    conn.commit()

    # Propagate win_probability to active recommendation_log entries
    cols = _table_columns(conn, 'recommendation_log')
    if 'win_probability' in cols:
        conn.execute("""
            UPDATE recommendation_log
            SET win_probability = (
                SELECT ts.win_probability
                FROM technical_signals ts
                WHERE ts.symbol = recommendation_log.symbol
                  AND ts.date = recommendation_log.signal_date
                LIMIT 1
            )
            WHERE source = 'technical_scan'
              AND status = 'ACTIVE'
              AND date(signal_date) >= date('now', '-14 days')
        """)
        # Deactivate entries where ML now says win < threshold (regime-adaptive)
        threshold = regime_threshold(conn)
        cutoff_date = (datetime.date.today() - datetime.timedelta(days=2)).isoformat()
        conn.execute("""
            UPDATE recommendation_log
            SET status = 'EXPIRED'
            WHERE (
                (win_probability IS NOT NULL AND win_probability < ?)
                OR (win_probability IS NULL AND signal_date < ?)
            )
              AND status = 'ACTIVE'
              AND source = 'technical_scan'
        """, (threshold, cutoff_date))
        conn.commit()
        print(f"[Ensemble] win_probability gate applied at {threshold:.2f} (regime-adaptive); "
              f"NULL signals older than 2 days also expired.")

    return updated


# ── Drift detection ───────────────────────────────────────────────────────────

def check_drift(conn: ConnWrapper, auc_drop_threshold: float = 0.04,
                window_days: int = 30) -> bool:
    """Return True (and log a warning) when recent live accuracy has drifted
    more than `auc_drop_threshold` below the trained CV AUC.

    Uses signal_outcomes resolved in the last `window_days` days as a proxy for
    live performance: fraction of WIN outcomes among resolved signals ≈ precision.
    Compares against the active model's cv_roc_auc from model_registry.
    """
    row = conn.execute("""
        SELECT cv_roc_auc FROM model_registry
        WHERE model_name = 'ensemble' AND is_active = 1
        ORDER BY trained_at DESC LIMIT 1
    """).fetchone()
    if not row:
        return False
    trained_auc = float(row[0])

    live = conn.execute(f"""
        SELECT
            COUNT(*) as total,
            SUM(CASE WHEN outcome = 'WIN' THEN 1 ELSE 0 END) as wins
        FROM signal_outcomes
        WHERE computed_at >= date('now', '-{window_days} days')
          AND outcome IN ('WIN', 'LOSS', 'STOP_LOSS')
    """).fetchone()

    if not live or not live[0] or live[0] < 20:
        return False  # too few resolved signals to judge

    live_win_rate = float(live[1]) / float(live[0])
    # Calibrated AUC ≈ 0.5 + 0.5*precision at our operating point; a 4pt AUC
    # drop is roughly a 4pt win-rate drop at this calibration.
    estimated_auc = 0.5 + 0.5 * live_win_rate
    drift = trained_auc - estimated_auc

    if drift >= auc_drop_threshold:
        print(
            f"[Ensemble] DRIFT DETECTED: trained_auc={trained_auc:.3f} "
            f"live_est_auc={estimated_auc:.3f} (drop={drift:.3f} over {window_days}d, "
            f"n={live[0]}). Triggering retrain."
        )
        return True

    print(f"[Ensemble] Drift check OK: trained={trained_auc:.3f} live_est={estimated_auc:.3f} "
          f"(n={live[0]}, window={window_days}d)")
    return False


# ── Main ──────────────────────────────────────────────────────────────────────

def run(do_train: bool = True, do_score: bool = True,
        retrain_full: bool = False, min_samples: int = 30,
        label: str = 'horizon', do_tune: bool = False):
    try:
        from lightgbm import LGBMClassifier  # noqa: F401 — verify dependency at startup
    except ImportError:
        print("[Ensemble] lightgbm not installed. Run: pip install lightgbm")
        sys.exit(1)

    conn = connect()
    try:
        # Ensure optional tables exist so LEFT JOINs don't fail
        for ddl in [
            """CREATE TABLE IF NOT EXISTS mc_sector_earnings (
                sector_name TEXT PRIMARY KEY,
                market_np_yoy DOUBLE PRECISION,
                earnings_breadth DOUBLE PRECISION,
                updated_at TEXT
            )""",
            """CREATE TABLE IF NOT EXISTS feature_store (
                symbol TEXT, date DATE, timeframe TEXT,
                PRIMARY KEY (symbol, date, timeframe)
            )""",
            """CREATE TABLE IF NOT EXISTS market_regimes (
                date TEXT PRIMARY KEY, regime TEXT, regime_prob DOUBLE PRECISION
            )""",
            """CREATE TABLE IF NOT EXISTS historical_fno_sentiment (
                symbol TEXT, date TEXT, PRIMARY KEY (symbol, date)
            )""",
        ]:
            try: conn.execute(ddl); conn.commit()
            except Exception: conn.rollback()

        if do_train:
            if retrain_full or not os.path.exists(ENSEMBLE_PATH):
                print("[Ensemble] Training from scratch...")
            else:
                print("[Ensemble] Retraining (incremental — same architecture)...")

            df = load_training_data(label=label)
            df = df.sort_values('signal_date').reset_index(drop=True)
            if len(df) < min_samples:
                print(f"[Ensemble] Need {min_samples} samples, have {len(df)}. Skipping train.")
                do_train = False
            else:
                X = build_features(df)
                y = df['outcome'].astype(int)
                _hz = int(pd.to_numeric(df['horizon_days'], errors='coerce').median() or 15)

                tuned_params = None
                if do_tune:
                    spw = float((y == 0).sum()) / max(1, (y == 1).sum())
                    embargo = 0
                    if df['signal_date'].nunique() > 1:
                        samples_per_day = max(1.0, len(X) / df['signal_date'].nunique())
                        embargo = int(min(len(X) // 10, samples_per_day * _hz))
                    weights = None
                    if len(df['signal_date']) == len(X):
                        starts = pd.to_datetime(pd.Series(list(df['signal_date'])), errors='coerce')
                        starts = starts.map(lambda d: d.toordinal() if pd.notna(d) else 0).to_numpy()
                        horizons = pd.to_numeric(X['horizon_days'], errors='coerce').fillna(_hz).astype(int).to_numpy()
                        weights = np.asarray(average_uniqueness(starts, horizons), dtype=float)

                    try:
                        tuned_params = tune_hyperparameters(X, y, weights, spw, embargo, n_trials=30)
                    except Exception as e:
                        print(f"[Ensemble] Tuning failed: {e}. Falling back to default parameters.")

                ensemble = train_ensemble(X, y, dates=df['signal_date'],
                                          horizon_days=_hz, min_samples=min_samples,
                                          tuned_params=tuned_params)
                ensemble['label'] = label
                save_ensemble(ensemble)
                register_model(conn, ensemble)

        if do_score:
            # Auto-retrain if live performance has drifted >4 AUC pts below trained value
            if not do_train and check_drift(conn):
                print("[Ensemble] Auto-retraining due to drift...")
                df = load_training_data(label=label)
                df = df.sort_values('signal_date').reset_index(drop=True)
                if len(df) >= min_samples:
                    X = build_features(df)
                    y = df['outcome'].astype(int)
                    _hz = int(pd.to_numeric(df['horizon_days'], errors='coerce').median() or 15)
                    ensemble_new = train_ensemble(X, y, dates=df['signal_date'],
                                                  horizon_days=_hz, min_samples=min_samples)
                    ensemble_new['label'] = label
                    save_ensemble(ensemble_new)
                    register_model(conn, ensemble_new)

            ensemble = load_ensemble()
            if ensemble is None:
                print("[Ensemble] No saved model — run with --train first.")
            else:
                n = score_pending(conn, ensemble)
                print(f"[Ensemble] Scored {n} signals.")

    finally:
        conn.close()

    print("[Ensemble] Done.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="ML Ensemble Signal Confidence Scorer")
    parser.add_argument("--train",       action="store_true", help="Train ensemble model")
    parser.add_argument("--score",       action="store_true", help="Score pending signals")
    parser.add_argument("--tune",        action="store_true", help="Tune model hyperparameters with Optuna")
    parser.add_argument("--retrain-full",action="store_true", help="Discard saved model and retrain")
    parser.add_argument("--check-drift", action="store_true", help="Check live vs trained AUC drift only")
    parser.add_argument("--min-samples", type=int, default=30)
    parser.add_argument("--label", choices=['horizon', 'triple_barrier'], default='horizon',
                        help="Training label: fixed-horizon WIN/LOSS (default) or triple-barrier")
    args = parser.parse_args()

    if args.check_drift:
        conn = connect()
        try:
            check_drift(conn)
        finally:
            conn.close()
        sys.exit(0)

    do_train = args.train or args.retrain_full or args.tune or (not args.score)
    do_score = args.score or (not args.train and not args.retrain_full and not args.tune)

    run(do_train=do_train, do_score=do_score,
        retrain_full=args.retrain_full, min_samples=args.min_samples, label=args.label,
        do_tune=args.tune)
