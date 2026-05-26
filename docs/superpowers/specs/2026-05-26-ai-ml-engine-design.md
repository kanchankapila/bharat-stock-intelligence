# AI/ML Engine — Design Spec (Phases 1, 2, 4)
**Date:** 2026-05-26
**Status:** Approved
**Scope:** Feature Engineering Pipeline + BiLSTM+TFT Deep Learning + HMM Regime Detection

---

## Overview

A production-grade hybrid AI prediction engine added as a parallel layer to the existing Bharat Stock Intelligence platform. Three phases built together as one coherent system sharing a central feature store:

- **Phase 1:** Advanced Feature Engineering Pipeline — 60 engineered features per stock per day, all downstream models read from here
- **Phase 2:** Deep Learning Time-Series — BiLSTM + TFT models producing multi-horizon (1d/5d/15d) directional probabilities and expected returns
- **Phase 4:** HMM Regime Detection — 5-state market regime classifier that dynamically weights model ensemble and flags extreme conditions

All predictions write to a new `deep_learning_predictions` table. The existing `quant_scores`, `technical_signals`, and `stock_scores` tables are untouched. The DL layer is additive — existing system degrades gracefully if DL engine is down.

---

## Compute Requirements

- **GPU:** NVIDIA RTX 3060/4070 class (8–12GB VRAM)
- **LSTM training:** ~2GB VRAM, ~45 min for full history
- **TFT training:** ~6GB VRAM, ~3 hrs for full history
- **Daily inference:** ~8 min for 2,000 symbols on GPU
- **CPU fallback:** supported via PyTorch device detection (`cuda` if available else `cpu`)

---

## Data Layer

### New DB Tables (added to `src/server/db.ts`)

#### `feature_store`

Central feature cache — one row per `(symbol, date, timeframe)`. All ML models read exclusively from here.

```sql
CREATE TABLE feature_store (
  symbol          TEXT NOT NULL,
  date            TEXT NOT NULL,
  timeframe       TEXT NOT NULL DEFAULT 'D',
  -- Returns
  ret_1d REAL, ret_5d REAL, ret_15d REAL, ret_21d REAL,
  ret_63d REAL, ret_126d REAL, ret_252d REAL,
  -- Trend
  sma20 REAL, sma50 REAL, sma200 REAL, ema8 REAL, ema21 REAL,
  dist_sma20_pct REAL, dist_sma200_pct REAL, above_sma200 INTEGER,
  -- Momentum
  rsi_14 REAL, rsi_28 REAL,
  macd REAL, macd_signal REAL, macd_hist REAL,
  adx REAL, di_plus REAL, di_minus REAL,
  stoch_k REAL, stoch_d REAL, cci REAL, williams_r REAL,
  -- Volatility
  atr_14 REAL, atr_pct REAL,
  bb_upper REAL, bb_lower REAL, bb_width REAL, bb_pct REAL,
  hist_vol_21d REAL, hist_vol_63d REAL, vol_regime TEXT,
  -- Volume
  volume_ratio_20d REAL, volume_ratio_5d REAL,
  obv REAL, obv_slope REAL, vwap REAL, vwap_dist_pct REAL,
  -- Multi-timeframe alignment
  trend_1d TEXT, trend_1w TEXT, trend_1m TEXT, mtf_alignment_score REAL,
  -- Options
  pcr_oi REAL, pcr_vol REAL, iv_rank REAL, max_pain REAL,
  -- Institutional
  fii_3d_net REAL, fii_10d_net REAL, dii_3d_net REAL, delivery_pct REAL,
  -- Fundamentals (lagged 45 days)
  trailing_pe REAL, pb REAL, roe REAL, debt_to_equity REAL,
  op_margins REAL, rev_growth REAL, eps_growth REAL,
  piotroski_f REAL, earnings_yield REAL,
  -- India macro
  nifty_vix REAL, nifty_pe REAL, advance_decline_ratio REAL,
  nifty_ret_5d REAL, nifty_ret_21d REAL,
  -- Global macro (exogenous)
  us_10y_yield REAL, dxy REAL,
  crude_ret_5d REAL, gold_ret_5d REAL, sp500_ret_5d REAL,
  -- Sentiment
  news_sentiment_score REAL, news_impact_count INTEGER,
  -- Forward targets (NULL for future dates, filled post-facto for training)
  target_ret_1d REAL, target_ret_5d REAL, target_ret_15d REAL,
  target_dir_1d INTEGER, target_dir_5d INTEGER, target_dir_15d INTEGER,
  computed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (symbol, date, timeframe)
);
```

#### `deep_learning_predictions`

Parallel to existing scores — never overwrites existing tables.

```sql
CREATE TABLE deep_learning_predictions (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol          TEXT NOT NULL,
  prediction_date TEXT NOT NULL,
  model_name      TEXT NOT NULL,
  model_version   TEXT NOT NULL,
  prob_up_1d  REAL, prob_up_5d  REAL, prob_up_15d  REAL,
  prob_dn_1d  REAL, prob_dn_5d  REAL, prob_dn_15d  REAL,
  exp_ret_1d  REAL, exp_ret_5d  REAL, exp_ret_15d  REAL,
  confidence  REAL,
  uncertainty REAL,
  regime            TEXT,
  regime_confidence REAL,
  top_features_json TEXT,
  attention_json    TEXT,
  actual_ret_5d   REAL,
  actual_ret_15d  REAL,
  outcome_5d      TEXT,
  outcome_15d     TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(symbol, prediction_date, model_name)
);
```

#### `dl_model_performance`

Tracks accuracy over time and drift scores per model.

```sql
CREATE TABLE dl_model_performance (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  model_name    TEXT NOT NULL,
  model_version TEXT NOT NULL,
  eval_date     TEXT NOT NULL,
  horizon_days  INTEGER NOT NULL,
  directional_accuracy REAL,
  roc_auc       REAL,
  precision_up  REAL,
  recall_up     REAL,
  f1_score      REAL,
  sharpe_ratio  REAL,
  profit_factor REAL,
  sample_count  INTEGER,
  drift_score   REAL,
  retrain_triggered INTEGER DEFAULT 0,
  UNIQUE(model_name, eval_date, horizon_days)
);
```

#### `market_regimes`

Daily regime classification from HMM.

```sql
CREATE TABLE market_regimes (
  date            TEXT PRIMARY KEY,
  regime          TEXT NOT NULL,
  regime_prob     REAL,
  hmm_state       INTEGER,
  viterbi_path_json TEXT,
  features_json   TEXT,
  computed_at     DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

### Global Macro Data Ingestion

New script `global_macro_fetcher.py` runs daily via BullMQ, fetches via `yfinance`:

| Ticker | Field | Stored as |
|---|---|---|
| `^TNX` | US 10Y Treasury Yield | `us_10y_yield` |
| `DX-Y.NYB` | US Dollar Index | `dxy` |
| `CL=F` | Crude Oil Futures | `crude_ret_5d` |
| `GC=F` | Gold Futures | `gold_ret_5d` |
| `^GSPC` | S&P 500 | `sp500_ret_5d` |
| `^NSEBANK` | India VIX proxy | `nifty_vix` |

Writes to existing `macro_indicators` table. Feature engineering reads from there.

---

## Phase 1: Feature Engineering Pipeline

### File: `src/server/feature_engineering.py`

**Class:** `FeatureEngineer`  
**Entry point:** `run_full_pipeline(symbols=None, lookback_days=504)`

#### Feature Groups

| Group | Features | Source Table |
|---|---|---|
| Price/Returns | ret_1d → ret_252d, SMA 20/50/200, EMA 8/21, dist from SMAs | `stock_ohlcv` |
| Momentum | RSI(14,28), MACD(12,26,9), ADX(14), Stoch(14,3), CCI(20), Williams%R, ROC(5,10,21) | `stock_ohlcv` |
| Volatility | ATR(14) abs+%, BB(20,2) width+%B, hist vol 21d+63d, vol regime classifier | `stock_ohlcv` |
| Volume | Volume ratio vs 5d+20d avg, OBV+10d slope, VWAP+dist% | `stock_ohlcv` |
| Multi-timeframe | Trend per 1d/1w/1m (UP/DOWN/SIDEWAYS), MTF alignment score -1 to +1 | `stock_ohlcv` aggregated |
| Options | PCR OI, PCR volume, IV rank, max pain distance | `stock_options_oi` |
| Institutional | FII net 3d+10d, DII net 3d, delivery % | `fii_dii_flow`, `technical_signals` |
| Fundamentals | PE, PB, ROE, D/E, op margins, rev growth, EPS growth, Piotroski, earnings yield | `stock_fundamentals` |
| India macro | Nifty VIX, Nifty PE, A/D ratio, Nifty ret 5d+21d | `macro_indicators`, `nse_stocks` |
| Global macro | US 10Y, DXY, crude ret 5d, gold ret 5d, S&P500 ret 5d | `macro_indicators` |
| Sentiment | Avg news sentiment score 3d, HIGH-impact article count 5d | `news_sentiment_items` |

**Total features: ~75 raw numeric + one-hot encoded categoricals (vol_regime × 4, trend_1d/1w/1m × 3 each = ~84 model input dimensions)**

#### Data Leakage Prevention Rules

1. **Target forward shift only** — `target_ret_5d` at date T = return from T+1 close to T+6 close. Never computed from same-day or prior data.
2. **Fundamentals lagged 45 days** — earnings are announced ~45 days after quarter end. Feature at date T uses fundamentals reported before T-45.
3. **FII/DII lagged 1 day** — data published next morning; feature at date T uses T-1 flow data.
4. **Scaler fit on training window only** — RobustScaler fitted on first 80% of dates per symbol; transform applied to full dataset.

#### Normalization Strategy

| Feature Group | Method |
|---|---|
| Returns, ratios, momentum oscillators already bounded (RSI, %B) | Pass-through (already 0–100 range) |
| Unbounded returns, ATR, vol metrics | `RobustScaler` (median/IQR — robust to fat tails) |
| Volume ratios (heavy right skew) | `log1p` then `RobustScaler` |
| Categorical features (trend direction, vol regime) | One-hot encode |
| Macro + fundamental numerics | `RobustScaler` |

Scaler state serialized to `app_settings` key `dl_feature_scaler_v{version}` as JSON. Loaded at inference time to ensure consistent normalization.

#### Scale

~2,000 symbols × 500 trading days × 84 features ≈ 84M cells. Estimated SQLite size: ~1.1GB for `feature_store`. Acceptable — SQLite handles up to 140TB.

---

## Phase 2: Deep Learning Models

### File: `src/server/dl_engine.py`

Two models trained independently, both reading from `feature_store`.

#### Model A — BiLSTM (Fast inference, daily update)

```
Input:  (batch, sequence_len=60, n_features=84)

Architecture:
  BiLSTM(256 units) → Dropout(0.3)
  BiLSTM(128 units) → Dropout(0.3)
  Self-Attention over time steps → weighted hidden state sum
  Dense(64, ReLU) → BatchNorm

Output heads (multi-task):
  head_dir_1d:  Dense(2, Softmax)  → P(up), P(down) 1-day
  head_dir_5d:  Dense(2, Softmax)  → P(up), P(down) 5-day
  head_dir_15d: Dense(2, Softmax)  → P(up), P(down) 15-day
  head_ret_5d:  Dense(1, Linear)   → expected return % 5-day
  head_ret_15d: Dense(1, Linear)   → expected return % 15-day

Loss: direction_loss (CrossEntropy × 0.5) + return_loss (Huber δ=0.02 × 0.5)
Optimizer: AdamW, lr=1e-3, weight_decay=1e-4
Scheduler: CosineAnnealingLR (T_max=50 epochs)
Batch: 512 | Epochs: 100 | Early stop patience: 10
VRAM: ~2GB | Training time: ~45 min
```

#### Model B — TFT (Temporal Fusion Transformer, weekly retrain)

```
Library: pytorch-forecasting >= 1.0

Input categorization:
  time_varying_known_reals:    macro features (known for future dates)
  time_varying_unknown_reals:  price/volume/momentum features
  static_categoricals:         symbol (embedding), sector (embedding)
  static_reals:                piotroski_f, market_cap (stable fundamentals)

Architecture:
  Encoder: GRN (Gated Residual Network) per feature group
  Variable selection: learned soft attention weights per feature per timestep
  Multi-head self-attention: 4 heads over encoder outputs
  Decoder: GRN + cross-attention for each output horizon

Sequence: encoder_len=90 days, decoder_len=15 days
hidden_size: 128 | attention_head_size: 32 | dropout: 0.1

Output: quantile predictions [0.1, 0.25, 0.5, 0.75, 0.9]
        for horizons 1d, 5d, 15d simultaneously
        median (0.5) → point estimate; 0.1/0.9 → uncertainty bounds

Loss: QuantileLoss
Optimizer: AdamW, lr=1e-3 | Batch: 128 | Epochs: 50 | Early stop: 7
VRAM: ~6GB | Training time: ~3 hrs
```

#### Walk-Forward Validation (both models)

Expanding window, no random splits:

```
Fold 1: Train[1–300]   | Val[301–315]   | Test[316–330]
Fold 2: Train[1–330]   | Val[331–345]   | Test[346–360]
Fold N: Train[1–N×30]  | Val next 15d   | Test next 15d

Metrics per fold: directional accuracy, ROC-AUC, Sharpe of long-only signals
Final report: mean ± std across folds
Production model: trained on all data except last 30 days (held-out test set)
Minimum data: 252 trading days per symbol to qualify for DL training
```

#### Daily Inference Pipeline

```
3:30 PM IST: feature_engineering.py refreshes feature_store
4:30 PM IST: dl_engine.py --mode infer
  For each symbol (batched, 50/batch):
    1. Load last 90 days from feature_store
    2. Apply saved RobustScaler
    3. LSTM forward pass → direction probs × 3 horizons + expected returns
    4. TFT forward pass → quantile preds × 3 horizons
    5. Ensemble: weighted average (weights = each model's last 30d directional accuracy)
    6. Write to deep_learning_predictions (model_name = 'LSTM_TFT_ENSEMBLE')
Total inference: ~8 min for 2,000 symbols on RTX 3060
```

#### Model Artifact Storage

```
src/server/ml_models/
  lstm_v{N}.pt                   ← PyTorch state dict
  tft_v{N}.pt                    ← pytorch-forecasting checkpoint
  feature_scaler_v{N}.pkl        ← RobustScaler (inference use)
  dl_model_config.json           ← active versions, feature list, hyperparams
```

Version `N` increments on each successful retrain that beats quality gate.

---

## Phase 4: HMM Regime Detection

### File: `src/server/regime_detector.py`

```
Model: Gaussian HMM
Library: hmmlearn >= 0.3
n_components: 5 states
covariance_type: 'full'
n_iter: 200

Input features (market-level, 8 features):
  nifty_ret_21d_rolling     ← Nifty 21-day returns
  nifty_realized_vol_21d    ← Nifty realized volatility
  nifty_vix                 ← India VIX
  fii_5d_net_normalized     ← FII 5-day net flow
  advance_decline_ratio     ← Market breadth
  us_10y_yield_change_5d    ← US yield trend
  dxy_ret_5d                ← Dollar strength
  sp500_ret_5d              ← Global risk appetite

State labels (assigned post-training by inspecting emission means):
  State 0 → BULL      (positive returns, low vol, FII buying)
  State 1 → SIDEWAYS  (flat returns, low vol, mixed flows)
  State 2 → HIGH_VOL  (any return, elevated vol, VIX spike)
  State 3 → BEAR      (negative returns, rising vol, FII selling)
  State 4 → CRASH     (extreme negative, VIX > 25, large FII outflow)

Output: Viterbi sequence (most probable state path) + forward probabilities
Written daily to market_regimes table
Retrained: monthly (1st Sunday), minimum 252 days Nifty history
```

### Regime-Aware Ensemble Weighting

At inference time, regime modifies DL model blend:

| Regime | LSTM weight | TFT weight | Confidence modifier |
|---|---|---|---|
| BULL | 40% | 60% | ×1.0 |
| SIDEWAYS | 40% | 60% | ×1.0 |
| HIGH_VOL | 60% | 40% | ×0.85 |
| BEAR | 60% | 40% | ×0.85 |
| CRASH | 50% | 50% | ×0.50 + flag LOW_CONFIDENCE |

TFT is weighted higher in stable regimes (its variable selection and attention handle structured trends better). LSTM is more robust under distribution shift and elevated volatility.

---

## Drift Detection + Retraining

### File: `src/server/drift_detector.py`

**Layer 1 — Feature Drift (PSI)**
- Baseline: feature distributions from training window (10 equal-width bins per feature)
- Daily: compute PSI per feature against baseline
- `PSI > 0.20` on any feature → WARNING logged
- `PSI > 0.25` on >20% of features → CRITICAL → queue emergency retrain
- PSI formula: `Σ (actual_pct - expected_pct) × ln(actual_pct / expected_pct)`

**Layer 2 — Prediction Drift (accuracy degradation)**
- Baseline: directional accuracy on validation fold (set at training time, stored in `dl_model_performance`)
- Daily: compute rolling 30-day directional accuracy from resolved `outcome_5d` in `deep_learning_predictions`
- Accuracy drops >15% from baseline → queue emergency retrain
- Results written to `dl_model_performance.drift_score` daily

### File: `src/server/dl_trainer.py`

Unified retrain orchestrator:

```
retrain_models(trigger, models):
  1. Acquire lock (app_settings flag dl_retrain_running)
  2. Run feature_engineering.py --full
  3. Per model:
     a. Walk-forward validation on fresh feature_store
     b. Log metrics to dl_model_performance
     c. Quality gate: directional_accuracy > 0.50 AND roc_auc > 0.52
     d. If new model passes quality gate AND beats current model on held-out 30d:
          save as new version, update dl_model_config.json
        Else:
          retain current version, log warning
  4. Run regime_detector retrain if trigger='monthly'
  5. Release lock, update app_settings.dl_last_retrain
  6. Write entry to model_registry (existing table)

Failure handling:
  - Retrain failure: keep current model, log to dl_model_performance.error
  - Never deploy below quality gate (>50% directional accuracy, >0.52 AUC)
  - Concurrent retrain prevention via lock flag
```

---

## BullMQ Queues (additions to `src/server/queues.ts`)

| Constant | Queue Name | Cron (IST) | Cron (UTC) | Job |
|---|---|---|---|---|
| `QUEUE_DL_MACRO_FETCH` | `dl-macro-fetch` | 8:00 AM | 2:30 AM | `global_macro_fetcher.py` |
| `QUEUE_DL_FEATURE_REFRESH` | `dl-feature-refresh` | 3:30 PM | 10:00 AM | `feature_engineering.py --date today` |
| `QUEUE_DL_INFERENCE` | `dl-inference` | 4:30 PM | 11:00 AM | `dl_engine.py --mode infer` |
| `QUEUE_DL_REGIME_UPDATE` | `dl-regime-update` | 4:45 PM | 11:15 AM | `regime_detector.py --date today` |
| `QUEUE_DL_RETRAIN_WEEKLY` | `dl-retrain-weekly` | Sun 11:00 PM | Sun 17:30 | `dl_trainer.py --trigger scheduled` |
| `QUEUE_DL_RETRAIN_EMERGENCY` | `dl-retrain-emergency` | On drift alert | — | `dl_trainer.py --trigger drift` |

All queues follow existing pattern: exported Queue handle, Worker processor, registered in `initQueues()`.

---

## tRPC Procedures (additions to `src/server/router.ts`)

| Procedure | Input | Output | Notes |
|---|---|---|---|
| `getDLPredictions` | `{ symbols?: string[], date?: string }` | Array of DL predictions with regime | Defaults to latest date, all symbols |
| `getDLModelPerformance` | `{ model?: string, days?: number }` | Accuracy trends + drift scores | Default 30 days |
| `getMarketRegime` | `{ date?: string }` | Regime + state probabilities | Default today |
| `getDLPredictionHistory` | `{ symbol: string, horizon: 5\|15 }` | Past predictions + outcomes | For performance tracking |

---

## Frontend Integration

### `HedgeFundResearch.tsx` additions

`TopPicksTable` gains two new columns:
- **DL Prob↑** — TFT+LSTM ensemble `prob_up_5d` (color-coded: green >0.65, yellow 0.50–0.65, red <0.50)
- **Regime** — HMM regime badge from `market_regimes`

`StockDeepDive` gains **"AI Model Signals"** section:
- Three horizon tabs: 1D / 5D / 15D
- Per tab: direction probability bar, expected return %, uncertainty range
- Top 5 features from `top_features_json` with SHAP values
- TFT attention pattern as a small heatmap (time × feature weights from `attention_json`)

### New route: `/deep-learning`

Sub-tab under Research:
- Model performance chart (rolling 30d directional accuracy per model)
- Drift score timeline (PSI per day)
- Regime history chart (state transitions as colored segments)
- Model vs baseline comparison table

---

## Python Dependencies (`requirements.txt` additions)

```
torch>=2.2.0
pytorch-forecasting>=1.0.0
pytorch-lightning>=2.2.0
hmmlearn>=0.3.0
shap>=0.45.0
ta>=0.11.0
```

`scikit-learn`, `yfinance` already present.

---

## Non-Goals (explicitly excluded from this spec)

- CNN chart pattern recognition (Phase 3 — separate spec)
- Advanced RL — PPO/DQN (Phase 5 — separate spec)
- GNN market relationships (Phase 6 — separate spec)
- LLM social sentiment (Phase 7 — separate spec)
- Intraday (15m) model training — daily only in this phase
- Real-time streaming inference — batch daily only
- GPU cluster / multi-GPU training

---

## Complete File Changelist

| File | Change |
|---|---|
| `src/server/db.ts` | Add 4 tables: `feature_store`, `deep_learning_predictions`, `dl_model_performance`, `market_regimes` |
| `src/server/global_macro_fetcher.py` | **New** — yfinance macro data fetcher |
| `src/server/feature_engineering.py` | **New** — 60-feature pipeline, leakage prevention, RobustScaler |
| `src/server/dl_engine.py` | **New** — BiLSTM + TFT models, walk-forward validation, batch inference |
| `src/server/regime_detector.py` | **New** — 5-state Gaussian HMM, Viterbi, regime-weighted ensemble |
| `src/server/drift_detector.py` | **New** — PSI feature drift + accuracy drift, retrain triggers |
| `src/server/dl_trainer.py` | **New** — retrain orchestrator, quality gates, model versioning |
| `src/server/queues.ts` | Add 6 new queues + workers + register in `initQueues()` |
| `src/server/router.ts` | Add 4 tRPC procedures |
| `src/components/HedgeFundResearch.tsx` | Add DL columns, AI signals section, attention heatmap |
| `src/App.tsx` | Add `/deep-learning` sub-route |
| `requirements.txt` | Add torch, pytorch-forecasting, pytorch-lightning, hmmlearn, shap, ta |
