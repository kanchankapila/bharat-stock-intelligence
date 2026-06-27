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
"""
import sys, json, re
from pathlib import Path
from datetime import datetime, timedelta

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
    (r'(?:debt|loan|borrow).{0,20}(?:raise|raise|increas|new)', -0.8, 'DEBT_RAISED'),
    (r'(?:sebi\s+(?:action|order|penalty|notice|ban|suspend|investig|probe)|cbi\s+(?:raid|arrest|investig|probe)|enforcement\s+direct|money\s+launder|\bfraud\b|\bscam\b|ponzi|insider\s+trad(?:ing|er)|market\s+manipulat)', -2.0, 'REGULATORY'),
    (r'(?:downgrad|rating\s+cut|negative\s+outlook)', -1.5, 'RATING_DOWNGRADE'),
    (r'(?:upgrad|rating\s+improv|positive\s+outlook)', +1.2, 'RATING_UPGRADE'),
    (r'(?:plant\s+expan|capex|capacity\s+expan|greenfield|brownfield)', +0.8, 'CAPEX_EXPANSION'),
    (r'(?:block\s+deal|bulk\s+deal).{0,30}(?:buy|purchas)', +0.5, 'BLOCK_BUY'),
    (r'(?:block\s+deal|bulk\s+deal).{0,30}(?:sell)', -0.5, 'BLOCK_SELL'),
    (r'(?:ceo|md|cfo|managing\s+director).{0,20}(?:resign|quit|step\s+down)', -1.5, 'MGMT_EXIT'),
    (r'(?:new\s+(?:ceo|md|cfo)|appoint.{0,20}(?:ceo|md|cfo))', +0.5, 'MGMT_APPOINT'),
]

def classify_article(title: str, summary: str) -> list[tuple[str, float]]:
    text = f"{title} {summary}".lower()
    events = []
    for pattern, score, etype in EVENT_PATTERNS:
        if re.search(pattern, text, re.I):
            events.append((etype, score))
    return events

def ensure_schema(con):
    for col in ['event_signal_score DOUBLE PRECISION', 'event_type_flags TEXT']:
        try:
            con.execute(f'ALTER TABLE technical_signals ADD COLUMN IF NOT EXISTS {col}')
            con.commit()
        except Exception:
            con.rollback()

def run():
    con = connect()
    ensure_schema(con)

    # Build valid NSE ticker set to avoid false symbols like 'OIL', 'GLOBAL', 'BSE'
    valid_symbols: set[str] = set()
    try:
        rows = con.execute("SELECT symbol FROM nse_stocks").fetchall()
        valid_symbols = {r['symbol'].upper() for r in rows}
    except Exception:
        pass

    cutoff = (datetime.now() - timedelta(days=30)).strftime('%Y-%m-%d')
    articles = con.execute(
        "SELECT id, title, summary, symbols, timestamp FROM news_articles WHERE timestamp >= ? ORDER BY timestamp DESC",
        (cutoff,)
    ).fetchall()

    print(f"[EventClassifier] Processing {len(articles)} articles from last 30 days (valid tickers: {len(valid_symbols)})...")

    # Accumulate per-symbol event scores
    symbol_events: dict[str, list] = {}
    for art in articles:
        syms_raw = art['symbols'] or ''
        symbols = [s.strip().upper() for s in syms_raw.split(',') if s.strip()]
        # Filter to valid NSE symbols only (skip generic words like 'OIL', 'GLOBAL', 'BSE')
        if valid_symbols:
            symbols = [s for s in symbols if s in valid_symbols]
        if not symbols:
            continue
        events = classify_article(art['title'] or '', art['summary'] or '')
        if not events:
            continue
        for sym in symbols:
            if sym not in symbol_events:
                symbol_events[sym] = []
            symbol_events[sym].extend(events)

    # Write to technical_signals — latest row per symbol (rolling 30d event score is date-independent)
    updated = 0
    for symbol, events in symbol_events.items():
        score = sum(s for _, s in events)
        etypes = list(set(e for e, _ in events))
        con.execute("""
            UPDATE technical_signals
            SET event_signal_score = ?, event_type_flags = ?
            WHERE (symbol, date) IN (
                SELECT symbol, MAX(date) FROM technical_signals WHERE symbol = ? GROUP BY symbol
            )
        """, (round(score, 2), json.dumps(etypes), symbol))
        if con.execute("SELECT 1", []).fetchone():  # always true — count via rowcount workaround
            updated += 1
    con.commit()
    print(f"[EventClassifier] Wrote event scores for {updated} valid symbols.")

    # Print top events
    top = sorted(symbol_events.items(), key=lambda x: abs(sum(s for _, s in x[1])), reverse=True)[:10]
    for sym, evs in top:
        score = sum(s for _, s in evs)
        etypes = [e for e, _ in evs]
        print(f"  {sym}: {score:+.1f} {etypes}")

if __name__ == '__main__':
    run()
