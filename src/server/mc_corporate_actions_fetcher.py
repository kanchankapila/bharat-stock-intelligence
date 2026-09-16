#!/usr/bin/env python3
"""
mc_corporate_actions_fetcher.py

Deep, per-stock historical corporate-action ledger (dividends / bonus / splits / rights),
from MoneyControl's `stock/corporate-action` endpoint.

WHY THIS EXISTS
---------------
Two prior gaps, both traced live during the 2026-08-07 urls.txt/open-source sourcing pass
(`docs/url_explorer/DATA_CATEGORIZATION_AND_USAGE.md` + that session's own live probes):

1. `ohlcv_adjust.py` had to reverse-derive bonus/split ratios purely from a price-ratio
   discontinuity in bhavcopy, because (per its own docstring) "the corporate_actions table was
   checked and is unusable for it: 353 rows, dividends and results only, no splits or bonuses,
   spanning six weeks." That's correct but incomplete -- `corporate_actions` is fed by
   `mc_corporate_calendar_fetcher.py`, a FORWARD-LOOKING ~2-week upcoming-events calendar
   (`duration=UP`/`duration=T`), not a historical ledger. It was never going to have deep bonus/
   split history because nothing has ever fetched it. This fetcher is the historical ledger
   `ohlcv_adjust.py` actually needs -- see `ohlcv_adjust.cross_validate_with_mc_actions()`, run
   right after this fetcher in the same weekly job (`trendlyneWeekly.jobs.ts`).
2. `getCorporateActions` (the existing per-stock tRPC procedure) proxies ET Markets live, with
   no DB persistence at all -- every page view re-fetches, and there's no historical record to
   join against, backtest with, or cross-validate anything else.

ENDPOINT -- verified live 2026-08-07, `section=all` returns every category in ONE call
--------------------------------------------------------------------------------------
    https://api.moneycontrol.com/mcapi/v1/stock/corporate-action?deviceType=W&scId={scid}&section=all&start=0&limit={n}

Confirmed real field shapes (RELIANCE `scId=RI`, NESTLEIND `scId=NI` for the split case --
RELIANCE has never split, so its `splits` key was absent from `section=all` entirely; empty
categories are OMITTED from the response, not returned as empty lists -- always `.get(key, [])`):

    dividends: announce_date (ISO), dividend_type, dividend_per, effective_date ("DD Mon, YYYY"),
               remarks, dividend_amount
    bonus:     announcement_date ("DD Mon, YYYY"), existing_ratio, offered_ratio, record_date
               (ISO), exbonus_date ("DD Mon, YYYY"), bonus_ratio ("1:1")
    splits:    announce_date (ISO), old_fv, new_fv, exsplit_date ("DD Mon, YYYY"), record_date
               (ISO)   -- NESTLEIND's real 2024-01-05 1:10 split: old_fv=10, new_fv=1
    rights:    announce_date (ISO), existing_ratio, offered_ratio, facevalue, premium,
               record_date (ISO), exrights_date ("DD Mon, YYYY"), rights_ratio ("1:15")

Date fields are a genuine MIXTURE of ISO and "DD Mon, YYYY" within the SAME payload (e.g.
bonus's own `announcement_date` is display-format while its `record_date` is ISO) -- parsed via
this codebase's existing `data_integrity_repair.parse_loose_date()` rather than a new parser,
per this project's own "grep before reinventing a date parser" precedent (see that module's
`repair_insider_dates`, the exact prior incident this would otherwise repeat).

`board_meeting`/`agm_egm`/`announcement` sections are DELIBERATELY NOT fetched here --
`board_meeting` is already covered, forward-looking, by `mc_corporate_calendar_fetcher.py`;
`agm_egm`/`announcement` are lower-value regulatory-filing noise for this fetcher's stated
purpose (ratio-bearing action history for OHLCV adjustment + a per-stock action timeline), and
adding them would just be scope creep with no clear consumer.

RATIO CONVENTION (matches ohlcv_adjust.py's `factor` exactly, so cross-validation is a plain
numeric comparison, not a unit conversion)
-------------------------------------------------------------------------------------------
    bonus factor  = existing_ratio / (existing_ratio + offered_ratio)   -- 1:1 bonus -> 0.5
    split factor  = new_fv / old_fv                                    -- 10->1 split -> 0.1
    dividend/rights -> ratio_factor is NULL. A rights issue does change shares outstanding but
    its price adjustment is NOT a clean multiplicative ratio the way a split/bonus is -- it
    depends on the (frequently below-market) rights issue price via the theoretical
    ex-rights-price formula, which this endpoint doesn't give us the market price to compute.
    Storing a fabricated "ratio_factor" for rights would silently corrupt anything that later
    trusts this column as if it meant the same thing as the bonus/split one.

Run:
  python mc_corporate_actions_fetcher.py                # full mcsymbol-mapped universe
  python mc_corporate_actions_fetcher.py --symbol RELIANCE
"""

import polars as pl
import argparse
import json
import sys
from concurrent.futures import ThreadPoolExecutor, as_completed

import requests

from db_compat import connect, ConnWrapper
from data_integrity_repair import parse_loose_date
from fetch_utils import retry_get

ACTION_URL = "https://api.moneycontrol.com/mcapi/v1/stock/corporate-action"
HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    ),
    "Accept": "application/json, text/plain, */*",
}

# Matches mc_pricefeed_fetcher.py's already-proven-safe concurrency for this same host --
# MC's own endpoint has a real ~12-16 concurrent-connection ceiling for this class of API
# (documented in mc_ohlcv_backfill.py / intraday_fetcher.py's own concurrency findings).
BATCH_SIZE = 15


def _log(m):
    print(f"[MCCorporateActions] {m}", flush=True)


def fetch_actions(session: requests.Session, scid: str) -> dict:
    """One stock's full corporate-action payload. The ONLY fetch path -- tests call this."""
    resp = retry_get(
        session, ACTION_URL,
        params={"deviceType": "W", "scId": scid, "section": "all", "start": 0, "limit": 25},
        timeout=20,
    )
    if resp.status_code == 204:
        return {}
    payload = resp.json()
    if not isinstance(payload, dict) or payload.get("success") != 1:
        return {}
    return payload.get("data") or {}


def _iso(raw: str | None):
    d = parse_loose_date(raw) if raw else None
    return d.isoformat() if d else None


def _num(v):
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return None if f != f else f


def parse_dividends(symbol: str, rows: list) -> list[dict]:
    out = []
    for r in rows:
        announce_raw = r.get("announce_date")
        effective_raw = r.get("effective_date")
        key = f"{announce_raw}|{r.get('dividend_type')}|{effective_raw}"
        out.append({
            "symbol": symbol, "action_type": "dividend", "event_key": key,
            "announce_date": _iso(announce_raw), "record_date": _iso(effective_raw),
            "ratio_text": None, "ratio_factor": None,
            "amount": _num(r.get("dividend_amount") if r.get("dividend_amount") is not None
                           else r.get("dividend_per")),
            "detail": json.dumps(r, default=str),
        })
    return out


def _effective_date(r: dict, ex_field: str) -> str | None:
    """The date the PRICE actually moved -- prefer the true ex-date field over record_date.

    Record date and ex-date are not the same thing (record date can trail the ex-date by a
    settlement cycle) and only the ex-date is safe to compare against a bhavcopy price
    discontinuity. Falls back to record_date when the ex-date field is absent -- still a much
    closer anchor than announce_date, which can precede the actual event by weeks or months.
    """
    return _iso(r.get(ex_field)) or _iso(r.get("record_date"))


def parse_bonus(symbol: str, rows: list) -> list[dict]:
    out = []
    for r in rows:
        existing, offered = _num(r.get("existing_ratio")), _num(r.get("offered_ratio"))
        factor = (existing / (existing + offered)) if existing and offered and (existing + offered) > 0 else None
        announce_raw = r.get("announcement_date")
        key = f"{announce_raw}|{r.get('bonus_ratio')}|{r.get('record_date')}"
        out.append({
            "symbol": symbol, "action_type": "bonus", "event_key": key,
            "announce_date": _iso(announce_raw), "record_date": _effective_date(r, "exbonus_date"),
            "ratio_text": r.get("bonus_ratio"), "ratio_factor": factor,
            "amount": None, "detail": json.dumps(r, default=str),
        })
    return out


def parse_splits(symbol: str, rows: list) -> list[dict]:
    out = []
    for r in rows:
        old_fv, new_fv = _num(r.get("old_fv")), _num(r.get("new_fv"))
        factor = (new_fv / old_fv) if old_fv and new_fv and old_fv > 0 else None
        announce_raw = r.get("announce_date")
        key = f"{announce_raw}|{old_fv}:{new_fv}|{r.get('record_date')}"
        out.append({
            "symbol": symbol, "action_type": "split", "event_key": key,
            "announce_date": _iso(announce_raw), "record_date": _effective_date(r, "exsplit_date"),
            "ratio_text": f"{old_fv:g}:{new_fv:g}" if old_fv and new_fv else None,
            "ratio_factor": factor, "amount": None, "detail": json.dumps(r, default=str),
        })
    return out


def parse_rights(symbol: str, rows: list) -> list[dict]:
    out = []
    for r in rows:
        announce_raw = r.get("announce_date")
        key = f"{announce_raw}|{r.get('rights_ratio')}|{r.get('record_date')}"
        out.append({
            "symbol": symbol, "action_type": "rights", "event_key": key,
            "announce_date": _iso(announce_raw), "record_date": _effective_date(r, "exrights_date"),
            "ratio_text": r.get("rights_ratio"), "ratio_factor": None,  # see module docstring
            "amount": _num(r.get("premium")), "detail": json.dumps(r, default=str),
        })
    return out


def parse_payload(symbol: str, data: dict) -> list[dict]:
    """One stock's raw `data` dict -> flat list of rows ready for `store()`."""
    rows = []
    rows += parse_dividends(symbol, data.get("dividends") or [])
    rows += parse_bonus(symbol, data.get("bonus") or [])
    rows += parse_splits(symbol, data.get("splits") or [])
    rows += parse_rights(symbol, data.get("rights") or [])
    return rows


COLS = ["symbol", "action_type", "event_key", "announce_date", "record_date",
        "ratio_text", "ratio_factor", "amount", "detail"]


def ensure_schema(conn: ConnWrapper) -> None:
    conn.execute("""
        -- record_date here holds the EFFECTIVE (ex-) date where MC provides one
        -- (_effective_date() prefers exbonus_date/exsplit_date/exrights_date), falling back to
        -- MC's own record_date only when no ex-date field exists. It's the "when did the price
        -- actually move" anchor ohlcv_adjust.py's cross-check compares against, not necessarily
        -- MC's literal record_date value.
        CREATE TABLE IF NOT EXISTS stock_corporate_action_history (
            symbol TEXT NOT NULL, action_type TEXT NOT NULL, event_key TEXT NOT NULL,
            announce_date TEXT, record_date TEXT,
            ratio_text TEXT, ratio_factor REAL, amount REAL, detail TEXT,
            source TEXT DEFAULT 'moneycontrol', fetched_at TEXT DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (symbol, action_type, event_key)
        )
    """)
    conn.execute("CREATE INDEX IF NOT EXISTS idx_scah_symbol ON stock_corporate_action_history (symbol)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_scah_record_date ON stock_corporate_action_history (record_date)")
    conn.commit()


def store(conn: ConnWrapper, rows: list[dict]) -> int:
    if not rows:
        return 0
    ph = ",".join(["?"] * len(COLS))
    updates = ", ".join(f"{c}=excluded.{c}" for c in COLS if c not in ("symbol", "action_type", "event_key"))
    sql = (f"INSERT INTO stock_corporate_action_history ({', '.join(COLS)}) VALUES ({ph}) "
           f"ON CONFLICT (symbol, action_type, event_key) DO UPDATE SET {updates}")
    n = 0
    for r in rows:
        conn.execute(sql, tuple(r[c] for c in COLS))
        n += 1
    conn.commit()
    return n


def _load_stocks(conn: ConnWrapper, symbol_filter: str | None) -> list[tuple[str, str]]:
    cur = conn.execute(
        "SELECT symbol, mcsymbol FROM nse_stocks "
        "WHERE status = 'ACTIVE' AND mcsymbol IS NOT NULL AND mcsymbol != '' ORDER BY symbol"
    )
    rows = [(r[0], r[1]) for r in cur.fetchall()]
    if symbol_filter:
        rows = [(s, m) for s, m in rows if s.upper() == symbol_filter.upper()]
    return rows


def run(symbol: str | None = None) -> int:
    conn = connect()
    try:
        ensure_schema(conn)
        stocks = _load_stocks(conn, symbol)
        if not stocks:
            _log("no stocks with mcsymbol found" + (f" matching {symbol}" if symbol else ""))
            return 1
        _log(f"fetching {len(stocks)} stocks in batches of {BATCH_SIZE}")
        session = requests.Session()
        session.headers.update(HEADERS)

        def _one(item):
            sym, scid = item
            try:
                data = fetch_actions(session, scid)
            except Exception as e:
                return sym, None, str(e)
            return sym, data, None

        done = stored = failed = 0
        for start in range(0, len(stocks), BATCH_SIZE):
            batch = stocks[start:start + BATCH_SIZE]
            with ThreadPoolExecutor(max_workers=len(batch)) as pool:
                futures = [pool.submit(_one, item) for item in batch]
                for fut in as_completed(futures):
                    sym, data, err = fut.result()
                    done += 1
                    if err is not None:
                        failed += 1
                        continue
                    rows = parse_payload(sym, data or {})
                    stored += store(conn, rows)
        _log(f"processed {done}/{len(stocks)} stocks ({failed} failed), {stored} rows upserted")
    finally:
        try:
            conn.close()
        except Exception:
            pass
    return 0 if failed < len(stocks) else 1


def main():
    ap = argparse.ArgumentParser(description="MoneyControl per-stock corporate-action history")
    ap.add_argument("--symbol", default=None, help="limit to one NSE symbol")
    args = ap.parse_args()
    sys.exit(run(symbol=args.symbol))


if __name__ == "__main__":
    main()

from pydantic import BaseModel
from base_fetcher import BaseFetcher, governed_fetcher

class McCorporateActionsFetcherSchema(BaseModel):
    symbol: str | None = None
    date: str | None = None

class McCorporateActionsFetcherBaseFetcher(BaseFetcher[McCorporateActionsFetcherSchema]):
    fetcher_name = 'McCorporateActionsFetcher'
    domain = 'moneycontrol.com'
    schema = McCorporateActionsFetcherSchema
    min_interval_sec = 0.5

def to_polars_df(data):
    """Converts pandas DataFrame or list of dicts to Polars DataFrame for fast vector operations."""
    if hasattr(data, 'empty') and data.empty:
        return pl.DataFrame()
    return pl.from_pandas(data) if hasattr(data, 'to_numpy') else pl.DataFrame(data)
