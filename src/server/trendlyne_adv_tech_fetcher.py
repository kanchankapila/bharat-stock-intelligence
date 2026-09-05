#!/usr/bin/env python3
"""
Trendlyne Advanced Technical Analysis Fetcher (Daily)
======================================================
Fetches Trendlyne's advanced technical analysis per stock (daily frequency).
One API call per stock returns MA signals, oscillators, pivot points, price
returns, delivery/volume averages, and beta.

Endpoint:
  https://trendlyne.com/equity/api/stock/adv-technical-analysis/{tlid}/24/?format=json
  where 24 = daily frequency (available_frequency["1D"] = 24)
  ?format=json is required â€” DRF returns HTML without it.

Writes to:
  trendlyne_adv_tech_daily  (symbol, date, PRIMARY KEY) â€” full daily snapshot
  technical_signals         â€” back-filled with derived ML features

ML features written to technical_signals:
  ma_bull_frac       = ma_bull / (ma_bull + ma_bear)   â€” fraction of MAs bullish
  osc_bull_frac      = osc_bull / (osc_bull + osc_bear) â€” fraction of oscillators bullish
  adx_tl             = ADX value (trend strength)
  atr_pct_tl         = ATR / current_price * 100        â€” normalised volatility
  mfi_tl             = Money Flow Index
  pivot_dist_pct_tl  = (price - pivot) / pivot * 100    â€” distance from pivot
  delivery_avg_1m_tl = 1-month delivery %
  beta_1y_tl         = 1-year beta
  ret_1m_tl          = 1-month return %
  ret_3m_tl          = 3-month return %
  ret_6m_tl          = 6-month return %
  ret_1y_tl          = 1-year return %

Run:
  python trendlyne_adv_tech_fetcher.py              # all stocks
  python trendlyne_adv_tech_fetcher.py --symbol BEL # single stock
"""

import polars as pl
from pydantic import BaseModel
from base_fetcher import BaseFetcher, governed_fetcher

class TrendlyneAdvTechFetcherSchema(BaseModel):
    symbol: str | None = None
    date: str | None = None

class TrendlyneAdvTechFetcherBaseFetcher(BaseFetcher[TrendlyneAdvTechFetcherSchema]):
    fetcher_name = 'TrendlyneAdvTechFetcher'
    domain = 'trendlyne.com'
    schema = TrendlyneAdvTechFetcherSchema
    min_interval_sec = 0.5


import argparse
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import date

import requests

import tl_fetch

from db_compat import connect
from as_of import logical_write_floor
from fetch_utils import (retry_get, FetchTracker, filter_numeric_tlids,
                         TRENDLYNE_MAX_CONCURRENT, cap_to_run_budget, WAF_BLOCKED,
                         _is_waf_challenge,
                         run_deadline, past_deadline)
import os
import sys

BASE_URL = (
    "https://trendlyne.com/equity/api/stock/adv-technical-analysis/{tlid}/24/"
)

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
    ),
    "Accept": "application/json",
    "Referer": "https://trendlyne.com/",
}

RATE_LIMIT_SEC = 0.5
# Was 15 -- AWS WAF returns 405/captcha for the rest of the run when more than 3
# requests are in flight at once. Measured, see TRENDLYNE_MAX_CONCURRENT in fetch_utils.py.
BATCH_SIZE = TRENDLYNE_MAX_CONCURRENT
BATCH_GAP_SEC  = 0.5

# Total count of MA signals (8 SMA + 8 EMA = 16) and oscillator signals (9)
# used as denominators for the fractional features.
MA_TOTAL = 16
OSC_TOTAL = 9


# â”€â”€ Schema â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

def ensure_schema(con) -> None:
    cur = con.cursor()

    cur.execute("""
        CREATE TABLE IF NOT EXISTS trendlyne_adv_tech_daily (
            symbol              TEXT    NOT NULL,
            date                TEXT    NOT NULL,
            -- MA signals
            ma_bull             INTEGER,
            ma_bear             INTEGER,
            osc_bull            INTEGER,
            osc_bear            INTEGER,
            -- Individual oscillator values
            rsi                 REAL,
            macd                REAL,
            macd_hist           REAL,
            adx                 REAL,
            atr                 REAL,
            mfi                 REAL,
            cci                 REAL,
            roc_21              REAL,
            roc_125             REAL,
            william             REAL,
            uo                  REAL,
            momentum_score      REAL,
            current_price       REAL,
            -- Pivot points
            pivot               REAL,
            r1                  REAL,
            s1                  REAL,
            pivot_dist_pct      REAL,
            -- Price returns
            ret_1d              REAL,
            ret_1w              REAL,
            ret_1m              REAL,
            ret_3m              REAL,
            ret_6m              REAL,
            ret_1y              REAL,
            ret_3y              REAL,
            ret_5y              REAL,
            -- Volume / delivery
            delivery_pct_day    REAL,
            delivery_pct_week   REAL,
            delivery_pct_1m     REAL,
            delivery_pct_6m     REAL,
            vol_avg_day         REAL,
            vol_avg_week        REAL,
            vol_avg_1m          REAL,
            -- Beta
            beta_1m             REAL,
            beta_3m             REAL,
            beta_1y             REAL,
            beta_3y             REAL,
            fetched_at          TEXT DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (symbol, date)
        )
    """)
    for idx in [
        "CREATE INDEX IF NOT EXISTS idx_tlat_sym  ON trendlyne_adv_tech_daily(symbol, date DESC)",
        "CREATE INDEX IF NOT EXISTS idx_tlat_date ON trendlyne_adv_tech_daily(date)",
    ]:
        cur.execute(idx)
    con.commit()  # commit DDL before ALTER so Postgres doesn't abort the tx

    # Back-fill columns on technical_signals â€” each ALTER in its own commit/rollback.
    # AF-20260901: these columns have existed for months (schema-of-record is
    # db/schema.postgres.sql) yet the ALTERs re-ran on every fetch, each attempt queueing
    # an ACCESS EXCLUSIVE lock on a hot table before failing with DuplicateColumn. Guard:
    # lock-free information_schema pre-check + IF NOT EXISTS + 2s session lock_timeout
    # (mechanism documented in trendlyne_overview_fetcher.py and AF-20260827-14).
    cur.execute("SET lock_timeout = '2s'")
    try:
        for ddl in [
            "ALTER TABLE technical_signals ADD COLUMN IF NOT EXISTS ma_bull_frac      REAL",
            "ALTER TABLE technical_signals ADD COLUMN IF NOT EXISTS osc_bull_frac     REAL",
            "ALTER TABLE technical_signals ADD COLUMN IF NOT EXISTS adx_tl            REAL",
            "ALTER TABLE technical_signals ADD COLUMN IF NOT EXISTS atr_pct_tl        REAL",
            "ALTER TABLE technical_signals ADD COLUMN IF NOT EXISTS mfi_tl            REAL",
            "ALTER TABLE technical_signals ADD COLUMN IF NOT EXISTS pivot_dist_pct_tl REAL",
            "ALTER TABLE technical_signals ADD COLUMN IF NOT EXISTS delivery_avg_1m_tl REAL",
            "ALTER TABLE technical_signals ADD COLUMN IF NOT EXISTS beta_1y_tl        REAL",
            "ALTER TABLE technical_signals ADD COLUMN IF NOT EXISTS ret_1m_tl         REAL",
            "ALTER TABLE technical_signals ADD COLUMN IF NOT EXISTS ret_3m_tl         REAL",
            "ALTER TABLE technical_signals ADD COLUMN IF NOT EXISTS ret_6m_tl         REAL",
            "ALTER TABLE technical_signals ADD COLUMN IF NOT EXISTS ret_1y_tl         REAL",
        ]:
            try:
                if not _ddl_column_exists(cur, ddl):
                    cur.execute(ddl)
                con.commit()
            except Exception:
                con.rollback()
    finally:
        cur.execute("SET lock_timeout = DEFAULT")
        con.commit()


def _ddl_column_exists(cur, ddl: str) -> bool:
    """True when the column targeted by an ``ALTER TABLE t ADD COLUMN [IF NOT EXISTS] c``
    statement already exists in the current schema. Lock-free (information_schema lookup),
    so gating the ALTER on it avoids queueing an ACCESS EXCLUSIVE lock request just to
    discover the column was already there (AF-20260901 / AF-20260827-14)."""
    toks = ddl.split()
    if (len(toks) < 6 or toks[0].upper() != "ALTER" or toks[1].upper() != "TABLE"
            or toks[3].upper() != "ADD" or toks[4].upper() != "COLUMN"):
        return False
    rest = toks[5:]
    if rest and rest[0].upper() == "IF":  # skip IF NOT EXISTS
        rest = rest[3:]
    if not rest:
        return False
    cur.execute(
        "SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() "
        f"AND table_name = '{toks[2]}' AND column_name = '{rest[0]}'"
    )
    return cur.fetchone() is not None


# â”€â”€ Fetch â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

def fetch_adv_tech(tlid: str, session: requests.Session) -> dict | None:
    """Fetch the raw advanced-technical JSON body for a given tlid.
    Returns the parsed ``body.parameters`` dict or None on failure."""
    url = BASE_URL.format(tlid=tlid)
    try:
        r = retry_get(session, url, params={"format": "json"}, timeout=15)
        data = r.json()
        body = data.get("body") or {}
        params = body.get("parameters")
        if params is None:
            # Some responses wrap differently â€” try top-level body as params
            params = body if body else None
        return params
    except Exception as e:
        # A WAF challenge means OUR ALLOWANCE ended, not that this stock has no data -- see
        # fetch_utils.FetchTracker.record_allowance_exhausted.
        if _is_waf_challenge(e):
            print(f"  [{tlid}] allowance exhausted (WAF): {e}", file=sys.stderr)
            return WAF_BLOCKED
        print(f"  fetch error (tlid={tlid}): {e}", file=sys.stderr)
        return None


# â”€â”€ Extract â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

def _fval(d: dict, key: str) -> float | None:
    """Safely extract a float from a nested {"value": ...} dict."""
    try:
        v = d.get(key, {})
        if isinstance(v, dict):
            val = v.get("value")
        else:
            val = v
        return float(val) if val is not None else None
    except (TypeError, ValueError):
        return None


def _safe_float(v) -> float | None:
    try:
        return float(v) if v is not None else None
    except (TypeError, ValueError):
        return None


def extract_features(params: dict) -> dict:
    """Parse the raw parameters dict into a flat feature dict.

    All numeric values are native Python float/int so Postgres accepts them
    (np.float64 would be rejected).
    """
    feat: dict = {}

    # â”€â”€ MA signals â”€â”€
    ma = params.get("ma_signal") or {}
    feat["ma_bull"] = int(ma.get("bullish", 0))
    feat["ma_bear"] = int(ma.get("bearish", 0))

    # â”€â”€ Oscillator signals â”€â”€
    osc = params.get("oscillator_signal") or {}
    feat["osc_bull"] = int(osc.get("bullish", 0))
    feat["osc_bear"] = int(osc.get("bearish", 0))

    # â”€â”€ Individual indicators â”€â”€
    feat["rsi"]            = _fval(params, "rsi")
    feat["macd"]           = _fval(params, "macd")
    feat["macd_hist"]      = _fval(params, "macdhistogram")
    feat["adx"]            = _fval(params, "adx")
    feat["atr"]            = _fval(params, "atr")
    feat["mfi"]            = _fval(params, "mfi")
    feat["cci"]            = _fval(params, "cci")
    feat["roc_21"]         = _fval(params, "roc_21")
    feat["roc_125"]        = _fval(params, "roc_125")
    feat["william"]        = _fval(params, "william")
    feat["uo"]             = _fval(params, "uo")
    feat["momentum_score"] = _fval(params, "momentum")
    feat["current_price"]  = _safe_float(params.get("current_price"))

    # â”€â”€ Pivot points â”€â”€
    pivot_lvl = params.get("pivot_level") or {}
    feat["pivot"] = _fval(pivot_lvl, "pivot_point")
    feat["r1"]    = _fval(pivot_lvl, "R1")
    feat["s1"]    = _fval(pivot_lvl, "S1")

    # Pivot distance %: (price - pivot) / pivot * 100
    if feat["current_price"] and feat["pivot"] and feat["pivot"] != 0:
        feat["pivot_dist_pct"] = round(
            (feat["current_price"] - feat["pivot"]) / feat["pivot"] * 100, 4
        )
    else:
        feat["pivot_dist_pct"] = None

    # â”€â”€ Price returns â”€â”€
    # Map period name â†’ column key
    ret_map = {
        "1 Day":    "ret_1d",
        "1 Week":   "ret_1w",
        "1 Month":  "ret_1m",
        "3 Months": "ret_3m",
        "6 Months": "ret_6m",
        "1 Year":   "ret_1y",
        "3 Year":   "ret_3y",
        "5 Year":   "ret_5y",
    }
    for entry in params.get("price_analysis") or []:
        col = ret_map.get(entry.get("name"))
        if col:
            feat[col] = _safe_float(entry.get("changePercent"))

    # â”€â”€ Volume / delivery analysis â”€â”€
    # tableData rows: [period_label, avg_vol, delivery_pct, del_vol]
    vol_map = {
        "Day":     ("vol_avg_day",   "delivery_pct_day"),
        "Week":    ("vol_avg_week",  "delivery_pct_week"),
        "1 Month": ("vol_avg_1m",    "delivery_pct_1m"),
        "6 Month": ("delivery_pct_6m", None),          # only delivery_pct for 6m
    }
    va = params.get("volume_analysis") or {}
    for row in va.get("tableData", []):
        if not isinstance(row, (list, tuple)) or len(row) < 3:
            continue
        label = str(row[0])
        mapping = vol_map.get(label)
        if mapping is None:
            continue
        vol_col, del_col = mapping if len(mapping) == 2 else (mapping[0], None)
        if vol_col and vol_col.startswith("delivery"):
            # 6 Month row: only store delivery_pct (index 2)
            feat["delivery_pct_6m"] = _safe_float(row[2])
        else:
            if vol_col:
                feat[vol_col] = _safe_float(row[1])
            if del_col:
                feat[del_col] = _safe_float(row[2])

    # â”€â”€ Beta â”€â”€
    beta_map = {
        "1 Month": "beta_1m",
        "3 Month": "beta_3m",
        "1 Year":  "beta_1y",
        "3 Year":  "beta_3y",
    }
    for entry in params.get("beta_analysis") or []:
        col = beta_map.get(entry.get("label"))
        if col:
            feat[col] = _safe_float(entry.get("data"))

    # â”€â”€ Derived ML fractions â”€â”€
    ma_total = feat["ma_bull"] + feat["ma_bear"]
    feat["ma_bull_frac"] = (
        round(feat["ma_bull"] / ma_total, 4) if ma_total > 0 else 0.5
    )

    osc_total = feat["osc_bull"] + feat["osc_bear"]
    feat["osc_bull_frac"] = (
        round(feat["osc_bull"] / osc_total, 4) if osc_total > 0 else 0.5
    )

    if feat.get("atr") is not None and feat.get("current_price"):
        feat["atr_pct"] = round(feat["atr"] / feat["current_price"] * 100, 4)
    else:
        feat["atr_pct"] = None

    return feat


# â”€â”€ Persist â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

def upsert_row(symbol: str, today: str, feat: dict, con) -> None:
    """Insert or replace the daily row for (symbol, today)."""
    cur = con.cursor()
    cur.execute("""
        INSERT INTO trendlyne_adv_tech_daily (
            symbol, date,
            ma_bull, ma_bear, osc_bull, osc_bear,
            rsi, macd, macd_hist, adx, atr, mfi, cci,
            roc_21, roc_125, william, uo, momentum_score, current_price,
            pivot, r1, s1, pivot_dist_pct,
            ret_1d, ret_1w, ret_1m, ret_3m, ret_6m, ret_1y, ret_3y, ret_5y,
            delivery_pct_day, delivery_pct_week, delivery_pct_1m, delivery_pct_6m,
            vol_avg_day, vol_avg_week, vol_avg_1m,
            beta_1m, beta_3m, beta_1y, beta_3y,
            fetched_at
        ) VALUES (
            ?,?,
            ?,?,?,?,
            ?,?,?,?,?,?,?,
            ?,?,?,?,?,?,
            ?,?,?,?,
            ?,?,?,?,?,?,?,?,
            ?,?,?,?,
            ?,?,?,
            ?,?,?,?,
            CURRENT_TIMESTAMP
        )
        ON CONFLICT(symbol, date) DO UPDATE SET
            ma_bull            = excluded.ma_bull,
            ma_bear            = excluded.ma_bear,
            osc_bull           = excluded.osc_bull,
            osc_bear           = excluded.osc_bear,
            rsi                = excluded.rsi,
            macd               = excluded.macd,
            macd_hist          = excluded.macd_hist,
            adx                = excluded.adx,
            atr                = excluded.atr,
            mfi                = excluded.mfi,
            cci                = excluded.cci,
            roc_21             = excluded.roc_21,
            roc_125            = excluded.roc_125,
            william            = excluded.william,
            uo                 = excluded.uo,
            momentum_score     = excluded.momentum_score,
            current_price      = excluded.current_price,
            pivot              = excluded.pivot,
            r1                 = excluded.r1,
            s1                 = excluded.s1,
            pivot_dist_pct     = excluded.pivot_dist_pct,
            ret_1d             = excluded.ret_1d,
            ret_1w             = excluded.ret_1w,
            ret_1m             = excluded.ret_1m,
            ret_3m             = excluded.ret_3m,
            ret_6m             = excluded.ret_6m,
            ret_1y             = excluded.ret_1y,
            ret_3y             = excluded.ret_3y,
            ret_5y             = excluded.ret_5y,
            delivery_pct_day   = excluded.delivery_pct_day,
            delivery_pct_week  = excluded.delivery_pct_week,
            delivery_pct_1m    = excluded.delivery_pct_1m,
            delivery_pct_6m    = excluded.delivery_pct_6m,
            vol_avg_day        = excluded.vol_avg_day,
            vol_avg_week       = excluded.vol_avg_week,
            vol_avg_1m         = excluded.vol_avg_1m,
            beta_1m            = excluded.beta_1m,
            beta_3m            = excluded.beta_3m,
            beta_1y            = excluded.beta_1y,
            beta_3y            = excluded.beta_3y,
            fetched_at         = CURRENT_TIMESTAMP
    """, (
        symbol, today,
        feat.get("ma_bull"),   feat.get("ma_bear"),
        feat.get("osc_bull"),  feat.get("osc_bear"),
        feat.get("rsi"),       feat.get("macd"),      feat.get("macd_hist"),
        feat.get("adx"),       feat.get("atr"),       feat.get("mfi"),
        feat.get("cci"),       feat.get("roc_21"),    feat.get("roc_125"),
        feat.get("william"),   feat.get("uo"),
        feat.get("momentum_score"),   feat.get("current_price"),
        feat.get("pivot"),     feat.get("r1"),        feat.get("s1"),
        feat.get("pivot_dist_pct"),
        feat.get("ret_1d"),    feat.get("ret_1w"),    feat.get("ret_1m"),
        feat.get("ret_3m"),    feat.get("ret_6m"),    feat.get("ret_1y"),
        feat.get("ret_3y"),    feat.get("ret_5y"),
        feat.get("delivery_pct_day"),  feat.get("delivery_pct_week"),
        feat.get("delivery_pct_1m"),   feat.get("delivery_pct_6m"),
        feat.get("vol_avg_day"),       feat.get("vol_avg_week"),
        feat.get("vol_avg_1m"),
        feat.get("beta_1m"),   feat.get("beta_3m"),
        feat.get("beta_1y"),   feat.get("beta_3y"),
    ))
    con.commit()


# â”€â”€ Back-fill technical_signals â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

def backfill_technical_signals(symbol: str, today: str, feat: dict, con) -> None:
    """Write ML features derived from the fetched data into technical_signals.

    Uses COALESCE so existing (non-NULL) values are not overwritten by a NULL, guarded to
    today-or-later rows only. BUG FOUND 2026-07-19: this previously had no date filter at all
    (`WHERE symbol = ?`) on the theory that "technical_signals rows are rolling and contain
    only the latest state per symbol" -- that premise is wrong; it's a proper per-date time
    series used for ML training on historical outcomes, and the old query smeared today's
    snapshot across a symbol's entire history via COALESCE-fills-null-once-then-frozen-forever
    (confirmed via mc_ma30_dist/mc_days_from_52wh in mc_pricefeed_fetcher.py, which had the
    identical pattern). The `date >= ? ELSE NULL` guard matches the pattern already used
    correctly elsewhere (trendlyne_fundamentals_fetcher.py, working_capital_fetcher.py).
    """
    if not feat:
        return
    cur = con.cursor()
    cur.execute("""
        UPDATE technical_signals SET
            ma_bull_frac       = CASE WHEN date >= ? THEN COALESCE(?, ma_bull_frac)       ELSE ma_bull_frac END,
            osc_bull_frac      = CASE WHEN date >= ? THEN COALESCE(?, osc_bull_frac)      ELSE osc_bull_frac END,
            adx_tl             = CASE WHEN date >= ? THEN COALESCE(?, adx_tl)             ELSE adx_tl END,
            atr_pct_tl         = CASE WHEN date >= ? THEN COALESCE(?, atr_pct_tl)         ELSE atr_pct_tl END,
            mfi_tl             = CASE WHEN date >= ? THEN COALESCE(?, mfi_tl)             ELSE mfi_tl END,
            pivot_dist_pct_tl  = CASE WHEN date >= ? THEN COALESCE(?, pivot_dist_pct_tl)  ELSE pivot_dist_pct_tl END,
            delivery_avg_1m_tl = CASE WHEN date >= ? THEN COALESCE(?, delivery_avg_1m_tl) ELSE delivery_avg_1m_tl END,
            beta_1y_tl         = CASE WHEN date >= ? THEN COALESCE(?, beta_1y_tl)         ELSE beta_1y_tl END,
            ret_1m_tl          = CASE WHEN date >= ? THEN COALESCE(?, ret_1m_tl)          ELSE ret_1m_tl END,
            ret_3m_tl          = CASE WHEN date >= ? THEN COALESCE(?, ret_3m_tl)          ELSE ret_3m_tl END,
            ret_6m_tl          = CASE WHEN date >= ? THEN COALESCE(?, ret_6m_tl)          ELSE ret_6m_tl END,
            ret_1y_tl          = CASE WHEN date >= ? THEN COALESCE(?, ret_1y_tl)          ELSE ret_1y_tl END
        WHERE symbol = ?
    """, (
        today, feat.get("ma_bull_frac"),
        today, feat.get("osc_bull_frac"),
        today, feat.get("adx"),
        today, feat.get("atr_pct"),
        today, feat.get("mfi"),
        today, feat.get("pivot_dist_pct"),
        today, feat.get("delivery_pct_1m"),
        today, feat.get("beta_1y"),
        today, feat.get("ret_1m"),
        today, feat.get("ret_3m"),
        today, feat.get("ret_6m"),
        today, feat.get("ret_1y"),
        symbol,
    ))
    con.commit()


# â”€â”€ Stock list â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

def _load_stocks(symbol_filter: str | None, con, skip_done_for_date: str | None = None) -> list[tuple[str, str]]:
    """Return [(symbol, tlid), ...] scoped to the NSE master list only (nse_stocks.tlid).
    No trendlyne_screener_stocks fallback — that table carries non-NSE-master symbols
    (junk/delisted/BSE-only tickers) which pulled the universe well past NSE coverage.

    skip_done_for_date: when set, drops symbols that already have a row for that date --
    resumability. Without this, every catch-up retry (see queues.ts/registerJob.ts's
    addJobWithCatchup) re-fetches the full ~2200-stock universe from scratch, so a run that
    gets killed by the outer 40-min timeout at 90% complete throws away that 90% and starts
    over -- the timeout then recurs on every subsequent retry regardless of how close the
    prior attempt got. Found 2026-08-15: the endpoint and this fetcher's own logic are both
    healthy in isolation (live-probed 300/300 stocks, ~0.15s/call, ~2.5min projected
    full-universe) -- the repeated 40-min kills (24 of the last 31 runs) trace to this
    machine's shared MAX_PYTHON_CONCURRENT=5 pool getting starved by concurrent long-running
    jobs (e.g. a same-day dl_engine.py LSTM run held a slot/CPU for 10h12m), which is a
    resource-contention problem this fetcher can't fix directly -- but it doesn't need to:
    making every retry cheap (only fetch what's still missing) stops a slow day from
    compounding into a total-failure day.
    """
    cur = con.cursor()
    cur.execute("""
        SELECT symbol, tlid::TEXT AS tlid FROM nse_stocks
        WHERE symbol IS NOT NULL AND tlid IS NOT NULL AND tlid::TEXT != ''
        ORDER BY symbol
    """)
    rows = [(r[0], str(r[1])) for r in cur.fetchall() if r[0] is not None]
    if symbol_filter:
        rows = [(s, t) for s, t in rows if s.upper() == symbol_filter.upper()]
    # Ticker-shaped tlids are a permanent 404; without this each one burned 3 retry_get
    # attempts with exponential backoff every run and inflated the failure rate the
    # FetchTracker reports, which is what made a real transient outage indistinguishable
    # from routine noise on 2026-08-12.
    rows, _ = filter_numeric_tlids(rows, "TLAdvTech")
    if skip_done_for_date:
        cur.execute(
            "SELECT symbol FROM trendlyne_adv_tech_daily WHERE date = ?",
            (skip_done_for_date,),
        )
        done = {r[0] for r in cur.fetchall()}
        if done:
            before = len(rows)
            rows = [(s, t) for s, t in rows if s not in done]
            print(f"[TLAdvTech] Resuming: {before - len(rows)} of {before} stocks already "
                  f"fetched for {skip_done_for_date}, {len(rows)} remaining.")
    return rows


# â”€â”€ Main â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

def main() -> None:
    parser = argparse.ArgumentParser(
        description="Fetch Trendlyne advanced technical analysis (daily) per stock."
    )
    parser.add_argument(
        "--symbol", default=None,
        help="Process a single NSE symbol (e.g. BEL). Omit to process all stocks."
    )
    args = parser.parse_args()

    con = connect()
    ensure_schema(con)

    # Align to the last completed trading session, NOT date.today() -- this job runs in the
    # trendlyne-midweek batch (Tuesday) and can race the day's grid-ensurer (or run ad-hoc on a
    # non-trading day), leaving "date >= today" matching zero rows while nulling every existing
    # row via the ELSE branch. Same bug/fix as trendlyne_price_analysis_fetcher.py and others.
    # Computed before _load_stocks() so a retry can skip symbols already written for this date.
    today = logical_write_floor(con, fallback=date.today().isoformat())

    # Only resume-skip on a full-universe run -- an explicit --symbol invocation is a manual
    # debug/re-fetch and should always hit the API regardless of what's already stored.
    stocks = _load_stocks(args.symbol, con, skip_done_for_date=None if args.symbol else today)
    if not stocks:
        print("[TLAdvTech] No stocks with tlid found (or all already fetched for today).")
        con.close()
        return
    stocks = cap_to_run_budget(stocks, "TLAdvTech", requests_per_row=1)
    print(f"[TLAdvTech] Processing {len(stocks)} stocks in batches of {BATCH_SIZE} ({BATCH_GAP_SEC}s gap)...")
    # 2026-08-26: tl_fetch.create_session() returns a curl_cffi Chrome-TLS-impersonated
    # session (Scrapling's Fetcher, fetcher-only) instead of plain python-requests — the WAF
    # bot rule fingerprints TLS, and the legacy urllib ClientHello was the cheapest signal it
    # had. TRENDLYNE_USE_SCRAPLING=0 reverts to requests+HEADERS with no code change.
    session = tl_fetch.create_session()
    if not isinstance(session, tl_fetch.TLSession):
        session.headers.update(HEADERS)
    ok = 0
    skipped = 0
    done = 0
    # Same silent-degradation guard as trendlyne_price_analysis_fetcher.py (its sibling in the
    # same trendlyne-midweek batch): a run where most/all stocks come back "no data" must not
    # look identical to a healthy one.
    # abort_after_consecutive_fails=20 (2026-08-13): its price-analysis sibling was WAF-blocking
    # on request 1 of every run and grinding through the whole universe anyway until the outer
    # timeout killed it -- see fetch_utils.FetchTracker. This fetcher's failures are currently
    # interspersed with real successes (18-28% success, not 0%), so the breaker won't trip
    # under that pattern, but it's cheap defense-in-depth against a full block later.
    tracker = FetchTracker("trendlyne_adv_tech_fetcher", abort_after_consecutive_fails=20)

    def _fetch_one(args):
        symbol, tlid = args
        return symbol, tlid, fetch_adv_tech(tlid, session)

    # Time-box the slice. cap_to_run_budget above bounds it by REQUEST COUNT (the WAF's own
    # unit), which says nothing about elapsed time: when upstream slows to ~6s/request the
    # 110-request slice overruns the 10-minute runPython budget and the run is KILLED mid-work.
    # That budget cannot simply be raised -- it is deliberately below the 20-minute cadence so
    # two catch-up runs can never overlap and double-spend the shared allowance. Stopping
    # cleanly and letting the next run resume from the DB is already the designed behaviour
    # (see cap_to_run_budget: 'a partial run here is normal, not a failure').
    deadline = run_deadline(float(os.environ.get('TRENDLYNE_SLICE_DEADLINE_SEC', '480')))
    allowance_gone = False
    for batch_start in range(0, len(stocks), BATCH_SIZE):
        if allowance_gone:
            print(f"[TLAdvTech] Allowance exhausted at {done}/{len(stocks)} stocks -- "
                  "stopping cleanly; the next scheduled run resumes from the DB.",
                  file=sys.stderr)
            break
        if past_deadline(deadline):
            print(f"[TLAdvTech] Slice deadline reached at {done}/{len(stocks)} stocks -- "
                  "stopping cleanly; the next scheduled run resumes from the DB.",
                  file=sys.stderr)
            break
        batch = stocks[batch_start:batch_start + BATCH_SIZE]
        with ThreadPoolExecutor(max_workers=len(batch)) as pool:
            futures = [pool.submit(_fetch_one, item) for item in batch]
            for fut in as_completed(futures):
                symbol, tlid, params = fut.result()
                done += 1
                if params is WAF_BLOCKED:
                    tracker.record_allowance_exhausted(symbol)
                    allowance_gone = True
                    continue
                if params is None:
                    print(f"  [{done}/{len(stocks)}] {symbol}: SKIP (no data)")
                    skipped += 1
                    tracker.record(symbol, ok=False)
                    continue
                feat = extract_features(params)
                upsert_row(symbol, today, feat, con)
                backfill_technical_signals(symbol, today, feat, con)
                ma_str  = f"MA {feat.get('ma_bull','?')}up/{feat.get('ma_bear','?')}dn"
                osc_str = f"OSC {feat.get('osc_bull','?')}up/{feat.get('osc_bear','?')}dn"
                rsi_str = f"RSI={feat.get('rsi','?')}"
                adx_str = f"ADX={feat.get('adx','?')}"
                ret_str = f"1m={feat.get('ret_1m','?')}% 3m={feat.get('ret_3m','?')}%"
                pdist   = f"pvt_dist={feat.get('pivot_dist_pct',0):.2f}%" if feat.get("pivot_dist_pct") is not None else "pvt_dist=?"
                print(f"  [{done}/{len(stocks)}] {symbol}: {ma_str} | {osc_str} | {rsi_str} | {adx_str} | {ret_str} | {pdist}")
                ok += 1
                tracker.record(symbol, ok=True)
        time.sleep(BATCH_GAP_SEC)

    print(f"[TLAdvTech] Done. {ok} OK / {skipped} skipped out of {len(stocks)} stocks.")
    con.close()
    tracker.finish()


if __name__ == "__main__":
    main()

def to_polars_df(data):
    """Converts pandas DataFrame or list of dicts to Polars DataFrame for fast vector operations."""
    if hasattr(data, 'empty') and data.empty:
        return pl.DataFrame()
    return pl.from_pandas(data) if hasattr(data, 'to_numpy') else pl.DataFrame(data)
