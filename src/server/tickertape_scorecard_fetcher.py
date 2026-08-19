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

import argparse
from datetime import date

import requests

from db_compat import connect
from tickertape_client import HEADERS, fetch_scorecard, load_tickertape_sid_map
import sys

ORDINAL_MAP = {"low": 0, "avg": 1, "high": 2}


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


# ── Per-stock processing ──────────────────────────────────────────────────────────

def process_stock(symbol: str, sid: str, today: str, session: requests.Session, con) -> int:
    data = fetch_scorecard(sid, session)
    scores = compute_ordinal_scores(data)
    return upsert_scores(symbol, today, scores, con)


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
    args = parser.parse_args()

    con = connect()

    stocks = load_stocks(args.symbol, args.limit)
    if not stocks:
        print("[TickertapeScorecard] No stocks with a tickertape_sid found.")
        con.close()
        return

    print(f"[TickertapeScorecard] Processing {len(stocks)} stocks…")
    session = requests.Session()
    session.headers.update(HEADERS)
    today = date.today().isoformat()

    ok = 0
    for i, (symbol, sid) in enumerate(stocks, 1):
        try:
            n = process_stock(symbol, sid, today, session, con)
            if n:
                ok += 1
            print(f"  [{i}/{len(stocks)}] {symbol}: {n} categories written")
        except Exception as e:
            try:
                con.rollback()
            except Exception:
                pass
            print(f"  [{i}/{len(stocks)}] {symbol}: ERROR — {e}", file=sys.stderr)

    print(f"[TickertapeScorecard] Done. {ok}/{len(stocks)} stocks with scores written.")
    con.close()


if __name__ == "__main__":
    main()
