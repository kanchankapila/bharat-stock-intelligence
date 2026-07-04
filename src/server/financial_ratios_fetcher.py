#!/usr/bin/env python3
"""
Financial Ratios Fetcher — FCF Yield + Interest Coverage
=========================================================
Computes two of the strongest quality signals in quant finance from
Trendlyne's chart-data API (the same endpoint used by
trendlyne_fundamentals_fetcher.py):

  FCF Yield         = (CFO_TTM - |CapEx_TTM|) / market_cap * 100
  Interest Coverage = EBIT_TTM / interest_expense_TTM

Params fetched per stock:
  CFO_Q           → operating cash flow (quarterly series)
  CAPEX_Q         → capital expenditure (quarterly, usually positive in TL)
  EBIT_A / EBIT_Q → earnings before interest & tax
  INT_EXP_Q       → interest expense (quarterly)
  MARKET_CAP      → market cap (from stockData headers, already in EPS body)

TTM is computed by summing the four most-recent quarters.

Writes:
  tl_financial_quality  (symbol, as_of_date)  — raw + derived values
  technical_signals     — fcf_yield, interest_coverage, fcf_positive, debt_coverage_risk

Run:
  python financial_ratios_fetcher.py              # all stocks with tlid
  python financial_ratios_fetcher.py --symbol BEL
  python financial_ratios_fetcher.py --limit 50
"""

import argparse
import time
from datetime import date, datetime, timezone

import requests

from db_compat import connect

# ── API config ──────────────────────────────────────────────────────────────────

BASE_URL = "https://trendlyne.com/mapp/v1/stock/chart-data/{tlid}/{param}/"

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
    ),
    "Accept": "application/json",
    "Referer": "https://trendlyne.com/",
}

RATE_LIMIT_SEC = 0.3

# TL chart-data param names for the financial statement lines we need.
# Quarterly params (Q suffix) return quarterly data; we sum 4 quarters for TTM.
PARAM_CFO    = "CFO_Q"         # operating cash flow quarterly
PARAM_CAPEX  = "CAPEX_Q"       # capital expenditure quarterly (abs value in TL)
PARAM_EBIT   = "EBIT_Q"        # EBIT quarterly (operating profit before interest/tax)
PARAM_INT    = "INT_EXP_Q"     # interest expense quarterly


# ── Schema ──────────────────────────────────────────────────────────────────────

def ensure_schema(con) -> None:
    cur = con.cursor()

    cur.execute("""
        CREATE TABLE IF NOT EXISTS tl_financial_quality (
            symbol               TEXT NOT NULL,
            as_of_date           TEXT NOT NULL,
            cfo_ttm              REAL,
            capex_ttm            REAL,
            fcf_ttm              REAL,
            ebit_ttm             REAL,
            interest_expense_ttm REAL,
            market_cap           REAL,
            fcf_yield            REAL,
            interest_coverage    REAL,
            fetched_at           TEXT DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (symbol, as_of_date)
        )
    """)
    cur.execute("""
        CREATE INDEX IF NOT EXISTS idx_tlfq_sym
        ON tl_financial_quality(symbol, as_of_date DESC)
    """)
    con.commit()

    for ddl in [
        "ALTER TABLE tl_financial_quality ADD COLUMN fetched_at TEXT DEFAULT CURRENT_TIMESTAMP",
        "ALTER TABLE technical_signals ADD COLUMN fcf_yield         REAL",
        "ALTER TABLE technical_signals ADD COLUMN interest_coverage  REAL",
        "ALTER TABLE technical_signals ADD COLUMN fcf_positive       INTEGER",
        "ALTER TABLE technical_signals ADD COLUMN debt_coverage_risk INTEGER",
    ]:
        try:
            cur.execute(ddl)
            con.commit()
        except Exception:
            con.rollback()


# ── Fetch helpers ────────────────────────────────────────────────────────────────

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
    """Return [(date_str, value), ...] sorted most-recent first (as returned by TL)."""
    series: list[tuple[str, float]] = []
    for ts_ms, val in body.get("eodData", []):
        try:
            series.append((_ts_to_date(int(ts_ms)), float(val)))
        except (TypeError, ValueError):
            continue
    return series


def _extract_market_cap(body: dict) -> float | None:
    """Read market_cap from the stockData / stockHeaders side-channel embedded in any
    chart-data response body."""
    headers = body.get("stockHeaders", [])
    values  = body.get("stockData",   [])
    if not headers or not values:
        return None
    idx = {h.get("unique_name", ""): i for i, h in enumerate(headers)}
    for key in ("market_cap", "mktcap", "mcap"):
        i = idx.get(key)
        if i is not None and i < len(values):
            try:
                return float(values[i])
            except (TypeError, ValueError):
                pass
    return None


def _ttm(series: list[tuple[str, float]], quarters: int = 4) -> float | None:
    """Sum the `quarters` most-recent quarterly values for a TTM figure."""
    vals = [v for _, v in series[:quarters] if v is not None]
    if len(vals) < quarters:
        return None
    return sum(vals)


def _fcf_positive_quarters(cfo_series: list[tuple[str, float]],
                            capex_series: list[tuple[str, float]]) -> int:
    """Count how many of the 4 most-recent quarters had positive FCF (CFO > capex)."""
    count = 0
    for i in range(min(4, len(cfo_series), len(capex_series))):
        try:
            fcf_q = cfo_series[i][1] - abs(capex_series[i][1])
            if fcf_q > 0:
                count += 1
        except (TypeError, ValueError):
            pass
    return count


# ── Persist ──────────────────────────────────────────────────────────────────────

def _upsert_quality(symbol: str, today: str, row: dict, con) -> None:
    cur = con.cursor()
    cur.execute("""
        INSERT INTO tl_financial_quality
            (symbol, as_of_date, cfo_ttm, capex_ttm, fcf_ttm,
             ebit_ttm, interest_expense_ttm, market_cap,
             fcf_yield, interest_coverage)
        VALUES (?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(symbol, as_of_date) DO UPDATE SET
            cfo_ttm              = excluded.cfo_ttm,
            capex_ttm            = excluded.capex_ttm,
            fcf_ttm              = excluded.fcf_ttm,
            ebit_ttm             = excluded.ebit_ttm,
            interest_expense_ttm = excluded.interest_expense_ttm,
            market_cap           = excluded.market_cap,
            fcf_yield            = excluded.fcf_yield,
            interest_coverage    = excluded.interest_coverage,
            fetched_at           = CURRENT_TIMESTAMP
    """, (
        symbol, today,
        row.get("cfo_ttm"), row.get("capex_ttm"), row.get("fcf_ttm"),
        row.get("ebit_ttm"), row.get("interest_expense_ttm"), row.get("market_cap"),
        row.get("fcf_yield"), row.get("interest_coverage"),
    ))
    con.commit()


def _update_technical_signals(symbol: str, features: dict, con) -> None:
    if not features:
        return
    cur = con.cursor()
    cur.execute("""
        UPDATE technical_signals SET
            fcf_yield         = COALESCE(?, fcf_yield),
            interest_coverage  = COALESCE(?, interest_coverage),
            fcf_positive       = COALESCE(?, fcf_positive),
            debt_coverage_risk = COALESCE(?, debt_coverage_risk)
        WHERE symbol = ?
    """, (
        features.get("fcf_yield"),
        features.get("interest_coverage"),
        features.get("fcf_positive"),
        features.get("debt_coverage_risk"),
        symbol,
    ))
    con.commit()


# ── Stock list ────────────────────────────────────────────────────────────────────

def _load_stocks(symbol_filter: str | None, limit: int | None, con) -> list[tuple[str, str]]:
    """Return [(symbol, tlid), ...] from trendlyne_screener_stocks (same source as
    trendlyne_fundamentals_fetcher). Falls back to nse_stocks.tlid if that table is empty."""
    cur = con.cursor()
    cur.execute("""
        SELECT DISTINCT ON (symbol) symbol, stock_id FROM trendlyne_screener_stocks
        WHERE stock_id IS NOT NULL AND stock_id != ''
        ORDER BY symbol, stock_id
    """)
    rows = [(r[0], str(r[1])) for r in cur.fetchall() if r[0] is not None]

    if not rows:
        # Fallback: nse_stocks table that has a tlid column
        try:
            cur.execute("""
                SELECT symbol, tlid FROM nse_stocks
                WHERE tlid IS NOT NULL AND tlid != ''
                ORDER BY symbol
            """)
            rows = [(r[0], str(r[1])) for r in cur.fetchall() if r[0] is not None]
        except Exception:
            pass

    if symbol_filter:
        rows = [(s, t) for s, t in rows if s.upper() == symbol_filter.upper()]
    if limit:
        rows = rows[:limit]
    return rows


# ── Per-stock processing ──────────────────────────────────────────────────────────

def process_stock(symbol: str, tlid: str, today: str,
                  session: requests.Session, con) -> dict:
    """Fetch cash-flow and interest data for one stock, compute FCF yield and
    interest coverage, persist to DB, return a features dict."""

    # ── 1. CFO (operating cash flow, quarterly) ──
    body_cfo = _fetch(tlid, PARAM_CFO, session)
    time.sleep(RATE_LIMIT_SEC)
    cfo_series = _parse_eod(body_cfo) if body_cfo else []

    # Try to read market cap from the side-channel
    market_cap: float | None = _extract_market_cap(body_cfo) if body_cfo else None

    # ── 2. CapEx (quarterly) ──
    body_capex = _fetch(tlid, PARAM_CAPEX, session)
    time.sleep(RATE_LIMIT_SEC)
    capex_series = _parse_eod(body_capex) if body_capex else []

    # ── 3. EBIT (quarterly) ──
    body_ebit = _fetch(tlid, PARAM_EBIT, session)
    time.sleep(RATE_LIMIT_SEC)
    ebit_series = _parse_eod(body_ebit) if body_ebit else []

    # ── 4. Interest expense (quarterly) ──
    body_int = _fetch(tlid, PARAM_INT, session)
    time.sleep(RATE_LIMIT_SEC)
    int_series = _parse_eod(body_int) if body_int else []

    # ── Derive TTM figures ──
    cfo_ttm  = _ttm(cfo_series)
    # TL usually returns CapEx as positive; make sure we work with abs value
    capex_ttm_raw = _ttm(capex_series)
    capex_ttm = abs(capex_ttm_raw) if capex_ttm_raw is not None else None
    ebit_ttm  = _ttm(ebit_series)
    int_ttm   = _ttm(int_series)

    # ── FCF ──
    fcf_ttm: float | None = None
    if cfo_ttm is not None and capex_ttm is not None:
        fcf_ttm = round(cfo_ttm - capex_ttm, 2)

    # ── FCF yield (%) ──
    fcf_yield: float | None = None
    if fcf_ttm is not None and market_cap and market_cap > 0:
        fcf_yield = round(fcf_ttm / market_cap * 100, 4)

    # ── Interest coverage ──
    interest_coverage: float | None = None
    if ebit_ttm is not None and int_ttm is not None and int_ttm > 0:
        interest_coverage = round(ebit_ttm / int_ttm, 2)

    # ── FCF quality flags ──
    fcf_pos_count = _fcf_positive_quarters(cfo_series, capex_series)
    fcf_positive  = 1 if fcf_pos_count >= 4 else 0
    debt_coverage_risk = (
        1 if (interest_coverage is not None and interest_coverage < 1.5) else 0
    )

    quality_row = {
        "cfo_ttm":              round(cfo_ttm,  2) if cfo_ttm  is not None else None,
        "capex_ttm":            round(capex_ttm, 2) if capex_ttm is not None else None,
        "fcf_ttm":              fcf_ttm,
        "ebit_ttm":             round(ebit_ttm,  2) if ebit_ttm  is not None else None,
        "interest_expense_ttm": round(int_ttm,   2) if int_ttm   is not None else None,
        "market_cap":           round(market_cap, 2) if market_cap is not None else None,
        "fcf_yield":            fcf_yield,
        "interest_coverage":    interest_coverage,
    }

    _upsert_quality(symbol, today, quality_row, con)

    features = {
        "fcf_yield":         fcf_yield,
        "interest_coverage": interest_coverage,
        "fcf_positive":      fcf_positive,
        "debt_coverage_risk": debt_coverage_risk,
    }
    _update_technical_signals(symbol, features, con)

    return features


# ── Main ──────────────────────────────────────────────────────────────────────────

def main() -> None:
    parser = argparse.ArgumentParser(description="FCF yield + interest coverage from Trendlyne")
    parser.add_argument("--symbol", default=None, help="Single stock NSE symbol")
    parser.add_argument("--limit",  type=int, default=None, help="Process first N stocks")
    args = parser.parse_args()

    con = connect()
    ensure_schema(con)

    stocks = _load_stocks(args.symbol, args.limit, con)
    if not stocks:
        print("[FinancialRatios] No stocks with tlid found.")
        con.close()
        return

    print(f"[FinancialRatios] Processing {len(stocks)} stocks — FCF yield + interest coverage…")
    session = requests.Session()
    session.headers.update(HEADERS)
    today = date.today().isoformat()

    ok = 0
    fcf_positive_count   = 0
    distress_count       = 0

    for i, (symbol, tlid) in enumerate(stocks, 1):
        try:
            features = process_stock(symbol, tlid, today, session, con)
            ok += 1

            if features.get("fcf_positive"):
                fcf_positive_count += 1
            if features.get("debt_coverage_risk"):
                distress_count += 1

            fcf_str  = (
                f"FCF yield={features['fcf_yield']:.2f}%"
                if features.get("fcf_yield") is not None
                else "FCF yield=n/a"
            )
            cov_str  = (
                f"IC={features['interest_coverage']:.1f}x"
                if features.get("interest_coverage") is not None
                else "IC=n/a"
            )
            flag = " [DISTRESS]" if features.get("debt_coverage_risk") else ""
            print(f"  [{i}/{len(stocks)}] {symbol}: {fcf_str} | {cov_str}{flag}")

        except Exception as e:
            try:
                con.rollback()
            except Exception:
                pass
            print(f"  [{i}/{len(stocks)}] {symbol}: ERROR — {e}")

    fcf_pct = round(fcf_positive_count / ok * 100) if ok else 0
    print(
        f"[FinancialRatios] Done. {ok} stocks. "
        f"FCF positive: {fcf_pct}%. "
        f"Interest coverage distress (<1.5x): {distress_count} stocks."
    )
    con.close()


if __name__ == "__main__":
    main()
