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

import polars as pl
import os
import sys
import datetime
import argparse
import math

from db_compat import connect, use_postgres, ConnWrapper

# Same reason as nlp_engine.py's copy: load from the local HF cache, don't call the Hub.
# Must precede the transformers import inside load_model().
os.environ.setdefault("HF_HUB_OFFLINE", "1")
os.environ.setdefault("HF_HUB_DISABLE_PROGRESS_BARS", "1")

MODEL_NAME = "ProsusAI/finbert"
# Second, independently-trained finance BERT (Amazon, financial-tone). Running it alongside
# ProsusAI/finbert exposes single-model bias: its verdict is stored on news_sentiment_items
# (tone_pos/tone_neg/tone_neu/tone_label/tone_score) and sentiment_conflict =
# |signed_prosusai - signed_tone| / 2 ∈ [0, 1] (0 = full agreement, 1 = maximal
# disagreement) — additive feature for the ML sentiment lane. Fail-soft: if the model isn't
# in the local HF cache (HF_HUB_OFFLINE=1 blocks Hub calls at runtime), scoring continues
# ProsusAI-only with NULL tone columns. One-time cache warm, WITHOUT the offline env:
#   python hf_pull_model.py yiyanghkust/finbert-tone
TONE_MODEL_NAME = "yiyanghkust/finbert-tone"
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
        print("[FinBERT] ERROR: transformers/torch not installed.", file=sys.stderr)
        print("  Run: pip install transformers torch sentencepiece", file=sys.stderr)
        sys.exit(1)


def load_tone_model():
    """Load yiyanghkust/finbert-tone. Returns (tokenizer, model) or None — fail-soft:
    a missing/uncached model must degrade the nightly job to ProsusAI-only, never kill it.

    Loads the BERT classes EXPLICITLY, not via Auto*: the repo's config.json predates the
    `model_type` convention (transformers 5.x rejects it — "Should have a model_type key"),
    and AutoTokenizer's legacy-config fallback then mis-routes into a sentencepiece/tiktoken
    conversion path. The snapshot is actually a plain BERT + vocab.txt (WordPiece), so
    BertConfig/BertTokenizer/BertForSequenceClassification load it cleanly, fully offline,
    with zero extra dependencies (live-verified 2026-09-11: 109,754,115 params)."""
    try:
        from transformers import (
            BertConfig,
            BertForSequenceClassification,
            BertTokenizer,
        )
        import torch
        config = BertConfig.from_pretrained(TONE_MODEL_NAME)
        tokenizer = BertTokenizer.from_pretrained(TONE_MODEL_NAME)
        model     = BertForSequenceClassification.from_pretrained(
            TONE_MODEL_NAME, config=config)
        model.eval()
        device = "cuda" if torch.cuda.is_available() else "cpu"
        model  = model.to(device)
        # The tone repo ships a LEGACY label order (neutral=0, positive=1, negative=2) that
        # differs from ProsusAI's — read it from the model's own config and pass it through
        # to fuse_tone(). If the config lacks a usable id2label, fail LOUD here rather than
        # silently writing negated tone_score/sentiment_conflict values.
        raw_id2label = getattr(config, "id2label", None)
        if not raw_id2label or set(raw_id2label.keys()) != {0, 1, 2}:
            print(f"[FinBERT-tone] Missing/unexpected id2label in config ({raw_id2label!r}) — "
                  f"refusing to guess label order; continuing ProsusAI-only.", file=sys.stderr)
            return None
        order = {int(k): str(v).lower() for k, v in raw_id2label.items()}
        if sorted(order.values()) != ["negative", "neutral", "positive"]:
            print(f"[FinBERT-tone] UNEXPECTED id2label labels {order} — "
                  f"refusing to score; continuing ProsusAI-only.", file=sys.stderr)
            return None
        print(f"[FinBERT-tone] Model loaded on {device} (label order: {order})")
        return tokenizer, model, order
    except Exception as e:
        print(f"[FinBERT-tone] Unavailable ({e.__class__.__name__}: {e}) — "
              f"continuing ProsusAI-only; tone columns will be NULL.", file=sys.stderr)
        return None


def fuse_tone(base: dict, tone_probs, order: dict | None = None) -> dict:
    """Merge one tone-model probability row (or None) into a ProsusAI result dict. Pure —
    no torch — so the conflict arithmetic is unit-testable without loading weights.
    `order` maps probability-index → label. DEFAULT is ProsusAI's order
    (positive=0, negative=1, neutral=2), but yiyanghkust/finbert-tone ships a DIFFERENT
    legacy order (neutral=0, positive=1, negative=2) — load_tone_model() reads the model's
    own config.id2label and passes the real one in; the in-loader guard refuses to score
    if the config can't be trusted. NEVER hardcode the tone order here."""
    if tone_probs is None:
        base.update({
            "tone_pos": None, "tone_neg": None, "tone_neu": None,
            "tone_label": None, "tone_score": None, "sentiment_conflict": None,
        })
        return base
    idx_of = {label: i for i, label in (order or {0: "positive", 1: "negative", 2: "neutral"}).items()}
    idx = max(range(len(tone_probs)), key=lambda i: tone_probs[i])
    # Label lookup MUST use the passed order, not a hardcoded map — the tone repo's
    # legacy order (neutral=0, positive=1, negative=2) differs from ProsusAI's, and a
    # hardcoded lookup silently labels a confident negative verdict "neutral" (caught
    # live 2026-09-11 on real headlines: bearish text scored −1.0 but labeled "neutral").
    tone_label  = (order or {0: "positive", 1: "negative", 2: "neutral"})[idx]
    tone_signed = float(tone_probs[idx_of["positive"]] - tone_probs[idx_of["negative"]])
    base.update({
        "tone_pos":   float(tone_probs[idx_of["positive"]]),
        "tone_neg":   float(tone_probs[idx_of["negative"]]),
        "tone_neu":   float(tone_probs[idx_of["neutral"]]),
        "tone_label": tone_label,
        "tone_score": tone_signed,
        # |gap| between the two signed scores, halved so [0, 1]: 0 = agree, 1 = maximally
        # disagree (one model's positive prob == the other's negative prob, both confident).
        "sentiment_conflict": abs(base["sentiment_score"] - tone_signed) / 2.0,
    })
    return base


def score_batch(texts: list[str], tokenizer, model, device, tone=None) -> list[dict]:
    """Score a batch of texts. Returns list of {positive, negative, neutral, label,
    confidence, sentiment_score, tone_*, sentiment_conflict}. `tone` is a
    (tokenizer, model, label_order) tuple from load_tone_model(), or None for
    ProsusAI-only."""
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

    tone_probs_all = None
    if tone is not None:
        t_tokenizer, t_model, t_order = tone
        t_inputs = t_tokenizer(
            texts, padding=True, truncation=True, max_length=MAX_LENGTH, return_tensors="pt",
        ).to(device)
        with torch.no_grad():
            t_logits = t_model(**t_inputs).logits
            tone_probs_all = torch.softmax(t_logits, dim=-1).cpu().numpy()

    # FinBERT label order (both models): positive=0, negative=1, neutral=2
    results = []
    for i, p in enumerate(probs):
        label_idx  = int(p.argmax())
        label_map  = {0: "positive", 1: "negative", 2: "neutral"}
        label      = label_map[label_idx]
        result = {
            "positive":   float(p[0]),
            "negative":   float(p[1]),
            "neutral":    float(p[2]),
            "label":      label,
            "confidence": float(p[label_idx]),
            # Signed score: positive probability - negative probability, range [-1, +1]
            "sentiment_score": float(p[0] - p[1]),
        }
        results.append(fuse_tone(
            result,
            tone_probs_all[i] if tone_probs_all is not None else None,
            order=t_order if tone_probs_all is not None else None,
        ))
    return results


def load_unscored_articles(conn: ConnWrapper, limit: int, days: int) -> list[dict]:
    """Load news_articles rows that have no finbert score yet."""
    cur = conn.cursor()

    where_clauses = [
        "a.id NOT IN (SELECT COALESCE(id,'') FROM news_sentiment_items WHERE source='finbert')"
    ]
    params: list = []

    if days > 0:
        # news_articles.timestamp is TIMESTAMPTZ on PG -> bind a datetime (rule #6);
        # keep the exact isoformat string on SQLite (TEXT column) to preserve behavior.
        cutoff_dt = datetime.datetime.now() - datetime.timedelta(days=days)
        where_clauses.append("a.timestamp >= ?")
        params.append(cutoff_dt if use_postgres() else cutoff_dt.isoformat())

    where = " AND ".join(where_clauses)
    limit_clause = f"LIMIT {limit}" if limit > 0 else ""

    cur.execute(f"""
        SELECT a.id, a.title, a.summary, a.symbols, a.timestamp
        FROM news_articles a
        WHERE {where}
        ORDER BY a.timestamp DESC
        {limit_clause}
    """, params)

    rows = cur.fetchall()
    return [
        {"id": r[0], "title": r[1] or "", "description": r[2] or "",
         "symbol": r[3] or "", "published_at": r[4]}  # keep None; "" can't cast to timestamptz on PG
        for r in rows
    ]


def upsert_sentiment(conn: ConnWrapper, records: list[dict]):
    """Write FinBERT scores to news_sentiment_items."""
    import json as _json
    now = datetime.datetime.now().isoformat()
    cur = conn.cursor()

    for r in records:
        # Map finbert label → DB sentiment
        label_map = {"positive": "BULLISH", "negative": "BEARISH", "neutral": "NEUTRAL"}
        sentiment = label_map.get(r["label"], "NEUTRAL")

        # Impact from confidence
        confidence = max(abs(r.get("sentiment_score", 0)), r.get("confidence", 0))
        impact = "HIGH" if confidence >= 0.80 else ("MEDIUM" if confidence >= 0.55 else "LOW")

        # symbols_json: news_articles.symbols is comma-separated NSE symbols
        raw_symbols = r.get("symbol", "")
        symbols = [s.strip() for s in raw_symbols.split(",") if s.strip()]
        symbols_json = _json.dumps(symbols)

        cur.execute("""
            INSERT INTO news_sentiment_items
                (id, title, source, source_type, published_at, fetched_at,
                 sentiment, sentiment_score, impact, symbols_json, ai_scored,
                 tone_pos, tone_neg, tone_neu, tone_label, tone_score, sentiment_conflict)
            VALUES (?, ?, 'finbert', 'AI', ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
                sentiment       = excluded.sentiment,
                sentiment_score = excluded.sentiment_score,
                impact          = excluded.impact,
                ai_scored       = 1,
                tone_pos           = excluded.tone_pos,
                tone_neg           = excluded.tone_neg,
                tone_neu           = excluded.tone_neu,
                tone_label         = excluded.tone_label,
                tone_score         = excluded.tone_score,
                sentiment_conflict = excluded.sentiment_conflict
        """, (
            str(r["id"]),
            r["title"][:500],
            r.get("published_at") or now,
            now,
            sentiment,
            r["sentiment_score"],
            impact,
            symbols_json,
            r.get("tone_pos"),
            r.get("tone_neg"),
            r.get("tone_neu"),
            r.get("tone_label"),
            r.get("tone_score"),
            r.get("sentiment_conflict"),
        ))

    conn.commit()


def run(limit: int = 500, days: int = 7, dry_run: bool = False):
    print(f"[FinBERT] Starting at {datetime.datetime.now()}")

    tokenizer, model, device = load_model()
    tone = load_tone_model()

    conn = connect()
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
                scores = score_batch(batch_texts, tokenizer, model, device, tone=tone)
                for art, score in zip(batch_arts, scores):
                    scored.append({**art, **score})
            except Exception as e:
                print(f"[FinBERT] Batch {batch_num} error: {e}", file=sys.stderr)
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

def to_polars_df(data):
    """Converts pandas DataFrame or list of dicts to Polars DataFrame for fast vector operations."""
    if hasattr(data, 'empty') and data.empty:
        return pl.DataFrame()
    return pl.from_pandas(data) if hasattr(data, 'to_numpy') else pl.DataFrame(data)
