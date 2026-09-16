ALTER TABLE "unified_recommendations"
    ADD COLUMN IF NOT EXISTS "est_cost_bps" DOUBLE PRECISION;

-- 20260909130000_unified-recommendations-est-cost-bps.sql
-- Schema-of-record companion for the unified_ranker cost-aware sizing work (reviewed
-- 2026-09-09): the ranker applies apply_cost_penalty() to raw position sizes before
-- normalization; this column is reserved so per-recommendation realized cost can be stamped
-- alongside position_size_pct (writers are a follow-up -- nothing populates it yet, which is
-- why there is deliberately no runtime safe_alter for it). Nullable, additive.
-- ONE statement per file: the sql-file runner's first-statement-only history.
