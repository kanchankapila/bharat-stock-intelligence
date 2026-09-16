ALTER TABLE "news_sentiment_items"
    ADD COLUMN IF NOT EXISTS "tone_pos" DOUBLE PRECISION,
    ADD COLUMN IF NOT EXISTS "tone_neg" DOUBLE PRECISION,
    ADD COLUMN IF NOT EXISTS "tone_neu" DOUBLE PRECISION,
    ADD COLUMN IF NOT EXISTS "tone_label" TEXT,
    ADD COLUMN IF NOT EXISTS "tone_score" DOUBLE PRECISION,
    ADD COLUMN IF NOT EXISTS "sentiment_conflict" DOUBLE PRECISION;

-- 20260911100000_news-sentiment-items-tone-cols.sql
-- Second sentiment engine (yiyanghkust/finbert-tone) alongside ProsusAI/finbert in
-- finbert_scorer.py: independently-trained finance BERT exposes single-model bias.
-- tone_* columns carry the tone model's own verdict; sentiment_conflict =
-- |signed_prosusai - signed_tone| / 2 ∈ [0,1] (0 = agreement, 1 = maximal
-- disagreement) — additive feature for the ML sentiment lane. Fail-soft: rows scored
-- before the tone cache is warmed read back NULL. Nullable, additive.
-- ONE statement per file on purpose: node-pg-migrate's sql-file runner has a documented
-- history of silently executing only a file's first statement (measurement.md, 2026-08-25).
-- Runtime parity: pgClient.ts ensure-alter array carries the same six columns.