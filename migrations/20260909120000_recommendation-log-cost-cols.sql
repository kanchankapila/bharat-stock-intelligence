ALTER TABLE "recommendation_log"
    ADD COLUMN IF NOT EXISTS "round_trip_cost_pct" DOUBLE PRECISION,
    ADD COLUMN IF NOT EXISTS "cost_adjusted_target_1" DOUBLE PRECISION;

-- 20260909120000_recommendation-log-cost-cols.sql
-- Cost-aware recommendation tracking (concurrent-session ML accuracy work, reviewed and
-- wired 2026-09-09). scoring_engine._log_recommendations now stamps every BUY/STRONG_BUY
-- with the symbol's modelled round-trip cost (STT + exchange fees + stamp duty + GST +
-- brokerage + liquidity-scaled slippage, via indian_market_costs.round_trip_cost_bps) and
-- target_1 net of that cost -- algebraically target_1 - round_trip_cost_pct * entry_price.
-- Nullable, additive: existing rows read back NULL.
-- ONE statement per file on purpose: node-pg-migrate's sql-file runner has a documented
-- history of silently executing only a file's first statement (measurement.md, 2026-08-25).
-- Runtime parity for dev boxes/throwaway schemas: scoring_engine._ensure_cost_columns().
