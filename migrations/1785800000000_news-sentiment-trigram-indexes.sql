-- Up Migration
--
-- Perf audit 2026-08-02 (DB audit finding #7). misc.router.ts's getAIAnalysis does
-- `WHERE symbols_json LIKE '%"SYMBOL"%'` and `WHERE title LIKE '%keyword%'` against
-- news_sentiment_items -- both leading-wildcard patterns, which a standard btree index cannot
-- serve at all (idx_nsi_published/idx_nsi_sentiment/idx_nsi_category/idx_nsi_fetched cover
-- none of this), forcing a sequential scan on every call.
--
-- pg_trgm's GIN trigram index is the standard Postgres answer for arbitrary-substring LIKE
-- queries -- purely additive (no query rewrite needed, the planner picks it up automatically),
-- and Postgres-only by design: this migration only runs via `npm run migrate:up` against
-- POSTGRES_URL, same as every other migration in this repo, so the SQLite dev fallback (which
-- has no equivalent and doesn't need one at its scale) is unaffected either way.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS idx_nsi_symbols_json_trgm
  ON news_sentiment_items USING GIN (symbols_json gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_nsi_title_trgm
  ON news_sentiment_items USING GIN (title gin_trgm_ops);

-- Down Migration
DROP INDEX IF EXISTS idx_nsi_symbols_json_trgm;
DROP INDEX IF EXISTS idx_nsi_title_trgm;
