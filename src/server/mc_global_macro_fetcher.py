"""
MC Global Macro Fetcher
========================
Pulls six MoneyControl endpoints in one lightweight pass (~6 HTTP requests) and
writes structured data to two tables:

  mc_global_snapshot   — per-symbol daily snapshot: price, multi-period returns,
                         technical indicators (RSI/MACD/ADX/SMA), rating, category.

  macro_asset_prices   — extends the existing yfinance-based table with new symbols:
                         NIKKEI, HANGSENG, KOSPI, SHANGHAI, TAIWAN, STII, JAKARTA,
                         FTSE, DAX, NASDAQ, DOW, GIFT_NIFTY,
                         USDINR, EURUSD, USDJPY, EURINR, JPYINR, CNYINR,
                         BRENT, GOLD_MC, CRUDE_MC
                         + computed aggregates:
                         ASIA_SENTIMENT  — daily mean of 5 Asian ex-India indices
                         ADRS_BULLISH_PCT — % of Indian ADRs that closed positive

Endpoints consumed:
  1. Global indices overview  — 15 indices, 3 regions; price + multi-period returns + rating
  2. Global indices technical — same 15 indices; SMA50/200, RSI, MACD, Stochastic, CCI, ADX
  3. Currencies               — 9 pairs incl USD/INR, EUR/USD, USD/JPY, CNY/INR
  4. Indian ADRs              — 13 US-listed Indian companies; overnight % change
  5. Commodities overview     — Brent Crude, Gold, Crude Oil; multi-period returns + rating

ML value rationale:
  • Asian indices (Nikkei, Hang Seng, KOSPI) close before India opens → strongest
    leading predictor of Indian market direction at open.
  • Indian ADR overnight return → direct FII/institutional sentiment on Indian large-caps.
  • USD/INR → critical for IT exporters (Infosys, TCS, Wipro) and import-sensitive sectors.
  • Multi-period commodity momentum (weekly/monthly) → crude-corr and gold-corr features.
  • Technical ratings are pre-computed consensus signals usable as ordinal ML features.

Run:
  python mc_global_macro_fetcher.py          # full fetch + write
  python mc_global_macro_fetcher.py --dry-run # fetch only, print summary
"""

import polars as pl
from pydantic import BaseModel
from base_fetcher import BaseFetcher, governed_fetcher

class McGlobalMacroFetcherSchema(BaseModel):
    symbol: str | None = None
    date: str | None = None

class McGlobalMacroFetcherBaseFetcher(BaseFetcher[McGlobalMacroFetcherSchema]):
    fetcher_name = 'McGlobalMacroFetcher'
    domain = 'moneycontrol.com'
    schema = McGlobalMacroFetcherSchema
    min_interval_sec = 0.5


import argparse
import datetime
import sys

try:
    from curl_cffi import requests as cffi_req
except ImportError:
    cffi_req = None

from db_compat import connect, translate, use_postgres
from fetch_utils import retry_get

# ── Endpoints ─────────────────────────────────────────────────────────────────

_BASE_PRICE = "https://priceapi.moneycontrol.com/technicalCompanyData/globalMarket"
_BASE_API   = "https://api.moneycontrol.com/mcapi/v1"
_BASE_FEEDS = "https://appfeeds.moneycontrol.com/jsonapi/market"

ENDPOINTS = {
    "idx_overview":  f"{_BASE_PRICE}/getGlobalIndicesListingData?view=overview&deviceType=W",
    "idx_technical": f"{_BASE_PRICE}/getGlobalIndicesListingData?view=technical&deviceType=W",
    "commodities":   f"{_BASE_PRICE}/getCommodityListingData?view=overview&deviceType=W",
    "currencies":    f"{_BASE_API}/us-markets/getCurrencies",
    "adrs":          f"{_BASE_FEEDS}/get_indian_adrs",
}

MC_HEADERS = {
    "accept": "application/json",
    "origin": "https://www.moneycontrol.com",
    "referer": "https://www.moneycontrol.com/",
    "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36",
}

# ── Index symbol → canonical macro name ───────────────────────────────────────

INDEX_SYMBOL_MAP = {
    "INDU:IND":  "DOW",
    "SPX:IND":   "SP500_MC",       # SP500 already in macro from yfinance; keep for rating/tech
    "CCMP:IND":  "NASDAQ",
    "gb;FTSE":   "FTSE",
    "fr;CAC":    "CAC",
    "de;qx":     "DAX",
    "in;gsx":    "GIFT_NIFTY",
    "JP;N225":   "NIKKEI",
    "sg;STII":   "STII",
    "cn;hsi":    "HANGSENG",
    "tw;IXTA":   "TAIWAN",
    "kr;KSPI":   "KOSPI",
    "th;SETI":   "SET",
    "id;JSC":    "JAKARTA",
    "cn;shi":    "SHANGHAI",
}

# Asian indices used for ASIA_SENTIMENT aggregate (ex GIFT_NIFTY, ex India)
ASIA_SYMBOLS = {"NIKKEI", "HANGSENG", "KOSPI", "SHANGHAI", "TAIWAN"}

CURRENCY_NAME_MAP = {
    "Dollar Index": "DXY_MC",
    "USD/INR":      "USDINR",
    "GBP/INR":      "GBPINR",
    "EUR/INR":      "EURINR",
    "JPY/INR":      "JPYINR",
    "CNY/INR":      "CNYINR",
    "USD/JPY":      "USDJPY",
    "EUR/USD":      "EURUSD",
    "USD/CNY":      "USDCNY",
}

COMMODITY_NAME_MAP = {
    "Brent Crude": "BRENT",
    "Gold":        "GOLD_MC",
    "Crude Oil":   "CRUDE_MC",
}

RATING_SCORE = {
    "Very Bullish": 2,
    "Bullish":      1,
    "--":           0,
    "Neutral":      0,
    "Bearish":     -1,
    "Very Bearish":-2,
}

# ── HTTP ──────────────────────────────────────────────────────────────────────

def _get(url: str) -> dict | list | None:
    try:
        r = retry_get(cffi_req, url, headers=MC_HEADERS, timeout=15)
        return r.json()
    except Exception as e:
        print(f"[GlobalMacro] Fetch error {url}: {e}", file=sys.stderr)
        return None

# ── Parsers ───────────────────────────────────────────────────────────────────

def _f(v) -> float | None:
    if v is None or v == "--" or v == "":
        return None
    try:
        return float(str(v).replace(",", "").strip())
    except (ValueError, TypeError):
        return None


def parse_indices(overview_data: dict, tech_data: dict) -> list[dict]:
    ov_cols  = [h["name"] for h in overview_data["header"]]
    tch_cols = [h["name"] for h in tech_data["header"]]

    tech_by_sym: dict[str, dict] = {}
    for group in tech_data["dataList"]:
        for row in group["data"]:
            d = dict(zip(tch_cols, row))
            tech_by_sym[d["symbol"]] = d

    records = []
    for group in overview_data["dataList"]:
        region = group["heading"]   # US_Market / European_Market / Asian_Market
        for row in group["data"]:
            d  = dict(zip(ov_cols, row))
            tc = tech_by_sym.get(d["symbol"], {})
            sym = INDEX_SYMBOL_MAP.get(d["symbol"])
            if not sym:
                continue
            records.append({
                "symbol":           sym,
                "name":             d.get("name", ""),
                "category":         f"index_{region.split('_')[0].lower()}",
                "price":            _f(d.get("price")),
                "ret_1d":           _f(d.get("percent_change")),
                "ret_1w":           _f(d.get("weekly_per_change")),
                "ret_1m":           _f(d.get("monthly_per_change")),
                "ret_3m":           _f(d.get("3months_per_change")),
                "ret_6m":           _f(d.get("6months_per_change")),
                "ret_ytd":          _f(d.get("ytd_per_change")),
                "ret_1y":           _f(d.get("yearly_per_change")),
                "high_52w":         _f(d.get("52wkHigh")),
                "low_52w":          _f(d.get("52wkLow")),
                "sma50":            _f(tc.get("sma50")),
                "sma200":           _f(tc.get("sma200")),
                "rsi":              _f(tc.get("rsi")),
                "macd":             _f(tc.get("macd")),
                "adx":              _f(tc.get("adx")),
                "technical_rating": d.get("technical_rating", ""),
                "rating_score":     RATING_SCORE.get(d.get("technical_rating", ""), 0),
            })
    return records


def parse_commodities(data: dict) -> list[dict]:
    cols = [h["name"] for h in data["header"]]
    records = []
    for row in data["dataList"]:
        d   = dict(zip(cols, row))
        sym = COMMODITY_NAME_MAP.get(d.get("name", ""))
        if not sym:
            continue
        records.append({
            "symbol":           sym,
            "name":             d.get("name", ""),
            "category":         "commodity",
            "price":            _f(d.get("price")),
            "ret_1d":           _f(d.get("percent_change")),
            "ret_1w":           _f(d.get("weekly_per_change")),
            "ret_1m":           _f(d.get("monthly_per_change")),
            "ret_3m":           _f(d.get("3months_per_change")),
            "ret_6m":           _f(d.get("6months_per_change")),
            "ret_ytd":          _f(d.get("ytd_per_change")),
            "ret_1y":           _f(d.get("yearly_per_change")),
            "high_52w":         _f(d.get("52wkHigh")),
            "low_52w":          _f(d.get("52wkLow")),
            "sma50":            None,
            "sma200":           None,
            "rsi":              None,
            "macd":             None,
            "adx":              None,
            "technical_rating": d.get("technical_rating", ""),
            "rating_score":     RATING_SCORE.get(d.get("technical_rating", ""), 0),
        })
    return records


def parse_currencies(data: dict) -> list[dict]:
    records = []
    for item in data.get("data", []):
        sym = CURRENCY_NAME_MAP.get(item.get("name", ""))
        if not sym:
            continue
        ltp  = _f(item.get("ltp"))
        prev = _f(item.get("prevclose"))
        ret_1d = ((ltp - prev) / prev * 100) if (ltp and prev and prev != 0) else _f(item.get("chgper"))
        records.append({
            "symbol":           sym,
            "name":             item.get("name", ""),
            "category":         "currency",
            "price":            ltp,
            "ret_1d":           ret_1d,
            "ret_1w":           None, "ret_1m": None, "ret_3m": None,
            "ret_6m":           None, "ret_ytd": None, "ret_1y": None,
            "high_52w":         _f(item.get("high")),
            "low_52w":          _f(item.get("low")),
            "sma50":            None, "sma200": None, "rsi": None, "macd": None, "adx": None,
            "technical_rating": "",
            "rating_score":     0,
        })
    return records


def parse_adrs(items: list) -> tuple[list[dict], float | None]:
    """Returns (records, adrs_bullish_pct). bullish_pct = fraction of ADRs that closed positive."""
    records = []
    gains = 0
    valid = 0
    for item in items:
        chg = _f(item.get("percentchange"))
        ltp = _f(item.get("lastprice"))
        prev = _f(item.get("prev_close"))
        if ltp is None or ltp == 0:
            continue
        if chg is not None:
            valid += 1
            if chg > 0:
                gains += 1
        records.append({
            "symbol":           item.get("shortname", "").replace(" ", "_").upper()[:20],
            "name":             item.get("shortname", ""),
            "category":         "adr",
            "price":            ltp,
            "ret_1d":           chg,
            "ret_1w":           None, "ret_1m": None, "ret_3m": None,
            "ret_6m":           None, "ret_ytd": None, "ret_1y": None,
            "high_52w":         _f(item.get("high")),
            "low_52w":          _f(item.get("low")),
            "sma50":            None, "sma200": None, "rsi": None, "macd": None, "adx": None,
            "technical_rating": "",
            "rating_score":     0,
        })
    bullish_pct = (gains / valid * 100) if valid > 0 else None
    return records, bullish_pct

# ── Compute aggregates ────────────────────────────────────────────────────────

def compute_aggregates(all_records: list[dict], adrs_bullish_pct: float | None) -> list[dict]:
    """Compute ASIA_SENTIMENT and ADRS_BULLISH_PCT synthetic macro symbols."""
    by_sym = {r["symbol"]: r for r in all_records}

    asia_rets = [by_sym[s]["ret_1d"] for s in ASIA_SYMBOLS if s in by_sym and by_sym[s]["ret_1d"] is not None]
    asia_sentiment = (sum(asia_rets) / len(asia_rets)) if asia_rets else None

    aggregates = []
    if asia_sentiment is not None:
        aggregates.append({
            "symbol": "ASIA_SENTIMENT", "name": "Asia Sentiment (avg 5 indices)",
            "category": "aggregate", "price": asia_sentiment, "ret_1d": asia_sentiment,
            "ret_1w": None, "ret_1m": None, "ret_3m": None, "ret_6m": None,
            "ret_ytd": None, "ret_1y": None, "high_52w": None, "low_52w": None,
            "sma50": None, "sma200": None, "rsi": None, "macd": None, "adx": None,
            "technical_rating": "", "rating_score": 0,
        })
    if adrs_bullish_pct is not None:
        aggregates.append({
            "symbol": "ADRS_BULLISH_PCT", "name": "Indian ADRs Bullish %",
            "category": "aggregate", "price": adrs_bullish_pct, "ret_1d": None,
            "ret_1w": None, "ret_1m": None, "ret_3m": None, "ret_6m": None,
            "ret_ytd": None, "ret_1y": None, "high_52w": None, "low_52w": None,
            "sma50": None, "sma200": None, "rsi": None, "macd": None, "adx": None,
            "technical_rating": "", "rating_score": 0,
        })
    return aggregates

# ── Schema ────────────────────────────────────────────────────────────────────

_CREATE_SNAPSHOT = """
CREATE TABLE IF NOT EXISTS mc_global_snapshot (
    symbol           TEXT NOT NULL,
    name             TEXT,
    category         TEXT,
    date             TEXT NOT NULL,
    price            REAL,
    ret_1d           REAL,
    ret_1w           REAL,
    ret_1m           REAL,
    ret_3m           REAL,
    ret_6m           REAL,
    ret_ytd          REAL,
    ret_1y           REAL,
    high_52w         REAL,
    low_52w          REAL,
    sma50            REAL,
    sma200           REAL,
    rsi              REAL,
    macd             REAL,
    adx              REAL,
    technical_rating TEXT,
    rating_score     INTEGER,
    fetched_at       TEXT DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (symbol, date)
)
"""

_UPSERT_SNAPSHOT_PG = """
INSERT INTO mc_global_snapshot
    (symbol, name, category, date, price, ret_1d, ret_1w, ret_1m, ret_3m, ret_6m,
     ret_ytd, ret_1y, high_52w, low_52w, sma50, sma200, rsi, macd, adx,
     technical_rating, rating_score, fetched_at)
VALUES
    (:symbol,:name,:category,:date,:price,:ret_1d,:ret_1w,:ret_1m,:ret_3m,:ret_6m,
     :ret_ytd,:ret_1y,:high_52w,:low_52w,:sma50,:sma200,:rsi,:macd,:adx,
     :technical_rating,:rating_score,:fetched_at)
ON CONFLICT (symbol, date) DO UPDATE SET
    price            = EXCLUDED.price,
    ret_1d           = EXCLUDED.ret_1d,
    ret_1w           = EXCLUDED.ret_1w,
    ret_1m           = EXCLUDED.ret_1m,
    ret_3m           = EXCLUDED.ret_3m,
    ret_6m           = EXCLUDED.ret_6m,
    ret_ytd          = EXCLUDED.ret_ytd,
    ret_1y           = EXCLUDED.ret_1y,
    high_52w         = EXCLUDED.high_52w,
    low_52w          = EXCLUDED.low_52w,
    sma50            = EXCLUDED.sma50,
    sma200           = EXCLUDED.sma200,
    rsi              = EXCLUDED.rsi,
    macd             = EXCLUDED.macd,
    adx              = EXCLUDED.adx,
    technical_rating = EXCLUDED.technical_rating,
    rating_score     = EXCLUDED.rating_score,
    fetched_at       = EXCLUDED.fetched_at
"""

_UPSERT_SNAPSHOT_SL = """
INSERT OR REPLACE INTO mc_global_snapshot
    (symbol, name, category, date, price, ret_1d, ret_1w, ret_1m, ret_3m, ret_6m,
     ret_ytd, ret_1y, high_52w, low_52w, sma50, sma200, rsi, macd, adx,
     technical_rating, rating_score, fetched_at)
VALUES
    (:symbol,:name,:category,:date,:price,:ret_1d,:ret_1w,:ret_1m,:ret_3m,:ret_6m,
     :ret_ytd,:ret_1y,:high_52w,:low_52w,:sma50,:sma200,:rsi,:macd,:adx,
     :technical_rating,:rating_score,:fetched_at)
"""

_UPSERT_MACRO = """
INSERT INTO macro_asset_prices (date, symbol, close, ret_1d, ret_5d, fetched_at)
VALUES (:date, :symbol, :close, :ret_1d, NULL, :fetched_at)
ON CONFLICT (date, symbol) DO UPDATE SET
    close      = EXCLUDED.close,
    ret_1d     = EXCLUDED.ret_1d,
    fetched_at = EXCLUDED.fetched_at
"""

# ── DB writes ─────────────────────────────────────────────────────────────────

def ensure_schema(con) -> None:
    con.execute(translate(_CREATE_SNAPSHOT))
    con.commit()


def write_all(con, records: list[dict], today: str) -> None:
    pg         = use_postgres()
    snap_sql   = translate(_UPSERT_SNAPSHOT_PG if pg else _UPSERT_SNAPSHOT_SL)
    macro_sql  = translate(_UPSERT_MACRO)
    now        = datetime.datetime.utcnow().isoformat()

    snap_params  = []
    macro_params = []

    for r in records:
        snap_params.append({**r, "date": today, "fetched_at": now})
        # Write to macro_asset_prices for all symbols that have a price
        if r.get("price") is not None:
            macro_params.append({
                "date":       today,
                "symbol":     r["symbol"],
                "close":      r["price"],
                "ret_1d":     r.get("ret_1d"),
                "fetched_at": now,
            })

    cur = con.cursor()
    for p in snap_params:
        cur.execute(snap_sql, p)
    for p in macro_params:
        cur.execute(macro_sql, p)
    con.commit()

# ── Main ─────────────────────────────────────────────────────────────────────

def run(dry_run: bool = False) -> dict:
    if cffi_req is None:
        print("[GlobalMacro] curl_cffi not installed. Run: pip install curl-cffi", file=sys.stderr)
        sys.exit(1)

    today = datetime.date.today().isoformat()

    # Fetch
    print("[GlobalMacro] Fetching global indices (overview + technical)...")
    ov  = _get(ENDPOINTS["idx_overview"])
    tch = _get(ENDPOINTS["idx_technical"])
    print("[GlobalMacro] Fetching commodities...")
    com = _get(ENDPOINTS["commodities"])
    print("[GlobalMacro] Fetching currencies...")
    cur = _get(ENDPOINTS["currencies"])
    print("[GlobalMacro] Fetching Indian ADRs...")
    adr = _get(ENDPOINTS["adrs"])

    # Parse
    records = []
    if ov and tch:
        idx_records = parse_indices(ov, tch)
        records.extend(idx_records)
        print(f"[GlobalMacro]   Indices:     {len(idx_records)} symbols")

    if com:
        com_records = parse_commodities(com)
        records.extend(com_records)
        print(f"[GlobalMacro]   Commodities: {len(com_records)} symbols")

    if cur:
        cur_records = parse_currencies(cur)
        records.extend(cur_records)
        print(f"[GlobalMacro]   Currencies:  {len(cur_records)} symbols")

    adr_records, bullish_pct = (parse_adrs(adr) if adr else ([], None))
    records.extend(adr_records)
    print(f"[GlobalMacro]   ADRs:        {len(adr_records)} stocks  (bullish={bullish_pct:.0f}%)" if bullish_pct is not None else f"[GlobalMacro]   ADRs:        {len(adr_records)} stocks")

    agg_records = compute_aggregates(records, bullish_pct)
    records.extend(agg_records)

    # Show ML-relevant summary
    by_sym = {r["symbol"]: r for r in records}
    asia_names = [(s, by_sym[s]["ret_1d"]) for s in ["NIKKEI","HANGSENG","KOSPI","SHANGHAI","TAIWAN"] if s in by_sym]
    print("\n[GlobalMacro] Asia today:")
    for sym, ret in asia_names:
        print(f"  {sym:12s} {ret:+.2f}%" if ret is not None else f"  {sym:12s} n/a")
    if "ASIA_SENTIMENT" in by_sym:
        print(f"  ASIA_SENTIMENT = {by_sym['ASIA_SENTIMENT']['price']:+.2f}%")
    if "ADRS_BULLISH_PCT" in by_sym:
        print(f"  ADR bullish = {by_sym['ADRS_BULLISH_PCT']['price']:.0f}% of Indian ADRs positive overnight")
    if "USDINR" in by_sym:
        r = by_sym["USDINR"]
        print(f"  USD/INR = {r['price']}  ({r['ret_1d']:+.2f}%)" if r["ret_1d"] is not None else f"  USD/INR = {r['price']}")

    if dry_run:
        print(f"\n[GlobalMacro] Dry run — {len(records)} records parsed, nothing written.")
        return {"records": len(records), "dry_run": True}

    # Write
    con = connect()
    ensure_schema(con)
    write_all(con, records, today)
    con.close()

    if len(records) == 0:
        print("\n[GlobalMacro] ERROR: 0 records parsed from all endpoints. Treating as failure.", file=sys.stderr)
        if __name__ == "__main__":
            sys.exit(1)
        else:
            raise RuntimeError("Zero records parsed from GlobalMacro endpoints")

    print(f"\n[GlobalMacro] Done. {len(records)} records written to mc_global_snapshot + macro_asset_prices.")
    return {"records": len(records), "asia_sentiment": by_sym.get("ASIA_SENTIMENT", {}).get("price"),
            "adrs_bullish_pct": bullish_pct}


def main() -> None:
    parser = argparse.ArgumentParser(description="MC Global Macro Fetcher")
    parser.add_argument("--dry-run", action="store_true", help="Fetch and parse only, do not write to DB")
    args = parser.parse_args()
    run(dry_run=args.dry_run)


if __name__ == "__main__":
    main()

def to_polars_df(data):
    """Converts pandas DataFrame or list of dicts to Polars DataFrame for fast vector operations."""
    if hasattr(data, 'empty') and data.empty:
        return pl.DataFrame()
    return pl.from_pandas(data) if hasattr(data, 'to_numpy') else pl.DataFrame(data)
