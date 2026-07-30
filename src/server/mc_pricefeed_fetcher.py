#!/usr/bin/env python3
"""
MoneyControl Pricefeed Fetcher (Daily)
=======================================
Fetches https://priceapi.moneycontrol.com/pricefeed/nse/equitycash/{mcsymbol}

Unique data not available from Yahoo Finance or Trendlyne:
  IND_PE              — Industry-average P/E (e.g., 46.9 for Aerospace/Defence)
  cagr3Y/5Y/10Y       — Compounded annual growth rate (distinct from simple % return)
  PECONS/PBCONS/PCCONS— Analyst-consensus P/E, P/B, P/Cash earnings
  sc_ttm_cons         — Consensus TTM EPS (vs SC_TTM = actual) → EPS surprise
  P_C / PCCONS / CEPS — Price/Cash earnings and Cash EPS (pre-depreciation quality)
  AvgDelVolPer_3d/20d — Delivery % at short windows (NSE-specific, absent from Yahoo)
  cl3dPerChange       — 3-day price return (very recent micro-momentum)
  clYtdPerChange      — Year-to-date return (calendar momentum)
  30DayAvg/150DayAvg  — Pre-computed MAs not in Yahoo Finance
  52H/52L + dates     — 52-week high/low with exact dates
  upper/lower circuit — Price circuit limits (India-specific risk signal)
  MKT_LOT             — F&O lot size (eligibility + liquidity proxy)

ML features written to technical_signals (13 existing + 14 new = 27 total):
  mc_52w_high_dist_pct, mc_52w_low_dist_pct, mc_days_from_52wh
  mc_cagr_3y, mc_cagr_5y, mc_cagr_10y  (CAGR at 3/5/10 year)
  mc_ind_pe, mc_pe_vs_ind, mc_consensus_pe, mc_consensus_pb
  mc_ma30_dist_pct, mc_ma50_dist_pct, mc_ma150_dist_pct, mc_ma200_dist_pct
  mc_del_pct_3d, mc_del_pct_5d, mc_del_pct_20d, mc_del_acceleration
  mc_vol_ratio, mc_circuit_dist_pct, mc_fno_eligible
  mc_3d_return, mc_ytd_return
  mc_price_cash, mc_consensus_pb, mc_eps_vs_cons, mc_pe_fwd_discount

Run:
  python mc_pricefeed_fetcher.py             # all stocks with mcsymbol
  python mc_pricefeed_fetcher.py --symbol BEL
"""

import argparse
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import date, datetime

from curl_cffi import requests

from db_compat import connect, query_scalar

PRICEFEED_URL = "https://priceapi.moneycontrol.com/pricefeed/nse/equitycash/{scid}"

MC_HEADERS = {
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "en-US,en;q=0.9",
    "Origin": "https://www.moneycontrol.com",
    "Referer": "https://www.moneycontrol.com/",
    "Sec-Fetch-Dest": "empty",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Site": "same-site",
}

RATE_LIMIT_SEC = 0.35
BATCH_SIZE     = 15
BATCH_GAP_SEC  = 0.5


# ── Schema ──────────────────────────────────────────────────────────────────────

def ensure_schema(con) -> None:
    cur = con.cursor()
    cur.execute("""
        CREATE TABLE IF NOT EXISTS mc_pricefeed_daily (
            symbol          TEXT NOT NULL,
            date            TEXT NOT NULL,
            price           REAL,
            pe              REAL,
            pb              REAL,
            ind_pe          REAL,
            pe_vs_ind       REAL,
            consensus_pe    REAL,
            consensus_pb    REAL,
            consensus_eps   REAL,
            cagr_1y         REAL,
            cagr_3y         REAL,
            cagr_5y         REAL,
            cagr_10y        REAL,
            high_52w        REAL,
            low_52w         REAL,
            high_52w_date   TEXT,
            low_52w_date    TEXT,
            dist_52w_high   REAL,
            dist_52w_low    REAL,
            days_from_52wh  INTEGER,
            ma_30           REAL,
            ma_50           REAL,
            ma_150          REAL,
            ma_200          REAL,
            ma30_dist_pct   REAL,
            ma50_dist_pct   REAL,
            ma150_dist_pct  REAL,
            ma200_dist_pct  REAL,
            del_pct_3d      REAL,
            del_pct_5d      REAL,
            del_pct_8d      REAL,
            del_pct_20d     REAL,
            vol_today       BIGINT,
            vol_avg_20d     BIGINT,
            vol_ratio       REAL,
            upper_circuit   REAL,
            lower_circuit   REAL,
            circuit_dist_pct REAL,
            mktcap_cr       REAL,
            fno_lot_size    INTEGER,
            div_yield       REAL,
            ret_3d          REAL,
            ret_ytd         REAL,
            price_cash      REAL,
            consensus_price_cash REAL,
            cash_eps        REAL,
            eps_vs_cons     REAL,
            pe_fwd_discount REAL,
            fetched_at      TEXT DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (symbol, date)
        )
    """)
    cur.execute("CREATE INDEX IF NOT EXISTS idx_mcpf_sym ON mc_pricefeed_daily(symbol, date DESC)")
    con.commit()

    # Backfill new columns on existing mc_pricefeed_daily tables (no-op if already present)
    for ddl in [
        "ALTER TABLE mc_pricefeed_daily ADD COLUMN ma_30           REAL",
        "ALTER TABLE mc_pricefeed_daily ADD COLUMN ma_150          REAL",
        "ALTER TABLE mc_pricefeed_daily ADD COLUMN ma30_dist_pct   REAL",
        "ALTER TABLE mc_pricefeed_daily ADD COLUMN ma150_dist_pct  REAL",
        "ALTER TABLE mc_pricefeed_daily ADD COLUMN ret_3d          REAL",
        "ALTER TABLE mc_pricefeed_daily ADD COLUMN ret_ytd         REAL",
        "ALTER TABLE mc_pricefeed_daily ADD COLUMN price_cash      REAL",
        "ALTER TABLE mc_pricefeed_daily ADD COLUMN consensus_price_cash REAL",
        "ALTER TABLE mc_pricefeed_daily ADD COLUMN cash_eps        REAL",
        "ALTER TABLE mc_pricefeed_daily ADD COLUMN eps_vs_cons     REAL",
        "ALTER TABLE mc_pricefeed_daily ADD COLUMN pe_fwd_discount REAL",
    ]:
        try:
            cur.execute(ddl)
            con.commit()
        except Exception:
            con.rollback()

    for ddl in [
        "ALTER TABLE technical_signals ADD COLUMN mc_52w_high_dist_pct REAL",
        "ALTER TABLE technical_signals ADD COLUMN mc_52w_low_dist_pct  REAL",
        "ALTER TABLE technical_signals ADD COLUMN mc_days_from_52wh    INTEGER",
        "ALTER TABLE technical_signals ADD COLUMN mc_cagr_3y           REAL",
        "ALTER TABLE technical_signals ADD COLUMN mc_cagr_5y           REAL",
        "ALTER TABLE technical_signals ADD COLUMN mc_cagr_10y          REAL",
        "ALTER TABLE technical_signals ADD COLUMN mc_ind_pe            REAL",
        "ALTER TABLE technical_signals ADD COLUMN mc_pe_vs_ind         REAL",
        "ALTER TABLE technical_signals ADD COLUMN mc_consensus_pe      REAL",
        "ALTER TABLE technical_signals ADD COLUMN mc_consensus_pb      REAL",
        "ALTER TABLE technical_signals ADD COLUMN mc_ma30_dist_pct     REAL",
        "ALTER TABLE technical_signals ADD COLUMN mc_ma50_dist_pct     REAL",
        "ALTER TABLE technical_signals ADD COLUMN mc_ma150_dist_pct    REAL",
        "ALTER TABLE technical_signals ADD COLUMN mc_ma200_dist_pct    REAL",
        "ALTER TABLE technical_signals ADD COLUMN mc_del_pct_3d        REAL",
        "ALTER TABLE technical_signals ADD COLUMN mc_del_pct_5d        REAL",
        "ALTER TABLE technical_signals ADD COLUMN mc_del_pct_20d       REAL",
        "ALTER TABLE technical_signals ADD COLUMN mc_del_acceleration  REAL",
        "ALTER TABLE technical_signals ADD COLUMN mc_vol_ratio         REAL",
        "ALTER TABLE technical_signals ADD COLUMN mc_circuit_dist_pct  REAL",
        "ALTER TABLE technical_signals ADD COLUMN mc_fno_eligible      INTEGER",
        "ALTER TABLE technical_signals ADD COLUMN mc_3d_return         REAL",
        "ALTER TABLE technical_signals ADD COLUMN mc_ytd_return        REAL",
        "ALTER TABLE technical_signals ADD COLUMN mc_price_cash        REAL",
        "ALTER TABLE technical_signals ADD COLUMN mc_consensus_eps     REAL",
        "ALTER TABLE technical_signals ADD COLUMN mc_eps_vs_cons       REAL",
        "ALTER TABLE technical_signals ADD COLUMN mc_pe_fwd_discount   REAL",
    ]:
        try:
            cur.execute(ddl)
            con.commit()
        except Exception:
            con.rollback()


    cur.execute("""
        CREATE TABLE IF NOT EXISTS trendlyne_pe_history (
            symbol TEXT NOT NULL, date TEXT NOT NULL,
            pe_ttm REAL, fetched_at TEXT DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (symbol, date)
        )
    """)
    cur.execute("CREATE INDEX IF NOT EXISTS idx_tlpe_sym ON trendlyne_pe_history(symbol, date DESC)")

    cur.execute("""
        CREATE TABLE IF NOT EXISTS trendlyne_pb_history (
            symbol TEXT NOT NULL, date TEXT NOT NULL,
            pb_ratio REAL, fetched_at TEXT DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (symbol, date)
        )
    """)
    cur.execute("CREATE INDEX IF NOT EXISTS idx_tlpb_sym ON trendlyne_pb_history(symbol, date DESC)")
    con.commit()


# ── Fetch ────────────────────────────────────────────────────────────────────────

def _fetch(mcsymbol: str, session) -> dict | None:
    url = PRICEFEED_URL.format(scid=mcsymbol)
    try:
        r = session.get(url, headers=MC_HEADERS, timeout=10, impersonate="chrome110")
        if r.status_code != 200:
            return None
        payload = r.json()
        if payload.get("code") != "200" and payload.get("message") != "Success":
            return None
        return payload.get("data", {})
    except Exception as e:
        print(f"  [{mcsymbol}] pricefeed error: {e}")
        return None


def _sf(v, default=None) -> float | None:
    if v in (None, "", "0", 0):
        return default
    try:
        return float(str(v).replace(",", "").strip())
    except (TypeError, ValueError):
        return default


def _si(v) -> int | None:
    f = _sf(v)
    return int(f) if f is not None else None


def _days_since(date_str: str) -> int | None:
    if not date_str:
        return None
    for fmt in ("%Y-%m-%d", "%d-%b-%Y", "%d %b %Y"):
        try:
            dt = datetime.strptime(date_str.strip(), fmt).date()
            return (date.today() - dt).days
        except ValueError:
            continue
    return None


def extract_features(d: dict) -> dict:
    price     = _sf(d.get("pricecurrent") or d.get("LP"))
    pe        = _sf(d.get("PE"))
    ind_pe    = _sf(d.get("IND_PE"))
    h52       = _sf(d.get("52H") or d.get("HP"))
    l52       = _sf(d.get("52L"))
    ma30      = _sf(d.get("30DayAvg"))
    ma50      = _sf(d.get("50DayAvg"))
    ma150     = _sf(d.get("150DayAvg"))
    ma200     = _sf(d.get("200DayAvg"))
    vol_today = _si(d.get("VOL"))
    vol_avg   = _si(d.get("AvgVolQtyTraded_20day"))

    consensus_pe  = _sf(d.get("PECONS"))
    consensus_eps = _sf(d.get("sc_ttm_cons"))
    actual_eps    = _sf(d.get("SC_TTM"))

    pe_vs_ind      = round(pe / ind_pe - 1, 4) if pe and ind_pe and ind_pe > 0 else None
    dist_52h       = round((price - h52) / h52 * 100, 2) if price and h52 and h52 > 0 else None
    dist_52l       = round((price - l52) / l52 * 100, 2) if price and l52 and l52 > 0 else None
    ma30_dist      = round((price - ma30) / ma30 * 100, 2) if price and ma30 and ma30 > 0 else None
    ma50_dist      = round((price - ma50) / ma50 * 100, 2) if price and ma50 and ma50 > 0 else None
    ma150_dist     = round((price - ma150) / ma150 * 100, 2) if price and ma150 and ma150 > 0 else None
    ma200_dist     = round((price - ma200) / ma200 * 100, 2) if price and ma200 and ma200 > 0 else None
    vol_ratio      = round(vol_today / vol_avg, 3) if vol_today and vol_avg and vol_avg > 0 else None
    # positive = actual TTM EPS ahead of analyst consensus (beat), negative = miss
    eps_vs_cons    = round((actual_eps - consensus_eps) / abs(consensus_eps) * 100, 2) \
                     if actual_eps and consensus_eps and consensus_eps != 0 else None
    # negative means analysts expect earnings growth (consensus forward PE < trailing PE = cheaper fwd)
    pe_fwd_discount = round(consensus_pe / pe - 1, 4) \
                      if consensus_pe and pe and pe > 0 else None

    ucirc = _sf(d.get("upper_circuit_limit"))
    circuit_dist = round((ucirc - price) / price * 100, 2) if ucirc and price and price > 0 else None

    return {
        "price":                price,
        "pe":                   pe,
        "pb":                   _sf(d.get("PB")),
        "ind_pe":               ind_pe,
        "pe_vs_ind":            pe_vs_ind,
        "consensus_pe":         consensus_pe,
        "consensus_pb":         _sf(d.get("PBCONS")),
        "consensus_eps":        consensus_eps,
        "eps_vs_cons":          eps_vs_cons,
        "pe_fwd_discount":      pe_fwd_discount,
        "cagr_1y":              _sf(d.get("cagr1Y")),
        "cagr_3y":              _sf(d.get("cagr3Y")),
        "cagr_5y":              _sf(d.get("cagr5Y")),
        "cagr_10y":             _sf(d.get("cagr10Y")),
        "ret_3d":               _sf(d.get("cl3dPerChange")),
        "ret_ytd":              _sf(d.get("clYtdPerChange")),
        "high_52w":             h52,
        "low_52w":              l52,
        "high_52w_date":        d.get("52HDate"),
        "low_52w_date":         d.get("52LDate"),
        "dist_52w_high":        dist_52h,
        "dist_52w_low":         dist_52l,
        "days_from_52wh":       _days_since(d.get("52HDate")),
        "ma_30":                ma30,
        "ma_50":                ma50,
        "ma_150":               ma150,
        "ma_200":               ma200,
        "ma30_dist_pct":        ma30_dist,
        "ma50_dist_pct":        ma50_dist,
        "ma150_dist_pct":       ma150_dist,
        "ma200_dist_pct":       ma200_dist,
        "del_pct_3d":           _sf(d.get("AvgDelVolPer_3day")),
        "del_pct_5d":           _sf(d.get("AvgDelVolPer_5day")),
        "del_pct_8d":           _sf(d.get("AvgDelVolPer_8day")),
        "del_pct_20d":          _sf(d.get("AvgDelVolPer_20day")),
        "vol_today":            vol_today,
        "vol_avg_20d":          vol_avg,
        "vol_ratio":            vol_ratio,
        "upper_circuit":        ucirc,
        "lower_circuit":        _sf(d.get("lower_circuit_limit")),
        "circuit_dist_pct":     circuit_dist,
        "mktcap_cr":            _sf(d.get("MKTCAP")),
        "fno_lot_size":         _si(d.get("MKT_LOT")),
        "div_yield":            _sf(d.get("DY")),
        "price_cash":           _sf(d.get("P_C")),
        "consensus_price_cash": _sf(d.get("PCCONS")),
        "cash_eps":             _sf(d.get("CEPS")),
    }


def upsert_row(symbol: str, today: str, f: dict, con) -> None:
    cur = con.cursor()
    cur.execute("""
        INSERT INTO mc_pricefeed_daily (
            symbol, date, price, pe, pb, ind_pe, pe_vs_ind,
            consensus_pe, consensus_pb, consensus_eps, eps_vs_cons, pe_fwd_discount,
            cagr_1y, cagr_3y, cagr_5y, cagr_10y,
            ret_3d, ret_ytd,
            high_52w, low_52w, high_52w_date, low_52w_date,
            dist_52w_high, dist_52w_low, days_from_52wh,
            ma_30, ma_50, ma_150, ma_200,
            ma30_dist_pct, ma50_dist_pct, ma150_dist_pct, ma200_dist_pct,
            del_pct_3d, del_pct_5d, del_pct_8d, del_pct_20d,
            vol_today, vol_avg_20d, vol_ratio,
            upper_circuit, lower_circuit, circuit_dist_pct,
            mktcap_cr, fno_lot_size, div_yield,
            price_cash, consensus_price_cash, cash_eps
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(symbol, date) DO UPDATE SET
            price=excluded.price, pe=excluded.pe, pb=excluded.pb,
            ind_pe=excluded.ind_pe, pe_vs_ind=excluded.pe_vs_ind,
            consensus_pe=excluded.consensus_pe, consensus_pb=excluded.consensus_pb,
            consensus_eps=excluded.consensus_eps,
            eps_vs_cons=excluded.eps_vs_cons, pe_fwd_discount=excluded.pe_fwd_discount,
            cagr_1y=excluded.cagr_1y, cagr_3y=excluded.cagr_3y,
            cagr_5y=excluded.cagr_5y, cagr_10y=excluded.cagr_10y,
            ret_3d=excluded.ret_3d, ret_ytd=excluded.ret_ytd,
            high_52w=excluded.high_52w, low_52w=excluded.low_52w,
            high_52w_date=excluded.high_52w_date, low_52w_date=excluded.low_52w_date,
            dist_52w_high=excluded.dist_52w_high, dist_52w_low=excluded.dist_52w_low,
            days_from_52wh=excluded.days_from_52wh,
            ma_30=excluded.ma_30, ma_50=excluded.ma_50,
            ma_150=excluded.ma_150, ma_200=excluded.ma_200,
            ma30_dist_pct=excluded.ma30_dist_pct, ma50_dist_pct=excluded.ma50_dist_pct,
            ma150_dist_pct=excluded.ma150_dist_pct, ma200_dist_pct=excluded.ma200_dist_pct,
            del_pct_3d=excluded.del_pct_3d, del_pct_5d=excluded.del_pct_5d,
            del_pct_8d=excluded.del_pct_8d, del_pct_20d=excluded.del_pct_20d,
            vol_today=excluded.vol_today, vol_avg_20d=excluded.vol_avg_20d,
            vol_ratio=excluded.vol_ratio,
            upper_circuit=excluded.upper_circuit, lower_circuit=excluded.lower_circuit,
            circuit_dist_pct=excluded.circuit_dist_pct,
            mktcap_cr=excluded.mktcap_cr, fno_lot_size=excluded.fno_lot_size,
            div_yield=excluded.div_yield,
            price_cash=excluded.price_cash,
            consensus_price_cash=excluded.consensus_price_cash,
            cash_eps=excluded.cash_eps,
            fetched_at=CURRENT_TIMESTAMP
    """, (
        symbol, today,
        f.get("price"), f.get("pe"), f.get("pb"),
        f.get("ind_pe"), f.get("pe_vs_ind"),
        f.get("consensus_pe"), f.get("consensus_pb"), f.get("consensus_eps"),
        f.get("eps_vs_cons"), f.get("pe_fwd_discount"),
        f.get("cagr_1y"), f.get("cagr_3y"), f.get("cagr_5y"), f.get("cagr_10y"),
        f.get("ret_3d"), f.get("ret_ytd"),
        f.get("high_52w"), f.get("low_52w"), f.get("high_52w_date"), f.get("low_52w_date"),
        f.get("dist_52w_high"), f.get("dist_52w_low"), f.get("days_from_52wh"),
        f.get("ma_30"), f.get("ma_50"), f.get("ma_150"), f.get("ma_200"),
        f.get("ma30_dist_pct"), f.get("ma50_dist_pct"),
        f.get("ma150_dist_pct"), f.get("ma200_dist_pct"),
        f.get("del_pct_3d"), f.get("del_pct_5d"), f.get("del_pct_8d"), f.get("del_pct_20d"),
        f.get("vol_today"), f.get("vol_avg_20d"), f.get("vol_ratio"),
        f.get("upper_circuit"), f.get("lower_circuit"), f.get("circuit_dist_pct"),
        f.get("mktcap_cr"), f.get("fno_lot_size"), f.get("div_yield"),
        f.get("price_cash"), f.get("consensus_price_cash"), f.get("cash_eps"),
    ))
    con.commit()


def backfill_technical_signals(symbol: str, ts_floor: str, f: dict, con) -> None:
    """Writes only the columns that genuinely have no point-in-time-correct alternative
    (fundamentals/consensus/delivery -- live-snapshot-only by nature). The price/volume
    columns this used to write (mc_ma30/50/150/200_dist_pct, mc_3d_return,
    mc_52w_high/low_dist_pct, mc_days_from_52wh, mc_ytd_return, mc_vol_ratio) are now owned
    exclusively by mc_price_features_ohlcv.py, which derives them from stock_ohlcv and is
    correct for every historical date, not just today.

    BUG FOUND 2026-07-19: the old UPDATE here had `WHERE symbol = ?` with NO date filter, so
    every run smeared today's live snapshot across a symbol's ENTIRE technical_signals
    history via COALESCE-fills-null-once-then-frozen-forever (confirmed: mc_days_from_52wh,
    a day-counter that must increment daily, was IDENTICAL across 8-16 different dates for
    every symbol checked). The `date >= ? ELSE NULL` guard below is the same pattern already
    used correctly elsewhere in this codebase (trendlyne_fundamentals_fetcher.py,
    working_capital_fetcher.py, financial_ratios_fetcher.py) for exactly this class of
    live-only data: only apply to today-or-later rows, and explicitly NULL any older row
    that's still carrying yesterday's frozen value instead of silently keeping it.

    BUG FOUND 2026-07-28 (Finding #64 of the full-stack audit): `ts_floor` (the guard
    threshold, named `today` before this fix) was `date.today()`, the exact bug class
    already fixed in 6 sibling fetchers on 2026-07-25 -- on a closed-market day this
    job still runs via ml-daily-ops' closed-day-early-batch dispatcher, `date.today()`
    then matches zero technical_signals rows, and the ELSE branch nulls every one of
    the columns above across a symbol's ENTIRE history. Callers must now pass the
    last completed trading session (MAX(date) FROM stock_ohlcv), not raw
    date.today() -- see main()'s `ts_floor` computation.
    """
    cur = con.cursor()
    # del_acceleration: 3-day delivery % relative to 20-day baseline (positive = rising institutional interest)
    d3  = f.get("del_pct_3d")
    d20 = f.get("del_pct_20d")
    del_acc = round(d3 / d20 - 1, 4) if d3 and d20 and d20 > 0 else None
    fno_elig = 1 if f.get("fno_lot_size") else 0

    cur.execute("""
        UPDATE technical_signals SET
            mc_cagr_3y           = CASE WHEN date >= ? THEN COALESCE(?, mc_cagr_3y)           ELSE NULL END,
            mc_cagr_5y           = CASE WHEN date >= ? THEN COALESCE(?, mc_cagr_5y)           ELSE NULL END,
            mc_cagr_10y          = CASE WHEN date >= ? THEN COALESCE(?, mc_cagr_10y)          ELSE NULL END,
            mc_ind_pe            = CASE WHEN date >= ? THEN COALESCE(?, mc_ind_pe)            ELSE NULL END,
            mc_pe_vs_ind         = CASE WHEN date >= ? THEN COALESCE(?, mc_pe_vs_ind)         ELSE NULL END,
            mc_consensus_pe      = CASE WHEN date >= ? THEN COALESCE(?, mc_consensus_pe)      ELSE NULL END,
            mc_consensus_pb      = CASE WHEN date >= ? THEN COALESCE(?, mc_consensus_pb)      ELSE NULL END,
            mc_del_pct_3d        = CASE WHEN date >= ? THEN COALESCE(?, mc_del_pct_3d)        ELSE NULL END,
            mc_del_pct_5d        = CASE WHEN date >= ? THEN COALESCE(?, mc_del_pct_5d)        ELSE NULL END,
            mc_del_pct_20d       = CASE WHEN date >= ? THEN COALESCE(?, mc_del_pct_20d)       ELSE NULL END,
            mc_del_acceleration  = CASE WHEN date >= ? THEN COALESCE(?, mc_del_acceleration)  ELSE NULL END,
            mc_circuit_dist_pct  = CASE WHEN date >= ? THEN COALESCE(?, mc_circuit_dist_pct)  ELSE NULL END,
            mc_fno_eligible      = CASE WHEN date >= ? THEN COALESCE(?, mc_fno_eligible)      ELSE NULL END,
            mc_price_cash        = CASE WHEN date >= ? THEN COALESCE(?, mc_price_cash)        ELSE NULL END,
            mc_consensus_eps     = CASE WHEN date >= ? THEN COALESCE(?, mc_consensus_eps)     ELSE NULL END,
            mc_eps_vs_cons       = CASE WHEN date >= ? THEN COALESCE(?, mc_eps_vs_cons)       ELSE NULL END,
            mc_pe_fwd_discount   = CASE WHEN date >= ? THEN COALESCE(?, mc_pe_fwd_discount)   ELSE NULL END
        WHERE symbol = ?
    """, (
        ts_floor, f.get("cagr_3y"), ts_floor, f.get("cagr_5y"), ts_floor, f.get("cagr_10y"),
        ts_floor, f.get("ind_pe"), ts_floor, f.get("pe_vs_ind"),
        ts_floor, f.get("consensus_pe"), ts_floor, f.get("consensus_pb"),
        ts_floor, f.get("del_pct_3d"), ts_floor, f.get("del_pct_5d"), ts_floor, f.get("del_pct_20d"),
        ts_floor, del_acc, ts_floor, f.get("circuit_dist_pct"), ts_floor, fno_elig,
        ts_floor, f.get("price_cash"), ts_floor, f.get("consensus_eps"),
        ts_floor, f.get("eps_vs_cons"), ts_floor, f.get("pe_fwd_discount"),
        symbol,
    ))
    con.commit()



def append_pe_pb_history(symbol: str, today: str, pe: float | None, pb: float | None, con) -> None:
    """Append today's MC-sourced PE/PB into the same history tables
    trendlyne_fundamentals_fetcher.py used to populate weekly from Trendlyne's dead
    PE_TTM_SHARE_NOW/PBV_A_SHARE_NOW params. Keeps pe_pct_rank_252d/pb_pct_rank_252d
    (computed from these tables) fresh daily instead of weekly."""
    cur = con.cursor()
    if pe is not None:
        cur.execute("""
            INSERT INTO trendlyne_pe_history (symbol, date, pe_ttm)
            VALUES (?, ?, ?)
            ON CONFLICT(symbol, date) DO UPDATE SET
                pe_ttm = excluded.pe_ttm,
                fetched_at = CURRENT_TIMESTAMP
        """, (symbol, today, round(float(pe), 4)))
    if pb is not None:
        cur.execute("""
            INSERT INTO trendlyne_pb_history (symbol, date, pb_ratio)
            VALUES (?, ?, ?)
            ON CONFLICT(symbol, date) DO UPDATE SET
                pb_ratio = excluded.pb_ratio,
                fetched_at = CURRENT_TIMESTAMP
        """, (symbol, today, round(float(pb), 4)))
    con.commit()

def _load_stocks(symbol_filter: str | None, con) -> list[tuple[str, str]]:
    cur = con.cursor()
    cur.execute("""
        SELECT symbol, mcsymbol FROM nse_stocks
        WHERE mcsymbol IS NOT NULL AND mcsymbol != ''
        ORDER BY symbol
    """)
    rows = [(r[0], r[1]) for r in cur.fetchall()]
    if symbol_filter:
        rows = [(s, m) for s, m in rows if s.upper() == symbol_filter.upper()]
    return rows


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--symbol", default=None)
    args = parser.parse_args()

    con = connect()
    ensure_schema(con)

    stocks = _load_stocks(args.symbol, con)
    if not stocks:
        print("[MCPricefeed] No stocks with mcsymbol found.")
        return

    print(f"[MCPricefeed] Fetching {len(stocks)} stocks in batches of {BATCH_SIZE} ({BATCH_GAP_SEC}s gap)…")
    session = requests.Session()
    today = date.today().isoformat()
    # ts_floor anchors backfill_technical_signals' write guard to the last completed trading
    # session (not raw date.today()) -- see that function's docstring for why. `today` above
    # is kept as-is for upsert_row/append_pe_pb_history, which genuinely want the actual
    # calendar date as their per-day snapshot key.
    ohlcv_max = query_scalar("SELECT MAX(date) AS d FROM stock_ohlcv")
    ts_floor = str(ohlcv_max)[:10] if ohlcv_max else today
    ok = 0
    done = 0

    def _fetch_one(args):
        symbol, mcsymbol = args
        data = _fetch(mcsymbol, session)
        return symbol, mcsymbol, data

    for batch_start in range(0, len(stocks), BATCH_SIZE):
        batch = stocks[batch_start:batch_start + BATCH_SIZE]
        with ThreadPoolExecutor(max_workers=len(batch)) as pool:
            futures = [pool.submit(_fetch_one, item) for item in batch]
            for fut in as_completed(futures):
                symbol, mcsymbol, data = fut.result()
                done += 1
                if data is None:
                    print(f"  [{done}/{len(stocks)}] {symbol}: no data")
                    continue
                f = extract_features(data)
                upsert_row(symbol, today, f, con)
                backfill_technical_signals(symbol, ts_floor, f, con)
                append_pe_pb_history(symbol, today, f.get("pe"), f.get("pb"), con)
                ind_pe_str = f"IND_PE={f.get('ind_pe','?')} vs_ind={f.get('pe_vs_ind','?')}"
                cagr_str   = f"CAGR3={f.get('cagr_3y','?')}% CAGR5={f.get('cagr_5y','?')}%"
                ma_str     = f"MA200={f.get('ma200_dist_pct','?')}%"
                print(f"  [{done}/{len(stocks)}] {symbol}: {ind_pe_str} | {cagr_str} | {ma_str}")
                ok += 1
        time.sleep(BATCH_GAP_SEC)

    print(f"[MCPricefeed] Done. {ok}/{len(stocks)} stocks.")
    con.close()


if __name__ == "__main__":
    main()
