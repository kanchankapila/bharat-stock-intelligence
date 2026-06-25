#!/usr/bin/env python3
"""
MoneyControl Pricefeed Fetcher (Daily)
=======================================
Fetches https://priceapi.moneycontrol.com/pricefeed/nse/equitycash/{mcsymbol}

Unique data not available from Yahoo Finance or Trendlyne:
  IND_PE           — Industry-average P/E (e.g., 46.9 for Aerospace/Defence)
  cagr3Y / cagr5Y  — Compounded annual growth rate over 3/5 years
  PECONS / PBCONS  — Consensus (analyst-mean) P/E and P/B
  50DayAvg etc.    — Pre-computed 5/30/50/150/200 DMA values
  AvgDelVolPer_*   — Delivery % averages at 3/5/8/20-day windows
  52H / 52L + date — 52-week high/low with exact dates
  upper/lower circuit limits — Risk signal (price near circuit = volatility spike risk)
  MKT_LOT          — F&O lot size (useful for liquidity/size signal)
  mc_vol_ratio     — Today's volume vs 20-day avg (relative activity)

ML features written to technical_signals:
  mc_52w_high_dist_pct  = (price - 52H) / 52H * 100   (usually negative)
  mc_52w_low_dist_pct   = (price - 52L) / 52L * 100   (usually positive)
  mc_days_from_52wh     = days since 52-week high (momentum decay signal)
  mc_cagr_3y            = 3-year compounded annual return %
  mc_cagr_5y            = 5-year compounded annual return %
  mc_ind_pe             = industry average P/E
  mc_pe_vs_ind          = PE / IND_PE - 1  (premium/discount to industry)
  mc_consensus_pe       = analyst-consensus P/E (forward-looking)
  mc_ma50_dist_pct      = (price - 50DMA) / 50DMA * 100
  mc_ma200_dist_pct     = (price - 200DMA) / 200DMA * 100
  mc_del_pct_20d        = AvgDelVolPer_20day (delivery % 20-day avg from MC)
  mc_vol_ratio          = today's volume / 20-day avg volume
  mc_circuit_dist_pct   = (upper_circuit - price) / price * 100

Run:
  python mc_pricefeed_fetcher.py             # all stocks with mcsymbol
  python mc_pricefeed_fetcher.py --symbol BEL
"""

import argparse
import time
from datetime import date, datetime

from curl_cffi import requests

from db_compat import connect

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
            ma_50           REAL,
            ma_200          REAL,
            ma50_dist_pct   REAL,
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
            fetched_at      TEXT DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (symbol, date)
        )
    """)
    cur.execute("CREATE INDEX IF NOT EXISTS idx_mcpf_sym ON mc_pricefeed_daily(symbol, date DESC)")
    con.commit()

    for ddl in [
        "ALTER TABLE technical_signals ADD COLUMN mc_52w_high_dist_pct REAL",
        "ALTER TABLE technical_signals ADD COLUMN mc_52w_low_dist_pct  REAL",
        "ALTER TABLE technical_signals ADD COLUMN mc_days_from_52wh    INTEGER",
        "ALTER TABLE technical_signals ADD COLUMN mc_cagr_3y           REAL",
        "ALTER TABLE technical_signals ADD COLUMN mc_cagr_5y           REAL",
        "ALTER TABLE technical_signals ADD COLUMN mc_ind_pe            REAL",
        "ALTER TABLE technical_signals ADD COLUMN mc_pe_vs_ind         REAL",
        "ALTER TABLE technical_signals ADD COLUMN mc_consensus_pe      REAL",
        "ALTER TABLE technical_signals ADD COLUMN mc_ma50_dist_pct     REAL",
        "ALTER TABLE technical_signals ADD COLUMN mc_ma200_dist_pct    REAL",
        "ALTER TABLE technical_signals ADD COLUMN mc_del_pct_20d       REAL",
        "ALTER TABLE technical_signals ADD COLUMN mc_vol_ratio         REAL",
        "ALTER TABLE technical_signals ADD COLUMN mc_circuit_dist_pct  REAL",
    ]:
        try:
            cur.execute(ddl)
            con.commit()
        except Exception:
            con.rollback()


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
    price    = _sf(d.get("pricecurrent") or d.get("LP"))
    pe       = _sf(d.get("PE"))
    ind_pe   = _sf(d.get("IND_PE"))
    h52      = _sf(d.get("52H") or d.get("HP"))
    l52      = _sf(d.get("52L"))
    ma50     = _sf(d.get("50DayAvg"))
    ma200    = _sf(d.get("200DayAvg"))
    vol_today = _si(d.get("VOL"))
    vol_avg   = _si(d.get("AvgVolQtyTraded_20day"))

    pe_vs_ind = round(pe / ind_pe - 1, 4) if pe and ind_pe and ind_pe > 0 else None
    dist_52h  = round((price - h52) / h52 * 100, 2) if price and h52 and h52 > 0 else None
    dist_52l  = round((price - l52) / l52 * 100, 2) if price and l52 and l52 > 0 else None
    ma50_dist = round((price - ma50) / ma50 * 100, 2) if price and ma50 and ma50 > 0 else None
    ma200_dist = round((price - ma200) / ma200 * 100, 2) if price and ma200 and ma200 > 0 else None
    vol_ratio  = round(vol_today / vol_avg, 3) if vol_today and vol_avg and vol_avg > 0 else None

    ucirc = _sf(d.get("upper_circuit_limit"))
    circuit_dist = round((ucirc - price) / price * 100, 2) if ucirc and price and price > 0 else None

    return {
        "price":          price,
        "pe":             pe,
        "pb":             _sf(d.get("PB")),
        "ind_pe":         ind_pe,
        "pe_vs_ind":      pe_vs_ind,
        "consensus_pe":   _sf(d.get("PECONS")),
        "consensus_pb":   _sf(d.get("PBCONS")),
        "consensus_eps":  _sf(d.get("sc_ttm_cons")),
        "cagr_1y":        _sf(d.get("cagr1Y")),
        "cagr_3y":        _sf(d.get("cagr3Y")),
        "cagr_5y":        _sf(d.get("cagr5Y")),
        "cagr_10y":       _sf(d.get("cagr10Y")),
        "high_52w":       h52,
        "low_52w":        l52,
        "high_52w_date":  d.get("52HDate"),
        "low_52w_date":   d.get("52LDate"),
        "dist_52w_high":  dist_52h,
        "dist_52w_low":   dist_52l,
        "days_from_52wh": _days_since(d.get("52HDate")),
        "ma_50":          ma50,
        "ma_200":         ma200,
        "ma50_dist_pct":  ma50_dist,
        "ma200_dist_pct": ma200_dist,
        "del_pct_3d":     _sf(d.get("AvgDelVolPer_3day")),
        "del_pct_5d":     _sf(d.get("AvgDelVolPer_5day")),
        "del_pct_8d":     _sf(d.get("AvgDelVolPer_8day")),
        "del_pct_20d":    _sf(d.get("AvgDelVolPer_20day")),
        "vol_today":      vol_today,
        "vol_avg_20d":    vol_avg,
        "vol_ratio":      vol_ratio,
        "upper_circuit":  ucirc,
        "lower_circuit":  _sf(d.get("lower_circuit_limit")),
        "circuit_dist_pct": circuit_dist,
        "mktcap_cr":      _sf(d.get("MKTCAP")),
        "fno_lot_size":   _si(d.get("MKT_LOT")),
        "div_yield":      _sf(d.get("DY")),
    }


def upsert_row(symbol: str, today: str, f: dict, con) -> None:
    cur = con.cursor()
    cur.execute("""
        INSERT INTO mc_pricefeed_daily (
            symbol, date, price, pe, pb, ind_pe, pe_vs_ind,
            consensus_pe, consensus_pb, consensus_eps,
            cagr_1y, cagr_3y, cagr_5y, cagr_10y,
            high_52w, low_52w, high_52w_date, low_52w_date,
            dist_52w_high, dist_52w_low, days_from_52wh,
            ma_50, ma_200, ma50_dist_pct, ma200_dist_pct,
            del_pct_3d, del_pct_5d, del_pct_8d, del_pct_20d,
            vol_today, vol_avg_20d, vol_ratio,
            upper_circuit, lower_circuit, circuit_dist_pct,
            mktcap_cr, fno_lot_size, div_yield
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(symbol, date) DO UPDATE SET
            price=excluded.price, pe=excluded.pe, pb=excluded.pb,
            ind_pe=excluded.ind_pe, pe_vs_ind=excluded.pe_vs_ind,
            consensus_pe=excluded.consensus_pe, consensus_pb=excluded.consensus_pb,
            consensus_eps=excluded.consensus_eps,
            cagr_1y=excluded.cagr_1y, cagr_3y=excluded.cagr_3y,
            cagr_5y=excluded.cagr_5y, cagr_10y=excluded.cagr_10y,
            high_52w=excluded.high_52w, low_52w=excluded.low_52w,
            high_52w_date=excluded.high_52w_date, low_52w_date=excluded.low_52w_date,
            dist_52w_high=excluded.dist_52w_high, dist_52w_low=excluded.dist_52w_low,
            days_from_52wh=excluded.days_from_52wh,
            ma_50=excluded.ma_50, ma_200=excluded.ma_200,
            ma50_dist_pct=excluded.ma50_dist_pct, ma200_dist_pct=excluded.ma200_dist_pct,
            del_pct_3d=excluded.del_pct_3d, del_pct_5d=excluded.del_pct_5d,
            del_pct_8d=excluded.del_pct_8d, del_pct_20d=excluded.del_pct_20d,
            vol_today=excluded.vol_today, vol_avg_20d=excluded.vol_avg_20d,
            vol_ratio=excluded.vol_ratio,
            upper_circuit=excluded.upper_circuit, lower_circuit=excluded.lower_circuit,
            circuit_dist_pct=excluded.circuit_dist_pct,
            mktcap_cr=excluded.mktcap_cr, fno_lot_size=excluded.fno_lot_size,
            div_yield=excluded.div_yield,
            fetched_at=CURRENT_TIMESTAMP
    """, (
        symbol, today,
        f.get("price"), f.get("pe"), f.get("pb"),
        f.get("ind_pe"), f.get("pe_vs_ind"),
        f.get("consensus_pe"), f.get("consensus_pb"), f.get("consensus_eps"),
        f.get("cagr_1y"), f.get("cagr_3y"), f.get("cagr_5y"), f.get("cagr_10y"),
        f.get("high_52w"), f.get("low_52w"), f.get("high_52w_date"), f.get("low_52w_date"),
        f.get("dist_52w_high"), f.get("dist_52w_low"), f.get("days_from_52wh"),
        f.get("ma_50"), f.get("ma_200"), f.get("ma50_dist_pct"), f.get("ma200_dist_pct"),
        f.get("del_pct_3d"), f.get("del_pct_5d"), f.get("del_pct_8d"), f.get("del_pct_20d"),
        f.get("vol_today"), f.get("vol_avg_20d"), f.get("vol_ratio"),
        f.get("upper_circuit"), f.get("lower_circuit"), f.get("circuit_dist_pct"),
        f.get("mktcap_cr"), f.get("fno_lot_size"), f.get("div_yield"),
    ))
    con.commit()


def backfill_technical_signals(symbol: str, f: dict, con) -> None:
    cur = con.cursor()
    cur.execute("""
        UPDATE technical_signals SET
            mc_52w_high_dist_pct = COALESCE(?, mc_52w_high_dist_pct),
            mc_52w_low_dist_pct  = COALESCE(?, mc_52w_low_dist_pct),
            mc_days_from_52wh    = COALESCE(?, mc_days_from_52wh),
            mc_cagr_3y           = COALESCE(?, mc_cagr_3y),
            mc_cagr_5y           = COALESCE(?, mc_cagr_5y),
            mc_ind_pe            = COALESCE(?, mc_ind_pe),
            mc_pe_vs_ind         = COALESCE(?, mc_pe_vs_ind),
            mc_consensus_pe      = COALESCE(?, mc_consensus_pe),
            mc_ma50_dist_pct     = COALESCE(?, mc_ma50_dist_pct),
            mc_ma200_dist_pct    = COALESCE(?, mc_ma200_dist_pct),
            mc_del_pct_20d       = COALESCE(?, mc_del_pct_20d),
            mc_vol_ratio         = COALESCE(?, mc_vol_ratio),
            mc_circuit_dist_pct  = COALESCE(?, mc_circuit_dist_pct)
        WHERE symbol = ?
    """, (
        f.get("dist_52w_high"), f.get("dist_52w_low"), f.get("days_from_52wh"),
        f.get("cagr_3y"), f.get("cagr_5y"),
        f.get("ind_pe"), f.get("pe_vs_ind"), f.get("consensus_pe"),
        f.get("ma50_dist_pct"), f.get("ma200_dist_pct"),
        f.get("del_pct_20d"), f.get("vol_ratio"), f.get("circuit_dist_pct"),
        symbol,
    ))
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

    print(f"[MCPricefeed] Fetching {len(stocks)} stocks…")
    session = requests.Session()
    today = date.today().isoformat()
    ok = 0

    for i, (symbol, mcsymbol) in enumerate(stocks, 1):
        data = _fetch(mcsymbol, session)
        if data is None:
            print(f"  [{i}/{len(stocks)}] {symbol}: no data")
            time.sleep(RATE_LIMIT_SEC)
            continue

        f = extract_features(data)
        upsert_row(symbol, today, f, con)
        backfill_technical_signals(symbol, f, con)

        ind_pe_str = f"IND_PE={f.get('ind_pe','?')} vs_ind={f.get('pe_vs_ind','?')}"
        cagr_str   = f"CAGR3={f.get('cagr_3y','?')}% CAGR5={f.get('cagr_5y','?')}%"
        ma_str     = f"MA200={f.get('ma200_dist_pct','?')}%"
        print(f"  [{i}/{len(stocks)}] {symbol}: {ind_pe_str} | {cagr_str} | {ma_str}")
        ok += 1
        time.sleep(RATE_LIMIT_SEC)

    print(f"[MCPricefeed] Done. {ok}/{len(stocks)} stocks.")
    con.close()


if __name__ == "__main__":
    main()
