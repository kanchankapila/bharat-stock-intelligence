"""
trendlyne_fno_activity_fetcher.py
==================================
Fetches Trendlyne SmartOptions' market-wide F&O activity screeners (unusual OI
buildup / most-traded-value / OI gainers-losers across the whole options market) --
a genuinely different endpoint from so_option_chain_fetcher.py's per-stock option
chain (that one needs `stockCode`; this one is a cross-market ranked screener, no
per-stock id at all). Writes to trendlyne_fno_activity.

Promoted 2026-07-30 from a captured URL in updated_urls.json that had a stale
hardcoded `expDate=2026-05-26` (a past expiry relative to the capture date) --
fixed here by resolving the current nearest MONTHLY F&O expiry from nt_fno_expiry
(populated by sync_nt_fno_symbols.py, same source so_option_chain_fetcher.py uses).

Live-verified this endpoint filters strictly by expDate with no index/stock
distinction, so the expiry choice matters: NIFTY's own nearest expiry is a WEEKLY
date (e.g. 2026-08-04) that only NIFTY/BANKNIFTY trade -- using it here returned
298/298 rows for symbol=NIFTY only. The nearest MONTHLY expiry (empirically the
expiry date shared by the most symbols in nt_fno_expiry, e.g. 2026-08-25 with 213
symbols vs. the next-most-common date's 212) is what individual F&O stocks
actually expire on and is what makes this a genuine cross-market screener --
confirmed live: 97 distinct symbols across 200 oi-gainers rows at that date.

API: https://smartoptions.trendlyne.com/phoenix/api/fno/market/filter/
     ?mtype=options&expDate={expiry}&screenType={screen_type}

Column mapping is resolved from the response's own tableHeaders at parse time
(never a hardcoded position) -- see Finding #52 in so_option_chain_fetcher.py for
why a fixed-position assumption on this exact API family is a proven corruption
risk, live-verified again while building this fetcher (StockEdge/other candidate
endpoints in this same sweep silently 404'd instead -- this endpoint's shape was
independently confirmed live before writing this file).

Run:
  python trendlyne_fno_activity_fetcher.py                  # all screen types, nearest expiry
  python trendlyne_fno_activity_fetcher.py --screen-type oi-gainers
  python trendlyne_fno_activity_fetcher.py --expiry 2026-08-04
"""

import polars as pl
from pydantic import BaseModel
from base_fetcher import BaseFetcher, governed_fetcher

class TrendlyneFnoActivityFetcherSchema(BaseModel):
    symbol: str | None = None
    date: str | None = None

class TrendlyneFnoActivityFetcherBaseFetcher(BaseFetcher[TrendlyneFnoActivityFetcherSchema]):
    fetcher_name = 'TrendlyneFnoActivityFetcher'
    domain = 'trendlyne.com'
    schema = TrendlyneFnoActivityFetcherSchema
    min_interval_sec = 0.5


import argparse
from datetime import date as _date, datetime

import requests

from db_compat import execute, executemany, connect, query_all
import sys

FNO_ACTIVITY_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
    ),
    "Accept": "application/json",
    "Origin": "https://smartoptions.trendlyne.com",
    "Referer": "https://smartoptions.trendlyne.com/",
}

ACTIVITY_URL = (
    "https://smartoptions.trendlyne.com/phoenix/api/fno/market/filter/"
    "?mtype=options&expDate={expiry}&screenType={screen_type}"
)

# Live-verified 2026-07-30 for these 3; the API supports more (price-gainers/losers,
# contract-gainers/losers, most-active-contract, ...) -- add once each is individually
# live-tested, per the "test live, only add working ones" rule.
SCREEN_TYPES = ("most-active-value", "oi-gainers", "oi-losers")

_FIELD_MAP = {
    "current_price": "ltp",
    "day_change": "day_change_pct",
    "traded_contracts": "volume",
    "traded_contracts_change": "volume_chg_pct",
    "ttv": "ttv",
    "open_interest": "oi",
    "oi_difference": "oi_change",
    "oi_change": "oi_change_pct",
    "implied_volatility": "iv",
    "iv_change": "iv_change_pct",
    "currentPrice": "spot",
    "delta_calc": "delta",
    "gamma_calc": "gamma",
    "rho_calc": "rho",
    "theta_calc": "theta",
    "vega_calc": "vega",
    "get_built_up_str": "buildup",
}
_REQUIRED_FIELDS = set(_FIELD_MAP.values())


def ensure_schema(con=None) -> None:
    own = con is None
    con = con or connect()
    cur = con.cursor()
    cur.execute("""
        CREATE TABLE IF NOT EXISTS trendlyne_fno_activity (
            symbol TEXT NOT NULL,
            date TEXT NOT NULL,
            expiry TEXT NOT NULL,
            screen_type TEXT NOT NULL,
            rank INTEGER,
            option_type TEXT,
            strike REAL,
            ltp REAL,
            day_change_pct REAL,
            volume REAL,
            volume_chg_pct REAL,
            ttv REAL,
            oi REAL,
            oi_change REAL,
            oi_change_pct REAL,
            iv REAL,
            iv_change_pct REAL,
            spot REAL,
            delta REAL,
            gamma REAL,
            theta REAL,
            vega REAL,
            rho REAL,
            buildup TEXT,
            fetched_at TEXT DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (symbol, date, expiry, screen_type, option_type, strike)
        )
    """)
    if own:
        con.commit()
        con.close()


def _build_col_map(table_headers: list) -> dict:
    """Resolve field -> tableData index from the response's OWN tableHeaders (keyed by
    'name', this endpoint's field-identity key -- distinct from the per-stock option-chain
    endpoint's 'unique_name'). Raises RuntimeError rather than silently misreading Greeks/OI
    if Trendlyne changes this response's shape."""
    col: dict[str, int] = {}
    for idx, header in enumerate(table_headers or []):
        field = _FIELD_MAP.get(header.get("name"))
        if field:
            col[field] = idx
    missing = _REQUIRED_FIELDS - col.keys()
    if missing:
        raise RuntimeError(
            f"[fno_activity] tableHeaders shape mismatch -- required field(s) not found: "
            f"{sorted(missing)}. Trendlyne's market/filter response layout may have changed; "
            f"refusing to parse with a stale/incomplete column map."
        )
    return col


def _get_nse_official_monthly_expiry() -> str | None:
    """NSE's own futures-expiry list for NIFTY -- the authoritative source (this IS where
    NiftyTrader's nt_fno_expiry ultimately comes from). Live-verified 2026-07-30 that its
    first upcoming entry matches nt_fno_expiry's empirically-derived mode exactly
    (2026-08-25 both ways). Tried first so this fetcher isn't 100% dependent on
    sync_nt_fno_symbols.py/NiftyTrader staying up -- returns None (not raises) on any
    failure so the caller can fall back cleanly."""
    try:
        from nse import NSE
        with NSE(download_folder=".") as nse:
            dates = nse.getFuturesExpiry("NIFTY")
        if not dates:
            return None
        return datetime.strptime(dates[0], "%d-%b-%Y").date().isoformat()
    except Exception as e:
        print(f"  [fno_activity] NSE official expiry lookup failed ({e}), falling back to nt_fno_expiry", file=sys.stderr)
        return None


def _get_nearest_monthly_expiry() -> str:
    """The current monthly F&O expiry, as opposed to NIFTY/BANKNIFTY's own weekly-only
    expiries which most individual stocks don't trade on at all. Tries NSE's own official
    futures-expiry list first (authoritative, load-distributes away from sole reliance on
    NiftyTrader); falls back to the mode/most-common expiry across nt_fno_expiry (populated
    by sync_nt_fno_symbols.py) if the NSE lookup fails for any reason -- empirical rather
    than a hardcoded day-of-week formula, since NSE's expiry-day rules have changed more
    than once and a fixed formula would silently drift out of sync with reality."""
    nse_expiry = _get_nse_official_monthly_expiry()
    if nse_expiry:
        return nse_expiry

    today = _date.today().isoformat()
    rows = query_all(
        "SELECT expiry, COUNT(*) AS n FROM nt_fno_expiry WHERE expiry >= ? "
        "GROUP BY expiry ORDER BY n DESC, expiry ASC LIMIT 1",
        (today,),
    )
    if rows:
        return rows[0]["expiry"][:10]
    raise RuntimeError(
        "[fno_activity] both NSE official lookup and nt_fno_expiry are unavailable -- "
        "run sync_nt_fno_symbols.py first"
    )


def _sf(v):
    try:
        return float(v) if v is not None and v != "" else None
    except (TypeError, ValueError):
        return None


def fetch_activity(expiry: str, screen_type: str) -> dict | None:
    url = ACTIVITY_URL.format(expiry=expiry, screen_type=screen_type)
    try:
        r = requests.get(url, headers=FNO_ACTIVITY_HEADERS, timeout=20)
        if not r.ok or not r.text.strip():
            return None
        d = r.json()
        if d.get("head", {}).get("status") != 0:
            return None
        return d.get("body")
    except Exception as e:
        print(f"    [fno_activity] fetch error {screen_type}/{expiry}: {e}", file=sys.stderr)
        return None


def parse_activity(body: dict, today: str, expiry: str, screen_type: str) -> list:
    col = _build_col_map(body.get("tableHeaders"))
    rows = []
    for rank, rec in enumerate(body.get("tableData") or [], start=1):
        identity = rec[0] if rec else None
        if not isinstance(identity, dict):
            continue
        callback = identity.get("callbackinfo") or {}
        symbol = (callback.get("nseCode") or identity.get("name") or "").upper()
        if not symbol:
            continue
        rows.append((
            symbol, today, expiry, screen_type, rank,
            callback.get("optionType"), _sf(callback.get("strikePrice")),
            _sf(rec[col["ltp"]]), _sf(rec[col["day_change_pct"]]),
            _sf(rec[col["volume"]]), _sf(rec[col["volume_chg_pct"]]), _sf(rec[col["ttv"]]),
            _sf(rec[col["oi"]]), _sf(rec[col["oi_change"]]), _sf(rec[col["oi_change_pct"]]),
            _sf(rec[col["iv"]]), _sf(rec[col["iv_change_pct"]]), _sf(rec[col["spot"]]),
            _sf(rec[col["delta"]]), _sf(rec[col["gamma"]]), _sf(rec[col["theta"]]),
            _sf(rec[col["vega"]]), _sf(rec[col["rho"]]),
            rec[col["buildup"]] if len(rec) > col["buildup"] else None,
        ))
    return rows


def save_activity(rows: list) -> int:
    if not rows:
        return 0
    executemany("""
        INSERT INTO trendlyne_fno_activity
            (symbol, date, expiry, screen_type, rank, option_type, strike,
             ltp, day_change_pct, volume, volume_chg_pct, ttv,
             oi, oi_change, oi_change_pct, iv, iv_change_pct, spot,
             delta, gamma, theta, vega, rho, buildup)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT (symbol, date, expiry, screen_type, option_type, strike) DO UPDATE SET
            rank=excluded.rank, ltp=excluded.ltp, day_change_pct=excluded.day_change_pct,
            volume=excluded.volume, volume_chg_pct=excluded.volume_chg_pct, ttv=excluded.ttv,
            oi=excluded.oi, oi_change=excluded.oi_change, oi_change_pct=excluded.oi_change_pct,
            iv=excluded.iv, iv_change_pct=excluded.iv_change_pct, spot=excluded.spot,
            delta=excluded.delta, gamma=excluded.gamma, theta=excluded.theta,
            vega=excluded.vega, rho=excluded.rho, buildup=excluded.buildup,
            fetched_at=CURRENT_TIMESTAMP
    """, rows)
    return len(rows)


def run(expiry: str | None = None, screen_types=SCREEN_TYPES) -> int:
    ensure_schema()
    today = _date.today().isoformat()
    exp = expiry or _get_nearest_monthly_expiry()
    total = 0
    for screen_type in screen_types:
        body = fetch_activity(exp, screen_type)
        if body is None:
            print(f"  [fno_activity] no data for {screen_type}/{exp}")
            continue
        rows = parse_activity(body, today, exp, screen_type)
        total += save_activity(rows)
        print(f"  [fno_activity] {screen_type}/{exp}: {len(rows)} rows")
    print(f"[fno_activity] done, {total} rows written for expiry {exp}")
    return total


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--expiry", default=None, help="Force expiry date YYYY-MM-DD (default: nearest NIFTY expiry)")
    parser.add_argument("--screen-type", default=None, help="Fetch a single screen type instead of all")
    args = parser.parse_args()

    screen_types = (args.screen_type,) if args.screen_type else SCREEN_TYPES
    run(expiry=args.expiry, screen_types=screen_types)

def to_polars_df(data):
    """Converts pandas DataFrame or list of dicts to Polars DataFrame for fast vector operations."""
    if hasattr(data, 'empty') and data.empty:
        return pl.DataFrame()
    return pl.from_pandas(data) if hasattr(data, 'to_numpy') else pl.DataFrame(data)
