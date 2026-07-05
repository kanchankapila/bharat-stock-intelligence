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

Run:
  python trendlyne_fundamentals_fetcher.py           # all stocks with tlid
  python trendlyne_fundamentals_fetcher.py --symbol BEL
"""

import argparse
import time
from datetime import date, datetime, timezone

import requests

from db_compat import connect

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

    for ddl in [
        "ALTER TABLE technical_signals ADD COLUMN eps_ttm REAL",
        "ALTER TABLE technical_signals ADD COLUMN eps_growth_yoy REAL",
        "ALTER TABLE technical_signals ADD COLUMN eps_growth_qoq REAL",
        "ALTER TABLE technical_signals ADD COLUMN eps_acceleration REAL",
        "ALTER TABLE technical_signals ADD COLUMN pe_ttm REAL",
        "ALTER TABLE technical_signals ADD COLUMN pe_pct_rank_252d REAL",
        "ALTER TABLE technical_signals ADD COLUMN pe_vs_median_1yr REAL",
        "ALTER TABLE technical_signals ADD COLUMN pb_pct_rank_252d REAL",
        "ALTER TABLE technical_signals ADD COLUMN div_yield_ttm REAL",
        "ALTER TABLE technical_signals ADD COLUMN dvm_durability INTEGER",
        "ALTER TABLE technical_signals ADD COLUMN dvm_valuation INTEGER",
        "ALTER TABLE technical_signals ADD COLUMN dvm_momentum INTEGER",
    ]:
        try:
            cur.execute(ddl)
            con.commit()
        except Exception:
            con.rollback()


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
        print(f"  [{param}] error: {e}")
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


def _backfill_technical_signals(symbol: str, features: dict, con) -> None:
    if not features:
        return
    cur = con.cursor()
    cur.execute("""
        UPDATE technical_signals SET
            eps_ttm          = COALESCE(?, eps_ttm),
            eps_growth_yoy   = COALESCE(?, eps_growth_yoy),
            eps_growth_qoq   = COALESCE(?, eps_growth_qoq),
            eps_acceleration  = COALESCE(?, eps_acceleration),
            pe_ttm            = COALESCE(?, pe_ttm),
            pe_pct_rank_252d  = COALESCE(?, pe_pct_rank_252d),
            pe_vs_median_1yr  = COALESCE(?, pe_vs_median_1yr),
            pb_pct_rank_252d  = COALESCE(?, pb_pct_rank_252d),
            div_yield_ttm     = COALESCE(?, div_yield_ttm),
            dvm_durability    = COALESCE(?, dvm_durability),
            dvm_valuation     = COALESCE(?, dvm_valuation),
            dvm_momentum      = COALESCE(?, dvm_momentum)
        WHERE symbol = ?
    """, (
        features.get("eps_ttm"),         features.get("eps_growth_yoy"),
        features.get("eps_growth_qoq"),  features.get("eps_acceleration"),
        features.get("pe_ttm"),          features.get("pe_pct_rank_252d"),
        features.get("pe_vs_median_1yr"),features.get("pb_pct_rank_252d"),
        features.get("div_yield_ttm"),
        features.get("dvm_d"),           features.get("dvm_v"),
        features.get("dvm_m"),
        symbol,
    ))
    con.commit()


# â”€â”€ Stock list â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

def _load_stocks(symbol_filter: str | None, con) -> list[tuple[str, str]]:
    """Return [(symbol, tlid), ...].
    Primary: nse_stocks.tlid (canonical, 1822 stocks).
    Fallback: MAX(trendlyne_screener_stocks.stock_id) for the rest (~1200 more).
    """
    cur = con.cursor()
    cur.execute("""
        SELECT symbol, tlid::TEXT AS tlid FROM nse_stocks
        WHERE symbol IS NOT NULL AND tlid IS NOT NULL AND tlid::TEXT != ''
        UNION
        SELECT tss.symbol, MAX(tss.stock_id)::TEXT AS tlid
        FROM trendlyne_screener_stocks tss
        WHERE tss.stock_id IS NOT NULL AND tss.stock_id::TEXT != ''
          AND NOT EXISTS (SELECT 1 FROM nse_stocks ns WHERE ns.symbol = tss.symbol AND ns.tlid IS NOT NULL)
        GROUP BY tss.symbol
        ORDER BY symbol
    """)
    rows = [(r[0], str(r[1])) for r in cur.fetchall() if r[0] is not None]
    if symbol_filter:
        rows = [(s, t) for s, t in rows if s.upper() == symbol_filter.upper()]
    return rows


# â”€â”€ Main â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--symbol", default=None)
    args = parser.parse_args()

    con = connect()
    ensure_schema(con)

    stocks = _load_stocks(args.symbol, con)
    if not stocks:
        print("[TLFund] No stocks with tlid found.")
        return

    print(f"[TLFund] Processing {len(stocks)} stocks â€” EPS/DivYield + DVMâ€¦")
    session = requests.Session()
    session.headers.update(HEADERS)
    today = date.today().isoformat()
    ok = 0

    for i, (symbol, tlid) in enumerate(stocks, 1):
        features: dict = {}

        # â”€â”€ 1. EPS_TTM (also carries DVM scores) â”€â”€
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

        # PE/PB history is now appended daily by mc_pricefeed_fetcher.py (that endpoint
        # already fetches each stock's own daily PE/PB — re-pulling Trendlyne's full
        # multi-year history here every week was pure duplication). Still read the
        # percentile-rank features from the same tables, now fresher (daily not weekly).
        features.update(_pe_features_from_db(symbol, con))
        features.update(_pb_features_from_db(symbol, con))

        # â”€â”€ 2. DIVIDEND_YIELD_TTM_Q (quarterly, 32 pts) â”€â”€
        body = _fetch(tlid, "DIVIDEND_YIELD_TTM_Q", session)
        if body is not None:
            dy_series = _parse_eod(body)
            if dy_series:
                _upsert_series("trendlyne_div_yield_history", "div_yield_pct", symbol, dy_series, con)
                features["div_yield_ttm"] = dy_series[0][1]  # latest
        time.sleep(RATE_LIMIT_SEC)

        # â”€â”€ Back-fill technical_signals â”€â”€
        _backfill_technical_signals(symbol, features, con)

        pe_str  = f"PE={features.get('pe_ttm','?')} rank={features.get('pe_pct_rank_252d','?')}%"
        dvm_str = (f"D={features.get('dvm_d','?')}/V={features.get('dvm_v','?')}/M={features.get('dvm_m','?')}")
        eps_str = f"EPS={features.get('eps_ttm','?')} YoY={features.get('eps_growth_yoy','?')}%"
        print(f"  [{i}/{len(stocks)}] {symbol}: {eps_str} | {pe_str} | DY={features.get('div_yield_ttm','?')}% | {dvm_str}")
        ok += 1

    print(f"[TLFund] Done. {ok}/{len(stocks)} stocks processed.")
    con.close()


if __name__ == "__main__":
    main()
