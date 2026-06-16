"""
Populates ChromaDB with stock profiles, screener descriptions, and recent news.
Run once at startup if chroma_store is empty; re-run nightly for incremental updates.

Usage:
    python src/server/chatbot/ingest.py
"""
import os
import sqlite3
import logging

import chromadb
from chromadb.utils.embedding_functions import SentenceTransformerEmbeddingFunction

DB_PATH = os.getenv("DB_PATH", "database.sqlite")
CHROMA_DIR = os.getenv("CHROMA_PERSIST_DIR", "src/server/chatbot/chroma_store")

logging.basicConfig(level=logging.INFO, format="[ingest] %(message)s")
logger = logging.getLogger(__name__)


def get_chroma_client() -> chromadb.ClientAPI:
    return chromadb.PersistentClient(path=CHROMA_DIR)


def get_embedding_fn():
    return SentenceTransformerEmbeddingFunction(model_name="all-MiniLM-L6-v2")


def ingest_stock_profiles(client: chromadb.ClientAPI, db_path: str = DB_PATH) -> int:
    """One document per stock: name + sector + description."""
    ef = get_embedding_fn()
    col = client.get_or_create_collection("stock_profiles", embedding_function=ef)

    conn = sqlite3.connect(db_path)
    try:
        rows = conn.execute("""
            SELECT ns.symbol, ns.name, ns.sector, ns.industry,
                   cp.description, cp.ai_analysis
            FROM nse_stocks ns
            LEFT JOIN company_profiles cp ON ns.symbol = cp.symbol
            WHERE ns.status = 'ACTIVE' OR ns.status IS NULL
            LIMIT 3000
        """).fetchall()
    except Exception:
        rows = conn.execute("""
            SELECT symbol, name, sector, industry, NULL, NULL
            FROM nse_stocks
            LIMIT 3000
        """).fetchall()
    conn.close()

    docs, ids, metas = [], [], []
    for symbol, name, sector, industry, desc, ai in rows:
        text = f"{name} ({symbol}). Sector: {sector or 'N/A'}. Industry: {industry or 'N/A'}."
        if desc:
            text += f" {desc}"
        if ai:
            text += f" AI Analysis: {ai}"
        docs.append(text)
        ids.append(f"stock_{symbol}")
        metas.append({"symbol": symbol, "name": name or "", "sector": sector or "", "type": "stock"})

    if docs:
        col.upsert(documents=docs, ids=ids, metadatas=metas)
        logger.info(f"Upserted {len(docs)} stock profiles")
    return len(docs)


def ingest_screener_descriptions(client: chromadb.ClientAPI, db_path: str = DB_PATH) -> int:
    """One document per screener with name + description + category."""
    ef = get_embedding_fn()
    col = client.get_or_create_collection("screener_descriptions", embedding_function=ef)

    conn = sqlite3.connect(db_path)
    try:
        rows = conn.execute("""
            SELECT scan_id, name, source, inferred_sentiment, inferred_category
            FROM screener_master
            WHERE name IS NOT NULL
        """).fetchall()
    except Exception:
        rows = []
    conn.close()

    docs, ids, metas = [], [], []
    for scan_id, name, source, sentiment, category in rows:
        text = f"{name}. Source: {source or 'unknown'}. Category: {category or 'general'}. Sentiment: {sentiment or 'neutral'}."
        docs.append(text)
        ids.append(f"screener_{scan_id}")
        metas.append({"scan_id": scan_id, "name": name, "source": source or "", "type": "screener"})

    if docs:
        col.upsert(documents=docs, ids=ids, metadatas=metas)
        logger.info(f"Upserted {len(docs)} screener descriptions")
    return len(docs)


def ingest_news_articles(client: chromadb.ClientAPI, db_path: str = DB_PATH) -> int:
    """Recent news from news_sentiment_items (FinBERT-scored, live, updated ~30 min).
    Upserts into the 'news_articles' ChromaDB collection to avoid a full re-embed on upgrade."""
    ef = get_embedding_fn()
    col = client.get_or_create_collection("news_articles", embedding_function=ef)

    conn = sqlite3.connect(db_path)
    try:
        rows = conn.execute("""
            SELECT id, title, summary, source, sentiment, sentiment_score,
                   impact, category, sector, symbols_json
            FROM news_sentiment_items
            WHERE published_at >= datetime('now', '-30 days')
            ORDER BY published_at DESC
            LIMIT 1000
        """).fetchall()
    except Exception:
        rows = []
    conn.close()

    docs, ids, metas = [], [], []
    for row in rows:
        art_id, title, summary, source, sentiment, score, impact, category, sector, symbols_json = row
        text = f"{title or ''}. {summary or ''}".strip()
        if not text:
            continue
        docs.append(text[:500])
        ids.append(f"news_{art_id}")
        metas.append({
            "source": source or "",
            "sentiment": sentiment or "Neutral",
            "sentiment_score": float(score) if score is not None else 0.0,
            "impact": impact or "MEDIUM",
            "category": category or "",
            "sector": sector or "",
            "symbols": symbols_json or "",
            "type": "news",
        })

    if docs:
        col.upsert(documents=docs, ids=ids, metadatas=metas)
        logger.info(f"Upserted {len(docs)} news items from news_sentiment_items")
    return len(docs)


def run_full_ingest(db_path: str = DB_PATH) -> dict:
    client = get_chroma_client()
    stocks = ingest_stock_profiles(client, db_path)
    screeners = ingest_screener_descriptions(client, db_path)
    news = ingest_news_articles(client, db_path)
    return {"stocks": stocks, "screeners": screeners, "news": news}


if __name__ == "__main__":
    result = run_full_ingest()
    logger.info(f"Ingest complete: {result}")
