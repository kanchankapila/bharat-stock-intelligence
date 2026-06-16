import os
import sqlite3

DB_PATH = os.getenv("DB_PATH", "database.sqlite")
CHROMA_DIR = os.getenv("CHROMA_PERSIST_DIR", "src/server/chatbot/chroma_store")


def get_chroma_client():
    import chromadb
    return chromadb.PersistentClient(path=CHROMA_DIR)


def get_embedding_fn():
    from chromadb.utils.embedding_functions import SentenceTransformerEmbeddingFunction
    return SentenceTransformerEmbeddingFunction(model_name="all-MiniLM-L6-v2")


def get_screener_stocks(scan_id: str, db_path: str = DB_PATH) -> list[dict]:
    """Fetch constituent stocks for a screener id, enriched with AI scores."""
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row

    rows = conn.execute("""
        SELECT tss.symbol, ns.name, ns.sector,
               ss.score, ss.classification
        FROM trendlyne_screener_stocks tss
        JOIN nse_stocks ns ON tss.symbol = ns.symbol
        LEFT JOIN stock_scores ss ON tss.symbol = ss.symbol AND ss.timeframe = 'long_term'
        WHERE tss.screener_id = ?
        UNION
        SELECT mss.symbol, ns.name, ns.sector,
               ss.score, ss.classification
        FROM moneycontrol_screener_stocks mss
        JOIN nse_stocks ns ON mss.symbol = ns.symbol
        LEFT JOIN stock_scores ss ON mss.symbol = ss.symbol AND ss.timeframe = 'long_term'
        WHERE mss.scan_id = ?
        ORDER BY score DESC
        LIMIT 30
    """, (scan_id, scan_id)).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def search_screener(query: str, top_k: int = 3, db_path: str = DB_PATH) -> list[dict]:
    """
    Semantic search over screener names/descriptions using ChromaDB,
    then return each matched screener's constituent stocks.
    Falls back to SQL LIKE search if ChromaDB is empty.
    """
    client = get_chroma_client()
    ef = get_embedding_fn()
    col = client.get_or_create_collection("screener_descriptions", embedding_function=ef)

    if col.count() == 0:
        conn = sqlite3.connect(db_path)
        conn.row_factory = sqlite3.Row
        term = f"%{query}%"
        screeners = conn.execute(
            "SELECT scan_id, name, source, inferred_sentiment FROM screener_master WHERE name LIKE ? LIMIT ?",
            (term, top_k),
        ).fetchall()
        conn.close()
        return [
            {
                "screener_name": r["name"],
                "source": r["source"],
                "sentiment": r["inferred_sentiment"],
                "stocks": get_screener_stocks(r["scan_id"], db_path),
            }
            for r in screeners
        ]

    result = col.query(query_texts=[query], n_results=top_k)
    metadatas = result["metadatas"][0] if result["metadatas"] else []

    return [
        {
            "screener_name": meta.get("name", ""),
            "source": meta.get("source", ""),
            "scan_id": meta.get("scan_id", ""),
            "stocks": get_screener_stocks(meta["scan_id"], db_path) if meta.get("scan_id") else [],
        }
        for meta in metadatas
    ]
