"""
so_option_chain_fetcher.py
==========================
Fetches full option chain with GREEKS from SmartOptions (Trendlyne) for all
F&O-eligible stocks and indices. Writes to:
  - so_option_chain       — per-strike CE/PE: price, volume, OI, IV, Delta, Gamma,
                            Theta, Vega, Rho, Build-Up
  - so_stock_oi_summary   — per stock/expiry: maxPain, ATM, MWPL, IV, PCR, futures

This is the only source in the platform that provides OPTIONS GREEKS for
individual stocks. Delta and Theta are used in oi_delta_features.py and
IV is cross-validated against pcr_fetcher.py ATM IV.

API: https://smartoptions.trendlyne.com/phoenix/api/fno/option/chain/
     ?stockCode={symbol}&expDate={expiry_date}

expDate must be a valid upcoming expiry for the stock. Nearest expiry per symbol
is fetched from nt_fno_expiry (populated by sync_nt_fno_symbols.py → NT expiry API)
or falls back to the nearest upcoming Thursday (NSE weekly expiry).

Run:
  python so_option_chain_fetcher.py                # all F&O stocks, nearest expiry
  python so_option_chain_fetcher.py --symbol BEL   # single stock
  python so_option_chain_fetcher.py --index NIFTY  # single index
  python so_option_chain_fetcher.py --expiry 2026-06-30  # force expiry date
  python so_option_chain_fetcher.py --delay 0.5    # seconds between requests (default 0.3)
"""

import polars as pl
from pydantic import BaseModel
from base_fetcher import BaseFetcher, governed_fetcher

class SoOptionChainFetcherSchema(BaseModel):
    symbol: str | None = None
    date: str | None = None

class SoOptionChainFetcherBaseFetcher(BaseFetcher[SoOptionChainFetcherSchema]):
    fetcher_name = 'SoOptionChainFetcher'
    domain = 'general'
    schema = SoOptionChainFetcherSchema
    min_interval_sec = 0.5


import argparse
import time
from datetime import date as _date, timedelta

import requests

from db_compat import execute, executemany, query_all
import sys

SO_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
    ),
    "Accept": "application/json",
    "Origin": "https://smartoptions.trendlyne.com",
    "Referer": "https://smartoptions.trendlyne.com/",
}

# A per-RUN coverage floor would be the wrong monitor here and would fire on every single run:
# rotation does not raise per-run coverage (the request allowance still cuts each pass off at
# ~160 of 210), it makes the CUMULATIVE coverage converge. So the guard below is cumulative --
# how many symbols are still un-refreshed after this run -- and the floor is calibrated in
# STALE_DAYS against the real defect, which was 34 names sitting at infinity.
STALE_DAYS = 3
MAX_STALE_SYMBOLS = 45

CHAIN_URL = (
    "https://smartoptions.trendlyne.com/phoenix/api/fno/option/chain/"
    "?stockCode={symbol}&expDate={expiry}"
)

# Fixed 2026-07-30 (Finding #52, full-stack audit): these were previously hardcoded fixed
# indices into the positional tableData array, never validated against the API's own
# tableHeaders -- the same architectural bug class ("blind column N" trust with no header
# check) that already silently corrupted ~2.1M rows across 7 tables in
# trendlyne_screener_discovery.py before anyone checked a live response against the code.
# _UNIQUE_NAME_TO_FIELD maps Trendlyne's own field-identity strings (tableHeaders[i]
# ['unique_name'], confirmed live against a real RELIANCE option-chain response) to our
# field names; _build_col_map() resolves each field's ACTUAL index at parse time instead
# of trusting a fixed position, so a future Trendlyne column reorder fails loudly (a clear
# RuntimeError naming the missing field) instead of silently swapping Delta/Gamma/Theta/
# Vega/OI/IV across every F&O stock's option chain.
_UNIQUE_NAME_TO_FIELD = {
    "current_price_call":           "ce_price",
    "day_change_call":              "ce_day_chg",
    "traded_contracts_call":        "ce_volume",
    "traded_contracts_change_call": "ce_vol_chg",
    "ttv_call":                     "ce_ttv",
    "open_interest_call":           "ce_oi",
    "oi_change_call":               "ce_oi_chg",
    "implied_volatility_call":      "ce_iv",
    "iv_change_call":               "ce_iv_chg",
    "delta_calc_call":              "ce_delta",
    "gamma_calc_call":              "ce_gamma",
    "rho_calc_call":                "ce_rho",
    "theta_calc_call":              "ce_theta",
    "vega_calc_call":               "ce_vega",
    "get_built_up_str_call":        "ce_buildup",
    "strike_price":                 "strike",
    "current_price_put":            "pe_price",
    "day_change_put":               "pe_day_chg",
    "traded_contracts_put":         "pe_volume",
    "traded_contracts_change_put":  "pe_vol_chg",
    "ttv_put":                      "pe_ttv",
    "open_interest_put":            "pe_oi",
    "oi_change_put":                "pe_oi_chg",
    "implied_volatility_put":       "pe_iv",
    "iv_change_put":                "pe_iv_chg",
    "delta_calc_put":               "pe_delta",
    "gamma_calc_put":               "pe_gamma",
    "rho_calc_put":                 "pe_rho",
    "theta_calc_put":               "pe_theta",
    "vega_calc_put":                "pe_vega",
    "get_built_up_str_put":         "pe_buildup",
}

# Fields _parse_chain actually reads per row -- if any of these can't be resolved from a
# live response's tableHeaders, that response's shape no longer matches what this fetcher
# was built against and must not be silently parsed.
_REQUIRED_FIELDS = {
    "strike",
    "ce_price", "ce_volume", "ce_oi", "ce_oi_chg", "ce_iv", "ce_iv_chg",
    "ce_delta", "ce_gamma", "ce_theta", "ce_vega", "ce_rho", "ce_buildup",
    "pe_price", "pe_volume", "pe_oi", "pe_oi_chg", "pe_iv", "pe_iv_chg",
    "pe_delta", "pe_gamma", "pe_theta", "pe_vega", "pe_rho", "pe_buildup",
}


def _build_col_map(table_headers: list) -> dict:
    """Resolve field -> tableData index from the response's OWN tableHeaders, keyed by
    unique_name. Raises RuntimeError (not a silent skip) if a required field is missing --
    a mismatch here means Trendlyne changed the response shape and every downstream Greek
    would otherwise be read from the wrong column with no error."""
    col: dict[str, int] = {}
    for idx, header in enumerate(table_headers or []):
        field = _UNIQUE_NAME_TO_FIELD.get(header.get("unique_name"))
        if field:
            col[field] = idx
    missing = _REQUIRED_FIELDS - col.keys()
    if missing:
        raise RuntimeError(
            f"[so_chain] tableHeaders shape mismatch -- required field(s) not found: "
            f"{sorted(missing)}. Trendlyne's option-chain response layout may have "
            f"changed; refusing to parse with a stale/incomplete column map rather than "
            f"silently misreading Greeks."
        )
    return col


def last_tuesday_expiry(today: _date | None = None) -> str:
    """The monthly equity-F&O expiry on or after `today`: the month's LAST TUESDAY.

    Replaces `_nearest_thursday()`, which returned a date nothing expires on. Measured
    against live `nt_fno_expiry` 2026-09-05: every upcoming expiry is a Tuesday
    (2026-09-08/15/22/29, 2026-10-27; 2026-11-23 is a Monday where a holiday shifted it
    back), and the weekly Tuesdays carry exactly ONE symbol -- the index -- while the
    month-end Tuesdays carry 216. Equity F&O is monthly-only, so a stock's fallback must
    resolve to the month-end contract, never a weekly.

    This is only reached when `nt_fno_expiry` has no row for the symbol (4 of 210 F&O
    names as measured), so it deliberately does NOT model holiday shifts -- it cannot,
    without the very table whose absence put us here. A one-session-late fallback yields
    an empty chain for one day; a Thursday yields an empty chain forever.
    """
    today = today or _date.today()
    for month_offset in (0, 1):
        y, m = today.year, today.month + month_offset
        y, m = (y + (m - 1) // 12, (m - 1) % 12 + 1)
        # First day of the following month, stepped back to the last Tuesday of this one.
        nxt = _date(y + (1 if m == 12 else 0), 1 if m == 12 else m + 1, 1)
        last = nxt - timedelta(days=1)
        last_tue = last - timedelta(days=(last.weekday() - 1) % 7)
        if last_tue >= today:
            return last_tue.isoformat()
    raise AssertionError("unreachable: next month's last Tuesday is always in the future")


def _get_nearest_expiry(symbol: str, exchange: str = "NSE") -> str:
    """Look up nearest upcoming expiry from nt_fno_expiry, fallback to nearest Thursday."""
    today = _date.today().isoformat()
    try:
        rows = query_all(
            "SELECT expiry FROM nt_fno_expiry WHERE symbol = ? AND exchange = ? AND expiry >= ? ORDER BY expiry LIMIT 1",
            (symbol.upper(), exchange, today)
        )
        if rows:
            return rows[0]["expiry"][:10]
    except Exception:
        pass
    return last_tuesday_expiry()


def _get_fno_symbols() -> list[str]:
    """Return all F&O-eligible NSE symbols."""
    try:
        rows = query_all(
            "SELECT symbol FROM nse_stocks WHERE fno_eligible = 1 ORDER BY symbol"
        )
        return [r["symbol"] for r in rows]
    except Exception:
        return []


def resume_order(symbols: list[str], last_covered: dict[str, str | None]) -> list[str]:
    """Order the universe so the least-recently-covered names go FIRST.

    Trendlyne enforces a cumulative REQUEST ALLOWANCE, not a rate limit (measured 2026-09-05:
    a full 210-symbol pass costs 115s, succeeds for ~160 requests, then fails 41 of the last
    50 in a block). No pacing completes a full pass, and parallelising spends the allowance
    faster rather than buying coverage -- so the only convergent shape is to rotate WHERE the
    allowance runs out, exactly as recorded for the screener crawlers.

    Before this, `_get_fno_symbols()`'s `ORDER BY symbol` meant every run restarted at 360ONE
    and died in the same place, so 34 names after ~SRF -- TCS, TITAN, TATASTEEL, TRENT, VEDL,
    WIPRO among them -- had zero rows in 30 days while the job exited 0 daily.

    A symbol absent from `last_covered` is never-covered and sorts first; ties break
    alphabetically so a run is reproducible.
    """
    return sorted(symbols, key=lambda s: (last_covered.get(s) or "", s))


def _coverage_map(symbols: list[str]) -> dict[str, str | None]:
    """Newest so_option_chain date per symbol. Degrades to {} (i.e. plain alphabetical) on a
    read failure rather than aborting -- a rotation we cannot compute is not worth failing a
    fetch over, and the stderr coverage guard below still reports the outcome either way."""
    try:
        rows = query_all(
            "SELECT symbol, max(date)::text AS d FROM so_option_chain GROUP BY symbol"
        )
        return {r["symbol"]: r["d"] for r in rows}
    except Exception as e:
        print(f"[so_chain] coverage map unavailable, falling back to alphabetical: {e}",
              file=sys.stderr)
        return {}


def _sf(v) -> float | None:
    try:
        return float(v) if v is not None and v != "" else None
    except (TypeError, ValueError):
        return None


def fetch_chain(symbol: str, expiry: str) -> dict | None:
    url = CHAIN_URL.format(symbol=symbol, expiry=expiry)
    try:
        r = requests.get(url, headers=SO_HEADERS, timeout=20)
        if not r.ok or not r.text.strip():
            return None
        d = r.json()
        if d.get("head", {}).get("status") != "0":
            return None
        return d.get("body")
    except Exception as e:
        print(f"    [SO] fetch error {symbol}/{expiry}: {e}", file=sys.stderr)
        return None


def _parse_chain(body: dict, symbol: str, today: str, expiry: str) -> tuple[list, dict | None]:
    """Parse tableData into chain rows + summary. Returns (chain_rows, summary_dict).

    Raises RuntimeError (via _build_col_map) if this response's tableHeaders don't
    contain every field this function reads -- see Finding #52.
    """
    col = _build_col_map(body.get("tableHeaders"))
    rows = []
    for rec in body.get("tableData") or []:
        strike = _sf(rec[col["strike"]])
        if strike is None:
            continue
        rows.append((
            symbol, today, expiry, strike,
            _sf(rec[col["ce_price"]]),   _sf(rec[col["ce_volume"]]),
            _sf(rec[col["ce_oi"]]),      _sf(rec[col["ce_oi_chg"]]),
            _sf(rec[col["ce_iv"]]),      _sf(rec[col["ce_iv_chg"]]),
            _sf(rec[col["ce_delta"]]),   _sf(rec[col["ce_gamma"]]),
            _sf(rec[col["ce_theta"]]),   _sf(rec[col["ce_vega"]]),
            _sf(rec[col["ce_rho"]]),
            rec[col["ce_buildup"]] if len(rec) > col["ce_buildup"] else None,
            _sf(rec[col["pe_price"]]),   _sf(rec[col["pe_volume"]]),
            _sf(rec[col["pe_oi"]]),      _sf(rec[col["pe_oi_chg"]]),
            _sf(rec[col["pe_iv"]]),      _sf(rec[col["pe_iv_chg"]]),
            _sf(rec[col["pe_delta"]]),   _sf(rec[col["pe_gamma"]]),
            _sf(rec[col["pe_theta"]]),   _sf(rec[col["pe_vega"]]),
            _sf(rec[col["pe_rho"]]),
            rec[col["pe_buildup"]] if len(rec) > col["pe_buildup"] else None,
        ))

    # Stock-level summary
    # BUG FOUND 2026-08-07 (dead-column sweep): live-verified against real RELIANCE/
    # HDFCBANK responses (with a real expiry from nt_fno_expiry -- an invalid/unlisted
    # expDate returns a mostly-empty body that looks like a parsing failure but isn't one):
    #   - body["IV"] is always None -- this endpoint never populates a stock-level summary
    #     IV. Per-strike IV DOES exist (tableHeaders carries implied_volatility_call/put,
    #     confirmed populated in `rows` above) -- iv_call/iv_put are now derived from the
    #     ATM-nearest strike's ce_iv/pe_iv instead of a field that's never sent.
    #   - body["expiryLevelPCRValues"] is a FLAT dict of PCR sub-metrics for the requested
    #     expiry (pcr_oi/pcr_oi_change/pcr_volume/...), NOT keyed by expiry date as the old
    #     `.get(expiry) or list(...)[0]` code assumed -- it "worked" only because pcr_oi
    #     happens to be the first key in Python's dict iteration order, a landmine that
    #     breaks the moment Trendlyne reorders the response. Reads pcr_oi explicitly now.
    #   - body["futureData"] is confirmed genuinely EMPTY ({}) for real stocks/expiries --
    #     this endpoint does not carry per-stock futures price/OI at all. fut_price/fut_oi/
    #     fut_oi_chg are NOT fixable by correcting key names; no other fetcher in this
    #     codebase captures per-stock futures OI/price either (fno_rollover_fetcher.py is
    #     rollover%/cost-of-carry from NSE bhavcopy, a different metric; nt_dashboard_fetcher.py
    #     is options OI, not futures). Left NULL with this explanation rather than guessing
    #     at a replacement source -- see CLAUDE.md's dead-column sweep documentation.
    pcr_data = body.get("expiryLevelPCRValues") or {}
    atm = _sf(body.get("atTheMoney"))
    iv_call = iv_put = None
    if atm is not None and rows:
        # rows tuple layout: (symbol, date, expiry, strike, ..., ce_iv[8], ..., pe_iv[20], ...)
        nearest = min(rows, key=lambda r: abs(r[3] - atm))
        iv_call, iv_put = nearest[8], nearest[20]
    summary  = {
        "symbol":    symbol,
        "date":      today,
        "expiry":    expiry,
        "max_pain":  _sf(body.get("maxPain")),
        "atm":       atm,
        "mwpl":      _sf(body.get("MWPL")),
        "iv_call":   iv_call,
        "iv_put":    iv_put,
        "pcr":       _sf(pcr_data.get("pcr_oi")),
        "fut_price": None,
        "fut_oi":    None,
        "fut_oi_chg": None,
    }
    return rows, summary


def save_chain(chain_rows: list, summary: dict | None) -> int:
    if chain_rows:
        executemany("""
            INSERT INTO so_option_chain
                (symbol, date, expiry, strike,
                 ce_price, ce_volume, ce_oi, ce_oi_chg_pct, ce_iv, ce_iv_chg,
                 ce_delta, ce_gamma, ce_theta, ce_vega, ce_rho, ce_buildup,
                 pe_price, pe_volume, pe_oi, pe_oi_chg_pct, pe_iv, pe_iv_chg,
                 pe_delta, pe_gamma, pe_theta, pe_vega, pe_rho, pe_buildup)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
            ON CONFLICT (symbol, date, expiry, strike) DO UPDATE SET
                ce_price=excluded.ce_price, ce_volume=excluded.ce_volume,
                ce_oi=excluded.ce_oi, ce_oi_chg_pct=excluded.ce_oi_chg_pct,
                ce_iv=excluded.ce_iv, ce_iv_chg=excluded.ce_iv_chg,
                ce_delta=excluded.ce_delta, ce_gamma=excluded.ce_gamma,
                ce_theta=excluded.ce_theta, ce_vega=excluded.ce_vega,
                ce_rho=excluded.ce_rho, ce_buildup=excluded.ce_buildup,
                pe_price=excluded.pe_price, pe_volume=excluded.pe_volume,
                pe_oi=excluded.pe_oi, pe_oi_chg_pct=excluded.pe_oi_chg_pct,
                pe_iv=excluded.pe_iv, pe_iv_chg=excluded.pe_iv_chg,
                pe_delta=excluded.pe_delta, pe_gamma=excluded.pe_gamma,
                pe_theta=excluded.pe_theta, pe_vega=excluded.pe_vega,
                pe_rho=excluded.pe_rho, pe_buildup=excluded.pe_buildup,
                fetched_at=CURRENT_TIMESTAMP
        """, chain_rows)

    if summary:
        execute("""
            INSERT INTO so_stock_oi_summary
                (symbol, date, expiry, max_pain, atm, mwpl, iv_call, iv_put,
                 pcr, fut_price, fut_oi, fut_oi_chg)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
            ON CONFLICT (symbol, date, expiry) DO UPDATE SET
                max_pain=excluded.max_pain, atm=excluded.atm, mwpl=excluded.mwpl,
                iv_call=excluded.iv_call, iv_put=excluded.iv_put,
                pcr=excluded.pcr, fut_price=excluded.fut_price,
                fut_oi=excluded.fut_oi, fut_oi_chg=excluded.fut_oi_chg,
                fetched_at=CURRENT_TIMESTAMP
        """, (
            summary["symbol"], summary["date"], summary["expiry"],
            summary["max_pain"], summary["atm"], summary["mwpl"],
            summary["iv_call"], summary["iv_put"], summary["pcr"],
            summary["fut_price"], summary["fut_oi"], summary["fut_oi_chg"],
        ))

    return len(chain_rows)


def run_symbol(symbol: str, expiry: str | None = None, today: str | None = None) -> int:
    today = today or _date.today().isoformat()
    exp = expiry or _get_nearest_expiry(symbol)
    body = fetch_chain(symbol, exp)
    if body is None:
        return 0
    chain_rows, summary = _parse_chain(body, symbol.upper(), today, exp)
    return save_chain(chain_rows, summary)


def run(
    target_symbol: str | None = None,
    expiry: str | None = None,
    delay: float = 0.3,
) -> None:
    today = _date.today().isoformat()

    if target_symbol:
        symbols = [target_symbol.upper()]
    else:
        symbols = _get_fno_symbols()
        if not symbols:
            # fallback: top liquid F&O stocks
            symbols = ["NIFTY", "BANKNIFTY", "FINNIFTY", "RELIANCE", "TCS",
                       "INFY", "HDFCBANK", "SBIN", "ITC", "BEL"]
        # Least-recently-covered first, so Trendlyne's request allowance runs out somewhere
        # NEW each run instead of always at the same alphabetical point. See resume_order().
        symbols = resume_order(symbols, _coverage_map(symbols))

    print(f"[so_chain] Fetching option chains for {len(symbols)} symbols ...")
    ok = fail = 0
    written: set[str] = set()
    for i, sym in enumerate(symbols):
        exp = expiry or _get_nearest_expiry(sym)
        print(f"  [{i+1}/{len(symbols)}] {sym} (expiry={exp}) ...", end=" ", flush=True)
        body = fetch_chain(sym, exp)
        if body is None:
            print("no data")
            fail += 1
        else:
            try:
                chain_rows, summary = _parse_chain(body, sym, today, exp)
            except RuntimeError as e:
                # A tableHeaders shape mismatch (Finding #52) is caught HERE, per-symbol,
                # rather than left to propagate and abort every remaining symbol in this
                # run -- Trendlyne almost certainly reordered the SAME way for every
                # symbol, so this will likely repeat, but that's a loud, visible failure
                # count, not a silent wrong-Greeks write for any of them.
                print(f"SKIPPED: {e}", file=sys.stderr)
                fail += 1
                if delay > 0:
                    time.sleep(delay)
                continue
            n = save_chain(chain_rows, summary)
            mp = summary["max_pain"] if summary else None
            print(f"{n} strikes  maxPain={mp}")
            written.add(sym)
            ok += 1
        if delay > 0:
            time.sleep(delay)

    print(f"[so_chain] Done. ok={ok} fail={fail} total={ok+fail}")

    # Coverage guard -- CUMULATIVE, not per-run, and on stderr.
    #
    # The allowance failure is silent by construction: a dropped symbol is just a "no data"
    # line and the process still exits 0, which is how 34 F&O names went 30 days with zero
    # rows while the job reported success every day. A per-run floor cannot see that, because
    # a healthy rotated run and a starved alphabetical one both cover ~76% of the universe --
    # the difference is WHICH names, over time. So ask the question that actually distinguishes
    # them: after this run, how many symbols are still stale?
    #
    # stderr, not stdout: the subprocess wrapper only inspects stderr, so a stdout-only
    # degradation message is invisible to the one thing that would surface it
    # (recurring-bugs.md, "degraded-read print() to stdout").
    if not target_symbol:
        cutoff = (_date.today() - timedelta(days=STALE_DAYS)).isoformat()
        after = _coverage_map(symbols)
        stale = sorted(s for s in symbols if (after.get(s) or "")[:10] < cutoff)
        print(f"[so_chain] cumulative coverage: {len(symbols) - len(stale)}/{len(symbols)} "
              f"symbols refreshed within {STALE_DAYS}d")
        if len(stale) > MAX_STALE_SYMBOLS:
            print(
                f"[so_chain] COVERAGE: {len(stale)} symbols have no chain newer than {cutoff} "
                f"(floor {MAX_STALE_SYMBOLS}). Starved: {', '.join(stale[:25])}"
                + (f" (+{len(stale) - 25} more)" if len(stale) > 25 else ""),
                file=sys.stderr,
            )


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--symbol", default=None, help="Single stock, e.g. BEL")
    parser.add_argument("--index",  default=None, help="Index, e.g. NIFTY")
    parser.add_argument("--expiry", default=None, help="Expiry date YYYY-MM-DD")
    parser.add_argument("--delay",  type=float, default=0.3)
    args = parser.parse_args()

    sym = args.symbol or args.index
    run(target_symbol=sym, expiry=args.expiry, delay=args.delay)

def to_polars_df(data):
    """Converts pandas DataFrame or list of dicts to Polars DataFrame for fast vector operations."""
    if hasattr(data, 'empty') and data.empty:
        return pl.DataFrame()
    return pl.from_pandas(data) if hasattr(data, 'to_numpy') else pl.DataFrame(data)
