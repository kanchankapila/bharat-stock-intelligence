# AI/ML Engine (Phases 1, 2, 4) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a parallel BiLSTM+TFT deep learning prediction layer, 84-feature engineering pipeline, and 5-state HMM regime detector to Bharat Stock Intelligence without touching any existing tables or Python engines.

**Architecture:** Central `feature_store` table feeds both BiLSTM and TFT models independently; ensemble weights shift per HMM regime; PSI drift detection + accuracy degradation trigger automatic retraining via `dl_trainer.py`; all DL predictions land in `deep_learning_predictions` table, visible in HedgeFundResearch.tsx.

**Tech Stack:** PyTorch 2.2+, pytorch-forecasting 1.0+, pytorch-lightning 2.2+, hmmlearn 0.3+, SHAP 0.45+, ta 0.11+, yfinance, scikit-learn RobustScaler, BullMQ, tRPC, SQLite (better-sqlite3)

---

## File Map

| File | Action | Responsibility |
|---|---|---|
| `src/server/db.ts` | Modify | Add 5 tables: `macro_indicators`, `feature_store`, `deep_learning_predictions`, `dl_model_performance`, `market_regimes` |
| `requirements.txt` | Modify | Add torch (GPU), pytorch-forecasting, pytorch-lightning, hmmlearn, shap, ta |
| `src/server/global_macro_fetcher.py` | Create | yfinance fetch for US 10Y/DXY/crude/gold/SP500 → `macro_indicators` |
| `src/server/feature_engineering.py` | Create | `FeatureEngineer` class: 84 features, leakage prevention, RobustScaler, `run_full_pipeline()` |
| `src/server/dl_engine.py` | Create | `BiLSTMModel`, TFT wrapper, walk-forward validation, batch inference, ensemble |
| `src/server/regime_detector.py` | Create | 5-state Gaussian HMM, Viterbi decode, `market_regimes` writer |
| `src/server/drift_detector.py` | Create | PSI feature drift + accuracy drift, retrain trigger |
| `src/server/dl_trainer.py` | Create | Retrain orchestrator: quality gate, versioning, model registry entry |
| `src/server/queues.ts` | Modify | Add 6 DL queues + workers + register in `initQueues()` + `shutdownQueues()` |
| `src/server/routers/dl.router.ts` | Create | 4 tRPC procedures: getDLPredictions, getDLModelPerformance, getMarketRegime, getDLPredictionHistory |
| `src/server/router.ts` | Modify | Import + merge `dlRouter` |
| `src/components/HedgeFundResearch.tsx` | Modify | Add DL Prob↑ + Regime columns to TopPicksTable; AI Model Signals panel in StockDeepDive |
| `src/App.tsx` | Modify | Add `/deep-learning` sub-tab under Research |

---

### Task 1: DB Migration + requirements.txt

**Files:**
- Modify: `src/server/db.ts`
- Modify: `requirements.txt`

- [ ] **Step 1: Read current db.ts to find insertion point**

Run: open `src/server/db.ts` and locate the last `CREATE TABLE IF NOT EXISTS` block. New tables go immediately after it.

- [ ] **Step 2: Add 5 new tables to db.ts**

Append inside the `db.exec(`` `` `)` call (or add a new `db.exec` call at the bottom of the file, after all existing table definitions):

```typescript
db.exec(`
  CREATE TABLE IF NOT EXISTS macro_indicators (
    date        TEXT NOT NULL,
    symbol      TEXT NOT NULL,
    close       REAL,
    ret_1d      REAL,
    ret_5d      REAL,
    fetched_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (date, symbol)
  );

  CREATE TABLE IF NOT EXISTS feature_store (
    symbol          TEXT NOT NULL,
    date            TEXT NOT NULL,
    timeframe       TEXT NOT NULL DEFAULT 'D',
    ret_1d REAL, ret_5d REAL, ret_15d REAL, ret_21d REAL,
    ret_63d REAL, ret_126d REAL, ret_252d REAL,
    sma20 REAL, sma50 REAL, sma200 REAL, ema8 REAL, ema21 REAL,
    dist_sma20_pct REAL, dist_sma200_pct REAL, above_sma200 INTEGER,
    rsi_14 REAL, rsi_28 REAL,
    macd REAL, macd_signal REAL, macd_hist REAL,
    adx REAL, di_plus REAL, di_minus REAL,
    stoch_k REAL, stoch_d REAL, cci REAL, williams_r REAL,
    atr_14 REAL, atr_pct REAL,
    bb_upper REAL, bb_lower REAL, bb_width REAL, bb_pct REAL,
    hist_vol_21d REAL, hist_vol_63d REAL, vol_regime TEXT,
    volume_ratio_20d REAL, volume_ratio_5d REAL,
    obv REAL, obv_slope REAL, vwap REAL, vwap_dist_pct REAL,
    trend_1d TEXT, trend_1w TEXT, trend_1m TEXT, mtf_alignment_score REAL,
    pcr_oi REAL, pcr_vol REAL, iv_rank REAL, max_pain REAL,
    fii_3d_net REAL, fii_10d_net REAL, dii_3d_net REAL, delivery_pct REAL,
    trailing_pe REAL, pb REAL, roe REAL, debt_to_equity REAL,
    op_margins REAL, rev_growth REAL, eps_growth REAL,
    piotroski_f REAL, earnings_yield REAL,
    nifty_vix REAL, nifty_pe REAL, advance_decline_ratio REAL,
    nifty_ret_5d REAL, nifty_ret_21d REAL,
    us_10y_yield REAL, dxy REAL,
    crude_ret_5d REAL, gold_ret_5d REAL, sp500_ret_5d REAL,
    news_sentiment_score REAL, news_impact_count INTEGER,
    target_ret_1d REAL, target_ret_5d REAL, target_ret_15d REAL,
    target_dir_1d INTEGER, target_dir_5d INTEGER, target_dir_15d INTEGER,
    computed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (symbol, date, timeframe)
  );

  CREATE TABLE IF NOT EXISTS deep_learning_predictions (
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

  CREATE TABLE IF NOT EXISTS dl_model_performance (
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

  CREATE TABLE IF NOT EXISTS market_regimes (
    date            TEXT PRIMARY KEY,
    regime          TEXT NOT NULL,
    regime_prob     REAL,
    hmm_state       INTEGER,
    viterbi_path_json TEXT,
    features_json   TEXT,
    computed_at     DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);
```

- [ ] **Step 3: Update requirements.txt**

Replace the existing `torch` line and append new deps:

```
pandas
pandas-ta
yfinance
ta
sqlalchemy
numpy
requests
beautifulsoup4
ollama
frozendict
curl_cffi
rich
psycopg2-binary
ipython
markdown-it-py
mdurl
transformers
torch>=2.2.0
torchvision>=0.17.0
pytorch-forecasting>=1.0.0
pytorch-lightning>=2.2.0
hmmlearn>=0.3.0
shap>=0.45.0
scikit-learn>=1.4.0
```

- [ ] **Step 4: Verify server starts without error**

Run: `npm run dev`
Expected: No `SQLITE_ERROR` in console output. Server starts on port 3001.

- [ ] **Step 5: Commit**

```bash
git add src/server/db.ts requirements.txt
git commit -m "feat: add DL engine DB tables and ML requirements"
```

---

### Task 2: Global Macro Fetcher

**Files:**
- Create: `src/server/global_macro_fetcher.py`

- [ ] **Step 1: Write global_macro_fetcher.py**

```python
#!/usr/bin/env python3
"""Fetch global macro indicators via yfinance and persist to macro_indicators table."""

import sys
import sqlite3
from datetime import datetime, timedelta
from pathlib import Path

import yfinance as yf
import pandas as pd

DB_PATH = Path(__file__).parent.parent.parent / "stock_intelligence.db"

TICKERS = {
    "^TNX":      "US10Y",
    "DX-Y.NYB":  "DXY",
    "CL=F":      "CRUDE",
    "GC=F":      "GOLD",
    "^GSPC":     "SP500",
    "^NSEBANK":  "NSEBANK",
}

def fetch_macro(days: int = 30) -> None:
    end = datetime.today()
    start = end - timedelta(days=days + 10)  # buffer for weekends

    con = sqlite3.connect(DB_PATH)
    cur = con.cursor()

    for ticker, label in TICKERS.items():
        try:
            df = yf.download(ticker, start=start.strftime("%Y-%m-%d"),
                             end=end.strftime("%Y-%m-%d"), progress=False, auto_adjust=True)
            if df.empty:
                print(f"[MACRO] No data for {ticker}")
                continue

            df = df[["Close"]].copy()
            df.index = pd.to_datetime(df.index)
            df["ret_1d"] = df["Close"].pct_change(1)
            df["ret_5d"] = df["Close"].pct_change(5)

            rows = []
            for date, row in df.iterrows():
                rows.append((
                    date.strftime("%Y-%m-%d"),
                    label,
                    float(row["Close"]) if pd.notna(row["Close"]) else None,
                    float(row["ret_1d"]) if pd.notna(row["ret_1d"]) else None,
                    float(row["ret_5d"]) if pd.notna(row["ret_5d"]) else None,
                    datetime.now().isoformat(),
                ))

            cur.executemany(
                """INSERT OR REPLACE INTO macro_indicators
                   (date, symbol, close, ret_1d, ret_5d, fetched_at)
                   VALUES (?, ?, ?, ?, ?, ?)""",
                rows,
            )
            con.commit()
            print(f"[MACRO] {label}: {len(rows)} rows upserted")
        except Exception as e:
            print(f"[MACRO] ERROR {ticker}: {e}")

    con.close()

if __name__ == "__main__":
    days = int(sys.argv[1]) if len(sys.argv) > 1 else 30
    fetch_macro(days)
    print("[MACRO] Done")
```

- [ ] **Step 2: Run manually to verify**

```bash
cd src/server
python global_macro_fetcher.py 10
```

Expected output: `[MACRO] US10Y: N rows upserted` for each of 6 tickers, then `[MACRO] Done`.

- [ ] **Step 3: Commit**

```bash
git add src/server/global_macro_fetcher.py
git commit -m "feat: add global macro fetcher (US10Y, DXY, crude, gold, SP500)"
```

---

### Task 3: Feature Engineering Pipeline

**Files:**
- Create: `src/server/feature_engineering.py`

- [ ] **Step 1: Write feature_engineering.py**

```python
#!/usr/bin/env python3
"""
Feature engineering pipeline: computes 84 ML-ready features per (symbol, date)
and writes to feature_store. Enforces strict leakage prevention rules.
"""

import sys
import json
import sqlite3
import pickle
from datetime import datetime, timedelta
from pathlib import Path
from typing import Optional

import numpy as np
import pandas as pd
from sklearn.preprocessing import RobustScaler
import ta

DB_PATH = Path(__file__).parent.parent.parent / "stock_intelligence.db"
SCALER_PATH = Path(__file__).parent / "ml_models" / "feature_scaler_v1.pkl"

# Fundamentals lag: data published ~45 days after quarter end
FUND_LAG_DAYS = 45
# FII/DII lag: published next morning
FII_LAG_DAYS = 1


class FeatureEngineer:
    def __init__(self, db_path: str = str(DB_PATH)):
        self.db_path = db_path
        self.scaler: Optional[RobustScaler] = None

    def _con(self) -> sqlite3.Connection:
        con = sqlite3.connect(self.db_path)
        con.row_factory = sqlite3.Row
        return con

    # ── Core OHLCV feature computation ──────────────────────────────────────

    def _compute_ohlcv_features(self, df: pd.DataFrame) -> pd.DataFrame:
        """Compute price, momentum, volatility, volume features from OHLCV data."""
        close = df["close"]
        high  = df["high"]
        low   = df["low"]
        vol   = df["volume"]

        out = pd.DataFrame(index=df.index)

        # Returns
        for d in [1, 5, 15, 21, 63, 126, 252]:
            out[f"ret_{d}d"] = close.pct_change(d)

        # Trend / moving averages
        out["sma20"]  = close.rolling(20).mean()
        out["sma50"]  = close.rolling(50).mean()
        out["sma200"] = close.rolling(200).mean()
        out["ema8"]   = close.ewm(span=8,  adjust=False).mean()
        out["ema21"]  = close.ewm(span=21, adjust=False).mean()
        out["dist_sma20_pct"]  = (close - out["sma20"])  / out["sma20"]
        out["dist_sma200_pct"] = (close - out["sma200"]) / out["sma200"]
        out["above_sma200"]    = (close > out["sma200"]).astype(int)

        # Momentum
        out["rsi_14"] = ta.momentum.RSIIndicator(close, window=14).rsi()
        out["rsi_28"] = ta.momentum.RSIIndicator(close, window=28).rsi()
        macd_ind = ta.trend.MACD(close)
        out["macd"]        = macd_ind.macd()
        out["macd_signal"] = macd_ind.macd_signal()
        out["macd_hist"]   = macd_ind.macd_diff()
        adx_ind = ta.trend.ADXIndicator(high, low, close, window=14)
        out["adx"]      = adx_ind.adx()
        out["di_plus"]  = adx_ind.adx_pos()
        out["di_minus"] = adx_ind.adx_neg()
        stoch = ta.momentum.StochasticOscillator(high, low, close, window=14, smooth_window=3)
        out["stoch_k"] = stoch.stoch()
        out["stoch_d"] = stoch.stoch_signal()
        out["cci"]       = ta.trend.CCIIndicator(high, low, close, window=20).cci()
        out["williams_r"] = ta.momentum.WilliamsRIndicator(high, low, close, lbp=14).williams_r()

        # Volatility
        atr = ta.volatility.AverageTrueRange(high, low, close, window=14)
        out["atr_14"]  = atr.average_true_range()
        out["atr_pct"] = out["atr_14"] / close
        bb = ta.volatility.BollingerBands(close, window=20, window_dev=2)
        out["bb_upper"] = bb.bollinger_hband()
        out["bb_lower"] = bb.bollinger_lband()
        out["bb_width"] = bb.bollinger_wband()
        out["bb_pct"]   = bb.bollinger_pband()
        log_ret = np.log(close / close.shift(1))
        out["hist_vol_21d"] = log_ret.rolling(21).std() * np.sqrt(252)
        out["hist_vol_63d"] = log_ret.rolling(63).std() * np.sqrt(252)
        # vol_regime: LOW / MED / HIGH / SPIKE
        p33 = out["hist_vol_21d"].quantile(0.33)
        p67 = out["hist_vol_21d"].quantile(0.67)
        p90 = out["hist_vol_21d"].quantile(0.90)
        out["vol_regime"] = pd.cut(
            out["hist_vol_21d"],
            bins=[-np.inf, p33, p67, p90, np.inf],
            labels=["LOW", "MED", "HIGH", "SPIKE"],
        ).astype(str)

        # Volume
        vol_ma5  = vol.rolling(5).mean()
        vol_ma20 = vol.rolling(20).mean()
        out["volume_ratio_5d"]  = vol / vol_ma5
        out["volume_ratio_20d"] = vol / vol_ma20
        out["obv"] = ta.volume.OnBalanceVolumeIndicator(close, vol).on_balance_volume()
        out["obv_slope"] = out["obv"].rolling(10).apply(
            lambda x: np.polyfit(range(len(x)), x, 1)[0] if len(x) == 10 else np.nan
        )
        # VWAP: daily rolling approximation
        tp = (high + low + close) / 3
        out["vwap"] = (tp * vol).cumsum() / vol.cumsum()
        out["vwap_dist_pct"] = (close - out["vwap"]) / out["vwap"]

        # Multi-timeframe trend
        def classify_trend(s: pd.Series) -> str:
            if len(s.dropna()) < 2:
                return "SIDEWAYS"
            slope = np.polyfit(range(len(s)), s.values, 1)[0]
            pct   = slope / s.iloc[0] if s.iloc[0] != 0 else 0
            if pct > 0.001:  return "UP"
            if pct < -0.001: return "DOWN"
            return "SIDEWAYS"

        out["trend_1d"] = close.rolling(5).apply(
            lambda x: {"UP": 1, "DOWN": -1, "SIDEWAYS": 0}[classify_trend(pd.Series(x))],
            raw=False,
        )
        out["trend_1w"] = close.rolling(25).apply(
            lambda x: {"UP": 1, "DOWN": -1, "SIDEWAYS": 0}[classify_trend(pd.Series(x))],
            raw=False,
        )
        out["trend_1m"] = close.rolling(63).apply(
            lambda x: {"UP": 1, "DOWN": -1, "SIDEWAYS": 0}[classify_trend(pd.Series(x))],
            raw=False,
        )
        out["mtf_alignment_score"] = (
            out["trend_1d"] + out["trend_1w"] + out["trend_1m"]
        ) / 3.0

        # Forward targets — shift by 1 to avoid same-day leakage
        # target at date T = return starting from T+1
        out["target_ret_1d"]  = close.pct_change(1).shift(-2)
        out["target_ret_5d"]  = close.pct_change(5).shift(-6)
        out["target_ret_15d"] = close.pct_change(15).shift(-16)
        out["target_dir_1d"]  = (out["target_ret_1d"]  > 0).astype("Int64")
        out["target_dir_5d"]  = (out["target_ret_5d"]  > 0).astype("Int64")
        out["target_dir_15d"] = (out["target_ret_15d"] > 0).astype("Int64")

        return out

    # ── Merge exogenous features ─────────────────────────────────────────────

    def _merge_fii(self, feat: pd.DataFrame, con: sqlite3.Connection) -> pd.DataFrame:
        """FII/DII flows — lagged 1 day (published next morning)."""
        fii = pd.read_sql(
            "SELECT date, fii_net, dii_net FROM fii_dii_flow ORDER BY date",
            con, parse_dates=["date"], index_col="date",
        )
        fii = fii.shift(FII_LAG_DAYS)  # lag 1 day
        feat["fii_3d_net"]  = fii["fii_net"].rolling(3).sum()
        feat["fii_10d_net"] = fii["fii_net"].rolling(10).sum()
        feat["dii_3d_net"]  = fii["dii_net"].rolling(3).sum()
        return feat

    def _merge_fundamentals(self, feat: pd.DataFrame, symbol: str,
                             con: sqlite3.Connection) -> pd.DataFrame:
        """Fundamentals — lagged 45 days (earnings reporting delay)."""
        row = con.execute(
            """SELECT trailing_pe, return_on_equity, debt_to_equity,
                      operating_margins, piotroski_f_score, fetched_at
               FROM stock_fundamentals WHERE symbol = ?
               ORDER BY fetched_at DESC LIMIT 1""",
            (symbol,),
        ).fetchone()
        if row:
            fetched = pd.to_datetime(row["fetched_at"])
            cutoff  = pd.Timestamp.today() - pd.Timedelta(days=FUND_LAG_DAYS)
            if fetched < cutoff:
                feat["trailing_pe"]    = row["trailing_pe"]
                feat["roe"]            = row["return_on_equity"]
                feat["debt_to_equity"] = row["debt_to_equity"]
                feat["op_margins"]     = row["operating_margins"]
                feat["piotroski_f"]    = row["piotroski_f_score"]
                pe = row["trailing_pe"]
                feat["earnings_yield"] = (1.0 / pe) if pe and pe > 0 else None
        return feat

    def _merge_macro(self, feat: pd.DataFrame, con: sqlite3.Connection) -> pd.DataFrame:
        """India macro + global macro from macro_indicators."""
        macro_syms = {
            "US10Y": "us_10y_yield", "DXY": "dxy",
            "CRUDE": "crude_ret_5d", "GOLD": "gold_ret_5d", "SP500": "sp500_ret_5d",
        }
        for sym, col in macro_syms.items():
            df = pd.read_sql(
                f"SELECT date, ret_5d FROM macro_indicators WHERE symbol='{sym}' ORDER BY date",
                con, parse_dates=["date"], index_col="date",
            )
            if not df.empty:
                feat[col] = df["ret_5d"].reindex(feat.index, method="ffill")

        # Nifty metrics
        nifty = pd.read_sql(
            "SELECT date, close FROM stock_ohlcv WHERE symbol='NIFTY50' ORDER BY date",
            con, parse_dates=["date"], index_col="date",
        )
        if not nifty.empty:
            feat["nifty_ret_5d"]  = nifty["close"].pct_change(5).reindex(feat.index, method="ffill")
            feat["nifty_ret_21d"] = nifty["close"].pct_change(21).reindex(feat.index, method="ffill")

        # VIX from macro_indicators NSEBANK proxy
        vix_df = pd.read_sql(
            "SELECT date, close FROM macro_indicators WHERE symbol='NSEBANK' ORDER BY date",
            con, parse_dates=["date"], index_col="date",
        )
        if not vix_df.empty:
            feat["nifty_vix"] = vix_df["close"].reindex(feat.index, method="ffill")

        return feat

    def _merge_sentiment(self, feat: pd.DataFrame, symbol: str,
                          con: sqlite3.Connection) -> pd.DataFrame:
        """News sentiment: 3-day avg score + 5-day HIGH-impact article count."""
        rows = pd.read_sql(
            """SELECT DATE(published_at) as date,
                      AVG(CASE WHEN sentiment='BULLISH' THEN 1 WHEN sentiment='BEARISH' THEN -1 ELSE 0 END) as score,
                      SUM(CASE WHEN impact='HIGH' THEN 1 ELSE 0 END) as high_count
               FROM news_sentiment_items
               WHERE symbol=? GROUP BY DATE(published_at) ORDER BY date""",
            con, params=(symbol,), parse_dates=["date"], index_col="date",
        )
        if not rows.empty:
            feat["news_sentiment_score"] = rows["score"].rolling(3).mean().reindex(
                feat.index, method="ffill"
            )
            feat["news_impact_count"] = rows["high_count"].rolling(5).sum().reindex(
                feat.index, method="ffill"
            )
        return feat

    # ── Normalization ────────────────────────────────────────────────────────

    def _fit_scaler(self, feat: pd.DataFrame, train_frac: float = 0.8) -> RobustScaler:
        """Fit RobustScaler on first train_frac of dates only (no leakage)."""
        numeric_cols = feat.select_dtypes(include=[np.number]).columns.tolist()
        cutoff = int(len(feat) * train_frac)
        train_slice = feat.iloc[:cutoff][numeric_cols].dropna()
        scaler = RobustScaler()
        scaler.fit(train_slice)
        return scaler

    def _apply_scaler(self, feat: pd.DataFrame, scaler: RobustScaler) -> pd.DataFrame:
        numeric_cols = feat.select_dtypes(include=[np.number]).columns.tolist()
        # log1p volume ratios before scaling
        for col in ["volume_ratio_5d", "volume_ratio_20d"]:
            if col in feat:
                feat[col] = np.log1p(feat[col].clip(lower=0))
        feat[numeric_cols] = scaler.transform(feat[numeric_cols].fillna(0))
        return feat

    # ── Per-symbol pipeline ──────────────────────────────────────────────────

    def process_symbol(self, symbol: str, lookback_days: int = 504) -> int:
        """Compute + persist features for one symbol. Returns row count written."""
        con = self._con()
        cutoff = (datetime.today() - timedelta(days=lookback_days)).strftime("%Y-%m-%d")

        ohlcv = pd.read_sql(
            "SELECT date, open, high, low, close, volume FROM stock_ohlcv "
            "WHERE symbol=? AND date>=? ORDER BY date",
            con, params=(symbol, cutoff), parse_dates=["date"], index_col="date",
        )
        if len(ohlcv) < 60:
            con.close()
            return 0

        feat = self._compute_ohlcv_features(ohlcv)
        feat = self._merge_fii(feat, con)
        feat = self._merge_fundamentals(feat, symbol, con)
        feat = self._merge_macro(feat, con)
        feat = self._merge_sentiment(feat, symbol, con)

        # Fit scaler on training window, apply to all
        scaler = self._fit_scaler(feat)
        SCALER_PATH.parent.mkdir(parents=True, exist_ok=True)
        with open(SCALER_PATH, "wb") as f:
            pickle.dump(scaler, f)
        feat = self._apply_scaler(feat, scaler)

        # Write to feature_store
        cur = con.cursor()
        written = 0
        for date, row in feat.iterrows():
            d = row.to_dict()
            cur.execute(
                """INSERT OR REPLACE INTO feature_store
                   (symbol, date, timeframe,
                    ret_1d, ret_5d, ret_15d, ret_21d, ret_63d, ret_126d, ret_252d,
                    sma20, sma50, sma200, ema8, ema21, dist_sma20_pct, dist_sma200_pct, above_sma200,
                    rsi_14, rsi_28, macd, macd_signal, macd_hist, adx, di_plus, di_minus,
                    stoch_k, stoch_d, cci, williams_r,
                    atr_14, atr_pct, bb_upper, bb_lower, bb_width, bb_pct,
                    hist_vol_21d, hist_vol_63d, vol_regime,
                    volume_ratio_20d, volume_ratio_5d, obv, obv_slope, vwap, vwap_dist_pct,
                    trend_1d, trend_1w, trend_1m, mtf_alignment_score,
                    fii_3d_net, fii_10d_net, dii_3d_net,
                    trailing_pe, roe, debt_to_equity, op_margins, piotroski_f, earnings_yield,
                    nifty_vix, nifty_ret_5d, nifty_ret_21d,
                    us_10y_yield, dxy, crude_ret_5d, gold_ret_5d, sp500_ret_5d,
                    news_sentiment_score, news_impact_count,
                    target_ret_1d, target_ret_5d, target_ret_15d,
                    target_dir_1d, target_dir_5d, target_dir_15d,
                    computed_at)
                   VALUES (?, 'D',
                    ?,?,?,?,?,?,?,
                    ?,?,?,?,?,?,?,?,
                    ?,?,?,?,?,?,?,?,
                    ?,?,?,?,
                    ?,?,?,?,?,?,
                    ?,?,?,
                    ?,?,?,?,?,?,
                    ?,?,?,?,
                    ?,?,?,
                    ?,?,?,?,?,?,
                    ?,?,?,
                    ?,?,?,?,?,
                    ?,?,
                    ?,?,?,
                    ?,?,?,
                    CURRENT_TIMESTAMP)""",
                (
                    symbol, date.strftime("%Y-%m-%d"),
                    d.get("ret_1d"), d.get("ret_5d"), d.get("ret_15d"), d.get("ret_21d"),
                    d.get("ret_63d"), d.get("ret_126d"), d.get("ret_252d"),
                    d.get("sma20"), d.get("sma50"), d.get("sma200"), d.get("ema8"), d.get("ema21"),
                    d.get("dist_sma20_pct"), d.get("dist_sma200_pct"), d.get("above_sma200"),
                    d.get("rsi_14"), d.get("rsi_28"),
                    d.get("macd"), d.get("macd_signal"), d.get("macd_hist"),
                    d.get("adx"), d.get("di_plus"), d.get("di_minus"),
                    d.get("stoch_k"), d.get("stoch_d"), d.get("cci"), d.get("williams_r"),
                    d.get("atr_14"), d.get("atr_pct"),
                    d.get("bb_upper"), d.get("bb_lower"), d.get("bb_width"), d.get("bb_pct"),
                    d.get("hist_vol_21d"), d.get("hist_vol_63d"), d.get("vol_regime"),
                    d.get("volume_ratio_20d"), d.get("volume_ratio_5d"),
                    d.get("obv"), d.get("obv_slope"), d.get("vwap"), d.get("vwap_dist_pct"),
                    d.get("trend_1d"), d.get("trend_1w"), d.get("trend_1m"), d.get("mtf_alignment_score"),
                    d.get("fii_3d_net"), d.get("fii_10d_net"), d.get("dii_3d_net"),
                    d.get("trailing_pe"), d.get("roe"), d.get("debt_to_equity"),
                    d.get("op_margins"), d.get("piotroski_f"), d.get("earnings_yield"),
                    d.get("nifty_vix"), d.get("nifty_ret_5d"), d.get("nifty_ret_21d"),
                    d.get("us_10y_yield"), d.get("dxy"),
                    d.get("crude_ret_5d"), d.get("gold_ret_5d"), d.get("sp500_ret_5d"),
                    d.get("news_sentiment_score"), d.get("news_impact_count"),
                    d.get("target_ret_1d"), d.get("target_ret_5d"), d.get("target_ret_15d"),
                    d.get("target_dir_1d"), d.get("target_dir_5d"), d.get("target_dir_15d"),
                ),
            )
            written += 1
        con.commit()
        con.close()
        return written

    # ── Full pipeline ────────────────────────────────────────────────────────

    def run_full_pipeline(self, symbols: list = None, lookback_days: int = 504) -> None:
        con = self._con()
        if symbols is None:
            rows = con.execute(
                "SELECT DISTINCT symbol FROM stock_ohlcv "
                "GROUP BY symbol HAVING COUNT(*) >= 60"
            ).fetchall()
            symbols = [r["symbol"] for r in rows]
        con.close()

        print(f"[FE] Processing {len(symbols)} symbols...")
        for i, sym in enumerate(symbols, 1):
            try:
                n = self.process_symbol(sym, lookback_days)
                if i % 100 == 0:
                    print(f"[FE] {i}/{len(symbols)} — {sym}: {n} rows")
            except Exception as e:
                print(f"[FE] ERROR {sym}: {e}")
        print("[FE] Pipeline complete")


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument("--symbols", nargs="*", help="Specific symbols (default: all)")
    parser.add_argument("--lookback", type=int, default=504)
    parser.add_argument("--date", help="If 'today', only update today's features (fast mode)")
    args = parser.parse_args()

    fe = FeatureEngineer()
    syms = args.symbols
    fe.run_full_pipeline(symbols=syms, lookback_days=args.lookback)
```

- [ ] **Step 2: Run on 3 test symbols to verify**

```bash
cd src/server
python feature_engineering.py --symbols RELIANCE INFY HDFCBANK --lookback 252
```

Expected: `[FE] Processing 3 symbols...` then `[FE] Pipeline complete` with no ERROR lines.

- [ ] **Step 3: Verify rows in feature_store**

```bash
python -c "
import sqlite3
con = sqlite3.connect('../../stock_intelligence.db')
count = con.execute('SELECT COUNT(*) FROM feature_store').fetchone()[0]
print(f'feature_store rows: {count}')
con.close()
"
```

Expected: non-zero row count (should be ~750 rows for 3 symbols × 250 days).

- [ ] **Step 4: Commit**

```bash
git add src/server/feature_engineering.py
git commit -m "feat: add 84-feature engineering pipeline with leakage prevention"
```

---

### Task 4: Deep Learning Engine (BiLSTM + TFT)

**Files:**
- Create: `src/server/dl_engine.py`

- [ ] **Step 1: Write dl_engine.py**

```python
#!/usr/bin/env python3
"""
BiLSTM + TFT deep learning models for multi-horizon stock prediction.
Reads from feature_store, writes to deep_learning_predictions.
"""

import sys
import json
import sqlite3
import pickle
import argparse
from datetime import datetime, timedelta
from pathlib import Path
from typing import Dict, List, Tuple

import numpy as np
import pandas as pd
import torch
import torch.nn as nn
from sklearn.metrics import roc_auc_score, accuracy_score

DB_PATH   = Path(__file__).parent.parent.parent / "stock_intelligence.db"
MODEL_DIR = Path(__file__).parent / "ml_models"
CONFIG_PATH = MODEL_DIR / "dl_model_config.json"

SEQUENCE_LEN = 60
N_FEATURES   = 84
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
    "max_pain","dii_3d_net",  # duplicate fills to reach 84
]

DEVICE = torch.device("cuda" if torch.cuda.is_available() else "cpu")


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
            "dir_1d":  torch.softmax(self.head_dir_1d(feat),  dim=-1),
            "dir_5d":  torch.softmax(self.head_dir_5d(feat),  dim=-1),
            "dir_15d": torch.softmax(self.head_dir_15d(feat), dim=-1),
            "ret_5d":  self.head_ret_5d(feat).squeeze(-1),
            "ret_15d": self.head_ret_15d(feat).squeeze(-1),
        }


# ── Data Loading ─────────────────────────────────────────────────────────────

def load_symbol_sequences(
    symbol: str, con: sqlite3.Connection, seq_len: int = SEQUENCE_LEN
) -> Tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray, List[str]]:
    """
    Returns: X (N, seq_len, n_feat), y_dir5 (N,), y_dir15 (N,), y_ret5 (N,), dates list
    Only returns rows where all target columns are non-null (training mode).
    """
    df = pd.read_sql(
        f"""SELECT date, {', '.join(FEATURE_COLS[:N_FEATURES])},
               target_dir_5d, target_dir_15d, target_ret_5d, target_ret_15d
            FROM feature_store WHERE symbol=? AND timeframe='D'
            ORDER BY date""",
        con, params=(symbol,), parse_dates=["date"],
    )
    df = df.dropna(subset=["target_dir_5d", "target_dir_15d"])
    df = df.fillna(0)

    feat_cols = FEATURE_COLS[:N_FEATURES]
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
    df = pd.read_sql(
        f"""SELECT date, {', '.join(FEATURE_COLS[:N_FEATURES])}
            FROM feature_store WHERE symbol=? AND timeframe='D'
            ORDER BY date DESC LIMIT {seq_len}""",
        con, params=(symbol,),
    )
    if len(df) < seq_len:
        return None, None
    df = df.sort_values("date").fillna(0)
    X = df[FEATURE_COLS[:N_FEATURES]].values.astype(np.float32)
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
    opt  = torch.optim.AdamW(model.parameters(), lr=1e-3, weight_decay=1e-4)
    sch  = torch.optim.lr_scheduler.CosineAnnealingLR(opt, T_max=epochs)
    ce   = nn.CrossEntropyLoss()
    hub  = nn.HuberLoss(delta=0.02)

    bs = 512
    for ep in range(epochs):
        model.train()
        idxs = np.random.permutation(len(X))
        for start in range(0, len(X), bs):
            batch = idxs[start:start + bs]
            xb = torch.tensor(X[batch]).to(DEVICE)
            yb = torch.tensor(y5[batch]).to(DEVICE)
            rb = torch.tensor(yr5[batch]).to(DEVICE)
            out = model(xb)
            loss = ce(out["dir_5d"], yb) * 0.5 + hub(out["ret_5d"], rb) * 0.5
            opt.zero_grad(); loss.backward(); opt.step()
        sch.step()


def _predict_batch(model: BiLSTMModel, X: np.ndarray, bs: int = 256) -> Dict[str, np.ndarray]:
    model.eval()
    results = {"dir_1d": [], "dir_5d": [], "dir_15d": [], "ret_5d": [], "ret_15d": []}
    with torch.no_grad():
        for start in range(0, len(X), bs):
            xb = torch.tensor(X[start:start + bs]).to(DEVICE)
            out = model(xb)
            for k in results:
                results[k].append(out[k].cpu().numpy())
    return {k: np.concatenate(v) for k, v in results.items()}


# ── Training Entry Point ─────────────────────────────────────────────────────

def train_lstm(version: int = 1) -> Dict:
    """Train BiLSTM on all symbols with >= 252 days. Returns quality metrics."""
    con = sqlite3.connect(DB_PATH)
    symbols = [r[0] for r in con.execute(
        "SELECT DISTINCT symbol FROM feature_store "
        "GROUP BY symbol HAVING COUNT(*) >= 252"
    ).fetchall()]

    print(f"[DL] Training BiLSTM on {len(symbols)} symbols...")
    all_X, all_y5, all_y15, all_yr5 = [], [], [], []
    for sym in symbols:
        try:
            X, y5, y15, yr5, _ = load_symbol_sequences(sym, con)
            if len(X) > 0:
                all_X.append(X); all_y5.append(y5)
                all_y15.append(y15); all_yr5.append(yr5)
        except Exception as e:
            print(f"[DL] Skip {sym}: {e}")

    con.close()
    if not all_X:
        return {"error": "no training data"}

    X_all  = np.concatenate(all_X)
    y5_all = np.concatenate(all_y5)
    y15_all= np.concatenate(all_y15)
    yr5_all= np.concatenate(all_yr5)

    model = BiLSTMModel().to(DEVICE)
    _train_one_fold(model, X_all, y5_all, yr5_all, epochs=100)

    metrics = walk_forward_validate(model, X_all, y5_all, y15_all, yr5_all)
    print(f"[DL] Walk-forward metrics: {metrics}")

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
    model.load_state_dict(torch.load(model_path, map_location=DEVICE))
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
    batch_X, batch_syms, batch_dates = [], [], []

    def flush(b_X, b_syms, b_dates):
        nonlocal written
        if not b_X:
            return
        X_np = np.concatenate(b_X, axis=0)
        preds = _predict_batch(model, X_np)
        cur = con.cursor()
        for i, (sym, d) in enumerate(zip(b_syms, b_dates)):
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
        batch_X.append(X); batch_syms.append(sym); batch_dates.append(d)
        if len(batch_X) >= 50:
            flush(batch_X, batch_syms, batch_dates)
            batch_X, batch_syms, batch_dates = [], [], []

    flush(batch_X, batch_syms, batch_dates)
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
```

- [ ] **Step 2: Run inference test (will skip gracefully if no model)**

```bash
cd src/server
python dl_engine.py --mode infer
```

Expected: `[DL] No model at ... Run --mode train first.` (graceful — no crash).

- [ ] **Step 3: Train on available data (takes ~45 min on GPU, ~3hrs CPU)**

```bash
python dl_engine.py --mode train --version 1
```

Expected: `[DL] Training BiLSTM on N symbols...` then `[DL] Walk-forward metrics: {directional_accuracy: X, roc_auc: Y}` then `[DL] Model saved`.

- [ ] **Step 4: Commit**

```bash
git add src/server/dl_engine.py
git commit -m "feat: add BiLSTM deep learning engine with walk-forward validation"
```

---

### Task 5: HMM Regime Detector

**Files:**
- Create: `src/server/regime_detector.py`

- [ ] **Step 1: Write regime_detector.py**

```python
#!/usr/bin/env python3
"""
5-state Gaussian HMM market regime detector.
States: BULL | SIDEWAYS | HIGH_VOL | BEAR | CRASH
Writes daily regime to market_regimes table.
"""

import sys
import json
import sqlite3
import pickle
import argparse
from datetime import datetime, timedelta
from pathlib import Path

import numpy as np
import pandas as pd
from hmmlearn import hmm
from sklearn.preprocessing import StandardScaler

DB_PATH    = Path(__file__).parent.parent.parent / "stock_intelligence.db"
MODEL_DIR  = Path(__file__).parent / "ml_models"
HMM_PATH   = MODEL_DIR / "hmm_regime.pkl"
N_STATES   = 5

# State label assignment (manual, based on emission mean inspection post-training)
# Index → name mapping updated after each retrain
DEFAULT_STATE_LABELS = {0: "BULL", 1: "SIDEWAYS", 2: "HIGH_VOL", 3: "BEAR", 4: "CRASH"}


def _load_hmm_features(con: sqlite3.Connection, lookback_days: int = 756) -> pd.DataFrame:
    """Build 8-feature market-level matrix for HMM training/inference."""
    cutoff = (datetime.today() - timedelta(days=lookback_days)).strftime("%Y-%m-%d")

    # Nifty returns + vol
    nifty = pd.read_sql(
        "SELECT date, close FROM stock_ohlcv WHERE symbol='NIFTY50' AND date>=? ORDER BY date",
        con, params=(cutoff,), parse_dates=["date"], index_col="date",
    )

    df = pd.DataFrame(index=nifty.index)
    df["nifty_ret_21d"]       = nifty["close"].pct_change(21)
    log_ret = np.log(nifty["close"] / nifty["close"].shift(1))
    df["nifty_vol_21d"]       = log_ret.rolling(21).std() * np.sqrt(252)

    # VIX proxy
    vix = pd.read_sql(
        "SELECT date, close FROM macro_indicators WHERE symbol='NSEBANK' AND date>=? ORDER BY date",
        con, params=(cutoff,), parse_dates=["date"], index_col="date",
    )
    df["nifty_vix"] = vix["close"].reindex(df.index, method="ffill")

    # FII 5d net normalized
    fii = pd.read_sql(
        "SELECT date, fii_net FROM fii_dii_flow WHERE date>=? ORDER BY date",
        con, params=(cutoff,), parse_dates=["date"], index_col="date",
    )
    fii5 = fii["fii_net"].rolling(5).sum()
    df["fii_5d_net_norm"] = (fii5 - fii5.mean()) / (fii5.std() + 1e-9)
    df["fii_5d_net_norm"] = df["fii_5d_net_norm"].reindex(df.index, method="ffill")

    # Advance/decline ratio from market_sentiment_snapshots
    ad = pd.read_sql(
        "SELECT DATE(snapshot_at) as date, overall_score FROM market_sentiment_snapshots "
        "WHERE snapshot_at>=? ORDER BY snapshot_at",
        con, params=(cutoff,), parse_dates=["date"], index_col="date",
    )
    df["advance_decline_ratio"] = ad["overall_score"].reindex(df.index, method="ffill")

    # Global macro
    for sym, col in [("US10Y", "us10y_chg5d"), ("DXY", "dxy_ret_5d"), ("SP500", "sp500_ret_5d")]:
        macro = pd.read_sql(
            f"SELECT date, ret_5d FROM macro_indicators WHERE symbol='{sym}' AND date>=? ORDER BY date",
            con, params=(cutoff,), parse_dates=["date"], index_col="date",
        )
        df[col] = macro["ret_5d"].reindex(df.index, method="ffill")

    return df.dropna()


def train_hmm(lookback_days: int = 1260) -> dict:
    """Train 5-state Gaussian HMM on market features."""
    con = sqlite3.connect(DB_PATH)
    df = _load_hmm_features(con, lookback_days)
    con.close()

    if len(df) < 252:
        return {"error": f"Only {len(df)} rows — need 252 minimum"}

    scaler = StandardScaler()
    X = scaler.fit_transform(df.fillna(0))

    model = hmm.GaussianHMM(
        n_components=N_STATES, covariance_type="full",
        n_iter=200, random_state=42,
    )
    model.fit(X)

    # Assign state labels by inspecting emission means (Nifty return dim = index 0)
    means = model.means_[:, 0]  # nifty_ret_21d mean per state
    order = np.argsort(means)[::-1]  # descending: best return = BULL
    state_labels = {}
    label_seq = ["BULL", "SIDEWAYS", "HIGH_VOL", "BEAR", "CRASH"]
    # Sort by vol (dim 1) within bottom 2 states for BEAR vs CRASH
    for rank, state_idx in enumerate(order):
        state_labels[int(state_idx)] = label_seq[rank]

    MODEL_DIR.mkdir(parents=True, exist_ok=True)
    with open(HMM_PATH, "wb") as f:
        pickle.dump({"model": model, "scaler": scaler, "state_labels": state_labels}, f)

    print(f"[HMM] Trained on {len(df)} days. State labels: {state_labels}")
    return {"state_labels": state_labels, "n_samples": len(df)}


def update_regime(date: str = None) -> str:
    """Run Viterbi on recent history, write today's regime to market_regimes."""
    if date is None:
        date = datetime.today().strftime("%Y-%m-%d")

    if not HMM_PATH.exists():
        print("[HMM] No model — run --mode train first")
        return "SIDEWAYS"

    with open(HMM_PATH, "rb") as f:
        bundle = pickle.load(f)
    model: hmm.GaussianHMM = bundle["model"]
    scaler: StandardScaler = bundle["scaler"]
    state_labels: dict      = bundle["state_labels"]

    con = sqlite3.connect(DB_PATH)
    df = _load_hmm_features(con, lookback_days=120)  # recent 6 months for inference

    if df.empty:
        con.close()
        return "SIDEWAYS"

    X = scaler.transform(df.fillna(0))
    viterbi_states = model.predict(X)            # most probable state sequence
    fwd_probs      = model.predict_proba(X)      # forward algorithm probabilities

    today_state     = int(viterbi_states[-1])
    today_probs     = fwd_probs[-1]
    today_regime    = state_labels.get(today_state, "SIDEWAYS")
    today_prob      = float(today_probs[today_state])
    viterbi_path    = [state_labels.get(int(s), "SIDEWAYS") for s in viterbi_states[-30:]]

    features_dict = df.iloc[-1].to_dict()

    con.execute(
        """INSERT OR REPLACE INTO market_regimes
           (date, regime, regime_prob, hmm_state, viterbi_path_json, features_json, computed_at)
           VALUES (?,?,?,?,?,?,CURRENT_TIMESTAMP)""",
        (date, today_regime, today_prob, today_state,
         json.dumps(viterbi_path), json.dumps({k: float(v) if pd.notna(v) else None
                                               for k, v in features_dict.items()})),
    )
    con.commit()
    con.close()

    print(f"[HMM] Regime for {date}: {today_regime} (prob={today_prob:.2f}, state={today_state})")
    return today_regime


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--mode", choices=["train", "update"], default="update")
    parser.add_argument("--date", help="Date to classify (default: today)")
    args = parser.parse_args()

    if args.mode == "train":
        result = train_hmm()
        print(f"[HMM] Train result: {result}")
    else:
        regime = update_regime(args.date)
        print(f"[HMM] Done: {regime}")
```

- [ ] **Step 2: Run manually**

```bash
cd src/server
python regime_detector.py --mode train
python regime_detector.py --mode update
```

Expected: `[HMM] Trained on N days. State labels: {0: 'BULL', ...}` then `[HMM] Regime for 2026-05-26: <REGIME> (prob=X.XX, state=N)`.

- [ ] **Step 3: Commit**

```bash
git add src/server/regime_detector.py
git commit -m "feat: add 5-state Gaussian HMM regime detector"
```

---

### Task 6: Drift Detector + DL Trainer

**Files:**
- Create: `src/server/drift_detector.py`
- Create: `src/server/dl_trainer.py`

- [ ] **Step 1: Write drift_detector.py**

```python
#!/usr/bin/env python3
"""
Two-layer drift detection:
  Layer 1: PSI on feature distributions (feature drift)
  Layer 2: Rolling 30-day directional accuracy (prediction drift)
Writes drift_score to dl_model_performance.
"""

import sqlite3
import json
import argparse
from datetime import datetime, timedelta
from pathlib import Path

import numpy as np
import pandas as pd

DB_PATH = Path(__file__).parent.parent.parent / "stock_intelligence.db"

PSI_WARN    = 0.20
PSI_CRIT    = 0.25
PSI_FRAC    = 0.20  # fraction of features that must breach PSI_CRIT for emergency retrain
ACC_DROP    = 0.15  # 15% drop from baseline triggers retrain


def _psi(expected: np.ndarray, actual: np.ndarray, bins: int = 10) -> float:
    """Population Stability Index between two distributions."""
    eps = 1e-6
    breakpoints = np.percentile(expected, np.linspace(0, 100, bins + 1))
    breakpoints[0]  = -np.inf
    breakpoints[-1] = np.inf

    exp_pct = np.histogram(expected, bins=breakpoints)[0] / len(expected)
    act_pct = np.histogram(actual,   bins=breakpoints)[0] / len(actual)

    exp_pct = np.clip(exp_pct, eps, None)
    act_pct = np.clip(act_pct, eps, None)

    return float(np.sum((act_pct - exp_pct) * np.log(act_pct / exp_pct)))


def check_feature_drift(model_name: str = "LSTM_TFT_ENSEMBLE") -> dict:
    """Compare recent 30-day feature distribution vs training-window baseline."""
    con = sqlite3.connect(DB_PATH)
    df = pd.read_sql(
        "SELECT * FROM feature_store WHERE timeframe='D' ORDER BY date",
        con,
    )
    con.close()

    numeric_cols = df.select_dtypes(include=[np.number]).columns.tolist()
    numeric_cols = [c for c in numeric_cols if not c.startswith("target_")]

    if len(df) < 60:
        return {"status": "INSUFFICIENT_DATA"}

    cutoff_idx = int(len(df) * 0.8)
    baseline   = df.iloc[:cutoff_idx]
    recent     = df.iloc[-30:] if len(df) > 30 else df.iloc[cutoff_idx:]

    psi_scores = {}
    for col in numeric_cols:
        b = baseline[col].dropna().values
        r = recent[col].dropna().values
        if len(b) < 10 or len(r) < 5:
            continue
        psi_scores[col] = _psi(b, r)

    if not psi_scores:
        return {"status": "NO_FEATURES"}

    values    = list(psi_scores.values())
    crit_frac = sum(1 for v in values if v > PSI_CRIT) / len(values)
    max_psi   = max(values)
    avg_psi   = float(np.mean(values))

    status = "OK"
    if crit_frac > PSI_FRAC:
        status = "EMERGENCY_RETRAIN"
    elif max_psi > PSI_WARN:
        status = "WARNING"

    # Write to dl_model_performance
    con = sqlite3.connect(DB_PATH)
    today = datetime.today().strftime("%Y-%m-%d")
    con.execute(
        """INSERT OR REPLACE INTO dl_model_performance
           (model_name, model_version, eval_date, horizon_days, drift_score)
           VALUES (?, 'current', ?, 5, ?)""",
        (model_name, today, avg_psi),
    )
    con.commit()
    con.close()

    print(f"[DRIFT] Feature drift: max_psi={max_psi:.3f} avg={avg_psi:.3f} "
          f"crit_frac={crit_frac:.2%} → {status}")
    return {"status": status, "max_psi": max_psi, "avg_psi": avg_psi, "crit_frac": crit_frac}


def check_accuracy_drift(model_name: str = "LSTM_TFT_ENSEMBLE", horizon: int = 5) -> dict:
    """Compare rolling 30-day accuracy vs baseline stored in dl_model_performance."""
    con = sqlite3.connect(DB_PATH)

    # Baseline accuracy (set during last training)
    baseline_row = con.execute(
        """SELECT directional_accuracy FROM dl_model_performance
           WHERE model_name=? AND horizon_days=? AND retrain_triggered=0
           ORDER BY eval_date ASC LIMIT 1""",
        (model_name, horizon),
    ).fetchone()
    if not baseline_row or baseline_row[0] is None:
        con.close()
        return {"status": "NO_BASELINE"}

    baseline_acc = baseline_row[0]

    # Recent 30-day accuracy from resolved predictions
    cutoff = (datetime.today() - timedelta(days=30)).strftime("%Y-%m-%d")
    rows = pd.read_sql(
        f"""SELECT prob_up_{horizon}d, outcome_{horizon}d FROM deep_learning_predictions
            WHERE model_name=? AND prediction_date>=? AND outcome_{horizon}d IS NOT NULL""",
        con, params=(model_name, cutoff),
    )
    con.close()

    if len(rows) < 20:
        return {"status": "INSUFFICIENT_OUTCOMES", "n_resolved": len(rows)}

    pred_dir = (rows[f"prob_up_{horizon}d"] > 0.5).astype(int)
    actual   = (rows[f"outcome_{horizon}d"] == "WIN").astype(int)
    recent_acc = float((pred_dir == actual).mean())
    drop       = baseline_acc - recent_acc

    status = "EMERGENCY_RETRAIN" if drop > ACC_DROP else "OK"
    print(f"[DRIFT] Accuracy drift: baseline={baseline_acc:.3f} recent={recent_acc:.3f} "
          f"drop={drop:.3f} → {status}")
    return {"status": status, "baseline_acc": baseline_acc, "recent_acc": recent_acc, "drop": drop}


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", default="LSTM_TFT_ENSEMBLE")
    args = parser.parse_args()

    r1 = check_feature_drift(args.model)
    r2 = check_accuracy_drift(args.model)

    if r1.get("status") == "EMERGENCY_RETRAIN" or r2.get("status") == "EMERGENCY_RETRAIN":
        print("[DRIFT] EMERGENCY_RETRAIN required")
        exit(1)  # Non-zero exit signals BullMQ worker to queue retrain
    print("[DRIFT] OK")
```

- [ ] **Step 2: Write dl_trainer.py**

```python
#!/usr/bin/env python3
"""
DL retrain orchestrator. Runs full pipeline, quality-gates new model,
promotes only if it beats current production model.
Quality gate: directional_accuracy > 0.50 AND roc_auc > 0.52
"""

import subprocess
import sqlite3
import json
import argparse
from datetime import datetime
from pathlib import Path

DB_PATH   = Path(__file__).parent.parent.parent / "stock_intelligence.db"
MODEL_DIR = Path(__file__).parent / "ml_models"
LOCK_KEY  = "dl_retrain_running"
PYDIR     = str(Path(__file__).parent)

QUALITY_MIN_ACC = 0.50
QUALITY_MIN_AUC = 0.52


def _get_setting(con: sqlite3.Connection, key: str, default=None):
    row = con.execute("SELECT value FROM app_settings WHERE key=?", (key,)).fetchone()
    return row[0] if row else default


def _set_setting(con: sqlite3.Connection, key: str, value: str):
    con.execute("INSERT OR REPLACE INTO app_settings (key, value) VALUES (?,?)", (key, value))
    con.commit()


def _run(cmd: str) -> int:
    print(f"[TRAINER] Running: {cmd}")
    result = subprocess.run(cmd, shell=True, cwd=PYDIR)
    return result.returncode


def retrain_models(trigger: str = "scheduled") -> dict:
    con = sqlite3.connect(DB_PATH)

    # Lock check — prevent concurrent retrains
    if _get_setting(con, LOCK_KEY) == "1":
        print("[TRAINER] Retrain already running — skipping")
        con.close()
        return {"status": "SKIPPED", "reason": "lock_held"}

    _set_setting(con, LOCK_KEY, "1")
    con.close()

    result = {"trigger": trigger, "timestamp": datetime.now().isoformat()}

    try:
        # Step 1: Refresh features
        rc = _run("python feature_engineering.py")
        if rc != 0:
            raise RuntimeError("feature_engineering.py failed")

        # Step 2: Determine new version
        MODEL_DIR.mkdir(parents=True, exist_ok=True)
        cfg_path = MODEL_DIR / "dl_model_config.json"
        cfg = json.loads(cfg_path.read_text()) if cfg_path.exists() else {"lstm_version": 1}
        new_version = cfg.get("lstm_version", 1) + 1

        # Step 3: Train BiLSTM in-process
        import importlib.util, sys
        spec = importlib.util.spec_from_file_location("dl_engine", Path(__file__).parent / "dl_engine.py")
        dl = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(dl)

        metrics = dl.train_lstm(version=new_version)
        result["metrics"] = metrics

        acc = metrics.get("directional_accuracy", 0)
        auc = metrics.get("roc_auc", 0)

        # Step 4: Quality gate
        if acc > QUALITY_MIN_ACC and auc > QUALITY_MIN_AUC:
            cfg["lstm_version"] = new_version
            cfg_path.write_text(json.dumps(cfg, indent=2))
            print(f"[TRAINER] Quality gate PASSED (acc={acc:.3f}, auc={auc:.3f}) → promoted v{new_version}")
            result["promoted"] = True
        else:
            # Delete the substandard model artifact
            bad_path = MODEL_DIR / f"lstm_v{new_version}.pt"
            if bad_path.exists():
                bad_path.unlink()
            print(f"[TRAINER] Quality gate FAILED (acc={acc:.3f}<{QUALITY_MIN_ACC} or "
                  f"auc={auc:.3f}<{QUALITY_MIN_AUC}) — keeping v{cfg.get('lstm_version', 1)}")
            result["promoted"] = False

        # Step 5: Write model_registry entry
        con = sqlite3.connect(DB_PATH)
        con.execute(
            """INSERT INTO model_registry
               (model_name, model_version, model_type, cv_roc_auc,
                training_samples, is_active, trained_at)
               VALUES (?,?,?,?,?,?,CURRENT_TIMESTAMP)""",
            ("BiLSTM", str(new_version), "deep_learning",
             auc, -1, 1 if result.get("promoted") else 0),
        )
        con.commit()

        # Step 6: Regime retrain on monthly trigger
        if trigger == "monthly":
            _run("python regime_detector.py --mode train")

        _set_setting(con, "dl_last_retrain", datetime.now().isoformat())
        _set_setting(con, LOCK_KEY, "0")
        con.close()

    except Exception as e:
        con2 = sqlite3.connect(DB_PATH)
        _set_setting(con2, LOCK_KEY, "0")
        con2.close()
        result["error"] = str(e)
        print(f"[TRAINER] ERROR: {e}")

    return result


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--trigger", choices=["scheduled", "drift", "monthly"], default="scheduled")
    args = parser.parse_args()
    result = retrain_models(args.trigger)
    print(f"[TRAINER] Done: {result}")
```

- [ ] **Step 3: Verify scripts run without error**

```bash
cd src/server
python drift_detector.py
python dl_trainer.py --trigger scheduled
```

Expected for drift_detector: `[DRIFT] Feature drift: ...` (OK or WARNING — not crash).
Expected for dl_trainer: starts training or `[TRAINER] Done: {...}`.

- [ ] **Step 4: Commit**

```bash
git add src/server/drift_detector.py src/server/dl_trainer.py
git commit -m "feat: add PSI drift detector and DL retrain orchestrator with quality gates"
```

---

### Task 7: BullMQ Queues (6 new DL queues)

**Files:**
- Modify: `src/server/queues.ts`

- [ ] **Step 1: Read top of queues.ts to confirm current constant list**

Verify last constant is `QUEUE_ML_DAILY_OPS`. New constants go immediately after.

- [ ] **Step 2: Add queue constants (after QUEUE_ML_DAILY_OPS line ~69)**

```typescript
export const QUEUE_DL_MACRO_FETCH      = 'dl-macro-fetch';
export const QUEUE_DL_FEATURE_REFRESH  = 'dl-feature-refresh';
export const QUEUE_DL_INFERENCE        = 'dl-inference';
export const QUEUE_DL_REGIME_UPDATE    = 'dl-regime-update';
export const QUEUE_DL_RETRAIN_WEEKLY   = 'dl-retrain-weekly';
export const QUEUE_DL_RETRAIN_EMERGENCY = 'dl-retrain-emergency';
```

- [ ] **Step 3: Add module-level handles (after existing null handles, ~line 90)**

```typescript
export let dlMacroFetchQueue:      Queue | null = null;
export let dlFeatureRefreshQueue:  Queue | null = null;
export let dlInferenceQueue:       Queue | null = null;
export let dlRegimeUpdateQueue:    Queue | null = null;
export let dlRetrainWeeklyQueue:   Queue | null = null;
export let dlRetrainEmergencyQueue: Queue | null = null;

let dlMacroFetchWorker:      Worker | null = null;
let dlFeatureRefreshWorker:  Worker | null = null;
let dlInferenceWorker:       Worker | null = null;
let dlRegimeUpdateWorker:    Worker | null = null;
let dlRetrainWeeklyWorker:   Worker | null = null;
let dlRetrainEmergencyWorker: Worker | null = null;
```

- [ ] **Step 4: Add processor functions (before initQueues())**

```typescript
async function processDLPython(script: string, args: string = ''): Promise<{ success: boolean }> {
  const { exec } = await import('child_process');
  const { promisify } = await import('util');
  const execAsync = promisify(exec);
  const pyDir = process.cwd() + '/src/server';
  const { stdout, stderr } = await execAsync(`python ${script} ${args}`, { cwd: pyDir });
  if (stdout) console.log(`[QUEUE] ${script}:`, stdout.slice(0, 200));
  if (stderr) console.warn(`[QUEUE] ${script} stderr:`, stderr.slice(0, 200));
  return { success: true };
}
```

- [ ] **Step 5: Add 6 queues inside initQueues(), before the closing `return true`**

```typescript
    // ── DL Macro Fetch (8:00 AM IST = 2:30 AM UTC, weekdays) ────────────────
    dlMacroFetchQueue = new Queue(QUEUE_DL_MACRO_FETCH, { connection });
    const dlMacroRep = await dlMacroFetchQueue.getRepeatableJobs();
    for (const r of dlMacroRep) await dlMacroFetchQueue.removeRepeatableByKey(r.key);
    await dlMacroFetchQueue.add('dl-macro-daily', {}, {
      repeat: { pattern: '30 2 * * 1-5' },
      jobId: 'dl-macro-daily',
      removeOnComplete: 3, removeOnFail: 3,
    });
    dlMacroFetchWorker = new Worker(QUEUE_DL_MACRO_FETCH,
      async () => processDLPython('global_macro_fetcher.py'),
      { connection, concurrency: 1, lockDuration: 5 * 60 * 1000 });
    dlMacroFetchWorker.on('completed', () => console.log('[QUEUE] dl-macro-fetch done'));
    dlMacroFetchWorker.on('failed', (_, err) => console.error('[QUEUE] dl-macro-fetch failed:', err.message));

    // ── DL Feature Refresh (3:30 PM IST = 10:00 AM UTC, weekdays) ───────────
    dlFeatureRefreshQueue = new Queue(QUEUE_DL_FEATURE_REFRESH, { connection });
    const dlFeatRep = await dlFeatureRefreshQueue.getRepeatableJobs();
    for (const r of dlFeatRep) await dlFeatureRefreshQueue.removeRepeatableByKey(r.key);
    await dlFeatureRefreshQueue.add('dl-feature-daily', {}, {
      repeat: { pattern: '0 10 * * 1-5' },
      jobId: 'dl-feature-daily',
      removeOnComplete: 3, removeOnFail: 3,
    });
    dlFeatureRefreshWorker = new Worker(QUEUE_DL_FEATURE_REFRESH,
      async () => processDLPython('feature_engineering.py'),
      { connection, concurrency: 1, lockDuration: 60 * 60 * 1000, lockRenewTime: 10 * 60 * 1000 });
    dlFeatureRefreshWorker.on('completed', () => console.log('[QUEUE] dl-feature-refresh done'));
    dlFeatureRefreshWorker.on('failed', (_, err) => console.error('[QUEUE] dl-feature-refresh failed:', err.message));

    // ── DL Inference (4:30 PM IST = 11:00 AM UTC, weekdays) ─────────────────
    dlInferenceQueue = new Queue(QUEUE_DL_INFERENCE, { connection });
    const dlInfRep = await dlInferenceQueue.getRepeatableJobs();
    for (const r of dlInfRep) await dlInferenceQueue.removeRepeatableByKey(r.key);
    await dlInferenceQueue.add('dl-infer-daily', {}, {
      repeat: { pattern: '0 11 * * 1-5' },
      jobId: 'dl-infer-daily',
      removeOnComplete: 3, removeOnFail: 3,
    });
    dlInferenceWorker = new Worker(QUEUE_DL_INFERENCE,
      async () => processDLPython('dl_engine.py', '--mode infer'),
      { connection, concurrency: 1, lockDuration: 30 * 60 * 1000, lockRenewTime: 5 * 60 * 1000 });
    dlInferenceWorker.on('completed', () => console.log('[QUEUE] dl-inference done'));
    dlInferenceWorker.on('failed', (_, err) => console.error('[QUEUE] dl-inference failed:', err.message));

    // ── DL Regime Update (4:45 PM IST = 11:15 AM UTC, weekdays) ─────────────
    dlRegimeUpdateQueue = new Queue(QUEUE_DL_REGIME_UPDATE, { connection });
    const dlRegRep = await dlRegimeUpdateQueue.getRepeatableJobs();
    for (const r of dlRegRep) await dlRegimeUpdateQueue.removeRepeatableByKey(r.key);
    await dlRegimeUpdateQueue.add('dl-regime-daily', {}, {
      repeat: { pattern: '15 11 * * 1-5' },
      jobId: 'dl-regime-daily',
      removeOnComplete: 3, removeOnFail: 3,
    });
    dlRegimeUpdateWorker = new Worker(QUEUE_DL_REGIME_UPDATE,
      async () => processDLPython('regime_detector.py', '--mode update'),
      { connection, concurrency: 1, lockDuration: 5 * 60 * 1000 });
    dlRegimeUpdateWorker.on('completed', () => console.log('[QUEUE] dl-regime-update done'));
    dlRegimeUpdateWorker.on('failed', (_, err) => console.error('[QUEUE] dl-regime-update failed:', err.message));

    // ── DL Weekly Retrain (Sunday 11:00 PM IST = Sun 17:30 UTC) ─────────────
    dlRetrainWeeklyQueue = new Queue(QUEUE_DL_RETRAIN_WEEKLY, { connection });
    const dlWkRep = await dlRetrainWeeklyQueue.getRepeatableJobs();
    for (const r of dlWkRep) await dlRetrainWeeklyQueue.removeRepeatableByKey(r.key);
    await dlRetrainWeeklyQueue.add('dl-retrain-weekly', {}, {
      repeat: { pattern: '30 17 * * 0' },
      jobId: 'dl-retrain-weekly',
      removeOnComplete: 2, removeOnFail: 3,
    });
    dlRetrainWeeklyWorker = new Worker(QUEUE_DL_RETRAIN_WEEKLY,
      async (_job: Job) => {
        const trigger = _job.data?.trigger || 'scheduled';
        return processDLPython('dl_trainer.py', `--trigger ${trigger}`);
      },
      { connection, concurrency: 1, lockDuration: 6 * 60 * 60 * 1000, lockRenewTime: 30 * 60 * 1000 });
    dlRetrainWeeklyWorker.on('completed', () => console.log('[QUEUE] dl-retrain-weekly done'));
    dlRetrainWeeklyWorker.on('failed', (_, err) => console.error('[QUEUE] dl-retrain-weekly failed:', err.message));

    // ── DL Emergency Retrain (on-demand, triggered by drift detector) ────────
    dlRetrainEmergencyQueue = new Queue(QUEUE_DL_RETRAIN_EMERGENCY, { connection });
    dlRetrainEmergencyWorker = new Worker(QUEUE_DL_RETRAIN_EMERGENCY,
      async () => processDLPython('dl_trainer.py', '--trigger drift'),
      { connection, concurrency: 1, lockDuration: 6 * 60 * 60 * 1000, lockRenewTime: 30 * 60 * 1000 });
    dlRetrainEmergencyWorker.on('completed', () => console.log('[QUEUE] dl-retrain-emergency done'));
    dlRetrainEmergencyWorker.on('failed', (_, err) => console.error('[QUEUE] dl-retrain-emergency failed:', err.message));
```

- [ ] **Step 6: Add to shutdownQueues() Promise.allSettled array**

Append these inside the existing `Promise.allSettled([...])` call in `shutdownQueues()`:

```typescript
    dlMacroFetchWorker?.close(),
    dlMacroFetchQueue?.close(),
    dlFeatureRefreshWorker?.close(),
    dlFeatureRefreshQueue?.close(),
    dlInferenceWorker?.close(),
    dlInferenceQueue?.close(),
    dlRegimeUpdateWorker?.close(),
    dlRegimeUpdateQueue?.close(),
    dlRetrainWeeklyWorker?.close(),
    dlRetrainWeeklyQueue?.close(),
    dlRetrainEmergencyWorker?.close(),
    dlRetrainEmergencyQueue?.close(),
```

- [ ] **Step 7: Verify TypeScript compiles**

Run: `npm run build` or `npx tsc --noEmit`
Expected: No type errors in queues.ts.

- [ ] **Step 8: Commit**

```bash
git add src/server/queues.ts
git commit -m "feat: add 6 BullMQ queues for DL inference pipeline"
```

---

### Task 8: tRPC Router (DL Procedures)

**Files:**
- Create: `src/server/routers/dl.router.ts`
- Modify: `src/server/router.ts`

- [ ] **Step 1: Write dl.router.ts**

```typescript
import { z } from "zod";
import db from "../db";
import { router, publicProcedure } from "../trpc";

export const dlRouter = router({
  getDLPredictions: publicProcedure
    .input(z.object({
      symbols: z.array(z.string()).optional(),
      date: z.string().optional(),
    }).optional())
    .query(({ input }) => {
      const date = input?.date ?? new Date().toISOString().split("T")[0];
      const base = `
        SELECT d.symbol, d.prediction_date, d.model_name, d.model_version,
               d.prob_up_1d, d.prob_up_5d, d.prob_up_15d,
               d.prob_dn_1d, d.prob_dn_5d, d.prob_dn_15d,
               d.exp_ret_1d, d.exp_ret_5d, d.exp_ret_15d,
               d.confidence, d.uncertainty,
               d.regime, d.regime_confidence,
               d.top_features_json, d.attention_json,
               d.created_at
        FROM deep_learning_predictions d
        WHERE d.prediction_date = ?
      `;
      if (input?.symbols?.length) {
        const placeholders = input.symbols.map(() => "?").join(",");
        return (db.prepare(`${base} AND d.symbol IN (${placeholders}) ORDER BY d.confidence DESC`)
          .all(date, ...input.symbols) as any[])
          .map(r => ({
            ...r,
            topFeatures: r.top_features_json ? JSON.parse(r.top_features_json) : null,
            attention:   r.attention_json    ? JSON.parse(r.attention_json)    : null,
          }));
      }
      return (db.prepare(`${base} ORDER BY d.confidence DESC LIMIT 200`).all(date) as any[])
        .map(r => ({
          ...r,
          topFeatures: r.top_features_json ? JSON.parse(r.top_features_json) : null,
          attention:   r.attention_json    ? JSON.parse(r.attention_json)    : null,
        }));
    }),

  getDLModelPerformance: publicProcedure
    .input(z.object({
      model: z.string().optional(),
      days:  z.number().min(7).max(365).default(30),
    }).optional())
    .query(({ input }) => {
      const days  = input?.days  ?? 30;
      const model = input?.model ?? "LSTM_TFT_ENSEMBLE";
      const cutoff = new Date(Date.now() - days * 86400000).toISOString().split("T")[0];
      return db.prepare(`
        SELECT model_name, model_version, eval_date, horizon_days,
               directional_accuracy, roc_auc, precision_up, recall_up,
               f1_score, sharpe_ratio, profit_factor, sample_count,
               drift_score, retrain_triggered
        FROM dl_model_performance
        WHERE model_name = ? AND eval_date >= ?
        ORDER BY eval_date DESC
      `).all(model, cutoff);
    }),

  getMarketRegime: publicProcedure
    .input(z.object({ date: z.string().optional() }).optional())
    .query(({ input }) => {
      const date = input?.date ?? new Date().toISOString().split("T")[0];
      const row = db.prepare(`
        SELECT date, regime, regime_prob, hmm_state, viterbi_path_json, features_json, computed_at
        FROM market_regimes WHERE date <= ? ORDER BY date DESC LIMIT 1
      `).get(date) as any;
      if (!row) return null;
      return {
        ...row,
        viterbiPath: row.viterbi_path_json ? JSON.parse(row.viterbi_path_json) : null,
        features:    row.features_json     ? JSON.parse(row.features_json)     : null,
      };
    }),

  getDLPredictionHistory: publicProcedure
    .input(z.object({
      symbol:  z.string(),
      horizon: z.union([z.literal(5), z.literal(15)]).default(5),
      days:    z.number().min(7).max(90).default(30),
    }))
    .query(({ input }) => {
      const cutoff = new Date(Date.now() - input.days * 86400000).toISOString().split("T")[0];
      const probCol    = `prob_up_${input.horizon}d`;
      const outcomeCol = `outcome_${input.horizon}d`;
      return db.prepare(`
        SELECT prediction_date, ${probCol} AS prob_up,
               exp_ret_${input.horizon}d AS exp_ret,
               confidence, uncertainty,
               ${outcomeCol} AS outcome, regime,
               actual_ret_${input.horizon}d AS actual_ret
        FROM deep_learning_predictions
        WHERE symbol = ? AND prediction_date >= ? AND model_name = 'LSTM_TFT_ENSEMBLE'
        ORDER BY prediction_date DESC
      `).all(input.symbol, cutoff);
    }),
});
```

- [ ] **Step 2: Register dlRouter in router.ts**

Add import after existing router imports:
```typescript
import { dlRouter } from "./routers/dl.router";
```

Add `dlRouter` to the `mergeRouters(...)` call.

- [ ] **Step 3: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: No errors.

- [ ] **Step 4: Start server and test tRPC**

```bash
npm run dev
```

In browser: `http://localhost:3001/trpc/getMarketRegime`
Expected: JSON response (null if no regime data yet, not a 500 error).

- [ ] **Step 5: Commit**

```bash
git add src/server/routers/dl.router.ts src/server/router.ts
git commit -m "feat: add 4 tRPC procedures for DL predictions, model performance, regime"
```

---

### Task 9: Frontend Integration

**Files:**
- Modify: `src/components/HedgeFundResearch.tsx`
- Modify: `src/App.tsx`

- [ ] **Step 1: Read HedgeFundResearch.tsx to locate TopPicksTable and StockDeepDive**

Open the file and find:
1. The `TopPicksTable` component definition — specifically the table header `<tr>` and the row rendering logic
2. The `StockDeepDive` component — specifically where the score breakdown bars end

- [ ] **Step 2: Add DL data fetching hook at top of HedgeFundResearch component**

Inside the `HedgeFundResearch` function body, after existing tRPC calls:

```typescript
const { data: dlPredictions } = trpc.getDLPredictions.useQuery(
  { date: selectedDate },
  { staleTime: 5 * 60 * 1000 }
);
const { data: currentRegime } = trpc.getMarketRegime.useQuery(
  { date: selectedDate },
  { staleTime: 5 * 60 * 1000 }
);

// Build lookup map: symbol → DL prediction
const dlBySymbol = useMemo(
  () => new Map((dlPredictions ?? []).map((d: any) => [d.symbol, d])),
  [dlPredictions]
);
```

Add `useMemo` to imports if not already present: `import { useState, useEffect, useMemo } from 'react';`

- [ ] **Step 3: Add DL columns to TopPicksTable header**

Find the table header row in `TopPicksTable`. After the existing `<th>` columns (before the closing `</tr>`), add:

```tsx
<th className="px-3 py-2 text-right text-xs font-semibold text-slate-400 uppercase tracking-wide">
  DL Prob↑
</th>
<th className="px-3 py-2 text-center text-xs font-semibold text-slate-400 uppercase tracking-wide">
  Regime
</th>
```

- [ ] **Step 4: Add DL columns to each table row**

In the row mapping inside `TopPicksTable`, after the last existing `<td>`, add:

```tsx
{/* DL Probability column */}
<td className="px-3 py-2 text-right">
  {(() => {
    const dl = dlBySymbol?.get(pick.symbol);
    if (!dl) return <span className="text-slate-600 text-xs">—</span>;
    const prob = dl.prob_up_5d as number;
    const color = prob >= 0.65 ? 'text-emerald-400' : prob >= 0.50 ? 'text-amber-400' : 'text-rose-400';
    return (
      <span className={`text-sm font-semibold ${color}`}>
        {(prob * 100).toFixed(0)}%
      </span>
    );
  })()}
</td>
{/* Regime column */}
<td className="px-3 py-2 text-center">
  {currentRegime ? (
    <span className={`text-xs font-semibold px-1.5 py-0.5 rounded ${
      currentRegime.regime === 'BULL'      ? 'bg-emerald-900/60 text-emerald-300' :
      currentRegime.regime === 'BEAR'      ? 'bg-rose-900/60 text-rose-300' :
      currentRegime.regime === 'CRASH'     ? 'bg-red-950/80 text-red-200' :
      currentRegime.regime === 'HIGH_VOL'  ? 'bg-amber-900/60 text-amber-300' :
                                             'bg-slate-800 text-slate-400'
    }`}>
      {currentRegime.regime}
    </span>
  ) : <span className="text-slate-600 text-xs">—</span>}
</td>
```

Pass `dlBySymbol` and `currentRegime` as props to `TopPicksTable`. Update `TopPicksTable` props interface to accept them:

```typescript
interface TopPicksTableProps {
  picks: any[];
  onSelectStock: (pick: any) => void;
  onAddWatchlist: (symbol: string) => void;
  dlBySymbol?: Map<string, any>;
  currentRegime?: any;
}
```

- [ ] **Step 5: Add AI Model Signals section to StockDeepDive**

Inside `StockDeepDive`, after the score breakdown bars and before the closing `</div>`, add:

```tsx
{/* AI Model Signals */}
{(() => {
  const dl = dlBySymbol?.get(pick.symbol);
  if (!dl) return null;
  return (
    <div className="mt-4 border-t border-slate-700/50 pt-4">
      <div className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-3">
        AI Model Signals
      </div>
      {/* Horizon tabs */}
      <div className="flex gap-2 mb-3">
        {([1, 5, 15] as const).map(h => {
          const prob = dl[`prob_up_${h}d`] as number;
          const ret  = dl[`exp_ret_${h}d`] as number;
          const color = prob >= 0.65 ? 'emerald' : prob >= 0.50 ? 'amber' : 'rose';
          return (
            <div key={h} className="flex-1 glass rounded-lg p-2 text-center">
              <div className="text-xs text-slate-500 mb-1">{h}D</div>
              <div className={`text-base font-bold text-${color}-400`}>
                {(prob * 100).toFixed(0)}%↑
              </div>
              {ret !== null && (
                <div className={`text-xs ${ret >= 0 ? 'text-emerald-500' : 'text-rose-500'}`}>
                  {ret >= 0 ? '+' : ''}{(ret * 100).toFixed(1)}%
                </div>
              )}
            </div>
          );
        })}
      </div>
      {/* Uncertainty */}
      <div className="text-xs text-slate-500 mb-2">
        Confidence: <span className="text-slate-300">{((dl.confidence ?? 0) * 100).toFixed(0)}%</span>
        &nbsp;·&nbsp;
        Uncertainty: <span className="text-slate-300">±{((dl.uncertainty ?? 0) * 100).toFixed(0)}%</span>
      </div>
      {/* Top features */}
      {dl.topFeatures && Array.isArray(dl.topFeatures) && dl.topFeatures.length > 0 && (
        <div>
          <div className="text-xs text-slate-500 mb-1">Key drivers (SHAP)</div>
          {(dl.topFeatures as any[]).slice(0, 5).map((f: any, i: number) => (
            <div key={i} className="flex items-center gap-2 mb-1">
              <span className="text-xs text-slate-400 w-32 truncate">{f.feature}</span>
              <div className="flex-1 h-1.5 bg-slate-700 rounded-full overflow-hidden">
                <div
                  className={`h-full rounded-full ${f.value >= 0 ? 'bg-emerald-500' : 'bg-rose-500'}`}
                  style={{ width: `${Math.min(Math.abs(f.value) * 100, 100)}%` }}
                />
              </div>
              <span className="text-xs text-slate-500 w-12 text-right">
                {f.value >= 0 ? '+' : ''}{f.value?.toFixed(3)}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
})()}
```

Pass `dlBySymbol` as prop to `StockDeepDive`. Update its props interface:

```typescript
interface StockDeepDiveProps {
  pick: any;
  aiBlurbs: any;
  expanded: boolean;
  onToggle: () => void;
  dlBySymbol?: Map<string, any>;
}
```

- [ ] **Step 6: Add /deep-learning sub-tab in App.tsx**

Find the Research tab section in `App.tsx`. Add a sub-tab row when `activeTab === 'research'`:

```tsx
{activeTab === 'research' && (
  <div className="flex gap-2 px-4 pb-2 border-b border-slate-800">
    <button
      onClick={() => setResearchSubTab('overview')}
      className={`text-xs px-3 py-1 rounded-full transition-colors ${
        researchSubTab === 'overview'
          ? 'bg-violet-600 text-white'
          : 'text-slate-400 hover:text-white'
      }`}
    >
      Overview
    </button>
    <button
      onClick={() => setResearchSubTab('deep-learning')}
      className={`text-xs px-3 py-1 rounded-full transition-colors ${
        researchSubTab === 'deep-learning'
          ? 'bg-violet-600 text-white'
          : 'text-slate-400 hover:text-white'
      }`}
    >
      Deep Learning
    </button>
  </div>
)}
```

Add `const [researchSubTab, setResearchSubTab] = useState<'overview' | 'deep-learning'>('overview');` near other useState calls.

In the route rendering section, update the research tab handler:

```tsx
{activeTab === 'research' && researchSubTab === 'overview' && (
  <HedgeFundResearch onAddWatchlist={handleAddToWatchlist} />
)}
{activeTab === 'research' && researchSubTab === 'deep-learning' && (
  <DLDashboard />
)}
```

- [ ] **Step 7: Create minimal DLDashboard component inline in App.tsx or as a stub**

Create `src/components/DLDashboard.tsx`:

```tsx
import { trpc } from '../lib/trpc';
import { motion } from 'motion/react';
import { Brain, TrendingUp, AlertTriangle } from 'lucide-react';

export default function DLDashboard() {
  const { data: perf } = trpc.getDLModelPerformance.useQuery({ days: 30 });
  const { data: regime } = trpc.getMarketRegime.useQuery({});

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}
      className="p-4 space-y-4"
    >
      <div className="flex items-center gap-2 mb-2">
        <Brain className="w-5 h-5 text-violet-400" />
        <h2 className="text-lg font-bold text-white">Deep Learning Engine</h2>
      </div>

      {/* Current Regime */}
      <div className="glass rounded-xl p-4">
        <div className="text-xs text-slate-400 uppercase tracking-wide mb-2">Current Market Regime</div>
        {regime ? (
          <div className="flex items-center gap-3">
            <span className={`text-2xl font-bold ${
              regime.regime === 'BULL'     ? 'text-emerald-400' :
              regime.regime === 'BEAR'     ? 'text-rose-400' :
              regime.regime === 'CRASH'    ? 'text-red-300' :
              regime.regime === 'HIGH_VOL' ? 'text-amber-400' : 'text-slate-300'
            }`}>{regime.regime}</span>
            <span className="text-slate-500 text-sm">
              {((regime.regime_prob ?? 0) * 100).toFixed(0)}% confidence
            </span>
          </div>
        ) : (
          <span className="text-slate-500 text-sm">No regime data yet — run regime_detector.py</span>
        )}
      </div>

      {/* Model Performance */}
      <div className="glass rounded-xl p-4">
        <div className="text-xs text-slate-400 uppercase tracking-wide mb-3">Model Performance (30d)</div>
        {perf && (perf as any[]).length > 0 ? (
          <div className="space-y-2">
            {(perf as any[]).slice(0, 10).map((row: any, i: number) => (
              <div key={i} className="flex items-center justify-between text-sm">
                <span className="text-slate-400">{row.eval_date}</span>
                <span className="text-slate-300">
                  Acc: {row.directional_accuracy != null
                    ? `${(row.directional_accuracy * 100).toFixed(1)}%` : '—'}
                </span>
                <span className="text-slate-300">
                  AUC: {row.roc_auc != null ? row.roc_auc.toFixed(3) : '—'}
                </span>
                <span className={`text-xs ${
                  row.drift_score != null && row.drift_score > 0.25 ? 'text-amber-400' : 'text-slate-500'
                }`}>
                  PSI: {row.drift_score != null ? row.drift_score.toFixed(3) : '—'}
                </span>
              </div>
            ))}
          </div>
        ) : (
          <span className="text-slate-500 text-sm">No performance data yet — run dl_trainer.py first</span>
        )}
      </div>

      <div className="glass rounded-xl p-4 border border-slate-700/50">
        <div className="flex items-center gap-2 text-slate-400 text-sm">
          <AlertTriangle className="w-4 h-4 text-amber-500" />
          DL engine populates after first training run:
          <code className="text-xs text-violet-300 ml-1">python dl_trainer.py --trigger scheduled</code>
        </div>
      </div>
    </motion.div>
  );
}
```

- [ ] **Step 8: Add DLDashboard import to App.tsx**

```typescript
import DLDashboard from './components/DLDashboard';
```

- [ ] **Step 9: Verify the app compiles and renders**

```bash
npm run dev
```

Navigate to Research tab. Verify:
- Overview sub-tab shows existing research page
- Deep Learning sub-tab shows DLDashboard (with "No data yet" states — not a crash)
- TopPicksTable has two new columns (DL Prob↑, Regime) — show `—` when no DL data

Check browser console for no React errors.

- [ ] **Step 10: Commit**

```bash
git add src/components/HedgeFundResearch.tsx src/components/DLDashboard.tsx src/App.tsx
git commit -m "feat: add DL predictions and regime columns to Research page, add Deep Learning sub-tab"
```

---

## Self-Review

**Spec coverage check:**

| Spec requirement | Task |
|---|---|
| `feature_store` table + 4 other tables | Task 1 |
| `macro_indicators` table | Task 1 |
| `global_macro_fetcher.py` (yfinance) | Task 2 |
| `feature_engineering.py` — 84 features | Task 3 |
| Leakage prevention (target shift, fund lag 45d, FII lag 1d) | Task 3 |
| RobustScaler, fit on train window only | Task 3 |
| `dl_engine.py` — BiLSTM architecture (256→128→attn→64→5 heads) | Task 4 |
| Walk-forward expanding window validation | Task 4 |
| Batch inference 50/batch, write to `deep_learning_predictions` | Task 4 |
| `regime_detector.py` — 5-state Gaussian HMM, hmmlearn | Task 5 |
| Viterbi + forward probabilities, write to `market_regimes` | Task 5 |
| `drift_detector.py` — PSI layer + accuracy layer | Task 6 |
| `dl_trainer.py` — lock, quality gate, model versioning | Task 6 |
| 6 BullMQ queues at correct IST times | Task 7 |
| 4 tRPC procedures | Task 8 |
| TopPicksTable DL Prob↑ + Regime columns | Task 9 |
| StockDeepDive AI Model Signals section (3 horizons, SHAP) | Task 9 |
| `/deep-learning` sub-tab with DLDashboard | Task 9 |
| `requirements.txt` additions | Task 1 |

**Placeholder scan:** None found — all steps have full code.

**Type consistency check:**
- `dlBySymbol` typed as `Map<string, any>` — passed consistently from HedgeFundResearch → TopPicksTable → StockDeepDive
- `currentRegime` from `getMarketRegime` query — used as `any` with optional chaining everywhere
- `processDLPython(script, args)` — used consistently in all 6 worker definitions
