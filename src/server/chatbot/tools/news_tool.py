import os
import sqlite3
from datetime import datetime, timedelta

DB_PATH = os.getenv("DB_PATH", "database.sqlite")


def get_news_sentiment(
    symbol: str | None,
    days: int = 7,
    limit: int = 10,
    db_path: str = DB_PATH,
) -> dict:
    """Query recent news articles for a symbol (or general market news)."""
    cutoff = (datetime.now() - timedelta(days=days)).strftime("%Y-%m-%d %H:%M:%S")

    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row

    if symbol:
        sym = symbol.upper()
        rows = conn.execute("""
            SELECT id, title, summary, source, sentiment, url, timestamp
            FROM news_articles
            WHERE (symbols LIKE ? OR symbols LIKE ? OR symbols LIKE ? OR symbols = ?)
              AND timestamp >= ?
            ORDER BY timestamp DESC
            LIMIT ?
        """, (
            f"%,{sym},%", f"{sym},%", f"%,{sym}", sym,
            cutoff, limit,
        )).fetchall()
    else:
        rows = conn.execute("""
            SELECT id, title, summary, source, sentiment, url, timestamp
            FROM news_articles
            WHERE timestamp >= ?
            ORDER BY timestamp DESC
            LIMIT ?
        """, (cutoff, limit)).fetchall()

    conn.close()

    articles = [dict(r) for r in rows]
    total = len(articles)
    positive = sum(1 for a in articles if a["sentiment"] == "Positive")
    negative = sum(1 for a in articles if a["sentiment"] == "Negative")
    neutral = total - positive - negative

    if positive > negative and positive > neutral:
        overall = "Positive"
    elif negative > positive and negative > neutral:
        overall = "Negative"
    elif positive == 0 and negative == 0:
        overall = "Neutral"
    else:
        overall = "Mixed"

    return {
        "symbol": symbol,
        "total": total,
        "positive": positive,
        "negative": negative,
        "neutral": neutral,
        "overall_sentiment": overall,
        "headlines": [
            {"title": a["title"], "source": a["source"],
             "sentiment": a["sentiment"], "url": a["url"], "date": a["timestamp"]}
            for a in articles[:5]
        ],
    }
