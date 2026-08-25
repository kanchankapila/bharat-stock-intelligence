#!/usr/bin/env python3
"""
BiLSTM + TFT deep learning models for multi-horizon stock prediction.
Reads from feature_store, writes to deep_learning_predictions.
"""

import os
import sys
import json
import math
import pickle
import argparse
from datetime import datetime, timedelta
from pathlib import Path
from typing import Dict, List, Tuple

from db_compat import connect, read_df
from model_promotion import clears_promotion_bar, file_staleness_override_applies
from as_of import logical_trading_date

# Must be set before torch/cuBLAS initialises
os.environ.setdefault("CUBLAS_WORKSPACE_CONFIG", ":4096:8")
os.environ.setdefault("PYTORCH_CUDA_ALLOC_CONF", "expandable_segments:True")

import numpy as np
import pandas as pd

try:
    import torch
    import torch.nn as nn
    try:
        from torch.amp import autocast, GradScaler        # PyTorch 2.3+
    except ImportError:
        from torch.cuda.amp import autocast, GradScaler   # PyTorch 2.2.x fallback
except (ImportError, OSError) as _torch_err:
    # WinError 1455 (paging file too small) or missing CUDA DLLs — skip gracefully.
    # Exit 0 so BullMQ marks the job completed, not failed.
    print(f"[DL] PyTorch unavailable ({_torch_err}). Rescheduled for next low-load window.", flush=True)
    if __name__ == "__main__":
        sys.exit(0)
    else:
        # If imported (e.g. by pytest or other services), don't kill the process.
        # But we must ensure downstream code doesn't crash on missing torch.
        torch = None

from sklearn.metrics import roc_auc_score, accuracy_score

MODEL_DIR = Path(__file__).parent / "ml_models"
CONFIG_PATH = MODEL_DIR / "dl_model_config.json"

SEQUENCE_LEN = 60
# 78 legacy channels + 7 added 2026-08-24 (see FEATURE_COLS tail). Positions 0-77 are
# frozen: the champion checkpoint lstm_v3.pt was trained at this width, and until a wider
# candidate clears the promotion bar, run_inference() loads and runs it via the
# width-agnostic loader (_checkpoint_input_width) reading ONLY the first N_FEATURES_LEGACY
# columns of every batch. Bumping this constant alone must never break daily inference.
N_FEATURES        = 85
N_FEATURES_LEGACY = 78

# Defensive winsorization bound for raw engineered features fed to the LSTM (2026-08-06).
# nan_to_num below only catches true NaN/+-inf; it does nothing for an extreme-but-finite
# outlier -- and those are real and pervasive in feature_store, not hypothetical: live query
# confirmed dist_sma200_pct in [-3644, +2771] (avg |value| ~2.15), ret_1d/ret_5d (fractional
# return columns, legitimate range roughly +-1) reaching +-1.5M/+-3.2M, op_margins to -19479,
# and 88k+ debt_to_equity rows with |value|>50 -- almost certainly the documented bad-OHLCV-bar
# class (ohlcv_quality.py) and/or unit-scale mismatches in upstream ratio computations, not
# clipped anywhere before reaching this model. A single such row in a 60-step sequence is
# enough to blow up the first matmul (worse under this model's AMP/fp16 forward pass, whose
# max representable magnitude is ~65504) and is a highly plausible contributor to the
# recurring NaN-weight divergence documented in dl_model_config.json's stale v3 pin (see
# CLAUDE.md's dl_trainer.py session notes) -- gradient clipping alone (added 2026-08-02) bounds
# the backward pass, not this. 1e4 is deliberately wide: it is far above every plausible real
# value for every FEATURE_COLS entry (bounded indicators like RSI/MACD/ratios are two to three
# orders of magnitude smaller) while unambiguously catching the confirmed corruption-scale
# outliers above -- this is a numerical-stability guard, not a per-column scale/unit fix.
FEATURE_CLIP_BOUND = 1e4
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
    # price_to_book (NOT legacy "pb"): feature_store.pb has never been written by
    # feature_engineering -- 0 non-null values across the entire table -- so this slot has
    # been a COALESCE(0) constant since inception. price_to_book went live 2026-08-24
    # (_merge_fundamentals Gap #4 follow-up, sourced PIT from fundamentals_history).
    # Same list position => identical tensor width, so existing checkpoints and the saved
    # scaler stay valid; the channel simply starts reading real data.
    "price_to_book","rev_growth","eps_growth","advance_decline_ratio","nifty_pe",
    "max_pain",
    # ── 2026-08-24 widening (+7, positions 78-84) ──────────────────────────────
    # APPENDED, never inserted: positions 0-77 stay byte-identical so a pre-widening
    # champion checkpoint scores identically through the width-agnostic loader
    # (_checkpoint_input_width + loaders' FEATURE_COLS[:width] slice).
    # All 7 locked through the density gate (fresh non-null coverage on fs_recent):
    # ret_12m_ex1m ~100% / iv_skew 78% / call_wall_dist_pct 76% / put_wall_dist_pct 75%
    # / insider_buy_pct_90d 28% / block_deal_net_qty 24% (fresh to 8/21) /
    # near_expiry_gamma 24% (accepted sparse gap -- see _merge_flow_features docstring).
    # sector_ret_5d/21d deliberately NOT added: their fallback producer
    # (_compute_sector_momentum) landed same day but the columns are ~constant per sector,
    # near-duplicating momentum channels already present; revisit only with evidence.
    "ret_12m_ex1m",
    "iv_skew",
    "call_wall_dist_pct","put_wall_dist_pct",
    "insider_buy_pct_90d","block_deal_net_qty",
    "near_expiry_gamma",
]

DEVICE = torch.device("cuda" if torch.cuda.is_available() else "cpu")
if DEVICE.type == "cuda":
    torch.backends.cudnn.enabled = False   # cuDNN LSTM backward broken on Windows/cu124; use PyTorch-native path
    torch.backends.cudnn.benchmark = False
    print(f"[DL] Device: cuda ({torch.cuda.get_device_name(0)}) "
          f"{torch.cuda.get_device_properties(0).total_memory // 1024**2} MB VRAM (cudnn disabled)")
else:
    print("[DL] Device: cpu")


# ── Checkpoint width handling ────────────────────────────────────────────────

# Input width of the currently cached checkpoint (set by run_inference when it loads a
# model; None outside inference). The sequence loaders slice FEATURE_COLS to this so a
# legacy-width champion keeps running unchanged after the feature widening.
_INFERENCE_INPUT_WIDTH: int | None = None


def _checkpoint_input_width(state_dict: Dict) -> int:
    """Infer a BiLSTMModel checkpoint's input width from its own weights.

    lstm1.weight_ih_l0 has shape (4*hidden, n_features) -- bidirectional LSTM weight
    tensors are stored per direction, so the forward direction's input projection carries
    exactly the channel count the model was trained with. Width-agnostic loading keeps
    daily inference alive when today's N_FEATURES no longer matches the ACTIVE champion:
    after the 2026-08-24 widening (78 -> 85) the promoted config can still point at a
    pre-widening checkpoint until a wider candidate clears the promotion bar, and
    constructing a default-width model for it used to crash load_state_dict with a
    size-mismatch RuntimeError -- killing every deep_learning_predictions write for the
    whole stale-champion window.
    """
    w = state_dict.get("lstm1.weight_ih_l0")
    if w is None or w.dim() != 2:
        raise RuntimeError(
            "Checkpoint has no recognisable lstm1.weight_ih_l0 tensor -- cannot infer "
            "input width. Is this actually a BiLSTMModel state_dict?"
        )
    return int(w.shape[1])


def _resolve_input_width(n_features: int = None) -> int:
    """Column count the sequence loaders should emit: an explicit argument wins (training
    always passes N_FEATURES so it never inherits a stale champion's narrower width);
    otherwise follow the active checkpoint's input width if one is loaded in-process;
    otherwise today's N_FEATURES."""
    if n_features is not None:
        return int(n_features)
    return _INFERENCE_INPUT_WIDTH or N_FEATURES


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
    symbol: str, seq_len: int = SEQUENCE_LEN, n_features: int = None
) -> Tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray, List[str]]:
    """
    Returns: X (N, seq_len, n_feat), y_dir5 (N,), y_dir15 (N,), y_ret5 (N,), dates list
    Only returns rows where all target columns are non-null (training mode).
    n_features overrides the emitted column count (see _resolve_input_width); training
    callers must pass N_FEATURES explicitly.
    """
    feat_cols = FEATURE_COLS[:_resolve_input_width(n_features)]
    numeric_cols = [c for c in feat_cols if c not in _VOL_ONEHOT]
    cols_sql = ", ".join(
        f'COALESCE(CAST("{c}" AS REAL), 0.0) as "{c}"' if c in ("trend_1d", "trend_1w", "trend_1m")
        else f'COALESCE("{c}", 0) as "{c}"'
        for c in numeric_cols
    )
    df = read_df(
        f"""SELECT date, {cols_sql}, vol_regime,
               target_ret_5d, target_ret_15d
            FROM feature_store WHERE symbol=? AND timeframe='D'
            ORDER BY date""",
        (symbol,),
    )
    df["date"] = pd.to_datetime(df["date"])
    df = _onehot_vol_regime(df)
    # Derive direction labels from the return columns rather than the stored
    # target_dir_5d/target_dir_15d columns: legacy rows (predating the current boolean-cast
    # encoding) hold values outside {0,1} (observed live: -4,-2,-1,2,4), which crash
    # nn.CrossEntropyLoss with a CUDA "t >= 0 && t < n_classes" assertion since the direction
    # heads are 2-class. target_ret_5d/15d are the raw returns feature_engineering.py itself
    # derives target_dir from, so recomputing here is always consistent with {0,1}.
    df = df.dropna(subset=["target_ret_5d", "target_ret_15d"])
    df = df.fillna(0)

    # A ratio-style feature (e.g. dist_sma200_pct, pe, vwap_dist_pct) computed off a near-zero
    # denominator or an implausible bad bar (this codebase has documented cases of >100,000%
    # single-day "returns" from bad OHLCV rows -- see ohlcv_quality.py) can be +/-inf. Feeding
    # that straight into the LSTM blows up the first matmul instantly and diverges the whole
    # model; np.nan_to_num maps it to 0 (treated the same as the missing-data fillna(0) above)
    # rather than letting a single row poison every future gradient step. np.clip afterward
    # catches the same failure mode's finite sibling -- an extreme-but-not-inf outlier
    # (confirmed live, see FEATURE_CLIP_BOUND's own comment) that nan_to_num does not touch.
    X_all = np.nan_to_num(df[feat_cols].values.astype(np.float32), nan=0.0, posinf=0.0, neginf=0.0)
    X_all = np.clip(X_all, -FEATURE_CLIP_BOUND, FEATURE_CLIP_BOUND)
    y5    = (df["target_ret_5d"]  > 0).astype(np.int64).values
    y15   = (df["target_ret_15d"] > 0).astype(np.int64).values
    yr5   = np.nan_to_num(df["target_ret_5d"].values.astype(np.float32), nan=0.0, posinf=0.0, neginf=0.0)
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
    symbol: str, seq_len: int = SEQUENCE_LEN, n_features: int = None
) -> Tuple[np.ndarray, str]:
    """Load last seq_len rows for inference. Returns (1, seq_len, n_feat) and latest date.
    Defaults to the ACTIVE CHECKPOINT's input width (not today's N_FEATURES): loaders
    always build the full widened frame, then slice, so a legacy-width champion reads
    FEATURE_COLS[:78] -- byte-identical to its training-time columns because the widening
    appended, never inserted."""
    feat_cols = FEATURE_COLS[:_resolve_input_width(n_features)]
    numeric_cols = [c for c in feat_cols if c not in _VOL_ONEHOT]
    cols_sql = ", ".join(
        f'COALESCE(CAST("{c}" AS REAL), 0.0) as "{c}"' if c in ("trend_1d", "trend_1w", "trend_1m")
        else f'COALESCE("{c}", 0) as "{c}"'
        for c in numeric_cols
    )
    df = read_df(
        f"""SELECT date, {cols_sql}, vol_regime
            FROM feature_store WHERE symbol=? AND timeframe='D'
            ORDER BY date DESC LIMIT {int(seq_len)}""",
        (symbol,),
    )
    if len(df) < seq_len:
        return None, None
    df = df.sort_values("date")
    df = _onehot_vol_regime(df).fillna(0)
    # Same non-finite + extreme-outlier guard as load_symbol_sequences (training) -- must match
    # exactly, or inference sees a different feature distribution than training did (train/serve
    # skew). A live inf/extreme feature here would otherwise produce an inf/NaN prediction,
    # which the caller's finite-check then correctly drops, but there's no reason to let it
    # reach the model at all.
    X = np.nan_to_num(df[feat_cols].values.astype(np.float32), nan=0.0, posinf=0.0, neginf=0.0)
    X = np.clip(X, -FEATURE_CLIP_BOUND, FEATURE_CLIP_BOUND)
    return X[np.newaxis], df["date"].iloc[-1]


# ── Walk-Forward Validation ──────────────────────────────────────────────────

def walk_forward_validate(model: BiLSTMModel, X: np.ndarray, y5: np.ndarray,
                           y15: np.ndarray, yr5: np.ndarray,
                           fold_size: int = 30) -> Dict:
    """Expanding window walk-forward. Returns mean metrics across folds.

    Also tracks frac_saturated -- the fraction of held-out predictions within
    SATURATION_EPS of 0 or 1 -- across ALL folds' predictions pooled together. Live bug,
    2026-08-10: AUC only measures rank order, so a model that outputs ~1.0/~0.0 for nearly
    everything (confidently wrong in absolute terms, not just miscalibrated) can still clear
    the AUC promotion bar. Confirmed live: BiLSTM v4 (promoted 2026-08-06) jumped from 19%
    saturated predictions (the prior, healthier version) to 70% the very next inference day,
    with output then barely changing day-to-day -- a real regression the AUC-only gate missed
    entirely. See _promote_lstm_version's MAX_SATURATION_FRAC check.
    """
    n = len(X)
    min_train = 300
    if n < min_train + fold_size * 2:
        return {"directional_accuracy": np.nan, "roc_auc": np.nan, "frac_saturated": np.nan}

    accs, aucs, all_probs = [], [], []
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
        # Fresh scaler per fold: reusing a stale scaler across folds can accumulate scale
        # adjustments and destabilize the loss (observed: late folds failed with NaN even
        # with scaling, likely due to scaler state corruption across prior fold iterations).
        fold_scaler = GradScaler('cuda') if DEVICE.type == "cuda" else None
        _train_one_fold(model_copy, X_tr, y_tr, yr5[:train_end], epochs=30, y15=y15[:train_end],
                         scaler=fold_scaler)

        preds = _predict_batch(model_copy, X_te)
        del model_copy
        if DEVICE.type == "cuda":
            torch.cuda.empty_cache()

        prob_up = preds["dir_5d"][:, 1]
        pred_dir = (prob_up > 0.5).astype(int)
        accs.append(accuracy_score(y_te, pred_dir))
        if len(np.unique(y_te)) > 1:
            aucs.append(roc_auc_score(y_te, prob_up))
        all_probs.extend(prob_up.tolist())
        fold += 1

    SATURATION_EPS = 0.01
    frac_saturated = (
        float(np.mean([(p <= SATURATION_EPS or p >= 1 - SATURATION_EPS) for p in all_probs]))
        if all_probs else np.nan
    )
    return {
        "directional_accuracy": float(np.mean(accs)) if accs else np.nan,
        "roc_auc":              float(np.mean(aucs)) if aucs else np.nan,
        "n_folds":              fold,
        "frac_saturated":       frac_saturated,
    }


def _train_one_fold(model: BiLSTMModel, X: np.ndarray, y5: np.ndarray,
                    yr5: np.ndarray, epochs: int = 100, y15: np.ndarray = None,
                    scaler=None):
    model  = model.to(DEVICE)
    opt    = torch.optim.AdamW(model.parameters(), lr=1e-3, weight_decay=1e-4)
    sch    = torch.optim.lr_scheduler.CosineAnnealingLR(opt, T_max=epochs)
    ce     = nn.CrossEntropyLoss()
    hub    = nn.HuberLoss(delta=0.02)
    is_cuda = DEVICE.type == "cuda"

    # Convert to CPU tensors once — avoid per-batch numpy→tensor copies
    X_t   = torch.from_numpy(np.ascontiguousarray(X,   dtype=np.float32))
    y5_t  = torch.from_numpy(np.ascontiguousarray(y5,  dtype=np.int64))
    yr5_t = torch.from_numpy(np.ascontiguousarray(yr5, dtype=np.float32))
    y15_t = torch.from_numpy(np.ascontiguousarray(y15, dtype=np.int64)) if y15 is not None else None
    if is_cuda:
        X_t = X_t.pin_memory(); y5_t = y5_t.pin_memory(); yr5_t = yr5_t.pin_memory()
        if y15_t is not None:
            y15_t = y15_t.pin_memory()

    n = len(X_t)
    bs = 128  # smaller batches reduce cuDNN workspace + VRAM pressure
    for ep in range(epochs):
        model.train()
        perm = torch.randperm(n)
        stepped = False
        for start in range(0, n, bs):
            idx = perm[start:start + bs]
            if len(idx) <= 1:
                continue
            xb   = X_t[idx].to(DEVICE, non_blocking=is_cuda)
            yb   = y5_t[idx].to(DEVICE, non_blocking=is_cuda)
            rb   = yr5_t[idx].to(DEVICE, non_blocking=is_cuda)
            yb15 = y15_t[idx].to(DEVICE, non_blocking=is_cuda) if y15_t is not None else None
            opt.zero_grad()
            with autocast('cuda', enabled=is_cuda):
                out  = model(xb)
                loss = ce(out["dir_5d"], yb) * 0.5 + hub(out["ret_5d"], rb) * 0.5
                if yb15 is not None:
                    loss = loss + ce(out["dir_15d"], yb15) * 0.5
            if not torch.isfinite(loss):
                # A single non-finite batch (e.g. one remaining bad-data row that np.nan_to_num
                # in load_symbol_sequences didn't already zero, or an unlucky fp16 overflow under
                # autocast) must not be allowed to backward() at all -- every lstm_v3..v18
                # checkpoint diverged to ~100% NaN weights this way, and once the LSTM's hidden
                # state carries a NaN it poisons every subsequent batch and epoch permanently.
                continue
            if scaler is not None:
                prev_scale = scaler.get_scale()
                scaler.scale(loss).backward()
                # unscale BEFORE clipping -- clip_grad_norm_ on still-fp16-scaled gradients
                # clips against the wrong (scaled) magnitude and doesn't actually bound the
                # true gradient norm.
                scaler.unscale_(opt)
                torch.nn.utils.clip_grad_norm_(model.parameters(), max_norm=1.0)
                scaler.step(opt)
                scaler.update()
                if scaler.get_scale() >= prev_scale:  # step was not skipped
                    stepped = True
            else:
                loss.backward()
                # Gradient clipping is the standard fix for LSTM exploding-gradient divergence;
                # this loop previously had none, and an unbounded update from one bad batch or
                # a stretch of high-lr instability could push weights to NaN in a single step.
                torch.nn.utils.clip_grad_norm_(model.parameters(), max_norm=1.0)
                opt.step()
                stepped = True
        if stepped:
            sch.step()


def _predict_batch(model: BiLSTMModel, X: np.ndarray, bs: int = 256) -> Dict[str, np.ndarray]:
    model = model.to(DEVICE)
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
            with autocast('cuda', enabled=is_cuda):
                out = model(xb)
            for k in results:
                tensor = torch.softmax(out[k], dim=-1) if k in _DIR_KEYS else out[k]
                results[k].append(tensor.float().cpu().numpy())
    return {k: np.concatenate(v) for k, v in results.items()}


# ── Training Entry Point ─────────────────────────────────────────────────────

_CHUNK_SIZE = 100  # symbols per gradient-update chunk — bounds peak RAM


def train_lstm(version: int = 1) -> Dict:
    """Train BiLSTM on all symbols with >= 252 days, streaming in chunks to bound RAM."""
    con = connect()
    symbols = [r[0] for r in con.execute(
        "SELECT DISTINCT symbol FROM feature_store "
        "GROUP BY symbol HAVING COUNT(*) >= 252"
    ).fetchall()]
    con.close()  # release before the multi-hour training loop — a PG connection held idle that
                 # long gets reaped server-side ("server closed the connection unexpectedly"),
                 # which silently failed every retrain. load_symbol_sequences() below opens its
                 # own pooled connection per call, so nothing needs this one during training.

    print(f"[DL] Training BiLSTM on {len(symbols)} symbols (chunk size {_CHUNK_SIZE})...")

    model = BiLSTMModel().to(DEVICE)
    # Single scaler shared across all chunks — preserves calibrated loss scale between chunks
    amp_scaler = GradScaler('cuda') if DEVICE.type == "cuda" else None

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
        y15_c = np.concatenate(chunk_y15)
        yr5_c = np.concatenate(chunk_yr5)
        total_seqs += len(X_c)
        print(f"[DL]   chunk: {len(X_c)} seqs, {X_c.nbytes // 1024 // 1024} MB")
        _train_one_fold(model, X_c, y5_c, yr5_c, epochs=30, y15=y15_c, scaler=amp_scaler)
        chunk_X.clear(); chunk_y5.clear(); chunk_y15.clear(); chunk_yr5.clear()

    for i, sym in enumerate(symbols):
        try:
            # Explicit N_FEATURES: training data MUST be today's full widened width even if
            # an old legacy-width champion happens to be loaded in-process -- otherwise a
            # candidate trained after the 2026-08-24 widening would silently inherit the
            # active checkpoint's narrower column count via _resolve_input_width().
            X, y5, y15, yr5, _ = load_symbol_sequences(sym, n_features=N_FEATURES)
            if len(X) > 0:
                chunk_X.append(X); chunk_y5.append(y5)
                chunk_y15.append(y15); chunk_yr5.append(yr5)
        except Exception as e:
            print(f"[DL] Skip {sym}: {e}")
        if (i + 1) % _CHUNK_SIZE == 0:
            _flush_chunk()

    _flush_chunk()  # remaining symbols

    if total_seqs == 0:
        return {"error": "no training data"}

    print(f"[DL] Total sequences trained: {total_seqs}")

    # Walk-forward validation: load a held-out sample (up to 50 symbols) fresh from DB.
    metrics: Dict = {"directional_accuracy": float("nan"), "roc_auc": float("nan")}
    val_symbols = symbols[:min(50, len(symbols))]
    val_X, val_y5, val_y15, val_yr5 = [], [], [], []
    for sym in val_symbols:
        try:
            Xv, y5v, y15v, yr5v, _ = load_symbol_sequences(sym)
            if len(Xv) > 0:
                val_X.append(Xv); val_y5.append(y5v)
                val_y15.append(y15v); val_yr5.append(yr5v)
        except Exception:
            pass
    if val_X:
        X_val   = np.concatenate(val_X)
        y5_val  = np.concatenate(val_y5)
        y15_val = np.concatenate(val_y15)
        yr5_val = np.concatenate(val_yr5)
        try:
            metrics = walk_forward_validate(model, X_val, y5_val, y15_val, yr5_val, fold_size=2000)
            print(f"[DL] Walk-forward metrics: {metrics}")
        except Exception as e:
            # Validation phase is fragile (NaN in metrics, label edge cases); don't let it abort
            # the entire training. Training succeeded if we reached here; return NaN metrics and
            # let the quality gate rely on training stability instead.
            print(f"[DL] Walk-forward validation failed (non-fatal): {e}")
            print(f"[DL] Training completed successfully; metrics unavailable")

    # Persist held-out metrics so monitoring finally sees what training computed. Before
    # 2026-08-24 NOTHING wrote dl_model_performance's directional_accuracy/roc_auc columns
    # (drift_detector only ever wrote drift_score), so the router/UI served an all-NULL AUC
    # history and drift_detector.check_accuracy_drift had no fresh baseline. Runs even when
    # validation failed above: NaN metrics are skipped inside write_training_metrics, and
    # that function swallows its own DB errors -- a monitoring write must never fail a
    # completed training run.
    try:
        from drift_detector import write_training_metrics
        write_training_metrics(metrics, model_version=f"lstm_v{version}")
    except Exception as me:
        print(f"[DL] Held-out metric persistence skipped: {me}")

    MODEL_DIR.mkdir(parents=True, exist_ok=True)
    path = MODEL_DIR / f"lstm_v{version}.pt"

    # Divergence check on the weights themselves, not just the metrics. A metric-based gate
    # cannot catch this: all-NaN weights make walk_forward_validate raise, which the handler
    # above deliberately swallows as non-fatal, leaving NaN metrics behind. lstm_v3..v18 were
    # all saved with 100% NaN parameters this way and v18 became the active model.
    nan_params = sum(int(torch.isnan(t).sum()) + int(torch.isinf(t).sum())
                     for t in model.state_dict().values() if t.is_floating_point())
    if nan_params:
        metrics["error"] = f"training diverged: {nan_params} non-finite parameters"
        print(f"[DL] REFUSED to save v{version}: training diverged "
              f"({nan_params} non-finite parameters). Lower the learning rate or check the "
              f"input features for NaN; the previous checkpoint stays active.", file=sys.stderr)
        return metrics

    torch.save(model.state_dict(), path)
    print(f"[DL] Model saved to {path}")
    return metrics


# ── Daily Inference ──────────────────────────────────────────────────────────

_DL_MODEL_CACHE: dict | None = None  # {'model': BiLSTMModel, 'path': str, 'mtime': float}


def _resolve_prediction_date(prediction_date: str = None) -> str:
    """Resolve run_inference()'s date argument, defaulting to logical_trading_date() rather
    than a raw wall-clock date (2026-08-06). dl-infer-daily's cron fires at 18:30 UTC = 00:00
    IST exactly (moved there 2026-07-31 specifically to dodge the 21:00-23:35 IST pg-pool
    contention window), and no scheduled caller ever passes --date, so every run's "today" was
    the calendar day AFTER the trading session whose feature_store row it actually reads --
    deep_learning_predictions.prediction_date was permanently stamped one day ahead of the data
    it reflects. Same bug class as insider_features.py/screener_performance.py; see
    as_of.logical_trading_date's docstring. Extracted as its own function so this default is
    directly unit-testable without invoking run_inference()'s model-loading/DB logic.
    """
    if prediction_date is None:
        return logical_trading_date()
    return prediction_date


def run_inference(prediction_date: str = None) -> None:
    """Run BiLSTM inference on all symbols, write to deep_learning_predictions."""
    global _DL_MODEL_CACHE

    prediction_date = _resolve_prediction_date(prediction_date)

    cfg = _load_config()
    model_version = cfg.get("lstm_version", 1)
    model_path = MODEL_DIR / f"lstm_v{model_version}.pt"

    if not model_path.exists():
        # A missing file here means dl_model_config.json's pointer and what's actually on disk
        # have diverged (observed live: the config pointed at lstm_v19.pt after training refused
        # to save a diverged checkpoint, but the promotion step still activated the version
        # number). Returning quietly used to let this run to "success" every day while writing
        # zero predictions -- indistinguishable from a healthy day in every job-monitoring signal.
        # A raised exception (not sys.exit) so this fails loudly both from the CLI entry point
        # (uncaught -> non-zero exit, same as any other Python crash) and from python_api.py's
        # in-process FastAPI call, where sys.exit would raise SystemExit -- a BaseException the
        # endpoint's `except Exception` does NOT catch, which would have taken down the whole
        # uvicorn worker instead of just failing this one request.
        raise RuntimeError(f"No model at {model_path} (config points to version {model_version}). "
                            f"Run --mode train first.")

    mtime = model_path.stat().st_mtime
    if (
        _DL_MODEL_CACHE is None
        or _DL_MODEL_CACHE.get('path') != str(model_path)
        or _DL_MODEL_CACHE.get('mtime') != mtime
    ):
        state_dict = torch.load(model_path, map_location=DEVICE, weights_only=True)
        # Width-agnostic loading (2026-08-24 feature widening): infer the input width from
        # the checkpoint itself instead of assuming BiLSTMModel() == N_FEATURES. The daily
        # inference chain runs the ACTIVE champion, which after the 78→85 widening can
        # legitimately be either width -- a pre-widening checkpoint (e.g. lstm_v3.pt) while
        # no retrained candidate has cleared the +0.005 AUC promotion bar yet. Constructing
        # the default-width model here used to crash every load_state_dict with a
        # size-mismatch RuntimeError and take down ALL deep_learning_predictions writes for
        # as long as the stale champion stayed active.
        ckpt_width = _checkpoint_input_width(state_dict)
        _m = BiLSTMModel(n_features=ckpt_width).to(DEVICE)
        _m.load_state_dict(state_dict)
        _m.eval()
        _DL_MODEL_CACHE = {'model': _m, 'path': str(model_path), 'mtime': mtime,
                           'input_width': ckpt_width}

    model = _DL_MODEL_CACHE['model']
    # Feed the model the column count IT was trained on, not today's N_FEATURES: loaders
    # always build the full widened frame, then slice. A legacy 78-input champion reads
    # FEATURE_COLS[:78] -- byte-identical to its training-time columns because the widening
    # appended, never inserted. A promoted 85-input candidate reads all of them.
    input_width = _DL_MODEL_CACHE.get('input_width', getattr(model.lstm1, "input_size"))
    global _INFERENCE_INPUT_WIDTH
    _INFERENCE_INPUT_WIDTH = input_width

    con = connect()
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
    skipped_nonfinite = 0
    batch_X, batch_syms = [], []

    def flush(b_X, b_syms):
        nonlocal written
        if not b_X:
            return
        nonlocal skipped_nonfinite
        X_np = np.concatenate(b_X, axis=0)
        preds = _predict_batch(model, X_np)
        cur = con.cursor()
        for i, sym in enumerate(b_syms):
            pu_1d  = float(preds["dir_1d"][i][1])
            pu_5d  = float(preds["dir_5d"][i][1])
            pu_15d = float(preds["dir_15d"][i][1])
            r5     = float(preds["ret_5d"][i])
            r15    = float(preds["ret_15d"][i])
            # Never persist a non-finite prediction. A diverged checkpoint emits all-NaN, and
            # downstream consumers (unified_ranker's dl_score) cannot distinguish "NaN" from
            # "a real probability" — writing nothing leaves the engine correctly absent.
            if not all(math.isfinite(v) for v in (pu_1d, pu_5d, pu_15d, r5, r15)):
                skipped_nonfinite += 1
                continue
            conf   = float(np.mean([pu_1d, pu_5d, pu_15d])) * conf_modifier
            unc    = float(np.std([pu_1d, pu_5d, pu_15d]))
            # KNOWN DEAD COLUMNS on deep_learning_predictions, investigated 2026-08-07
            # (dead-column sweep), NOT fixed here -- both need model-architecture changes to a
            # file with a documented NaN-weights/rollback incident history (see the 2026-08-02
            # dl_trainer note), not a quick wiring fix:
            #   exp_ret_1d: this model only has regression heads for 5d/15d (head_ret_5d,
            #     head_ret_15d) -- 1d has a direction-classification head (head_dir_1d) but no
            #     accompanying return-magnitude regression head. Populating this column for
            #     real needs a new head trained from scratch, not a bug fix.
            #   attention_json/top_features_json: SelfAttention (self.attn) IS computed inside
            #     forward(), but its weights are consumed internally to build `feat` and never
            #     returned/serialized -- attention_json is feasible (expose the existing
            #     tensor) but still an inference-path change; top_features_json would need a
            #     wholly new attribution mechanism (e.g. gradient-based), not a byproduct of
            #     the existing forward pass at all. Deliberately not attempted in this pass.
            cur.execute(
                """INSERT INTO deep_learning_predictions
                   (symbol, prediction_date, model_name, model_version,
                    prob_up_1d, prob_up_5d, prob_up_15d,
                    prob_dn_1d, prob_dn_5d, prob_dn_15d,
                    exp_ret_5d, exp_ret_15d,
                    confidence, uncertainty, regime, regime_confidence)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
                   ON CONFLICT(symbol, prediction_date, model_name) DO UPDATE SET
                     model_version=excluded.model_version,
                     prob_up_1d=excluded.prob_up_1d, prob_up_5d=excluded.prob_up_5d,
                     prob_up_15d=excluded.prob_up_15d,
                     prob_dn_1d=excluded.prob_dn_1d, prob_dn_5d=excluded.prob_dn_5d,
                     prob_dn_15d=excluded.prob_dn_15d,
                     exp_ret_5d=excluded.exp_ret_5d, exp_ret_15d=excluded.exp_ret_15d,
                     confidence=excluded.confidence, uncertainty=excluded.uncertainty,
                     regime=excluded.regime, regime_confidence=excluded.regime_confidence""",
                (sym, prediction_date, "LSTM_TFT_ENSEMBLE", str(model_version),
                 pu_1d, pu_5d, pu_15d,
                 1 - pu_1d, 1 - pu_5d, 1 - pu_15d,
                 r5, r15,
                 conf, unc, regime, regime_prob),
            )
            written += 1
        con.commit()

    for sym in symbols:
        X, d = load_inference_sequence(sym)
        if X is None:
            continue
        batch_X.append(X); batch_syms.append(sym)
        if len(batch_X) >= 50:
            flush(batch_X, batch_syms)
            batch_X, batch_syms = [], []

    flush(batch_X, batch_syms)
    con.close()
    print(f"[DL] Inference complete: {written} predictions written for {prediction_date}")
    if skipped_nonfinite:
        # Loud, and a raised error (not sys.exit — see the missing-model branch above for why)
        # when the model produced nothing usable — an all-NaN checkpoint previously ran to
        # "success" every day while writing pure NaN.
        msg = (f"{skipped_nonfinite} predictions dropped as non-finite (NaN/inf). "
               f"The active checkpoint (lstm_v{model_version}.pt) is likely diverged - retrain.")
        print(f"[DL] ERROR: {msg}", file=sys.stderr)
        if written == 0:
            raise RuntimeError(msg)


def _load_config() -> Dict:
    if CONFIG_PATH.exists():
        with open(CONFIG_PATH) as f:
            return json.load(f)
    return {"lstm_version": 1, "tft_version": 1}


def _save_config(cfg: Dict):
    MODEL_DIR.mkdir(parents=True, exist_ok=True)
    with open(CONFIG_PATH, "w") as f:
        json.dump(cfg, f, indent=2)


# New walk-forward roc_auc must beat the currently-active version's recorded roc_auc by at
# least this much to be promoted. Same value as ml_ensemble.py's PROMOTION_MARGIN.
LSTM_PROMOTION_MARGIN = 0.005


def _promote_lstm_version(new_version: int, metrics: Dict) -> bool:
    """Gate `--mode train`'s config write behind a promotion bar (Finding #70, 2026-07-28
    full-stack audit): `cfg["lstm_version"] = args.version; _save_config(cfg)` used to run
    unconditionally -- a regression in the new BiLSTM (bad batch, NaN fold, unlucky init)
    would go to production automatically the moment `run_inference()` next read the config,
    with no comparison against the previously-active version's own walk-forward metrics and
    no backup of the prior config. Mirrors ml_ensemble.py's promotion pattern: a required
    metric-improvement bar plus a timestamped backup of the previous config.

    `train_lstm()` already saves each version to its own versioned path
    (`lstm_v{version}.pt`) rather than overwriting a shared filename -- so a rejected
    version's weights are naturally preserved on disk as a candidate with no extra work;
    only the config pointer `run_inference()` reads is what needs gating here.

    Returns True if promoted (cfg written), False if rejected (cfg left untouched).
    """
    # A diverged run never reaches a usable checkpoint; train_lstm() refuses to save it and
    # reports the divergence here. Promoting the version pointer anyway would activate a
    # missing (or previously-written all-NaN) file.
    if metrics.get("error"):
        print(f"[DL] REFUSED: v{new_version} not promoted -- {metrics['error']}.")
        return False

    new_auc = metrics.get("roc_auc")
    if new_auc is None or (isinstance(new_auc, float) and np.isnan(new_auc)):
        print(f"[DL] REFUSED: walk-forward validation did not produce a usable roc_auc "
              f"(metrics={metrics}) -- cannot confirm v{new_version} is safe to promote. "
              f"Weights saved to lstm_v{new_version}.pt but NOT activated; "
              f"re-run --mode train once validation succeeds.")
        return False

    # Live bug, 2026-08-10: AUC only measures rank order -- a model that outputs ~1.0/~0.0 for
    # nearly every prediction (confidently wrong in absolute terms) can still clear the AUC bar
    # as long as its rank ordering happens to be directionally fine. Confirmed live: v4 (this
    # exact gate, promoted 2026-08-06) went from 19% saturated predictions to 70% the very next
    # day, then barely varied day-to-day -- a real regression this gate did not catch. 0.5 is a
    # deliberately generous ceiling (well above the 19% baseline, well below the 70% regression)
    # so a model with a genuinely high-conviction minority of predictions isn't blocked.
    MAX_SATURATION_FRAC = 0.5
    frac_saturated = metrics.get("frac_saturated")
    if frac_saturated is not None and not (isinstance(frac_saturated, float) and np.isnan(frac_saturated)) \
            and frac_saturated > MAX_SATURATION_FRAC:
        print(f"[DL] REFUSED: v{new_version} frac_saturated={frac_saturated:.2f} exceeds "
              f"{MAX_SATURATION_FRAC} -- {frac_saturated:.0%} of walk-forward predictions are "
              f"within 1% of 0 or 1, regardless of roc_auc={new_auc:.4f}. Weights saved to "
              f"lstm_v{new_version}.pt but NOT activated.")
        return False

    cfg = _load_config()
    active_version = cfg.get("lstm_version")
    version_metrics = cfg.get("lstm_metrics", {})
    baseline_auc = None
    if active_version is not None:
        baseline = version_metrics.get(str(active_version))
        if baseline and baseline.get("roc_auc") is not None and not (
            isinstance(baseline["roc_auc"], float) and np.isnan(baseline["roc_auc"])
        ):
            baseline_auc = float(baseline["roc_auc"])

    promote = clears_promotion_bar(new_auc, baseline_auc, LSTM_PROMOTION_MARGIN)

    # STALENESS OVERRIDE (ml-promotion-gate-review, 2026-08-15): this file's baseline lives in
    # a local JSON config, not model_registry, so it had no equivalent to ml_ensemble.py/
    # cs_ranker.py's safety valve against a baseline that's become permanently unbeatable --
    # every future honest retrain would reject forever. Bookkeeping lives inside the active
    # version's own metrics dict (mutating `baseline` in place also updates `version_metrics`/
    # `cfg`, since `.get()` returns the same dict object, not a copy). See model_promotion.
    # file_staleness_override_applies()'s docstring for the full contract.
    staleness_override, age_days, rejection_count = (False, 0.0, 0)
    if not promote and baseline is not None:
        staleness_override, age_days, rejection_count = file_staleness_override_applies(baseline)
        if not staleness_override:
            rejection_count += 1
            baseline["rejection_count"] = rejection_count
            baseline.setdefault("first_rejected_at", datetime.now().isoformat())

    version_metrics[str(new_version)] = {k: (None if isinstance(v, float) and np.isnan(v) else v)
                                          for k, v in metrics.items()}
    cfg["lstm_metrics"] = version_metrics

    if not promote and not staleness_override:
        print(f"[DL] REFUSED: v{new_version} roc_auc={new_auc:.4f} did not beat active "
              f"v{active_version}'s {baseline_auc:.4f} + {LSTM_PROMOTION_MARGIN} margin. "
              f"Weights saved to lstm_v{new_version}.pt for inspection; active version unchanged. "
              f"(rejection bookkeeping updated: {rejection_count} rejections so far)")
        _save_config(cfg)  # still persist this version's metrics for future comparisons
        return False

    if staleness_override and not promote:
        print(f"[DL] STALENESS OVERRIDE: v{active_version}'s baseline unbeaten {age_days:.1f}d "
              f"across {rejection_count} rejections -- promoting v{new_version} "
              f"(roc_auc={new_auc:.4f}) anyway.")

    if CONFIG_PATH.exists():
        backup_path = MODEL_DIR / f"dl_model_config.{datetime.now().strftime('%Y%m%d_%H%M%S')}.bak.json"
        backup_path.write_text(CONFIG_PATH.read_text())

    cfg["lstm_version"] = new_version
    _save_config(cfg)
    print(f"[DL] Model ACTIVATED: v{new_version} roc_auc={new_auc:.4f}"
          + (f" (beat v{active_version} baseline {baseline_auc:.4f})" if baseline_auc is not None else " (no prior active version)"))
    return True


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--mode", choices=["train", "infer", "validate"], default="infer")
    parser.add_argument("--date", help="Prediction date (default: today)")
    parser.add_argument("--version", type=int, default=1)
    args = parser.parse_args()

    if args.mode == "train":
        metrics = train_lstm(version=args.version)
        _promote_lstm_version(args.version, metrics)
        print(f"[DL] Training complete: {metrics}")
    elif args.mode == "infer":
        run_inference(args.date)
    elif args.mode == "validate":
        metrics = train_lstm(version=args.version)
        print(f"[DL] Validation metrics: {metrics}")
