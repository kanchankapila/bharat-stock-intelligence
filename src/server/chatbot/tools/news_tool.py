"""
News sentiment tool — queries news_sentiment_items (FinBERT-scored, updated ~30 min)
as the primary source. Falls back to the legacy news_articles table.
"""
import os
import sys
from datetime import datetime, timedelta
from pathlib import Path

# Add src/server to import path for db_compat
sys.path.insert(0, str(Path(__file__).resolve().parent.parent.parent))
from db_compat import connect as db_connect

# DB_PATH is handled centrally by db_compat via USE_POSTGRES env var.
DB_PATH = os.getenv("DB_PATH", "database.sqlite")


def _connect(db_path: str = None):
    return db_connect()


def get_news_sentiment(
    symbol: str | None = None,
    days: int = 7,
    limit: int = 15,
    db_path: str = DB_PATH,
) -> dict:
    """
    Fetch and summarise news sentiment for a stock or the overall market.
    Primary source: news_sentiment_items (FinBERT-scored, live).
    Falls back to legacy news_articles if the primary table is empty/missing.
    """
    conn = _connect(db_path)
    cutoff = (datetime.now() - timedelta(days=days)).strftime("%Y-%m-%d %H:%M:%S")

    # ── Primary: news_sentiment_items ────────────────────────────────────────
    try:
        where = ["published_at >= ?"]
        params: list = [cutoff]

        if symbol:
            sym = symbol.upper()
            # symbols_json is a JSON array like ["INFY", "TCS"]
            where.append(
                "(symbols_json LIKE ? OR symbols_json LIKE ? "
                "OR symbols_json LIKE ? OR symbols_json LIKE ?)"
            )
            params += [
                f'["{sym}"',
                f'"{sym}",',
                f', "{sym}"',
                f'"{sym}"]',
            ]

        params.append(limit)

        rows = conn.execute(
            f"SELECT title, summary, source, published_at, sentiment, sentiment_score, "
            f"impact, category, sector, url "
            f"FROM news_sentiment_items "
            f"WHERE {' AND '.join(where)} "
            f"ORDER BY published_at DESC LIMIT ?",
            params,
        ).fetchall()

        if rows:
            articles = [dict(r) for r in rows]
            conn.close()
            return _summarise(symbol, articles, source="news_sentiment_items")

    except Exception:
        pass

    # ── Fallback: legacy news_articles ───────────────────────────────────────
    try:
        where_leg = ["1=1"]
        params_leg: list = []

        if symbol:
            sym = symbol.upper()
            where_leg.append(
                "(symbols LIKE ? OR symbols LIKE ? OR symbols LIKE ? OR symbols = ?)"
            )
            params_leg += [f"%,{sym},%", f"{sym},%", f"%,{sym}", sym]

        cutoff_leg = (datetime.now() - timedelta(days=days)).strftime("%Y-%m-%d")
        where_leg.append("timestamp >= ?")
        params_leg.append(cutoff_leg)
        params_leg.append(limit)

        rows = conn.execute(
            f"SELECT title, summary, source, timestamp AS published_at, "
            f"sentiment, NULL AS sentiment_score, 'MEDIUM' AS impact, "
            f"'' AS category, '' AS sector, url "
            f"FROM news_articles "
            f"WHERE {' AND '.join(where_leg)} "
            f"ORDER BY timestamp DESC LIMIT ?",
            params_leg,
        ).fetchall()

        articles = [dict(r) for r in rows]
        conn.close()
        return _summarise(symbol, articles, source="news_articles")

    except Exception:
        conn.close()
        return {
            "symbol": symbol,
            "total": 0,
            "bullish": 0,
            "bearish": 0,
            "neutral": 0,
            "overall_sentiment": "Neutral",
            "headlines": [],
        }


def _summarise(symbol: str | None, articles: list[dict], source: str) -> dict:
    total = len(articles)
    pos = sum(1 for a in articles if str(a.get("sentiment", "")).upper() in ("BULLISH", "POSITIVE"))
    neg = sum(1 for a in articles if str(a.get("sentiment", "")).upper() in ("BEARISH", "NEGATIVE"))
    neu = total - pos - neg

    scores = [a["sentiment_score"] for a in articles if a.get("sentiment_score") is not None]
    avg_score = round(sum(scores) / len(scores), 3) if scores else 0.0

    overall = (
        "Bullish" if avg_score > 0.1 else
        "Bearish" if avg_score < -0.1 else
        "Neutral"
    )

    high_impact = [a for a in articles if a.get("impact") == "HIGH"]

    return {
        "symbol": symbol,
        "total": total,
        "bullish": pos,
        "bearish": neg,
        "neutral": neu,
        "avg_sentiment_score": avg_score,
        "overall_sentiment": overall,
        "high_impact_count": len(high_impact),
        "source": source,
        "headlines": [
            {
                "title": a["title"],
                "published_at": a.get("published_at"),
                "sentiment": a.get("sentiment"),
                "sentiment_score": a.get("sentiment_score"),
                "impact": a.get("impact"),
                "category": a.get("category"),
                "source": a.get("source"),
            }
            for a in articles[:10]
        ],
        "high_impact": high_impact[:3],
    }
