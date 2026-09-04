#!/usr/bin/env python3
"""
Trendlyne Fundamentals Fetcher â€” Chart-Data Series
===================================================
Fetches 2 time-series params per stock from Trendlyne's chart-data API, plus DVM:

  EPS_TTM          â†’ quarterly EPS trailing-12-month (31 pts, 8+ years); DVM scores embedded
  DIVIDEND_YIELD_TTM_Q â†’ quarterly dividend yield (32 pts, 2019â€“now)

PE_TTM_SHARE_NOW / PBV_A_SHARE_NOW are no longer fetched here â€” mc_pricefeed_fetcher.py
already pulls each stock's own daily PE/PB and appends it into trendlyne_pe_history /
trendlyne_pb_history directly, so the percentile-rank features below now update daily.

Endpoint: https://trendlyne.com/mapp/v1/stock/chart-data/{tlid}/{param}/?format=json
Key: ?format=json required â€” DRF returns HTML by default.

ML features computed from stored history:
  eps_ttm, eps_growth_yoy, eps_growth_qoq, eps_acceleration
  pe_pct_rank_252d   (0-100: how expensive vs own 1-year history)
  pe_vs_median_1yr   (% premium/discount to 1-yr median PE)
  pb_pct_rank_252d   (0-100: same for P/B)
  div_yield_ttm      (% dividend yield)
  dvm_durability, dvm_valuation, dvm_momentum (0-100)

Stock universe: scripts/stocklist.json (2005 stocks). Fetched in parallel batches of
BATCH_SIZE with BATCH_GAP_SEC between batches.

Run:
  python trendlyne_fundamentals_fetcher.py           # all stocks in stocklist.json
  python trendlyne_fundamentals_fetcher.py --symbol BEL
"""

import polars as pl
from pydantic import BaseModel
from base_fetcher import BaseFetcher, governed_fetcher

class TrendlyneFundamentalsFetcherSchema(BaseModel):
    symbol: str | None = None
    date: str | None = None

class TrendlyneFundamentalsFetcherBaseFetcher(BaseFetcher[TrendlyneFundamentalsFetcherSchema]):
    fetcher_name = 'TrendlyneFundamentalsFetcher'
    domain = 'trendlyne.com'
    schema = TrendlyneFundamentalsFetcherSchema
    min_interval_sec = 0.5


import argparse
import json
import os
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import date, datetime, timedelta, timezone

import requests
from requests.adapters import HTTPAdapter

from db_compat import connect
from as_of import logical_write_floor
from fetch_utils import TRENDLYNE_MAX_CONCURRENT, cap_to_run_budget
import sys

BASE_URL = "https://trendlyne.com/mapp/v1/stock/chart-data/{tlid}/{param}/"

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
BATCH_GAP_SEC = 0.5
STOCKLIST_PATH = os.path.join(os.path.dirname(__file__), "..", "..", "scripts", "stocklist.json")


# â”€â”€ Schema â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

def ensure_schema(con) -> None:
    cur = con.cursor()

    cur.execute("""
        CREATE TABLE IF NOT EXISTS trendlyne_eps_history (
            symbol TEXT NOT NULL, date TEXT NOT NULL,
            eps_ttm REAL, fetched_at TEXT DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (symbol, date)
        )
    """)
    cur.execute("CREATE INDEX IF NOT EXISTS idx_tleps_sym ON trendlyne_eps_history(symbol, date DESC)")

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

    cur.execute("""
        CREATE TABLE IF NOT EXISTS trendlyne_div_yield_history (
            symbol TEXT NOT NULL, date TEXT NOT NULL,
            div_yield_pct REAL, fetched_at TEXT DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (symbol, date)
        )
    """)
    cur.execute("CREATE INDEX IF NOT EXISTS idx_tldy_sym ON trendlyne_div_yield_history(symbol, date DESC)")

    cur.execute("""
        CREATE TABLE IF NOT EXISTS trendlyne_dvm_scores (
            symbol TEXT NOT NULL, date TEXT NOT NULL,
            d_score INTEGER, v_score INTEGER, m_score INTEGER,
            d_color TEXT, v_color TEXT, m_color TEXT,
            fetched_at TEXT DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (symbol, date)
        )
    """)
    con.commit()

    # AF-20260827-14 / AF-20260829-18: these 12 columns have existed on technical_signals for
    # months (db/schema.postgres.sql is schema-of-record and already carries them). A bare
    # "ADD COLUMN" without IF NOT EXISTS still requests an ACCESS EXCLUSIVE lock before it can
    # even discover the column exists and throw DuplicateColumn -- and once that lock request is
    # queued, every concurrent reader of technical_signals (a hot table read by dozens of jobs)
    # queues behind it too, by Postgres's FIFO lock-queue-per-relation rule. That queued-for-
    # minutes ALTER TABLE, re-run on every single fetcher invocation, is what repeatedly stalled
    # this session's `integrity_sweep.py`/pytest runs on 2026-08-29 while ml-weekly-retrain was
    # active. Fix: IF NOT EXISTS (no-op when already present, no exception) + a short
    # `lock_timeout` scoped to just this block so a genuinely busy table makes this skip fast
    # instead of holding a place in the lock queue for however long the blocker takes.
    # NOTE: SET LOCAL would reset after the first per-statement commit() below, leaving
    # statements 2-12 unprotected -- use a session-scoped SET, restored in the finally.
    cur.execute("SET lock_timeout = '2s'")
    try:
        for ddl in [
            "ALTER TABLE technical_signals ADD COLUMN IF NOT EXISTS eps_ttm REAL",
            "ALTER TABLE technical_signals ADD COLUMN IF NOT EXISTS eps_growth_yoy REAL",
            "ALTER TABLE technical_signals ADD COLUMN IF NOT EXISTS eps_growth_qoq REAL",
            "ALTER TABLE technical_signals ADD COLUMN IF NOT EXISTS eps_acceleration REAL",
            "ALTER TABLE technical_signals ADD COLUMN IF NOT EXISTS pe_ttm REAL",
            "ALTER TABLE technical_signals ADD COLUMN IF NOT EXISTS pe_pct_rank_252d REAL",
            "ALTER TABLE technical_signals ADD COLUMN IF NOT EXISTS pe_vs_median_1yr REAL",
            "ALTER TABLE technical_signals ADD COLUMN IF NOT EXISTS pb_pct_rank_252d REAL",
            "ALTER TABLE technical_signals ADD COLUMN IF NOT EXISTS div_yield_ttm REAL",
            "ALTER TABLE technical_signals ADD COLUMN IF NOT EXISTS dvm_durability INTEGER",
            "ALTER TABLE technical_signals ADD COLUMN IF NOT EXISTS dvm_valuation INTEGER",
            "ALTER TABLE technical_signals ADD COLUMN IF NOT EXISTS dvm_momentum INTEGER",
        ]:
            try:
                # AF-20260901: IF NOT EXISTS alone still queued a 2s-lock-timeout cancel per
                # column on 09-01 (9 cancels in the postgres log) because the no-op ALTER
                # still requests the ACCESS EXCLUSIVE lock before discovering the column
                # exists. The lock-free pre-check skips the ALTER entirely on the common
                # path; the DDL only runs when the column is genuinely missing.
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


# â”€â”€ Fetch helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

def _fetch(tlid: str, param: str, session: requests.Session) -> dict | None:
    url = BASE_URL.format(tlid=tlid, param=param)
    try:
        r = session.get(url, params={"format": "json"}, timeout=15)
        if r.status_code != 200:
            return None
        data = r.json()
        if data.get("head", {}).get("status") != "0":
            return None
        return data.get("body", {})
    except Exception as e:
        print(f"  [{param}] error: {e}", file=sys.stderr)
        return None


def _ts_to_date(ts_ms: int) -> str:
    return datetime.fromtimestamp(ts_ms / 1000, tz=timezone.utc).strftime("%Y-%m-%d")


def _parse_eod(body: dict) -> list[tuple[str, float]]:
    """Return [(date_str, value), ...] sorted most-recent first."""
    series = []
    for ts_ms, val in body.get("eodData", []):
        try:
            series.append((_ts_to_date(int(ts_ms)), float(val)))
        except (TypeError, ValueError):
            continue
    return series


def _extract_dvm(body: dict) -> dict | None:
    headers = body.get("stockHeaders", [])
    values  = body.get("stockData",   [])
    if not headers or not values:
        return None
    idx = {h["unique_name"]: i for i, h in enumerate(headers)}
    def get(key):
        i = idx.get(key)
        return values[i] if i is not None and i < len(values) else None
    d, v, m = get("d_value"), get("v_value"), get("m_value")
    if d is None and v is None and m is None:
        return None
    return {
        "d_score": int(d) if d is not None else None,
        "v_score": int(v) if v is not None else None,
        "m_score": int(m) if m is not None else None,
        "d_color": get("d_color"), "v_color": get("v_color"), "m_color": get("m_color"),
    }


# â”€â”€ EPS feature computation â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

def _compute_eps_features(series: list[tuple[str, float]]) -> dict:
    if not series:
        return {}
    latest_eps = series[0][1]
    prev_q  = series[1][1]  if len(series) > 1 else None
    prev_y  = series[4][1]  if len(series) > 4 else None
    prev_y2 = series[8][1]  if len(series) > 8 else None

    def pct(cur, base):
        if base is None or base == 0: return None
        return round((cur - base) / abs(base) * 100, 2)

    g_qoq = pct(latest_eps, prev_q)
    g_yoy = pct(latest_eps, prev_y)
    prior_yoy = pct(prev_y, prev_y2) if prev_y is not None else None
    accel = round(g_yoy - prior_yoy, 2) if g_yoy is not None and prior_yoy is not None else None

    return {
        "eps_ttm":          round(latest_eps, 4),
        "eps_growth_qoq":   g_qoq,
        "eps_growth_yoy":   g_yoy,
        "eps_acceleration": accel,
    }


# â”€â”€ PE/PB percentile from stored history â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

def _pe_features_from_db(symbol: str, con) -> dict:
    cur = con.cursor()
    cur.execute("""
        SELECT pe_ttm FROM trendlyne_pe_history
        WHERE symbol = ? ORDER BY date DESC LIMIT 253
    """, (symbol,))
    vals = [r[0] for r in cur.fetchall() if r[0] is not None]
    if len(vals) < 5:
        return {}
    current = vals[0]
    hist    = vals[1:]   # exclude today for rank
    pct_rank = round(sum(1 for v in hist if current > v) / len(hist) * 100, 1)
    median   = sorted(vals)[ len(vals)//2 ]
    vs_med   = round((current / median - 1) * 100, 2) if median else None
    return {
        "pe_ttm":           round(current, 2),
        "pe_pct_rank_252d": pct_rank,
        "pe_vs_median_1yr": vs_med,
    }


def _pb_features_from_db(symbol: str, con) -> dict:
    cur = con.cursor()
    cur.execute("""
        SELECT pb_ratio FROM trendlyne_pb_history
        WHERE symbol = ? ORDER BY date DESC LIMIT 253
    """, (symbol,))
    vals = [r[0] for r in cur.fetchall() if r[0] is not None]
    if len(vals) < 5:
        return {}
    current = vals[0]
    hist    = vals[1:]
    pct_rank = round(sum(1 for v in hist if current > v) / len(hist) * 100, 1)
    return {"pb_pct_rank_252d": pct_rank}


# â”€â”€ Persist â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

def _upsert_series(table: str, col: str, symbol: str,
                   series: list[tuple[str, float]], con) -> int:
    cur = con.cursor()
    for dt, val in series:
        cur.execute(f"""
            INSERT INTO {table} (symbol, date, {col})
            VALUES (?,?,?)
            ON CONFLICT(symbol, date) DO UPDATE SET
                {col} = excluded.{col},
                fetched_at = CURRENT_TIMESTAMP
        """, (symbol, dt, round(float(val), 6)))
    con.commit()
    return len(series)


def _upsert_dvm(symbol: str, today: str, dvm: dict, con) -> None:
    cur = con.cursor()
    cur.execute("""
        INSERT INTO trendlyne_dvm_scores
            (symbol, date, d_score, v_score, m_score, d_color, v_color, m_color)
        VALUES (?,?,?,?,?,?,?,?)
        ON CONFLICT(symbol, date) DO UPDATE SET
            d_score=excluded.d_score, v_score=excluded.v_score, m_score=excluded.m_score,
            d_color=excluded.d_color, v_color=excluded.v_color, m_color=excluded.m_color,
            fetched_at=CURRENT_TIMESTAMP
    """, (symbol, today, dvm.get("d_score"), dvm.get("v_score"), dvm.get("m_score"),
          dvm.get("d_color"), dvm.get("v_color"), dvm.get("m_color")))
    con.commit()


def _backfill_technical_signals(symbol: str, today: str, features: dict, con) -> None:
    if not features:
        return
    # Point-in-time: these are the CURRENT Trendlyne snapshot (DVM changes daily, EPS/PE/div
    # are the latest disclosed values) with no per-row history to reconstruct. Stamp only rows
    # on/after the fetch date and NULL older ones — never smear today's fundamentals onto history
    # the ML ensemble trains on (dvm_*/eps_ttm/pe_ttm are all features). Same anti-look-ahead
    # discipline as the shareholding + ET_Stats fetchers.
    cur = con.cursor()
    cur.execute("""
        UPDATE technical_signals SET
            eps_ttm          = CASE WHEN date >= ? THEN COALESCE(?, eps_ttm)          ELSE eps_ttm END,
            eps_growth_yoy   = CASE WHEN date >= ? THEN COALESCE(?, eps_growth_yoy)   ELSE eps_growth_yoy END,
            eps_growth_qoq   = CASE WHEN date >= ? THEN COALESCE(?, eps_growth_qoq)   ELSE eps_growth_qoq END,
            eps_acceleration = CASE WHEN date >= ? THEN COALESCE(?, eps_acceleration) ELSE eps_acceleration END,
            pe_ttm           = CASE WHEN date >= ? THEN COALESCE(?, pe_ttm)           ELSE pe_ttm END,
            pe_pct_rank_252d = CASE WHEN date >= ? THEN COALESCE(?, pe_pct_rank_252d) ELSE pe_pct_rank_252d END,
            pe_vs_median_1yr = CASE WHEN date >= ? THEN COALESCE(?, pe_vs_median_1yr) ELSE pe_vs_median_1yr END,
            pb_pct_rank_252d = CASE WHEN date >= ? THEN COALESCE(?, pb_pct_rank_252d) ELSE pb_pct_rank_252d END,
            div_yield_ttm    = CASE WHEN date >= ? THEN COALESCE(?, div_yield_ttm)    ELSE div_yield_ttm END,
            dvm_durability   = CASE WHEN date >= ? THEN COALESCE(?, dvm_durability)   ELSE dvm_durability END,
            dvm_valuation    = CASE WHEN date >= ? THEN COALESCE(?, dvm_valuation)    ELSE dvm_valuation END,
            dvm_momentum     = CASE WHEN date >= ? THEN COALESCE(?, dvm_momentum)     ELSE dvm_momentum END
        WHERE symbol = ?
    """, (
        today, features.get("eps_ttm"),          today, features.get("eps_growth_yoy"),
        today, features.get("eps_growth_qoq"),   today, features.get("eps_acceleration"),
        today, features.get("pe_ttm"),           today, features.get("pe_pct_rank_252d"),
        today, features.get("pe_vs_median_1yr"), today, features.get("pb_pct_rank_252d"),
        today, features.get("div_yield_ttm"),
        today, features.get("dvm_d"),            today, features.get("dvm_v"),
        today, features.get("dvm_m"),
        symbol,
    ))
    con.commit()


# â”€â”€ Stock list â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

def _load_stocks(symbol_filter: str | None, skip_done_for_date: str | None = None) -> list[tuple[str, str]]:
    """Return [(symbol, tlid), ...] from scripts/stocklist.json — the canonical
    provider-mapping table (2005 stocks) — instead of the much larger (7000+)
    trendlyne_screener_stocks fallback universe, which is why this fetcher used to
    blow past its timeout ceiling."""
    with open(STOCKLIST_PATH, encoding="utf-8") as f:
        entries = json.load(f)
    rows = [(e["symbol"], str(e["tlid"])) for e in entries if e.get("symbol") and e.get("tlid")]
    if symbol_filter:
        rows = [(s, t) for s, t in rows if s.upper() == symbol_filter.upper()]
    # Resume, same shape as trendlyne_adv_tech_fetcher.py's loader. Without it every run
    # restarts at the same alphabetical position, so the leading slice is re-fetched forever and
    # coverage never advances past one WAF allowance -- see cap_to_run_budget in fetch_utils.py.
    if skip_done_for_date:
        con = connect()
        try:
            cur = con.cursor()
            cur.execute("SELECT symbol FROM trendlyne_dvm_scores WHERE date = ?", (skip_done_for_date,))
            done = {r[0] for r in cur.fetchall()}
        finally:
            con.close()
        if done:
            before = len(rows)
            rows = [(s, t) for s, t in rows if s not in done]
            print(f"[TLFund] Resuming: {before - len(rows)} of {before} stocks already "
                  f"fetched for {skip_done_for_date}, {len(rows)} remaining.")
    return rows


# â”€â”€ Main â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

def _process_one(symbol: str, tlid: str, today: str, session: requests.Session) -> tuple[bool, str]:
    """Fetch + persist one stock's fundamentals. Opens its own DB connection (pulled from
    the SQLAlchemy pool) since connections aren't safe to share across threads."""
    con = connect()
    try:
        features: dict = {}

        body = _fetch(tlid, "EPS_TTM", session)
        if body is not None:
            eps_series = _parse_eod(body)
            if eps_series:
                _upsert_series("trendlyne_eps_history", "eps_ttm", symbol, eps_series, con)
                features.update(_compute_eps_features(eps_series))
            dvm = _extract_dvm(body)
            if dvm:
                _upsert_dvm(symbol, today, dvm, con)
                features["dvm_d"] = dvm.get("d_score")
                features["dvm_v"] = dvm.get("v_score")
                features["dvm_m"] = dvm.get("m_score")
        time.sleep(RATE_LIMIT_SEC)

        features.update(_pe_features_from_db(symbol, con))
        features.update(_pb_features_from_db(symbol, con))

        body = _fetch(tlid, "DIVIDEND_YIELD_TTM_Q", session)
        if body is not None:
            dy_series = _parse_eod(body)
            if dy_series:
                _upsert_series("trendlyne_div_yield_history", "div_yield_pct", symbol, dy_series, con)
                features["div_yield_ttm"] = dy_series[0][1]
        time.sleep(RATE_LIMIT_SEC)

        _backfill_technical_signals(symbol, today, features, con)

        pe_str  = f"PE={features.get('pe_ttm','?')} rank={features.get('pe_pct_rank_252d','?')}%"
        dvm_str = f"D={features.get('dvm_d','?')}/V={features.get('dvm_v','?')}/M={features.get('dvm_m','?')}"
        eps_str = f"EPS={features.get('eps_ttm','?')} YoY={features.get('eps_growth_yoy','?')}%"
        return True, f"{symbol}: {eps_str} | {pe_str} | DY={features.get('div_yield_ttm','?')}% | {dvm_str}"
    except Exception as e:
        return False, f"{symbol}: error {e}"
    finally:
        con.close()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--symbol", default=None)
    parser.add_argument("--force", action="store_true", default=False,
                        help="Force re-fetch all symbols even if fresh within last 7 days")
    args = parser.parse_args()

    con = connect()
    ensure_schema(con)
    # Align to the last completed trading session (same date the grid-ensurer builds), NOT
    # date.today() -- this job runs Sunday (ml-weekly-retrain, 'ml-weekly-retrain' cron), a
    # non-trading day with no technical_signals row yet. date.today() there matched zero rows
    # in _backfill_technical_signals' "date >= today" branch while its "date < today" ELSE
    # branch nulled every existing historical row -- silently wiping eps_ttm/dvm_*/pe_* to NULL
    # every week with no error, since the UPDATE always "succeeds" (0 rows affected on either
    # branch is not an exception). Same fix pattern as mc_techscanner_fetcher.py.
    today = logical_write_floor(con, fallback=date.today().isoformat())
    con.close()

    stocks = _load_stocks(args.symbol, skip_done_for_date=None if args.symbol else today)

    # Smart 7-day cadence check, on top of the same-day resume above: EPS_TTM/dividend-yield
    # are quarterly-cadence data (see class docstring), so re-fetching a symbol whose EPS/
    # dividend series was already pulled this week wastes this fetcher's share of the shared
    # trendlyne.com WAF request allowance (fetch_utils.TRENDLYNE_RUN_REQUEST_BUDGET) on data
    # that cannot have changed. Window kept short (7d, not the 20-25d used by the
    # monthly-cadence financial_ratios_fetcher.py/working_capital_fetcher.py) because this
    # fetcher's _backfill_technical_signals also refreshes PE/PB percentile ranks derived from
    # today's PRICE (via _pe_features_from_db/_pb_features_from_db, which read local history,
    # not the network) -- skipping a symbol here also defers that refresh, so the window is
    # bounded to at most a week of staleness on the price-driven half, not the quarter the
    # EPS/dividend half alone would tolerate.
    if not args.force and not args.symbol:
        from fetch_utils import filter_stale_symbols
        fresh_cutoff = (date.today() - timedelta(days=7)).isoformat()
        # con was already closed above (today's logical_write_floor lookup is the only thing
        # it was needed for) -- open a fresh one for this check, same as _load_stocks does
        # internally for its own skip_done_for_date query.
        stale_con = connect()
        try:
            stale_stocks = filter_stale_symbols(stale_con, stocks, "trendlyne_dvm_scores",
                                                date_col="date", as_of_date=fresh_cutoff)
        finally:
            stale_con.close()
        skipped = len(stocks) - len(stale_stocks)
        if skipped > 0:
            print(f"[TLFund] Smart cadence skip: {skipped}/{len(stocks)} symbols already fresh within last 7 days. Processing {len(stale_stocks)} remaining.")
            stocks = stale_stocks

    stocks = cap_to_run_budget(stocks, "TLFund", requests_per_row=2)
    if not stocks:
        print("[TLFund] No stocks with tlid found.")
        return

    print(f"[TLFund] Processing {len(stocks)} stocks in batches of {BATCH_SIZE} "
          f"({BATCH_GAP_SEC}s gap) - EPS/DivYield + DVM...")
    session = requests.Session()
    session.headers.update(HEADERS)
    session.mount("https://", HTTPAdapter(pool_connections=BATCH_SIZE, pool_maxsize=BATCH_SIZE))
    ok = 0
    done = 0

    for batch_start in range(0, len(stocks), BATCH_SIZE):
        batch = stocks[batch_start:batch_start + BATCH_SIZE]
        with ThreadPoolExecutor(max_workers=len(batch)) as pool:
            futures = [pool.submit(_process_one, symbol, tlid, today, session) for symbol, tlid in batch]
            for fut in as_completed(futures):
                success, line = fut.result()
                done += 1
                ok += success
                print(f"  [{done}/{len(stocks)}] {line}")
        time.sleep(BATCH_GAP_SEC)

    print(f"[TLFund] Done. {ok}/{len(stocks)} stocks processed.")


if __name__ == "__main__":
    main()

def to_polars_df(data):
    """Converts pandas DataFrame or list of dicts to Polars DataFrame for fast vector operations."""
    if hasattr(data, 'empty') and data.empty:
        return pl.DataFrame()
    return pl.from_pandas(data) if hasattr(data, 'to_numpy') else pl.DataFrame(data)
