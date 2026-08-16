"""
Populates ChromaDB with stock profiles, screener descriptions, and recent news.
Run once at startup if chroma_store is empty; re-run nightly for incremental updates.

Usage:
    python src/server/chatbot/ingest.py
"""
import os
import sys
import logging
from pathlib import Path

# Add src/server to import path for db_compat
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from db_compat import connect

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

    conn = connect()
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
        purge_stale_docs(col, ids)
    return len(docs)


def ingest_screener_descriptions(client: chromadb.ClientAPI, db_path: str = DB_PATH) -> int:
    """One document per screener with name + description + category."""
    ef = get_embedding_fn()
    col = client.get_or_create_collection("screener_descriptions", embedding_function=ef)

    conn = connect()
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
        # Source MUST be part of the id. screener_master's primary key is (scan_id, source)
        # because MoneyControl/Trendlyne/ETnow each issue their own small-integer scan_id
        # independently and their ranges genuinely overlap -- the composite-key rule in
        # .claude/rules/data-sources.md, which that table already follows. Keying the Chroma
        # document on the bare scan_id collapsed those back together, and ChromaDB rejects the
        # whole batch rather than silently overwriting: measured 2026-08-16, 20 duplicated ids
        # (screener_173, screener_520, ...) raised DuplicateIDError and aborted run_full_ingest
        # partway -- after stock_profiles had been written, so news_articles never ran at all.
        ids.append(f"screener_{(source or 'unknown').strip().lower()}_{scan_id}")
        metas.append({"scan_id": scan_id, "name": name, "source": source or "", "type": "screener"})

    if docs:
        col.upsert(documents=docs, ids=ids, metadatas=metas)
        logger.info(f"Upserted {len(docs)} screener descriptions")
        purge_stale_docs(col, ids)
    return len(docs)


def ingest_news_articles(client: chromadb.ClientAPI, db_path: str = DB_PATH) -> int:
    """Recent news from news_sentiment_items (FinBERT-scored, live, updated ~30 min).
    Upserts into the 'news_articles' ChromaDB collection to avoid a full re-embed on upgrade."""
    ef = get_embedding_fn()
    col = client.get_or_create_collection("news_articles", embedding_function=ef)

    conn = connect()
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
        # Bounded to the same rolling window the query uses, so the index cannot keep serving
        # articles that aged out of it months ago.
        purge_stale_docs(col, ids)
    return len(docs)


def purge_stale_docs(col, current_ids: list[str]) -> int:
    """Delete documents the current run did not produce.

    .claude/rules/recurring-bugs.md: "Any table written as today's full recomputation needs a
    purge of rows the run did not produce, not just an upsert." A Chroma collection is exactly
    that shape, and an upsert-only refresh leaves two kinds of debris:

      * Documents whose id scheme changed. Re-keying screeners from `screener_{scan_id}` to
        `screener_{source}_{scan_id}` (see ingest_screener_descriptions) left every old
        bare-id document orphaned: the collection went 1,521 -> 3,193 on the first fixed run,
        i.e. 1,521 stale docs that no future run can ever update, still answering queries.
      * Rows that dropped out of the source window -- news_articles keeps only the most recent
        1,000 items, so yesterday's fall out of the query but never out of the index. That is
        how a "recent news" collection ends up serving June articles in August.

    Deletion is by explicit id difference rather than col.delete(where=...) so it cannot remove
    anything the run did not consider.
    """
    try:
        existing = set(col.get(include=[])["ids"])
    except Exception as e:
        logger.warning(f"[ingest] could not list existing ids for purge: {e}")
        return 0
    stale = sorted(existing - set(current_ids))
    if stale:
        col.delete(ids=stale)
        logger.info(f"[ingest] purged {len(stale)} stale docs from {col.name}")
    return len(stale)


def run_full_ingest(db_path: str = DB_PATH) -> dict:
    """Refresh all three collections. Each is independent: a failure in one must not starve
    the others.

    This used to be three bare calls in a row, so the DuplicateIDError raised by
    ingest_screener_descriptions (see its comment) propagated out of the second call and
    news_articles -- the collection whose entire value is recency -- was never reached. Same
    shape as the "a step at the END of a script that gets killed never runs" class in
    .claude/rules/recurring-bugs.md: the later step is starved by an earlier one and nothing
    distinguishes that from it having run and found nothing.

    Errors are re-raised as a group after all three have been attempted, so the nightly
    chatbot-reingest job still goes red (a silently-successful no-op is what let this index sit
    frozen from 2026-06-20 to 2026-08-16) while every healthy collection is still refreshed.
    """
    client = get_chroma_client()
    counts: dict = {}
    failures: list[str] = []
    for key, fn in (
        ("stocks", ingest_stock_profiles),
        ("screeners", ingest_screener_descriptions),
        ("news", ingest_news_articles),
    ):
        try:
            counts[key] = fn(client, db_path)
        except Exception as e:
            counts[key] = 0
            failures.append(f"{key}: {type(e).__name__}: {e}")
            logger.error(f"[ingest] {key} failed: {e}", exc_info=True)

    if failures:
        raise RuntimeError(
            f"ingest completed with {len(failures)} failed collection(s) "
            f"(counts={counts}): " + " | ".join(failures)
        )
    return counts


if __name__ == "__main__":
    result = run_full_ingest()
    logger.info(f"Ingest complete: {result}")
