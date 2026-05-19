"""
FinBERT News Sentiment Scorer
================================
Uses ProsusAI/finbert (HuggingFace) to score financial news headlines
and article snippets, then upserts results into news_sentiment_items.

Requirements:
    pip install transformers torch sentencepiece

Run:  python finbert_scorer.py
      python finbert_scorer.py --limit 200
      python finbert_scorer.py --days 3
"""

import os
import sys
import datetime
import argparse
import math
import sqlite3

DB_PATH = os.path.join(os.getcwd(), 'database.sqlite')

MODEL_NAME = "ProsusAI/finbert"
BATCH_SIZE = 16
MAX_LENGTH = 512   # FinBERT max tokens


def load_model():
    try:
        from transformers import AutoTokenizer, AutoModelForSequenceClassification
        import torch
        tokenizer = AutoTokenizer.from_pretrained(MODEL_NAME)
        model     = AutoModelForSequenceClassification.from_pretrained(MODEL_NAME)
        model.eval()
        device = "cuda" if torch.cuda.is_available() else "cpu"
        model  = model.to(device)
        print(f"[FinBERT] Model loaded on {device}")
        return tokenizer, model, device
    except ImportError:
        print("[FinBERT] ERROR: transformers/torch not installed.")
        print("  Run: pip install transformers torch sentencepiece")
        sys.exit(1)


def score_batch(texts: list[str], tokenizer, model, device) -> list[dict]:
    """Score a batch of texts. Returns list of {positive, negative, neutral, label, confidence}."""
    import torch

    inputs = tokenizer(
        texts,
        padding=True,
        truncation=True,
        max_length=MAX_LENGTH,
        return_tensors="pt",
    ).to(device)

    with torch.no_grad():
        logits = model(**inputs).logits
        probs  = torch.softmax(logits, dim=-1).cpu().numpy()

    # FinBERT label order: positive=0, negative=1, neutral=2
    results = []
    for p in probs:
        label_idx  = int(p.argmax())
        label_map  = {0: "positive", 1: "negative", 2: "neutral"}
        label      = label_map[label_idx]
        
        # Confidence delta threshold gating
        delta_p = abs(float(p[0]) - float(p[1]))
        if label in ["positive", "negative"] and delta_p < 0.35:
            label = "neutral"
            sent_score = 0.0
            conf = float(p[2])
        else:
            sent_score = float(p[0] - p[1])
            conf = float(p[label_idx])

        results.append({
            "positive":   float(p[0]),
            "negative":   float(p[1]),
            "neutral":    float(p[2]),
            "label":      label,
            "confidence": conf,
            # Signed score: positive probability - negative probability, range [-1, +1]
            "sentiment_score": sent_score,
        })
    return results


def load_unscored_articles(conn: sqlite3.Connection, limit: int, days: int) -> list[dict]:
    """Load news_articles rows that have no finbert score yet."""
    cur = conn.cursor()

    where_clauses = [
        "a.id NOT IN (SELECT COALESCE(source_id,'') FROM news_sentiment_items WHERE source='finbert')"
    ]
    params: list = []

    if days > 0:
        cutoff = (datetime.datetime.now() - datetime.timedelta(days=days)).isoformat()
        where_clauses.append("a.published_at >= ?")
        params.append(cutoff)

    where = " AND ".join(where_clauses)
    limit_clause = f"LIMIT {limit}" if limit > 0 else ""

    cur.execute(f"""
        SELECT a.id, a.title, a.description, a.symbol, a.published_at
        FROM news_articles a
        WHERE {where}
        ORDER BY a.published_at DESC
        {limit_clause}
    """, params)

    rows = cur.fetchall()
    return [
        {"id": r[0], "title": r[1] or "", "description": r[2] or "",
         "symbol": r[3] or "", "published_at": r[4] or ""}
        for r in rows
    ]


def upsert_sentiment(conn: sqlite3.Connection, records: list[dict]):
    """Write FinBERT scores to news_sentiment_items."""
    now = datetime.datetime.now().isoformat()
    cur = conn.cursor()

    for r in records:
        # Map label to positive_count / negative_count booleans
        pos_count = 1 if r["label"] == "positive" else 0
        neg_count = 1 if r["label"] == "negative" else 0

        cur.execute("""
            INSERT INTO news_sentiment_items
                (symbol, source, category, sentiment, score,
                 positive_count, negative_count,
                 headline, source_id, fetched_at)
            VALUES (?, 'finbert', 'news', ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT DO NOTHING
        """, (
            r["symbol"],
            r["label"],
            r["sentiment_score"],
            pos_count,
            neg_count,
            r["title"][:500],
            str(r["id"]),
            now,
        ))

    conn.commit()


def run(limit: int = 500, days: int = 7, dry_run: bool = False):
    print(f"[FinBERT] Starting at {datetime.datetime.now()}")

    tokenizer, model, device = load_model()

    conn = sqlite3.connect(DB_PATH)
    try:
        articles = load_unscored_articles(conn, limit=limit, days=days)
        print(f"[FinBERT] {len(articles)} unscored articles found")

        if not articles:
            print("[FinBERT] Nothing to score.")
            return

        # Build texts: title + description snippet
        texts = []
        for a in articles:
            desc = a["description"][:300] if a["description"] else ""
            text = f"{a['title']}. {desc}".strip()
            texts.append(text)

        # Batch scoring
        scored = []
        total_batches = math.ceil(len(texts) / BATCH_SIZE)
        for i in range(0, len(texts), BATCH_SIZE):
            batch_texts = texts[i:i + BATCH_SIZE]
            batch_arts  = articles[i:i + BATCH_SIZE]
            batch_num   = i // BATCH_SIZE + 1
            print(f"[FinBERT] Batch {batch_num}/{total_batches} ({len(batch_texts)} items)...")

            try:
                scores = score_batch(batch_texts, tokenizer, model, device)
                for art, score in zip(batch_arts, scores):
                    scored.append({**art, **score})
            except Exception as e:
                print(f"[FinBERT] Batch {batch_num} error: {e}")
                continue

        print(f"[FinBERT] Scored {len(scored)} articles.")

        # Summary stats
        labels = [s["label"] for s in scored]
        pos = labels.count("positive")
        neg = labels.count("negative")
        neu = labels.count("neutral")
        print(f"[FinBERT] positive={pos}  negative={neg}  neutral={neu}")

        if dry_run:
            print("[FinBERT] Dry-run: not saving to DB.")
            for s in scored[:5]:
                print(f"  [{s['label']:8s} {s['confidence']:.2f}] {s['title'][:80]}")
            return

        upsert_sentiment(conn, scored)
        print(f"[FinBERT] Saved {len(scored)} rows to news_sentiment_items.")

    finally:
        conn.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="FinBERT News Sentiment Scorer")
    parser.add_argument("--limit", type=int, default=500,
                        help="Max articles to score per run (0=all, default=500)")
    parser.add_argument("--days",  type=int, default=7,
                        help="Only score articles from last N days (0=all, default=7)")
    parser.add_argument("--dry-run", action="store_true",
                        help="Score but do not write to DB")
    args = parser.parse_args()

    run(limit=args.limit, days=args.days, dry_run=args.dry_run)
