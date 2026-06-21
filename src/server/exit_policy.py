"""
Exit-Policy Head
================
The ensemble answers "will this entry win?". It says nothing about HOW to exit. This head
learns the exit side from the path labels in signal_excursions (written by exit_labeler.py):
two regressors that predict, from the same entry-time features the ensemble uses,

  expected MFE %  — how far the trade is likely to run in our favour  → where to set the target
  expected MAE %  — how far it is likely to draw down against us       → where to set the stop

`suggest_levels()` turns those predictions into concrete target/stop prices: we capture a
fraction of the expected favourable excursion (you rarely sell the exact high) and give the
stop a buffer beyond the expected adverse excursion (so normal noise doesn't knock us out).

Reuses ml_ensemble.build_features so entry features stay identical to the win-probability
model. Persists ml_models/exit_policy.pkl. Gracefully no-ops until enough excursions exist.

Run:  python exit_policy.py --train
      python exit_policy.py --train --min-samples 200
"""

import argparse
import os
import pickle

import numpy as np
import pandas as pd

from db_compat import read_df
from ml_ensemble import build_features

MODELS_DIR = os.path.join(os.getcwd(), 'src', 'server', 'ml_models')
EXIT_MODEL_PATH = os.path.join(MODELS_DIR, 'exit_policy.pkl')

# Defaults for translating predicted excursions into levels.
MFE_CAPTURE = 0.6   # bank 60% of the expected favourable run (you don't sell the exact high)
MAE_BUFFER  = 1.15  # set the stop 15% wider than the expected adverse excursion (noise room)


def suggest_levels(entry: float, pred_mfe_pct: float, pred_mae_pct: float,
                   mfe_capture: float = MFE_CAPTURE, mae_buffer: float = MAE_BUFFER) -> tuple:
    """Convert predicted MFE/MAE (%) into (target_price, stop_price).

    target = entry × (1 + MFE × capture/100); stop = entry × (1 + MAE × buffer/100). MAE is
    negative for a long, so the stop sits below entry. Capture<1 books before the high;
    buffer>1 keeps the stop outside expected noise. Returns prices rounded to 2dp."""
    target = entry * (1 + (pred_mfe_pct * mfe_capture) / 100.0)
    stop   = entry * (1 + (pred_mae_pct * mae_buffer) / 100.0)
    return round(target, 2), round(stop, 2)


def load_exit_training_data() -> pd.DataFrame:
    """Excursion labels joined to the entry-time technical features + point-in-time
    fundamentals (same as-of discipline as ml_ensemble.load_training_data)."""
    q = """
        SELECT se.symbol, se.signal_date, se.horizon_days,
               se.mfe_pct, se.mae_pct,
               ts.signal_score, ts.signals_json,
               ts.rsi, ts.adx, ts.nifty_regime, ts.cmp, ts.sma200, ts.volume_ratio,
               ts.fii_3d_net, ts.above_sma200, ts.pcr_oi, ts.pcr_vol,
               ts.fii_10d_net, ts.dii_3d_net, ts.delivery_pct,
               ts.sector_ret_5d, ts.sector_ret_21d,
               ts.iv_rank, ts.iv_skew, ts.rs_rank_21d, ts.rs_rank_63d,
               COALESCE(fh.fifty_two_week_high, sf.fifty_two_week_high) AS fifty_two_week_high,
               COALESCE(fh.piotroski_f_score, sf.piotroski_f_score)     AS piotroski_f_score,
               COALESCE(fh.debt_to_equity, sf.debt_to_equity)           AS debt_to_equity,
               COALESCE(fh.operating_margins, sf.operating_margins)     AS operating_margins,
               COALESCE(fh.return_on_equity, sf.return_on_equity)       AS return_on_equity,
               COALESCE(fh.revenue_growth, sf.revenue_growth)           AS revenue_growth,
               COALESCE(fh.earnings_growth, sf.earnings_growth)         AS earnings_growth,
               COALESCE(fh.earnings_yield, sf.earnings_yield)           AS earnings_yield,
               COALESCE(fh.price_to_book, sf.price_to_book)             AS price_to_book,
               COALESCE(fh.market_cap, sf.market_cap)                   AS market_cap
        FROM signal_excursions se
        JOIN technical_signals ts ON ts.symbol = se.symbol AND ts.date = se.signal_date
        LEFT JOIN fundamentals_history fh
               ON fh.symbol = se.symbol
              AND fh.as_of_date = (
                  SELECT MAX(fh2.as_of_date) FROM fundamentals_history fh2
                  WHERE fh2.symbol = se.symbol AND fh2.as_of_date <= se.signal_date
              )
        LEFT JOIN stock_fundamentals sf ON sf.symbol = se.symbol
        WHERE se.mfe_pct IS NOT NULL AND se.mae_pct IS NOT NULL
        ORDER BY se.signal_date
    """
    return read_df(q)


def train_from_df(df: pd.DataFrame, min_samples: int = 100) -> dict | None:
    """Fit MFE and MAE regressors on a prepared excursion frame. Time-ordered split (the rows
    arrive sorted by signal_date) keeps evaluation honest. Returns the persisted model dict
    or None when there is not enough data yet."""
    if len(df) < min_samples:
        print(f"[EXIT-POLICY] Only {len(df)} excursions (<{min_samples}); skipping train.")
        return None

    from sklearn.ensemble import GradientBoostingRegressor
    from sklearn.metrics import mean_absolute_error

    X = build_features(df)
    feature_names = list(X.columns)
    Xv = X.values.astype(np.float32)
    y_mfe = pd.to_numeric(df['mfe_pct'], errors='coerce').fillna(0.0).values
    y_mae = pd.to_numeric(df['mae_pct'], errors='coerce').fillna(0.0).values

    cut = max(min_samples // 2, int(len(df) * 0.8))
    models, metrics = {}, {}
    for name, y in (('mfe', y_mfe), ('mae', y_mae)):
        model = GradientBoostingRegressor(
            n_estimators=300, max_depth=3, learning_rate=0.03,
            subsample=0.8, random_state=42,
        )
        model.fit(Xv[:cut], y[:cut])
        if cut < len(df):
            mae = float(mean_absolute_error(y[cut:], model.predict(Xv[cut:])))
        else:
            mae = float('nan')
        model.fit(Xv, y)          # refit on all data for production use
        models[name] = model
        metrics[f'{name}_holdout_mae'] = mae

    payload = {
        'mfe_model': models['mfe'],
        'mae_model': models['mae'],
        'feature_names': feature_names,
        'metrics': metrics,
        'n_samples': len(df),
    }
    os.makedirs(MODELS_DIR, exist_ok=True)
    with open(EXIT_MODEL_PATH, 'wb') as f:
        pickle.dump(payload, f)
    print(f"[EXIT-POLICY] Trained on {len(df)} excursions. "
          f"Holdout MAE — MFE: {metrics['mfe_holdout_mae']:.2f}%  MAE: {metrics['mae_holdout_mae']:.2f}%")
    return payload


def train(min_samples: int = 100) -> dict | None:
    return train_from_df(load_exit_training_data(), min_samples=min_samples)


def predict_levels(df_row: pd.DataFrame, entry: float, model: dict | None = None) -> tuple:
    """Predict (target_price, stop_price) for one entry-feature row."""
    if model is None:
        with open(EXIT_MODEL_PATH, 'rb') as f:
            model = pickle.load(f)
    X = build_features(df_row)
    for col in model['feature_names']:
        if col not in X.columns:
            X[col] = 0.0
    Xv = X[model['feature_names']].values.astype(np.float32)
    pred_mfe = float(model['mfe_model'].predict(Xv)[0])
    pred_mae = float(model['mae_model'].predict(Xv)[0])
    return suggest_levels(entry, pred_mfe, pred_mae)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Exit-policy head (MFE/MAE regressors)")
    parser.add_argument("--train", action="store_true")
    parser.add_argument("--min-samples", type=int, default=100)
    args = parser.parse_args()
    if args.train:
        train(min_samples=args.min_samples)
