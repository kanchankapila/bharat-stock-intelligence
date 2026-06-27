"""
BSE Event Classifier
====================
Classifies news_articles into event types and computes per-stock event signal scores.
Event types have known directional implications:
  ORDER_WIN (+), PROMOTER_BUY (+), BUYBACK (+), RESULTS_BEAT (+), QIP (+/-), DEBT_RAISED (-)
  PROMOTER_SELL (-), LITIGATION (-), RATING_DOWNGRADE (-)

Writes:
  technical_signals.event_signal_score  — rolling 30d event score per stock
  technical_signals.event_type_flags    — JSON of recent event types

Usage:
  python bse_event_classifier.py              # today's 30-day window
  python bse_event_classifier.py --backfill   # score every ts row historically
"""
import sys, json, re, argparse
from pathlib import Path
from datetime import datetime, timedelta
from collections import defaultdict

sys.path.insert(0, str(Path(__file__).resolve().parent))
from db_compat import connect

# Event patterns: (regex, score, event_type)
EVENT_PATTERNS = [
    (r'\border\b.{0,30}(?:win|secur|receiv|award|bag|get)', +2.0, 'ORDER_WIN'),
    (r'(?:buyback|buy.?back|share.?repurchas)', +1.5, 'BUYBACK'),
    (r'(?:promoter|management).{0,20}(?:buy|acquir|purchas|increas)', +1.5, 'PROMOTER_BUY'),
    (r'(?:promoter|management).{0,20}(?:sell|offload|reduc|pledg)', -1.5, 'PROMOTER_SELL'),
    (r'(?:beat|beat\s+estimate|above\s+estimate|strong\s+quarter|record\s+(?:profit|revenue|sales))', +1.5, 'RESULTS_BEAT'),
    (r'(?:miss|below\s+estimate|disappoint|weak\s+quarter|profit\s+(?:fall|drop|declin))', -1.5, 'RESULTS_MISS'),
    (r'\bqip\b|\bqualified\s+institutional\s+placement\b', +0.5, 'QIP'),
    (r'(?:merger|acquisition|acquir|takeover|amalgamat)', +1.0, 'MERGER_ACQUISITION'),
    (r'(?:dividend|dividend\s+announc|dividend\s+declar)', +0.8, 'DIVIDEND'),
    (r'(?:debt|borrowing|loan|bond|ncd).{0,20}(?:rais|issu|taken)', -0.8, 'DEBT_RAISED'),
    (r'\bsebi\b.{0,30}(?:action|order|penalt|fine|notice|ban|restrict)', -2.0, 'REGULATORY'),
    (r'(?:fraud|scam|misappropriat|embezzl|forensic\s+audit)', -2.5, 'FRAUD'),
    (r'(?:litigation|lawsuit|legal\s+notice|court\s+order|arbitration)', -1.0, 'LITIGATION'),
    (r'(?:rating\s+upgrade|outlook\s+(?:positive|stable\s+to\s+positive))', +1.0, 'RATING_UPGRADE'),
    (r'(?:rating\s+downgrade|outlook\s+(?:negative|stable\s+to\s+negative))', -1.0, 'RATING_DOWNGRADE'),
    (r'(?:block\s+deal|bulk\s+deal).{0,30}(?:buy|purchas)', +0.8, 'BLOCK_BUY'),
    (r'(?:block\s+deal|bulk\s+deal).{0,30}(?:sell|offload)', -0.8, 'BLOCK_SELL'),
    (r'(?:expansion|capex|capacity\s+addition|new\s+plant|greenfield)', +1.0, 'EXPANSION'),
]

_PAT_COMPILED = [(re.compile(p, re.I), s, t) for p, s, t in EVENT_PATTERNS]


def classify_article(title: str, summary: str) -> list[tuple[str, float]]:
    text = f"{title} {summary}".lower()
    return [(etype, score) for pat, score, etype in _PAT_COMPILED if pat.search(text)]


def ensure_schema(con):
    for sql in [
        "ALTER TABLE technical_signals ADD COLUMN IF NOT EXISTS event_signal_score REAL",
        "ALTER TABLE technical_signals ADD COLUMN IF NOT EXISTS event_type_flags TEXT",
    ]:
        try:
            con.execute(sql)
            con.commit()
        except Exception:
            con.rollback()


def _load_valid_symbols(con) -> set:
    try:
        rows = con.execute("SELECT symbol FROM nse_stocks").fetchall()
        return {r['symbol'].upper() for r in rows}
    except Exception:
        return set()


def _build_event_index(con, since: str) -> dict[str, list[tuple[str, float, str]]]:
    """Returns {symbol: [(article_date, score, etype), ...]} for all articles since `since`."""
    articles = con.execute(
        "SELECT title, summary, symbols, timestamp FROM news_articles WHERE timestamp >= ? ORDER BY timestamp ASC",
        (since,)
    ).fetchall()

    valid = _load_valid_symbols(con)
    idx: dict[str, list] = defaultdict(list)
    for art in articles:
        syms_raw = art['symbols'] or ''
        symbols = [s.strip().upper() for s in syms_raw.split(',') if s.strip()]
        if valid:
            symbols = [s for s in symbols if s in valid]
        if not symbols:
            continue
        events = classify_article(art['title'] or '', art['summary'] or '')
        if not events:
            continue
        # article date is the first 10 chars of timestamp (ISO format)
        art_date = str(art['timestamp'])[:10]
        for sym in symbols:
            for etype, score in events:
                idx[sym].append((art_date, score, etype))
    return idx


def run_daily(con):
    """Update latest ts row per symbol using last 30 days of news."""
    ensure_schema(con)
    since = (datetime.now() - timedelta(days=30)).strftime('%Y-%m-%d')
    idx = _build_event_index(con, since)
    print(f"[EventClassifier] {len(idx)} symbols with events in last 30 days")

    updated = 0
    for symbol, events in idx.items():
        score = sum(s for _, s, _ in events)
        etypes = list(set(t for _, _, t in events))
        con.execute("""
            UPDATE technical_signals
            SET event_signal_score = ?, event_type_flags = ?
            WHERE (symbol, date) IN (
                SELECT symbol, MAX(date) FROM technical_signals WHERE symbol = ? GROUP BY symbol
            )
        """, (round(score, 2), json.dumps(etypes), symbol))
        updated += 1
    con.commit()
    print(f"[EventClassifier] Wrote event scores for {updated} symbols.")

    top = sorted(idx.items(), key=lambda x: abs(sum(s for _, s, _ in x[1])), reverse=True)[:10]
    for sym, evs in top:
        score = sum(s for _, s, _ in evs)
        etypes = list(set(t for _, _, t in evs))
        print(f"  {sym}: {score:+.1f} {etypes}")


def run_backfill(con, lookback_days: int = 180):
    """
    For every (symbol, date) row in technical_signals, compute the rolling 30-day
    event score from news_articles as of that date, then write it back.
    This gives the ML training data accurate historical event features.
    """
    ensure_schema(con)
    since = (datetime.now() - timedelta(days=lookback_days + 30)).strftime('%Y-%m-%d')
    print(f"[EventClassifier] Backfill: loading articles since {since}...")
    idx = _build_event_index(con, since)
    print(f"[EventClassifier] {len(idx)} symbols with historical events")

    # Get all (symbol, date) ts rows to backfill
    ts_rows = con.execute(
        "SELECT DISTINCT symbol, date FROM technical_signals ORDER BY symbol, date"
    ).fetchall()
    print(f"[EventClassifier] Backfilling {len(ts_rows)} ts rows...")

    updated = 0
    batch = []
    for row in ts_rows:
        symbol = row['symbol']
        ts_date = row['date']
        if symbol not in idx:
            continue
        # Rolling 30-day window up to ts_date
        window_start = (datetime.strptime(ts_date, '%Y-%m-%d') - timedelta(days=30)).strftime('%Y-%m-%d')
        events_in_window = [(s, t) for (d, s, t) in idx[symbol] if window_start <= d <= ts_date]
        if not events_in_window:
            continue
        score = sum(s for s, _ in events_in_window)
        etypes = list(set(t for _, t in events_in_window))
        batch.append((round(score, 2), json.dumps(etypes), symbol, ts_date))

        if len(batch) >= 500:
            for args in batch:
                con.execute(
                    "UPDATE technical_signals SET event_signal_score=?, event_type_flags=? WHERE symbol=? AND date=?",
                    args
                )
            con.commit()
            updated += len(batch)
            batch = []

    if batch:
        for args in batch:
            con.execute(
                "UPDATE technical_signals SET event_signal_score=?, event_type_flags=? WHERE symbol=? AND date=?",
                args
            )
        con.commit()
        updated += len(batch)

    print(f"[EventClassifier] Backfill complete: updated {updated} ts rows.")


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--backfill', action='store_true', help='Backfill event scores for all historical ts rows')
    parser.add_argument('--lookback', type=int, default=180, help='Days of history to backfill (default 180)')
    args = parser.parse_args()

    con = connect()
    if args.backfill:
        run_backfill(con, lookback_days=args.lookback)
    else:
        run_daily(con)
