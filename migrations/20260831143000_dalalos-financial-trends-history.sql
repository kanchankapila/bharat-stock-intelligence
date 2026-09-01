-- Up Migration
--
-- One-time historical backfill, NOT a live-refreshed fetcher target. `historical_fundamentals`
-- and `fundamentals_history` were checked live 2026-08-31 and found to hold no genuine
-- multi-quarter time series at all: despite ~35-46 "distinct dates" since 2026-06-30, the
-- underlying values (eps_ttm, revenue_growth, net_margin) are the same 3-4 quarterly snapshots
-- re-stamped daily -- see measurement.md's "Not testable" fundamentals row, which is accurate
-- for those two tables but was previously assumed (wrongly) to also describe shareholding,
-- which marketsmojo_shareholding_history already covers back to 2018.
--
-- This table holds real per-quarter revenue/EPS/margin/growth history sourced from DalalOS's
-- MCP `get_financial_trends` tool (github: dalalos, third-party, MCP-only -- its REST surface
-- returned 403 "surface_not_in_plan" when tested live 2026-08-31, so there is no callable HTTP
-- endpoint for a scheduled job to hit). Populated by a Claude session manually driving the MCP
-- tool and writing results through dalalos_financial_trends_backfill.py's own write function --
-- see that script's module docstring for the exact provenance and how to extend coverage.
--
-- Single provider, so no (source, id) composite-key concern (data-sources.md's composite-key
-- rule applies when >1 provider can independently produce a row for the same key -- nothing
-- else writes this table).

CREATE TABLE IF NOT EXISTS dalalos_financial_trends_history (
  symbol               TEXT        NOT NULL,
  period_end           DATE        NOT NULL,
  period_type          TEXT        NOT NULL DEFAULT 'quarterly',
  fiscal_label          TEXT,
  isin                 TEXT,
  statement_type       TEXT,
  revenue              NUMERIC,
  revenue_basis        TEXT,
  net_income           NUMERIC,
  eps                  NUMERIC,
  ebitda_margin        NUMERIC,
  net_margin           NUMERIC,
  net_margin_delta     NUMERIC,
  qoq_revenue_growth   NUMERIC,
  qoq_net_income_growth NUMERIC,
  yoy_revenue_growth   NUMERIC,
  revenue_cagr         NUMERIC,
  net_income_cagr      NUMERIC,
  source               TEXT        NOT NULL DEFAULT 'dalalos-mcp',
  fetched_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (symbol, period_end, period_type)
);

CREATE INDEX IF NOT EXISTS idx_dalalos_financial_trends_symbol
  ON dalalos_financial_trends_history (symbol);

COMMENT ON TABLE dalalos_financial_trends_history IS
  'Real quarterly revenue/EPS/margin/growth history per NSE symbol, sourced from DalalOS''s MCP '
  'get_financial_trends tool. Added 2026-08-31 as a one-time manual backfill (no REST endpoint '
  'exists for a scheduled fetcher -- MCP-only, plan-gated). NOT auto-refreshed: no freshness '
  'check registered in dataQualityChecks.ts on purpose, since nothing re-populates this table on '
  'a schedule -- see dalalos_financial_trends_backfill.py for how to extend coverage manually. '
  'Genuinely new capability, not a duplicate: historical_fundamentals/fundamentals_history hold '
  'no real multi-quarter series (checked live 2026-08-31, see this migration''s own comment). Do '
  'NOT wire into unified_ranker.py/scoring_engine.py/factor_backtest.py/multi_factor_scorer.py/ '
  'institutional_quant_engine.py/quantScoringService.ts without a factor_backtest.py run first, '
  'per data-sources.md''s vendor-onboarding freeze and measurement.md''s standing rule.';

-- Down Migration
DROP TABLE IF EXISTS dalalos_financial_trends_history;
