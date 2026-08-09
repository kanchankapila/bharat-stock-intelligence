-- Persist the 3 remaining unified_ranker.py engine scores (cs, breakout, smart_money) onto
-- unified_recommendations, alongside the 5 already there (screener/ml/confluence/technical/dl).
-- Closes the set of 8 engines so factor_edge.py can measure live forward-return edge per engine,
-- the same way it already validates third-party scores like Trendlyne's m_score.
ALTER TABLE "unified_recommendations" ADD COLUMN IF NOT EXISTS "cs_score" DOUBLE PRECISION;
ALTER TABLE "unified_recommendations" ADD COLUMN IF NOT EXISTS "breakout_score" DOUBLE PRECISION;
ALTER TABLE "unified_recommendations" ADD COLUMN IF NOT EXISTS "smart_money_score" DOUBLE PRECISION;
