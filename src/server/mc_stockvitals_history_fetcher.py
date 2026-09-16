#!/usr/bin/env python3
"""
MoneyControl StockVitals History Backfill
==========================================
Fetches https://api.moneycontrol.com/swiftapi/v1/stockvitals/historical
  ?scId={mcsymbol}&metric={altman|ohlson|graham|dupont}&responseType=json

Each call returns a ~10-year ANNUAL time series (2017-2026) for one proprietary
quant score. moneycontrol_fetcher.py's daily widget scrape (_parse_vitals, hitting
a *different* MC endpoint -- mc/widget/stockvitals) already captures these same four
metrics into proprietary_scores_history, but only as TODAY's single current value
(running since 2026-06-22, ~40 days deep, live-verified). This backfill deepens that
same table to ~9 years for every stock, one-time (idempotent -- safe to re-run).

Metrics -> score_type (must match moneycontrol_fetcher.py's widget-scrape keys
EXACTLY -- both write into the same proprietary_scores_history table, keyed on
source='moneycontrol', and ml_ensemble.py/cs_ranker.py/exit_policy.py/
online_learner.py all AS-OF join on (source, score_type)):
  altman  -> altman_z_score   (Altman Z-Score: bankruptcy/distress risk)
  ohlson  -> ohlson_o_score   (Ohlson O-Score: failure log-odds)
  graham  -> graham_number    (Graham Number: intrinsic value estimate, an absolute price)
  dupont  -> dupont_score     (DuPont ROE decomposition)

Point-in-time dating: MC's "year" label is just a bare label (e.g. "2026"), not an
exact fiscal-year-end date. Per-company fiscal year-end is resolved from
working_capital_history (ET_Stats-sourced real yearEnding dates -- confirmed live
that this is NOT a uniform March-31 assumption: e.g. ABB genuinely reports Dec 31),
taking the most common month/day across that symbol's rows. Falls back to "03-31"
(the majority convention) only for symbols absent from that table entirely.

Effective/knowable date = fiscal-year-end + PUBLICATION_LAG_DAYS (90 -- reusing
et_stats_client.py's as_of_floor()/PUBLICATION_LAG_DAYS convention rather than
inventing a new number), so a freshly-completed year's score is never stamped as
knowable before it could plausibly have been computed and published. Bars whose
effective date is still in the future (relative to logical_trading_date(), not a
bare date.today() -- see as_of.py's docstring on the midnight-crossing class of bug)
are skipped.

source='moneycontrol' -- the SAME tag the daily widget scrape uses (not a separate
'moneycontrol_history' tag). Backfill dates (fiscal-year-end + 90d, e.g.
"2020-06-29") essentially never collide with the daily snapshot's date (today), so
this is safe, and it means every existing AS-OF join for altman_z/ohlson_o in
ml_ensemble.py/cs_ranker.py/exit_policy.py/online_learner.py automatically gains
~9 years of depth with ZERO query changes.

Run:
  python mc_stockvitals_history_fetcher.py             # all stocks with mcsymbol
  python mc_stockvitals_history_fetcher.py --symbol BEL
"""

import polars as pl

import argparse
import time
from collections import Counter, defaultdict
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import date

from curl_cffi import requests

from db_compat import connect
from et_stats_client import as_of_floor
from as_of import logical_trading_date
import sys

HISTORY_URL = (
    "https://api.moneycontrol.com/swiftapi/v1/stockvitals/historical"
    "?scId={scid}&metric={metric}&responseType=json"
)

MC_HEADERS = {
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "en-US,en;q=0.9",
    "Origin": "https://www.moneycontrol.com",
    "Referer": "https://www.moneycontrol.com/",
    "Sec-Fetch-Dest": "empty",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Site": "same-site",
}

# metric query param -> score_type stored in proprietary_scores_history. Must match
# moneycontrol_fetcher.py's _parse_vitals() widget-scrape keys exactly (see module docstring).
SCORE_TYPE_MAP = {
    "altman": "altman_z_score",
    "ohlson": "ohlson_o_score",
    "graham": "graham_number",
    "dupont": "dupont_score",
}

DEFAULT_FY_END = "03-31"  # majority convention for NSE/BSE-listed companies

RATE_LIMIT_SEC = 0.2   # between the 4 sequential metric calls for one stock
BATCH_SIZE     = 12    # matches the ~12-16 safe concurrency ceiling documented for
                       # MoneyControl endpoints elsewhere in this codebase
BATCH_GAP_SEC  = 0.5


# ── Fiscal year-end resolution ──────────────────────────────────────────────────

def _load_fiscal_year_ends(con) -> dict:
    """Per-symbol fiscal year-end "MM-DD", derived from working_capital_history's real
    per-company yearEnding dates (ET_Stats-sourced). Falls back to DEFAULT_FY_END for any
    symbol absent from that table -- a documented, bounded simplification (mirrors the
    codebase's existing precedent for similarly-scoped gaps, e.g. adjustment_basis), not
    attempted to be resolved further here.
    """
    cur = con.cursor()
    cur.execute("SELECT symbol, fiscal_year FROM working_capital_history WHERE fiscal_year IS NOT NULL")
    per_symbol = defaultdict(Counter)
    for symbol, fy in cur.fetchall():
        try:
            d = date.fromisoformat(str(fy)[:10])
        except ValueError:
            continue
        per_symbol[symbol][f"{d.month:02d}-{d.day:02d}"] += 1
    return {symbol: counter.most_common(1)[0][0] for symbol, counter in per_symbol.items()}


def _year_ending_date(year: int, month_day: str) -> str | None:
    """Builds an ISO year-ending date for `year` using a "MM-DD" fiscal year-end. Returns
    None (skip this bar) rather than crashing on an invalid combination (e.g. "02-29" applied
    to a non-leap year)."""
    try:
        mm, dd = month_day.split("-")
        return date(year, int(mm), int(dd)).isoformat()
    except (ValueError, TypeError):
        return None


# ── Fetch ────────────────────────────────────────────────────────────────────────

def _fetch_metric(mcsymbol: str, metric: str, session) -> list[dict] | None:
    """Returns the raw barData list, [] if the stock genuinely has no data for this metric,
    or None on a fetch/parse failure (distinct from [] -- see insider_transactions_fetcher.py's
    established None-vs-[] contract; collapsing both to the same value makes a throttled run
    indistinguishable from a stock with no coverage)."""
    url = HISTORY_URL.format(scid=mcsymbol, metric=metric)
    try:
        r = session.get(url, headers=MC_HEADERS, timeout=10, impersonate="chrome110")
        if r.status_code != 200:
            return None
        payload = r.json()
        if payload.get("success") != 1:
            return None
        return payload.get("data", {}).get("barData", []) or []
    except Exception as e:
        print(f"  [{mcsymbol}] stockvitals history error ({metric}): {e}", file=sys.stderr)
        return None


def parse_bars(bars: list[dict], score_type: str, month_day: str, today: str) -> list[dict]:
    """Converts raw barData entries into point-in-time-safe rows ready for upsert.
    Skips any bar whose effective (knowable) date is still in the future -- this correctly
    excludes an in-progress fiscal year MC may show a running/estimated figure for, without
    needing to special-case "the latest bar" separately."""
    rows = []
    for bar in bars:
        try:
            year = int(str(bar.get("year", "")).strip())
            value = float(bar.get("value"))
        except (TypeError, ValueError):
            continue
        year_ending = _year_ending_date(year, month_day)
        if not year_ending:
            continue
        effective_date = as_of_floor(year_ending)
        if effective_date > today:
            continue
        rows.append({
            "date": effective_date,
            "score_type": score_type,
            "score_value": value,
            "score_label": bar.get("formattedValue") or str(value),
        })
    return rows


def upsert_history(symbol: str, rows: list[dict], con) -> None:
    if not rows:
        return
    cur = con.cursor()
    for r in rows:
        cur.execute("""
            INSERT INTO proprietary_scores_history (symbol, date, source, score_type, score_value, score_label)
            VALUES (?, ?, 'moneycontrol', ?, ?, ?)
            ON CONFLICT(symbol, date, source, score_type) DO UPDATE SET
                score_value = excluded.score_value,
                score_label = excluded.score_label
        """, (symbol, r["date"], r["score_type"], r["score_value"], r["score_label"]))
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
    stocks = _load_stocks(args.symbol, con)
    if not stocks:
        print("[MCStockVitalsHistory] No stocks with mcsymbol found.")
        return

    fy_ends = _load_fiscal_year_ends(con)
    today = logical_trading_date()
    print(f"[MCStockVitalsHistory] Backfilling {len(stocks)} stocks x {len(SCORE_TYPE_MAP)} "
          f"metrics in batches of {BATCH_SIZE} ({BATCH_GAP_SEC}s gap)…")

    session = requests.Session()
    ok = 0
    done = 0

    def _fetch_one(item):
        symbol, mcsymbol = item
        month_day = fy_ends.get(symbol, DEFAULT_FY_END)
        all_rows = []
        any_data = False
        for metric, score_type in SCORE_TYPE_MAP.items():
            bars = _fetch_metric(mcsymbol, metric, session)
            time.sleep(RATE_LIMIT_SEC)
            if bars is None:
                continue
            any_data = True
            all_rows.extend(parse_bars(bars, score_type, month_day, today))
        return symbol, all_rows, any_data

    for batch_start in range(0, len(stocks), BATCH_SIZE):
        batch = stocks[batch_start:batch_start + BATCH_SIZE]
        with ThreadPoolExecutor(max_workers=len(batch)) as pool:
            futures = [pool.submit(_fetch_one, item) for item in batch]
            for fut in as_completed(futures):
                symbol, rows, any_data = fut.result()
                done += 1
                if not any_data:
                    print(f"  [{done}/{len(stocks)}] {symbol}: no data")
                    continue
                upsert_history(symbol, rows, con)
                print(f"  [{done}/{len(stocks)}] {symbol}: {len(rows)} historical score-years")
                ok += 1
        time.sleep(BATCH_GAP_SEC)

    print(f"[MCStockVitalsHistory] Done. {ok}/{len(stocks)} stocks.")
    con.close()


if __name__ == "__main__":
    main()

from pydantic import BaseModel
from base_fetcher import BaseFetcher, governed_fetcher

class McStockvitalsHistoryFetcherSchema(BaseModel):
    symbol: str | None = None
    date: str | None = None

class McStockvitalsHistoryFetcherBaseFetcher(BaseFetcher[McStockvitalsHistoryFetcherSchema]):
    fetcher_name = 'McStockvitalsHistoryFetcher'
    domain = 'moneycontrol.com'
    schema = McStockvitalsHistoryFetcherSchema
    min_interval_sec = 0.5

def to_polars_df(data):
    """Converts pandas DataFrame or list of dicts to Polars DataFrame for fast vector operations."""
    if hasattr(data, 'empty') and data.empty:
        return pl.DataFrame()
    return pl.from_pandas(data) if hasattr(data, 'to_numpy') else pl.DataFrame(data)
