#!/usr/bin/env python3
"""
BiLSTM + TFT deep learning models for multi-horizon stock prediction.
Reads from feature_store, writes to deep_learning_predictions.
"""

import os
import sys
import json
import sqlite3
import pickle
import argparse
from datetime import datetime, timedelta
from pathlib import Path
from typing import Dict, List, Tuple

# Must be set before torch/cuBLAS initialises — fixes CUDNN_STATUS_INTERNAL_ERROR on Windows
os.environ.setdefault("CUBLAS_WORKSPACE_CONFIG", ":4096:8")

import numpy as np
import pandas as pd
import torch
import torch.nn as nn
from sklearn.metrics import roc_auc_score, accuracy_score

DB_PATH   = Path(__file__).parent.parent.parent / "database.sqlite"
MODEL_DIR = Path(__file__).parent / "ml_models"
CONFIG_PATH = MODEL_DIR / "dl_model_config.json"

SEQUENCE_LEN = 60
N_FEATURES   = 78
FEATURE_COLS = [
    "ret_1d","ret_5d","ret_15d","ret_21d","ret_63d","ret_126d","ret_252d",
    "sma20","sma50","sma200","ema8","ema21","dist_sma20_pct","dist_sma200_pct","above_sma200",
    "rsi_14","rsi_28","macd","macd_signal","macd_hist","adx","di_plus","di_minus",
    "stoch_k","stoch_d","cci","williams_r",
    "atr_14","atr_pct","bb_upper","bb_lower","bb_width","bb_pct",
    "hist_vol_21d","hist_vol_63d",
    "volume_ratio_20d","volume_ratio_5d","obv","obv_slope","vwap","vwap_dist_pct",
    "trend_1d","trend_1w","trend_1m","mtf_alignment_score",
    "fii_3d_net","fii_10d_net","dii_3d_net",
    "trailing_pe","roe","debt_to_equity","op_margins","piotroski_f","earnings_yield",
    "nifty_vix","nifty_ret_5d","nifty_ret_21d",
    "us_10y_yield","dxy","crude_ret_5d","gold_ret_5d","sp500_ret_5d",
    "news_sentiment_score","news_impact_count",
    # one-hot vol_regime (4): LOW, MED, HIGH, SPIKE
    "vol_LOW","vol_MED","vol_HIGH","vol_SPIKE",
    # one-hot trend_1d (3): UP, DOWN, SIDEWAYS encoded as floats above, use numeric
    # mtf cols already numeric; pad to 84
    "pcr_oi","pcr_vol","iv_rank","delivery_pct",
    "pb","rev_growth","eps_growth","advance_decline_ratio","nifty_pe",
    "max_pain",
]

DEVICE = torch.device("cuda" if torch.cuda.is_available() else "cpu")
if DEVICE.type == "cuda":
    torch.backends.cudnn.enabled = False   # cuDNN LSTM backward broken on Windows/cu124; use PyTorch-native path
    torch.backends.cudnn.benchmark = False
    print(f"[DL] Device: cuda ({torch.cuda.get_device_name(0)}) "
          f"{torch.cuda.get_device_properties(0).total_memory // 1024**2} MB VRAM (cudnn disabled)")
else:
    print("[DL] Device: cpu")


# ── Model Architecture ───────────────────────────────────────────────────────

class SelfAttention(nn.Module):
    def __init__(self, hidden_size: int):
        super().__init__()
        self.attn = nn.Linear(hidden_size, 1)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        # x: (batch, seq, hidden)
        weights = torch.softmax(self.attn(x), dim=1)  # (batch, seq, 1)
        return (x * weights).sum(dim=1)               # (batch, hidden)


class BiLSTMModel(nn.Module):
    def __init__(self, n_features: int = N_FEATURES, hidden: int = 256, dropout: float = 0.3):
        super().__init__()
        self.lstm1 = nn.LSTM(n_features, hidden, batch_first=True, bidirectional=True)
        self.drop1 = nn.Dropout(dropout)
        self.lstm2 = nn.LSTM(hidden * 2, hidden, batch_first=True, bidirectional=True)
        self.drop2 = nn.Dropout(dropout)
        self.attn  = SelfAttention(hidden * 2)
        self.dense = nn.Linear(hidden * 2, 64)
        self.bn    = nn.BatchNorm1d(64)
        self.relu  = nn.ReLU()

        self.head_dir_1d  = nn.Linear(64, 2)
        self.head_dir_5d  = nn.Linear(64, 2)
        self.head_dir_15d = nn.Linear(64, 2)
        self.head_ret_5d  = nn.Linear(64, 1)
        self.head_ret_15d = nn.Linear(64, 1)

    def forward(self, x: torch.Tensor) -> Dict[str, torch.Tensor]:
        out, _ = self.lstm1(x)
        out    = self.drop1(out)
        out, _ = self.lstm2(out)
        out    = self.drop2(out)
        ctx    = self.attn(out)
        feat   = self.relu(self.bn(self.dense(ctx)))

        return {
            "dir_1d":  self.head_dir_1d(feat),
            "dir_5d":  self.head_dir_5d(feat),
            "dir_15d": self.head_dir_15d(feat),
            "ret_5d":  self.head_ret_5d(feat).squeeze(-1),
            "ret_15d": self.head_ret_15d(feat).squeeze(-1),
        }


# ── Data Loading ─────────────────────────────────────────────────────────────

_VOL_ONEHOT = ("vol_LOW", "vol_MED", "vol_HIGH", "vol_SPIKE")


def _onehot_vol_regime(df: pd.DataFrame) -> pd.DataFrame:
    for col in _VOL_ONEHOT:
        regime = col[4:]  # "LOW", "MED", "HIGH", "SPIKE"
        df[col] = (df["vol_regime"] == regime).astype(np.float32)
    return df


def load_symbol_sequences(
    symbol: str, con: sqlite3.Connection, seq_len: int = SEQUENCE_LEN
) -> Tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray, List[str]]:
    """
    Returns: X (N, seq_len, n_feat), y_dir5 (N,), y_dir15 (N,), y_ret5 (N,), dates list
    Only returns rows where all target columns are non-null (training mode).
    """
    feat_cols = FEATURE_COLS[:N_FEATURES]
    numeric_cols = [c for c in feat_cols if c not in _VOL_ONEHOT]
    cols_sql = ", ".join(f'COALESCE("{c}", 0) as "{c}"' for c in numeric_cols)
    df = pd.read_sql(
        f"""SELECT date, {cols_sql}, vol_regime,
               target_dir_5d, target_dir_15d, target_ret_5d, target_ret_15d
            FROM feature_store WHERE symbol=? AND timeframe='D'
            ORDER BY date""",
        con, params=(symbol,), parse_dates=["date"],
    )
    df = _onehot_vol_regime(df)
    df = df.dropna(subset=["target_dir_5d", "target_dir_15d"])
    df = df[(df["target_dir_5d"] >= 0) & (df["target_dir_15d"] >= 0)]
    df = df.fillna(0)

    X_all = df[feat_cols].values.astype(np.float32)
    y5    = df["target_dir_5d"].values.astype(np.int64)
    y15   = df["target_dir_15d"].values.astype(np.int64)
    yr5   = df["target_ret_5d"].values.astype(np.float32)
    dates = df["date"].dt.strftime("%Y-%m-%d").tolist()

    # Build sliding windows
    X_seqs, y5_out, y15_out, yr5_out, d_out = [], [], [], [], []
    for i in range(seq_len, len(X_all)):
        X_seqs.append(X_all[i - seq_len:i])
        y5_out.append(y5[i])
        y15_out.append(y15[i])
        yr5_out.append(yr5[i])
        d_out.append(dates[i])

    return (
        np.array(X_seqs),
        np.array(y5_out),
        np.array(y15_out),
        np.array(yr5_out),
        d_out,
    )


def load_inference_sequence(
    symbol: str, con: sqlite3.Connection, seq_len: int = SEQUENCE_LEN
) -> Tuple[np.ndarray, str]:
    """Load last seq_len rows for inference. Returns (1, seq_len, n_feat) and latest date."""
    feat_cols = FEATURE_COLS[:N_FEATURES]
    numeric_cols = [c for c in feat_cols if c not in _VOL_ONEHOT]
    cols_sql = ", ".join(f'COALESCE("{c}", 0) as "{c}"' for c in numeric_cols)
    df = pd.read_sql(
        f"""SELECT date, {cols_sql}, vol_regime
            FROM feature_store WHERE symbol=? AND timeframe='D'
            ORDER BY date DESC LIMIT {int(seq_len)}""",
        con, params=(symbol,),
    )
    if len(df) < seq_len:
        return None, None
    df = df.sort_values("date")
    df = _onehot_vol_regime(df).fillna(0)
    X = df[feat_cols].values.astype(np.float32)
    return X[np.newaxis], df["date"].iloc[-1]


# ── Walk-Forward Validation ──────────────────────────────────────────────────

def walk_forward_validate(model: BiLSTMModel, X: np.ndarray, y5: np.ndarray,
                           y15: np.ndarray, yr5: np.ndarray, fold_size: int = 30) -> Dict:
    """Expanding window walk-forward. Returns mean metrics across folds."""
    n = len(X)
    min_train = 300
    if n < min_train + fold_size * 2:
        return {"directional_accuracy": np.nan, "roc_auc": np.nan}

    accs, aucs = [], []
    fold = 0
    while True:
        train_end = min_train + fold * fold_size
        val_end   = train_end + fold_size
        test_end  = val_end  + fold_size
        if test_end > n:
            break

        X_tr, y_tr = X[:train_end], y5[:train_end]
        X_te, y_te = X[val_end:test_end], y5[val_end:test_end]

        model_copy = BiLSTMModel().to(DEVICE)
        model_copy.load_state_dict(model.state_dict())
        _train_one_fold(model_copy, X_tr, y_tr, yr5[:train_end], epochs=30)

        preds = _predict_batch(model_copy, X_te)
        del model_copy
        if DEVICE.type == "cuda":
            torch.cuda.empty_cache()

        prob_up = preds["dir_5d"][:, 1]
        pred_dir = (prob_up > 0.5).astype(int)
        accs.append(accuracy_score(y_te, pred_dir))
        if len(np.unique(y_te)) > 1:
            aucs.append(roc_auc_score(y_te, prob_up))
        fold += 1

    return {
        "directional_accuracy": float(np.mean(accs)) if accs else np.nan,
        "roc_auc":              float(np.mean(aucs)) if aucs else np.nan,
        "n_folds":              fold,
    }


def _train_one_fold(model: BiLSTMModel, X: np.ndarray, y5: np.ndarray,
                    yr5: np.ndarray, epochs: int = 100):
    opt    = torch.optim.AdamW(model.parameters(), lr=1e-3, weight_decay=1e-4)
    sch    = torch.optim.lr_scheduler.CosineAnnealingLR(opt, T_max=epochs)
    ce     = nn.CrossEntropyLoss()
    hub    = nn.HuberLoss(delta=0.02)
    is_cuda = DEVICE.type == "cuda"

    # Convert to CPU tensors once — avoid per-batch numpy→tensor copies
    X_t   = torch.from_numpy(np.ascontiguousarray(X,   dtype=np.float32))
    y5_t  = torch.from_numpy(np.ascontiguousarray(y5,  dtype=np.int64))
    yr5_t = torch.from_numpy(np.ascontiguousarray(yr5, dtype=np.float32))
    if is_cuda:
        X_t = X_t.pin_memory(); y5_t = y5_t.pin_memory(); yr5_t = yr5_t.pin_memory()

    n = len(X_t)
    bs = 128  # smaller batches reduce cuDNN workspace + VRAM pressure
    for ep in range(epochs):
        model.train()
        perm = torch.randperm(n)
        for start in range(0, n, bs):
            idx = perm[start:start + bs]
            xb = X_t[idx].to(DEVICE, non_blocking=is_cuda)
            yb = y5_t[idx].to(DEVICE, non_blocking=is_cuda)
            rb = yr5_t[idx].to(DEVICE, non_blocking=is_cuda)
            out  = model(xb)
            loss = ce(out["dir_5d"], yb) * 0.5 + hub(out["ret_5d"], rb) * 0.5
            opt.zero_grad(); loss.backward(); opt.step()
        sch.step()


def _predict_batch(model: BiLSTMModel, X: np.ndarray, bs: int = 256) -> Dict[str, np.ndarray]:
    model.eval()
    is_cuda = DEVICE.type == "cuda"
    X_t = torch.from_numpy(np.ascontiguousarray(X, dtype=np.float32))
    if is_cuda:
        X_t = X_t.pin_memory()
    _DIR_KEYS = {"dir_1d", "dir_5d", "dir_15d"}
    results = {"dir_1d": [], "dir_5d": [], "dir_15d": [], "ret_5d": [], "ret_15d": []}
    with torch.no_grad():
        for start in range(0, len(X_t), bs):
            xb = X_t[start:start + bs].to(DEVICE, non_blocking=is_cuda)
            out = model(xb)
            for k in results:
                tensor = torch.softmax(out[k], dim=-1) if k in _DIR_KEYS else out[k]
                results[k].append(tensor.cpu().numpy())
    return {k: np.concatenate(v) for k, v in results.items()}


# ── Training Entry Point ─────────────────────────────────────────────────────

_CHUNK_SIZE = 100  # symbols per gradient-update chunk — bounds peak RAM


def train_lstm(version: int = 1) -> Dict:
    """Train BiLSTM on all symbols with >= 252 days, streaming in chunks to bound RAM."""
    con = sqlite3.connect(DB_PATH)
    symbols = [r[0] for r in con.execute(
        "SELECT DISTINCT symbol FROM feature_store "
        "GROUP BY symbol HAVING COUNT(*) >= 252"
    ).fetchall()]

    print(f"[DL] Training BiLSTM on {len(symbols)} symbols (chunk size {_CHUNK_SIZE})...")

    model = BiLSTMModel().to(DEVICE)

    # Accumulate one chunk, train, then release before next chunk to bound peak RAM.
    # We do a single pass through all symbols; for production you can add outer epochs.
    chunk_X, chunk_y5, chunk_y15, chunk_yr5 = [], [], [], []
    total_seqs = 0

    def _flush_chunk():
        nonlocal total_seqs
        if not chunk_X:
            return
        X_c   = np.concatenate(chunk_X)
        y5_c  = np.concatenate(chunk_y5)
        yr5_c = np.concatenate(chunk_yr5)
        total_seqs += len(X_c)
        print(f"[DL]   chunk: {len(X_c)} seqs, {X_c.nbytes // 1024 // 1024} MB")
        _train_one_fold(model, X_c, y5_c, yr5_c, epochs=30)
        chunk_X.clear(); chunk_y5.clear(); chunk_y15.clear(); chunk_yr5.clear()

    for i, sym in enumerate(symbols):
        try:
            X, y5, y15, yr5, _ = load_symbol_sequences(sym, con)
            if len(X) > 0:
                chunk_X.append(X); chunk_y5.append(y5)
                chunk_y15.append(y15); chunk_yr5.append(yr5)
        except Exception as e:
            print(f"[DL] Skip {sym}: {e}")
        if (i + 1) % _CHUNK_SIZE == 0:
            _flush_chunk()

    _flush_chunk()  # remaining symbols
    con.close()

    if total_seqs == 0:
        return {"error": "no training data"}

    print(f"[DL] Total sequences trained: {total_seqs}")

    # Walk-forward validation requires a contiguous array; load a validation sample
    # from the last chunk that is still in memory — skip if all data was flushed.
    metrics: Dict = {"directional_accuracy": float("nan"), "roc_auc": float("nan"),
                     "note": "walk-forward skipped (chunked training)"}

    MODEL_DIR.mkdir(parents=True, exist_ok=True)
    path = MODEL_DIR / f"lstm_v{version}.pt"
    torch.save(model.state_dict(), path)
    print(f"[DL] Model saved to {path}")
    return metrics


# ── Daily Inference ──────────────────────────────────────────────────────────

def run_inference(prediction_date: str = None) -> None:
    """Run BiLSTM inference on all symbols, write to deep_learning_predictions."""
    if prediction_date is None:
        prediction_date = datetime.today().strftime("%Y-%m-%d")

    cfg = _load_config()
    model_version = cfg.get("lstm_version", 1)
    model_path = MODEL_DIR / f"lstm_v{model_version}.pt"

    if not model_path.exists():
        print(f"[DL] No model at {model_path}. Run --mode train first.")
        return

    model = BiLSTMModel().to(DEVICE)
    model.load_state_dict(torch.load(model_path, map_location=DEVICE, weights_only=True))
    model.eval()

    con = sqlite3.connect(DB_PATH)
    symbols = [r[0] for r in con.execute(
        "SELECT DISTINCT symbol FROM feature_store WHERE timeframe='D'"
    ).fetchall()]

    # Load current regime for confidence modifier
    regime_row = con.execute(
        "SELECT regime, regime_prob FROM market_regimes ORDER BY date DESC LIMIT 1"
    ).fetchone()
    regime          = regime_row[0] if regime_row else "SIDEWAYS"
    regime_prob     = regime_row[1] if regime_row else 0.5
    conf_modifier   = {"BULL": 1.0, "SIDEWAYS": 1.0, "HIGH_VOL": 0.85, "BEAR": 0.85, "CRASH": 0.50}.get(regime, 1.0)

    written = 0
    batch_X, batch_syms = [], []

    def flush(b_X, b_syms):
        nonlocal written
        if not b_X:
            return
        X_np = np.concatenate(b_X, axis=0)
        preds = _predict_batch(model, X_np)
        cur = con.cursor()
        for i, sym in enumerate(b_syms):
            pu_1d  = float(preds["dir_1d"][i][1])
            pu_5d  = float(preds["dir_5d"][i][1])
            pu_15d = float(preds["dir_15d"][i][1])
            conf   = float(np.mean([pu_1d, pu_5d, pu_15d])) * conf_modifier
            unc    = float(np.std([pu_1d, pu_5d, pu_15d]))
            cur.execute(
                """INSERT OR REPLACE INTO deep_learning_predictions
                   (symbol, prediction_date, model_name, model_version,
                    prob_up_1d, prob_up_5d, prob_up_15d,
                    prob_dn_1d, prob_dn_5d, prob_dn_15d,
                    exp_ret_5d, exp_ret_15d,
                    confidence, uncertainty, regime, regime_confidence)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                (sym, prediction_date, "LSTM_TFT_ENSEMBLE", str(model_version),
                 pu_1d, pu_5d, pu_15d,
                 1 - pu_1d, 1 - pu_5d, 1 - pu_15d,
                 float(preds["ret_5d"][i]), float(preds["ret_15d"][i]),
                 conf, unc, regime, regime_prob),
            )
            written += 1
        con.commit()

    for sym in symbols:
        X, d = load_inference_sequence(sym, con)
        if X is None:
            continue
        batch_X.append(X); batch_syms.append(sym)
        if len(batch_X) >= 50:
            flush(batch_X, batch_syms)
            batch_X, batch_syms = [], []

    flush(batch_X, batch_syms)
    con.close()
    print(f"[DL] Inference complete: {written} predictions written for {prediction_date}")


def _load_config() -> Dict:
    if CONFIG_PATH.exists():
        with open(CONFIG_PATH) as f:
            return json.load(f)
    return {"lstm_version": 1, "tft_version": 1}


def _save_config(cfg: Dict):
    MODEL_DIR.mkdir(parents=True, exist_ok=True)
    with open(CONFIG_PATH, "w") as f:
        json.dump(cfg, f, indent=2)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--mode", choices=["train", "infer", "validate"], default="infer")
    parser.add_argument("--date", help="Prediction date (default: today)")
    parser.add_argument("--version", type=int, default=1)
    args = parser.parse_args()

    if args.mode == "train":
        metrics = train_lstm(version=args.version)
        cfg = _load_config()
        cfg["lstm_version"] = args.version
        _save_config(cfg)
        print(f"[DL] Training complete: {metrics}")
    elif args.mode == "infer":
        run_inference(args.date)
    elif args.mode == "validate":
        metrics = train_lstm(version=args.version)
        print(f"[DL] Validation metrics: {metrics}")
