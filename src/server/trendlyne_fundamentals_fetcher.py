#!/usr/bin/env python3
"""
Trendlyne Fundamentals Fetcher (EPS TTM + DVM Scores)
======================================================
Fetches EPS TTM time series and D/V/M scores from Trendlyne's chart-data API.

API endpoint: https://trendlyne.com/mapp/v1/stock/chart-data/{tlid}/{param}/
  EPS_TTM  → quarterly EPS trailing-12-month (8+ years history, ~31 data points)
  PE_TTM   → daily P/E ratio (500+ data points)
  DVM      → embedded in stockData on EVERY response (no extra call needed)

Why EPS TTM matters for ML:
  eps_growth_yoy  — fundamental momentum; most powerful EPS signal
  eps_growth_qoq  — short-term acceleration
  eps_acceleration — second derivative: growth getting better/worse
  eps_ttm         — absolute level (for P/E and valuation features)

Why DVM matters:
  dvm_durability (D) — Trendlyne's quality/consistency score (0–100)
  dvm_valuation  (V) — cheapness vs fair value (0–100; high = cheap)
  dvm_momentum   (M) — price + earnings momentum (0–100)
  These are pre-computed proprietary signals unavailable elsewhere.

What's NOT available without auth (returns "Not allowed"):
  REVENUE_TTM, PAT_TTM, EPS_QUARTERLY, EBITDA_TTM

Writes to:
  trendlyne_eps_history (symbol, date, eps_ttm)
  trendlyne_dvm_scores  (symbol, date, d_score, v_score, m_score, d_color, v_color, m_color)
  technical_signals: eps_ttm, eps_growth_yoy, eps_growth_qoq, eps_acceleration,
                     pe_ttm, dvm_durability, dvm_valuation, dvm_momentum

Requires: stocklist.ts-derived tlid for each stock (via db_compat).
Run:
  python trendlyne_fundamentals_fetcher.py            # all 180 mapped stocks
  python trendlyne_fundamentals_fetcher.py --symbol BEL
  python trendlyne_fundamentals_fetcher.py --pe       # also fetch PE_TTM daily series
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
    # DRF returns HTML by default; must request JSON explicitly.
    "Accept": "application/json",
    "Referer": "https://trendlyne.com/",
}

RATE_LIMIT_SEC = 0.5  # gentle — this is a free endpoint


# ── Schema ─────────────────────────────────────────────────────────────────────

def ensure_schema(con) -> None:
    cur = con.cursor()

    cur.execute("""
        CREATE TABLE IF NOT EXISTS trendlyne_eps_history (
            symbol     TEXT NOT NULL,
            date       TEXT NOT NULL,
            eps_ttm    REAL,
            fetched_at TEXT DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (symbol, date)
        )
    """)
    cur.execute("""
        CREATE INDEX IF NOT EXISTS idx_tleps_symbol ON trendlyne_eps_history(symbol, date DESC)
    """)
    con.commit()

    cur.execute("""
        CREATE TABLE IF NOT EXISTS trendlyne_dvm_scores (
            symbol     TEXT NOT NULL,
            date       TEXT NOT NULL,
            d_score    INTEGER,
            v_score    INTEGER,
            m_score    INTEGER,
            d_color    TEXT,
            v_color    TEXT,
            m_color    TEXT,
            fetched_at TEXT DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (symbol, date)
        )
    """)
    cur.execute("""
        CREATE INDEX IF NOT EXISTS idx_tldvm_symbol ON trendlyne_dvm_scores(symbol, date DESC)
    """)
    con.commit()

    cur.execute("""
        CREATE TABLE IF NOT EXISTS trendlyne_pe_history (
            symbol     TEXT NOT NULL,
            date       TEXT NOT NULL,
            pe_ttm     REAL,
            fetched_at TEXT DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (symbol, date)
        )
    """)
    con.commit()

    # technical_signals columns for ML
    for ddl in [
        "ALTER TABLE technical_signals ADD COLUMN eps_ttm          REAL",
        "ALTER TABLE technical_signals ADD COLUMN eps_growth_yoy   REAL",
        "ALTER TABLE technical_signals ADD COLUMN eps_growth_qoq   REAL",
        "ALTER TABLE technical_signals ADD COLUMN eps_acceleration  REAL",
        "ALTER TABLE technical_signals ADD COLUMN pe_ttm            REAL",
        "ALTER TABLE technical_signals ADD COLUMN dvm_durability    INTEGER",
        "ALTER TABLE technical_signals ADD COLUMN dvm_valuation     INTEGER",
        "ALTER TABLE technical_signals ADD COLUMN dvm_momentum      INTEGER",
    ]:
        try:
            cur.execute(ddl)
            con.commit()
        except Exception:
            con.rollback()


# ── Fetch ───────────────────────────────────────────────────────────────────────

def _fetch_param(tlid: str, param: str, session: requests.Session) -> dict | None:
    url = BASE_URL.format(tlid=tlid, param=param)
    try:
        # DRF returns HTML by default — ?format=json forces JSON response.
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
    """Convert millisecond timestamp to YYYY-MM-DD (UTC)."""
    return datetime.fromtimestamp(ts_ms / 1000, tz=timezone.utc).strftime("%Y-%m-%d")


def _extract_dvm(body: dict) -> dict | None:
    """Extract DVM scores from the stockData + stockHeaders arrays."""
    headers = body.get("stockHeaders", [])
    values  = body.get("stockData",   [])
    if not headers or not values:
        return None

    idx = {h["unique_name"]: i for i, h in enumerate(headers)}
    def get(key):
        i = idx.get(key)
        return values[i] if i is not None and i < len(values) else None

    d = get("d_value")
    v = get("v_value")
    m = get("m_value")
    if d is None and v is None and m is None:
        return None

    return {
        "d_score": int(d) if d is not None else None,
        "v_score": int(v) if v is not None else None,
        "m_score": int(m) if m is not None else None,
        "d_color": get("d_color"),
        "v_color": get("v_color"),
        "m_color": get("m_color"),
    }


# ── Compute EPS features ────────────────────────────────────────────────────────

def _compute_eps_features(eps_series: list[tuple[str, float]]) -> dict:
    """
    eps_series: [(date_str, eps_ttm), ...] sorted DESCENDING (most recent first).
    Returns features for the latest data point.
    """
    if not eps_series:
        return {}

    latest_date, latest_eps = eps_series[0]

    # QoQ: previous quarter (index 1)
    prev_q = eps_series[1][1] if len(eps_series) > 1 else None
    # YoY: 4 quarters ago (index 4) — same quarter last year
    prev_y = eps_series[4][1] if len(eps_series) > 4 else None
    # For acceleration: growth rate one year ago (indices 4 vs 8)
    prev_y2 = eps_series[8][1] if len(eps_series) > 8 else None

    def pct_change(current, base):
        if base is None or base == 0:
            return None
        return round((current - base) / abs(base) * 100, 2)

    growth_qoq = pct_change(latest_eps, prev_q)
    growth_yoy = pct_change(latest_eps, prev_y)

    # Acceleration = current YoY growth − prior year's YoY growth
    prior_yoy = pct_change(prev_y, prev_y2) if prev_y is not None else None
    acceleration = None
    if growth_yoy is not None and prior_yoy is not None:
        acceleration = round(growth_yoy - prior_yoy, 2)

    return {
        "eps_ttm":         round(latest_eps, 4),
        "eps_growth_qoq":  growth_qoq,
        "eps_growth_yoy":  growth_yoy,
        "eps_acceleration": acceleration,
    }


# ── Persist ─────────────────────────────────────────────────────────────────────

def _upsert_eps_history(symbol: str, series: list[tuple[str, float]], con) -> int:
    cur = con.cursor()
    for dt, eps in series:
        cur.execute("""
            INSERT INTO trendlyne_eps_history (symbol, date, eps_ttm)
            VALUES (?,?,?)
            ON CONFLICT(symbol, date) DO UPDATE SET
                eps_ttm    = excluded.eps_ttm,
                fetched_at = CURRENT_TIMESTAMP
        """, (symbol, dt, round(float(eps), 4)))
    con.commit()
    return len(series)


def _upsert_dvm(symbol: str, today: str, dvm: dict, con) -> None:
    cur = con.cursor()
    cur.execute("""
        INSERT INTO trendlyne_dvm_scores
            (symbol, date, d_score, v_score, m_score, d_color, v_color, m_color)
        VALUES (?,?,?,?,?,?,?,?)
        ON CONFLICT(symbol, date) DO UPDATE SET
            d_score    = excluded.d_score,
            v_score    = excluded.v_score,
            m_score    = excluded.m_score,
            d_color    = excluded.d_color,
            v_color    = excluded.v_color,
            m_color    = excluded.m_color,
            fetched_at = CURRENT_TIMESTAMP
    """, (symbol, today,
          dvm.get("d_score"), dvm.get("v_score"), dvm.get("m_score"),
          dvm.get("d_color"), dvm.get("v_color"), dvm.get("m_color")))
    con.commit()


def _upsert_pe_history(symbol: str, series: list[tuple[str, float]], con) -> int:
    cur = con.cursor()
    for dt, pe in series:
        cur.execute("""
            INSERT INTO trendlyne_pe_history (symbol, date, pe_ttm)
            VALUES (?,?,?)
            ON CONFLICT(symbol, date) DO UPDATE SET
                pe_ttm     = excluded.pe_ttm,
                fetched_at = CURRENT_TIMESTAMP
        """, (symbol, dt, round(float(pe), 4)))
    con.commit()
    return len(series)


def _backfill_technical_signals(symbol: str, eps_features: dict, dvm: dict | None,
                                 pe_ttm: float | None, con) -> None:
    """Update technical_signals with latest computed values for this symbol."""
    if not eps_features and not dvm and pe_ttm is None:
        return
    cur = con.cursor()
    cur.execute("""
        UPDATE technical_signals
        SET eps_ttm          = ?,
            eps_growth_yoy   = ?,
            eps_growth_qoq   = ?,
            eps_acceleration  = ?,
            pe_ttm            = COALESCE(?, pe_ttm),
            dvm_durability    = ?,
            dvm_valuation     = ?,
            dvm_momentum      = ?
        WHERE symbol = ?
    """, (
        eps_features.get("eps_ttm"),
        eps_features.get("eps_growth_yoy"),
        eps_features.get("eps_growth_qoq"),
        eps_features.get("eps_acceleration"),
        pe_ttm,
        dvm.get("d_score") if dvm else None,
        dvm.get("v_score") if dvm else None,
        dvm.get("m_score") if dvm else None,
        symbol,
    ))
    con.commit()


# ── Stock list ──────────────────────────────────────────────────────────────────

def _load_stocks(symbol_filter: str | None, con) -> list[tuple[str, str]]:
    """Return [(symbol, tlid)] for all stocks that have a tlid in the DB."""
    cur = con.cursor()
    # trendlyne_screener_stocks has stock_id = tlid
    cur.execute("""
        SELECT DISTINCT ns.symbol, tss.stock_id
        FROM nse_stocks ns
        JOIN trendlyne_screener_stocks tss ON tss.symbol = ns.symbol
        WHERE tss.stock_id IS NOT NULL
          AND tss.stock_id != ''
        ORDER BY ns.symbol
    """)
    rows = [(r[0], str(r[1])) for r in cur.fetchall()]

    if not rows:
        # Fall back: any symbol that has a tlid stored anywhere
        cur.execute("""
            SELECT symbol, stock_id FROM trendlyne_screener_stocks
            WHERE stock_id IS NOT NULL AND stock_id != ''
            GROUP BY symbol
        """)
        rows = [(r[0], str(r[1])) for r in cur.fetchall()]

    if symbol_filter:
        rows = [(s, t) for s, t in rows if s.upper() == symbol_filter.upper()]

    return rows


# ── Main ────────────────────────────────────────────────────────────────────────

def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--symbol", type=str, default=None,
                        help="Fetch only this NSE symbol (e.g. BEL)")
    parser.add_argument("--pe", action="store_true",
                        help="Also fetch PE_TTM daily series (heavier — 500+ rows/stock)")
    args = parser.parse_args()

    con = connect()
    ensure_schema(con)

    stocks = _load_stocks(args.symbol, con)
    if not stocks:
        print("[TLFund] No stocks with tlid found. Run syncNSEStocks first.")
        return

    print(f"[TLFund] Processing {len(stocks)} stocks…")
    session = requests.Session()
    session.headers.update(HEADERS)

    today = date.today().isoformat()
    ok = 0

    for i, (symbol, tlid) in enumerate(stocks, 1):
        # ── EPS TTM (also extracts DVM from same response) ──
        body = _fetch_param(tlid, "EPS_TTM", session)
        if body is None:
            print(f"  [{i}/{len(stocks)}] {symbol}: EPS_TTM fetch failed")
            time.sleep(RATE_LIMIT_SEC)
            continue

        # EPS series: [(date, eps), ...] most-recent first
        raw_eps = body.get("eodData", [])
        eps_series: list[tuple[str, float]] = []
        for ts_ms, val in raw_eps:
            try:
                eps_series.append((_ts_to_date(int(ts_ms)), float(val)))
            except (TypeError, ValueError):
                continue

        # DVM from same body
        dvm = _extract_dvm(body)

        # Persist EPS history
        if eps_series:
            _upsert_eps_history(symbol, eps_series, con)

        # Persist DVM
        if dvm:
            _upsert_dvm(symbol, today, dvm, con)

        # Compute EPS features
        eps_features = _compute_eps_features(eps_series)

        # ── PE TTM (optional, daily data) ──
        pe_latest = None
        if args.pe:
            time.sleep(RATE_LIMIT_SEC)
            pe_body = _fetch_param(tlid, "PE_TTM", session)
            if pe_body:
                raw_pe = pe_body.get("eodData", [])
                pe_series: list[tuple[str, float]] = []
                for ts_ms, val in raw_pe:
                    try:
                        pe_series.append((_ts_to_date(int(ts_ms)), float(val)))
                    except (TypeError, ValueError):
                        continue
                if pe_series:
                    _upsert_pe_history(symbol, pe_series, con)
                    pe_latest = pe_series[0][1]  # most recent

        # Back-fill technical_signals
        _backfill_technical_signals(symbol, eps_features, dvm, pe_latest, con)

        dvm_str = f"D={dvm['d_score']}/V={dvm['v_score']}/M={dvm['m_score']}" if dvm else "no DVM"
        eps_str = (f"EPS={eps_features.get('eps_ttm','?')} "
                   f"YoY={eps_features.get('eps_growth_yoy','?')}% "
                   f"QoQ={eps_features.get('eps_growth_qoq','?')}%") if eps_features else "no EPS"
        print(f"  [{i}/{len(stocks)}] {symbol}: {eps_str} | {dvm_str}")
        ok += 1

        time.sleep(RATE_LIMIT_SEC)

    print(f"[TLFund] Done. {ok}/{len(stocks)} stocks processed.")
    con.close()


if __name__ == "__main__":
    main()
