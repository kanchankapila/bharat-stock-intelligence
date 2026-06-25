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

    # Sector relative momentum
    X['sector_ret_5d']  = num('sector_ret_5d', 0)
    X['sector_ret_21d'] = num('sector_ret_21d', 0)

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

    # ── Cross-sectional relative strength (from relative_strength.py) ──
    # Universe percentile of trailing return (0=worst, 1=best). Absolute momentum (sector_ret)
    # can't tell a stock leading the tape from one merely floating up with it; rank can.
    X['rs_rank_21d'] = num('rs_rank_21d', 0.5).clip(0, 1)
    X['rs_rank_63d'] = num('rs_rank_63d', 0.5).clip(0, 1)

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
               ts.iv_rank, ts.iv_skew,
               ts.rs_rank_21d, ts.rs_rank_63d,
               ts.insider_buy_pct_90d,
               ts.opening_range_break,
               ts.vwap_deviation_pct,
               ts.first_hour_vol_share,
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
        LEFT JOIN technical_signals ts
               ON ts.symbol = so.symbol AND ts.date = so.signal_date
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
               ts.iv_rank, ts.iv_skew,
               ts.rs_rank_21d, ts.rs_rank_63d,
               ts.insider_buy_pct_90d,
               ts.opening_range_break,
               ts.vwap_deviation_pct,
               ts.first_hour_vol_share,
               sf.fifty_two_week_high,
               sf.piotroski_f_score, sf.debt_to_equity, sf.operating_margins,
               sf.return_on_equity, sf.revenue_growth, sf.earnings_growth,
               sf.earnings_yield, sf.price_to_book, sf.market_cap,
               aeh.n_analysts, aeh.buy_count, aeh.target_mean,
               psh_az.score_value AS altman_z,
               psh_oo.score_value AS ohlson_o
        FROM technical_signals ts
        LEFT JOIN stock_fundamentals sf ON sf.symbol = ts.symbol
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


def _base_models(scale_pos_weight: float = 1.0):
    from sklearn.ensemble import RandomForestClassifier, ExtraTreesClassifier
    from sklearn.linear_model import LogisticRegression
    from sklearn.calibration import CalibratedClassifierCV
    from lightgbm import LGBMClassifier
    from xgboost import XGBClassifier

    _dev = _gpu_device()

    lgbm = CalibratedClassifierCV(
        LGBMClassifier(
            n_estimators=300, max_depth=4, learning_rate=0.04,
            subsample=0.8, min_child_samples=5, random_state=42,
            device=_dev, verbose=-1, class_weight='balanced',
        ),
        method='isotonic', cv=3,
    )
    xgb_model = CalibratedClassifierCV(
        XGBClassifier(
            n_estimators=300, max_depth=4, learning_rate=0.04,
            subsample=0.8, random_state=42, scale_pos_weight=scale_pos_weight,
            device=_dev, eval_metric='logloss', verbosity=0,
        ),
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
    return [('lgbm', lgbm), ('xgb', xgb_model), ('rf', rf), ('et', et), ('lr', lr)]


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
               sample_weight=None):
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

    base = _base_models(scale_pos_weight=spw)
    sw = np.asarray(sample_weight, dtype=float) if sample_weight is not None else None
    # Keep folds viable once the embargo gap is subtracted.
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
            m_clone = _sklearn_clone(_base_models(scale_pos_weight=spw)[j][1].estimator)
            m_clone.fit(X.iloc[train_idx], y.iloc[train_idx],
                        **({'sample_weight': sw[train_idx]} if sw is not None else {}))
            oof_preds[val_idx] = m_clone.predict_proba(X.iloc[val_idx])[:, 1]
            covered[val_idx] = True
        oof[:, j] = oof_preds
        model.fit(X, y, **({'sample_weight': sw} if sw is not None else {}))   # full calibrated fit
        fitted.append((name, model))

    # Meta-learner — trained only on rows the walk-forward actually produced OOF preds for
    # (TimeSeriesSplit never validates the initial training block).
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
                   horizon_days: int = 15, min_samples: int = 30):
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

    # ── Honest held-out test: last 20%, chronological, with an embargo purge gap ──
    test = {'auc': None, 'precision': None, 'recall': None, 'f1': None, 'n': 0}
    n_test = int(len(X) * 0.20)
    if n_test >= 20 and (len(X) - n_test - embargo) >= max(min_samples, 100):
        tr_end = len(X) - n_test - embargo
        fb, mt, _, _, _ = _fit_stack(X.iloc[:tr_end], y.iloc[:tr_end], spw, embargo,
                                     sample_weight=(weights[:tr_end] if weights is not None else None))
        X_te, y_te = X.iloc[len(X) - n_test:], y.iloc[len(X) - n_test:]
        te_proba = mt.predict_proba(
            np.column_stack([m.predict_proba(X_te)[:, 1] for _, m in fb])
        )[:, 1]
        if y_te.nunique() > 1:
            te_pred = (te_proba > 0.5).astype(int)
            test = {
                'auc':       float(roc_auc_score(y_te, te_proba)),
                'precision': float(precision_score(y_te, te_pred, zero_division=0)),
                'recall':    float(recall_score(y_te, te_pred, zero_division=0)),
                'f1':        float(f1_score(y_te, te_pred, zero_division=0)),
                'n':         int(n_test),
            }
            print(f"[Ensemble]   HELD-OUT TEST (last {n_test}, embargo={embargo}): "
                  f"AUC={test['auc']:.4f} P={test['precision']:.3f} "
                  f"R={test['recall']:.3f} F1={test['f1']:.3f}")
    else:
        print(f"[Ensemble]   Insufficient data for a held-out test (n={len(X)}); reporting CV only.")

    # ── Production model: refit on ALL data; CV metric is the purged-OOF AUC ──
    fitted, meta, auc, acc, imp = _fit_stack(X, y, spw, embargo, sample_weight=weights)
    print(f"[Ensemble]   Stacking purged-OOF AUC={auc:.4f}  Accuracy={acc:.4f}  (embargo={embargo})")

    return {
        'base_models':  fitted,
        'meta':         meta,
        'feature_names': list(X.columns),
        'feature_importances': imp.tolist() if imp is not None else None,
        'cv_auc':       float(auc),
        'cv_accuracy':  acc,
        'test_auc':     test['auc'],
        'test_precision': test['precision'],
        'test_recall':  test['recall'],
        'test_f1':      test['f1'],
        'test_samples': test['n'],
        'embargo':      embargo,
        'n_samples':    len(X),
        'trained_at':   datetime.datetime.now().isoformat(),
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


def load_ensemble() -> dict | None:
    if not os.path.exists(ENSEMBLE_PATH):
        return None
    with open(ENSEMBLE_PATH, 'rb') as f:
        return pickle.load(f)


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
        conn.execute("""
            UPDATE recommendation_log
            SET status = 'EXPIRED'
            WHERE (
                (win_probability IS NOT NULL AND win_probability < ?)
                OR (win_probability IS NULL AND signal_date < date('now', '-2 days'))
            )
              AND status = 'ACTIVE'
              AND source = 'technical_scan'
        """, (threshold,))
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

    live = conn.execute("""
        SELECT
            COUNT(*) as total,
            SUM(CASE WHEN outcome = 'WIN' THEN 1 ELSE 0 END) as wins
        FROM signal_outcomes
        WHERE computed_at >= date('now', ?)
          AND outcome IN ('WIN', 'LOSS', 'STOP_LOSS')
    """, (f'-{window_days} days',)).fetchone()

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
        label: str = 'horizon'):
    try:
        from lightgbm import LGBMClassifier  # noqa: F401 — verify dependency at startup
    except ImportError:
        print("[Ensemble] lightgbm not installed. Run: pip install lightgbm")
        sys.exit(1)

    conn = connect()
    try:
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
                ensemble = train_ensemble(X, y, dates=df['signal_date'],
                                          horizon_days=_hz, min_samples=min_samples)
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

    do_train = args.train or args.retrain_full or (not args.score)
    do_score = args.score or (not args.train and not args.retrain_full)

    run(do_train=do_train, do_score=do_score,
        retrain_full=args.retrain_full, min_samples=args.min_samples, label=args.label)
