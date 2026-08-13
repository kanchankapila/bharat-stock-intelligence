#!/usr/bin/env python3
"""Batch FinBERT sentiment for news_sentiment_items' AI-enrichment step.

REPLACES the Anthropic call in newsSentimentService.ts's enrichWithAI() (2026-08-13):
ANTHROPIC_API_KEY has been empty since inception, so that path never ran (11,384 HIGH-impact
items stuck at ai_scored=0 and growing; found via a fetcher-accuracy-review sweep). This uses
nlp_engine.py's existing FinBERTInference (ProsusAI/finbert, ~440MB, already loaded elsewhere
in this codebase for screener sentiment) instead of adding a paid API dependency or an Ollama
model too large for this box's available RAM (23GB total, ~1GB free measured live 2026-08-13).

Only sentiment/score are re-derived here, NOT impact -- FinBERT is a sentiment classifier, it
has no basis for judging news impact, and the caller only ever passes items already filtered
to impact='HIGH' by the keyword baseline (scoreSentiment() in newsSentimentService.ts), so
impact is passed straight through unchanged rather than asked of a model that can't answer it.

Usage:
    python finbert_news_sentiment.py <base64-json>
    # base64-json decodes to [{"id": "...", "title": "...", "summary": "..."}, ...]
    # base64 (not a raw JSON arg) sidesteps shell-escaping headaches with quotes/unicode
    # (₹, apostrophes) that real headlines routinely contain.
    # Prints JSON to stdout: [{"id": "...", "sentiment": "BULLISH|BEARISH|NEUTRAL", "score": -1.0..1.0}, ...]
"""
import base64
import json
import sys

from nlp_engine import FinBERTInference

SENTIMENT_MAP = {"bullish": "BULLISH", "bearish": "BEARISH", "neutral": "NEUTRAL"}


def score_batch(items: list[dict]) -> list[dict]:
    finbert = FinBERTInference()
    out = []
    for item in items:
        text = f"{item.get('title', '')}. {item.get('summary', '') or ''}"[:1500]
        result = finbert.predict(text)
        sentiment = SENTIMENT_MAP.get(result["sentiment"], "NEUTRAL")
        # Signed score matching scoreSentiment()'s existing convention (-1..1): FinBERT's
        # `score` is an unsigned confidence in the predicted label, sign it by direction.
        signed = result["score"] if sentiment == "BULLISH" else (
            -result["score"] if sentiment == "BEARISH" else 0.0
        )
        out.append({"id": item["id"], "sentiment": sentiment, "score": round(signed, 4)})
    return out


if __name__ == "__main__":
    payload = json.loads(base64.b64decode(sys.argv[1]).decode("utf-8"))
    print(json.dumps(score_batch(payload)))
