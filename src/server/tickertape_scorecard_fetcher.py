#!/usr/bin/env python3
"""
Tickertape Scorecard Fetcher — ordinal category tags
======================================================
Fetches api.tickertape.in/stocks/scorecard/{sid} (via tickertape_client.py)
and writes each type="score" category's ORDINAL-ENCODED tag (numeric value
is premium-gated, see tickertape_client.py docstring) into
proprietary_scores_history, source='tickertape'.

sid is resolved via scripts/stocklist.json's tickertape_sid field (populated
by scripts/enrich_stocklist_tickertape.py) — stocks without a resolved sid
are skipped.

Cadence: weekly (this is a supplementary/secondary signal, categorical not
numeric — no value in fetching more often; low priority relative to the
platform's primary scoring pipelines).

Run:
  python tickertape_scorecard_fetcher.py              # all stocks with a tickertape_sid
  python tickertape_scorecard_fetcher.py --symbol BEL
  python tickertape_scorecard_fetcher.py --limit 50
"""

import polars as pl
from pydantic import BaseModel
from base_fetcher import BaseFetcher, governed_fetcher

class TickertapeScorecardFetcherSchema(BaseModel):
    symbol: str | None = None
    date: str | None = None

class TickertapeScorecardFetcherBaseFetcher(BaseFetcher[TickertapeScorecardFetcherSchema]):
    fetcher_name = 'TickertapeScorecardFetcher'
    domain = 'tickertape.in'
    schema = TickertapeScorecardFetcherSchema
    min_interval_sec = 0.5


import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import date, timedelta

import requests

from db_compat import connect
from tickertape_client import HEADERS, fetch_scorecard, load_tickertape_sid_map
import sys

ORDINAL_MAP = {"low": 0, "avg": 1, "high": 2}

# Live-measured 2026-08-28 (fetch_scorecard alone, no DB writes): 4 symbols serial =
# 1.68s (0.42s/symbol) vs 4 concurrent = 0.47s (0.12s/symbol), 3.57x, 4/4 ok both ways,
# zero errors introduced by concurrency. api.tickertape.in carries no documented WAF/
# request-budget ceiling (unlike Trendlyne) -- only a per-call politeness RATE_LIMIT_SEC
# in tickertape_client.py, which is unaffected by running several calls in parallel
# threads. BATCH_SIZE kept conservative (untested at full-universe scale) and matches
# marketsmojo_technical_fetcher.py's MAX_WORKERS=8, the closest in-repo precedent.
BATCH_SIZE = 8


# ── Pure computation (fully unit-testable, no network/DB) ───────────────────────

def compute_ordinal_scores(scorecard_data: list[dict] | None) -> dict[str, dict]:
    """scorecard_data: the `data` array from the scorecard API response.
    Returns {category_name_lowercased: {"score_value": int|None, "score_label": str}}
    for every type="score" category. Non-"score" categories (entryPoint,
    redFlag, etc.) are excluded — this fetcher only covers the four
    Performance/Valuation/Growth/Profitability-style categories."""
    if not scorecard_data:
        return {}

    result = {}
    for category in scorecard_data:
        if category.get("type") != "score":
            continue
        name = category.get("name", "")
        tag = category.get("tag", "")
        result[name.lower()] = {
            "score_value": ORDINAL_MAP.get(tag.lower()),
            "score_label": tag,
        }
    return result



# ── Persist ──────────────────────────────────────────────────────────────────────

def upsert_scores(symbol: str, today: str, scores: dict[str, dict], con) -> int:
    if not scores:
        return 0
    cur = con.cursor()
    count = 0
    for score_type, values in scores.items():
        cur.execute("""
            INSERT INTO proprietary_scores_history (symbol, date, source, score_type, score_value, score_label)
            VALUES (?, ?, 'tickertape', ?, ?, ?)
            ON CONFLICT(symbol, date, source, score_type) DO UPDATE SET
                score_value = excluded.score_value,
                score_label = excluded.score_label,
                updated_at  = CURRENT_TIMESTAMP
        """, (symbol, today, score_type, values["score_value"], values["score_label"]))
        count += 1
    con.commit()
    return count


# ── Stock list ────────────────────────────────────────────────────────────────────

def load_stocks(symbol_filter: str | None, limit: int | None) -> list[tuple[str, str]]:
    sid_map = load_tickertape_sid_map()
    rows = sorted(sid_map.items())
    if symbol_filter:
        rows = [(s, sid) for s, sid in rows if s == symbol_filter.upper()]
    if limit:
        rows = rows[:limit]
    return rows


# ── Main ──────────────────────────────────────────────────────────────────────────

def main() -> None:
    parser = argparse.ArgumentParser(description="Tickertape scorecard ordinal tags")
    parser.add_argument("--symbol", default=None, help="Single stock NSE symbol")
    parser.add_argument("--limit", type=int, default=None, help="Process first N stocks")
    parser.add_argument("--force", action="store_true", default=False,
                        help="Force re-fetch all stocks even if fresh within last 7 days")
    args = parser.parse_args()

    con = connect()

    stocks = load_stocks(args.symbol, args.limit)
    if not stocks:
        print("[TickertapeScorecard] No stocks with a tickertape_sid found.")
        con.close()
        return

    # Smart weekly cadence skip: categorical scorecards change slowly
    if not args.force and not args.symbol:
        from fetch_utils import filter_stale_symbols
        fresh_cutoff = (date.today() - timedelta(days=7)).isoformat()
        stale_stocks = filter_stale_symbols(con, stocks, "proprietary_scores_history",
                                            date_col="date", as_of_date=fresh_cutoff)
        skipped = len(stocks) - len(stale_stocks)
        if skipped > 0:
            print(f"[TickertapeScorecard] Smart weekly skip: {skipped}/{len(stocks)} stocks already fresh within last 7 days. Processing {len(stale_stocks)} remaining.")
            stocks = stale_stocks

    print(f"[TickertapeScorecard] Fetching {len(stocks)} stocks in batches of {BATCH_SIZE}…")
    session = requests.Session()

    session.headers.update(HEADERS)
    today = date.today().isoformat()

    def _fetch_one(item):
        symbol, sid = item
        return symbol, sid, fetch_scorecard(sid, session)

    ok = 0
    done = 0
    for batch_start in range(0, len(stocks), BATCH_SIZE):
        batch = stocks[batch_start:batch_start + BATCH_SIZE]
        with ThreadPoolExecutor(max_workers=len(batch)) as pool:
            futures = [pool.submit(_fetch_one, item) for item in batch]
            # DB writes happen here, on the main thread, after each fetch future
            # resolves -- never inside a worker thread. Matches mc_pricefeed_fetcher.py's
            # batch pattern: parallelize the network I/O only, keep the single `con`
            # connection single-threaded.
            for fut in as_completed(futures):
                symbol, sid, data = fut.result()
                done += 1
                try:
                    scores = compute_ordinal_scores(data)
                    n = upsert_scores(symbol, today, scores, con)
                    if n:
                        ok += 1
                    print(f"  [{done}/{len(stocks)}] {symbol}: {n} categories written")
                except Exception as e:
                    try:
                        con.rollback()
                    except Exception:
                        pass
                    print(f"  [{done}/{len(stocks)}] {symbol}: ERROR — {e}", file=sys.stderr)

    print(f"[TickertapeScorecard] Done. {ok}/{len(stocks)} stocks with scores written.")
    con.close()


if __name__ == "__main__":
    main()

def to_polars_df(data):
    """Converts pandas DataFrame or list of dicts to Polars DataFrame for fast vector operations."""
    if hasattr(data, 'empty') and data.empty:
        return pl.DataFrame()
    return pl.from_pandas(data) if hasattr(data, 'to_numpy') else pl.DataFrame(data)
