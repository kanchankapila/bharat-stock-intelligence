import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 2026-09-14 coverage-gate test - automated counterpart of the audit-loop skill's
 * "uncovered table is a blind spot" maxim (audit-loop/SKILL.md section 0).
 *
 * Asserts every public CREATE TABLE in db/schema.postgres.sql is either covered by
 * TABLE_FRESHNESS_CHECKS / MONITOR_SCRIPTS / monitor.router.ts getLastRunAt, or
 * documented in EXCLUDED_TABLES below with a reason.
 */

function load(p: string): string {
  return readFileSync(join(__dirname, '..', p), 'utf8');
}

const dqSrc = load('dataQualityChecks.ts');
const monSrc = load('monitorScripts.ts');
const routerSrc = load('routers/monitor.router.ts');
const hbSrc = load('jobHeartbeat.ts');
const wdSrc = load('jobWatchdog.ts');
const mon = dqSrc + '\n' + monSrc + '\n' + routerSrc + '\n' + hbSrc + '\n' + wdSrc;

const covered = new Set<string>();

// TABLE_FRESHNESS_CHECKS table fields.
for (const m of dqSrc.matchAll(/table:\s*'([^']+)'/g)) covered.add(m[1].toLowerCase());

const schemaSrc = load('../../db/schema.postgres.sql');
const schemaTables = new Set<string>();
for (const m of schemaSrc.matchAll(/CREATE TABLE(?:\s+IF NOT EXISTS)?\s+(?:\w+\.)?["']?([A-Za-z_][A-Za-z0-9_]*)/g)) {
  const t = m[1].toLowerCase();
  if (t === 'if') continue;
  schemaTables.add(t);
}
schemaTables.delete('if');

// Sweep all five monitoring files for any schema-table identifier anywhere. Tokenize the
// monitoring text into word-runs and membership-test each schema table against the set.
const tokens = new Set<string>();
for (const m of mon.matchAll(/[A-Za-z_][A-Za-z0-9_]*/g)) tokens.add(m[0].toLowerCase());
for (const t of schemaTables) { if (tokens.has(t)) covered.add(t); }

// Documented exclusions. Each entry MUST carry a reason.
const EXCLUDED_TABLES: Record<string, string> = {
  // Entered the snapshot on 2026-09-17 when AF-20260917-18's regen absorbed it, and this gate
  // correctly caught it the same run. It is url_explorer catalog bookkeeping written by
  // store.py -- internal tool state, not a market datasource -- so it takes an exclusion for
  // the same reason as its five url_* siblings below, not a freshness check.
  screener_instances: 'url_explorer tool store (store.py)',
  url_endpoints: 'url_explorer tool store (store.py)',
  url_fields: 'url_explorer tool store (store.py)',
  url_params: 'url_explorer tool store (store.py)',
  url_fetches: 'url_explorer tool store (store.py)',
  url_field_correlations: 'url_explorer tool store (store.py)',
  ai_endpoint_registry: 'url_explorer endpoint_registry.py tool store',
  provider_score_consistency_audit: 'reverse-engineering study tool table',
  _migrations: 'node-pg-migrate bookkeeping table',
  job_sweep_results: 'dev/runJobSweep.ts artifact',
  data_ingestion_dlq: 'DLQ queue table; monitored by inspect_ingestion_health MCP count, not freshness',
  todos: 'user-managed todo table',
  users: 'auth/user table',
  watchlist: 'user-managed watchlist',
  price_alerts: 'user-configured price alerts',
  portfolio_holdings: 'user portfolio positions',
  trade_journal: 'user trade journal',
  mf_portfolio_holdings: 'user MF portfolio tracker',
  etnow_screeners: 'per-provider screener catalog (proxied by screener_catalog check)',
  etnow_screener_stocks: 'per-provider screener membership (proxied by screener_appearances check)',
  moneycontrol_screeners: 'per-provider screener catalog (proxied by screener_catalog check)',
  moneycontrol_screener_stocks: 'per-provider screener membership (proxied by screener_appearances check)',
  et_marketstats_screeners: 'per-provider screener catalog (proxied by screener_catalog check)',
  et_marketstats_screener_stocks: 'per-provider screener membership (proxied by screener_appearances check)',
  trendlyne_screeners: 'per-provider screener catalog (proxied by screener_catalog check)',
  trendlyne_screener_stocks: 'per-provider screener membership (proxied by screener_appearances check)',
  mc_scid_map: 'MoneyControl scid->symbol provider map; refreshed by sync jobs (write-time heartbeat)',
  index_provider_map: 'index->provider id map; reference, refreshed by sync jobs',
  nt_fno_expiry: 'NiftyTrader FNO expiry calendar reference',
  stock_master: 'legacy provider-id master (nse_stocks is the canonical, checked master)',
  et_mf_universe: 'ET mutual-fund universe reference (small slow-changing ref)',
  technical_composite_scores: 'TS composite score output; derived',
  technical_scans: 'TS technical scan output; derived',
  timeframe_scores: 'legacy scoring table; no active writer',
  factor_edge_history: 'factor_edge.py research backtest log; derived',
  feature_importance_log: 'ML feature importance bookkeeping; derived',
  signal_portfolio_correlation: 'correlationService.ts research output; derived',
  signal_type_stats_history: 'weight-history bookkeeping (excluded by policy)',
  signal_type_weights_history: 'weight-history bookkeeping (excluded by policy)',
  stock_factor_breakdown: 'scoring_engine.py factor breakdown output; derived',
  stock_factor_breakdown_history: 'factor_breakdown_snapshot.py history; derived',
  unified_recommendations_history: 'unified_ranker.py ranking history snapshot; derived',
  recommendation_log: 'ml_ensemble/outcome_resolver action log; derived',
  early_hours_predictions: 'early_hours_predictor.py DL prediction output; derived (DL output)',
  intraday_recommendations_history: 'intraday_ranker.py output history; derived',
  intraday_recommendation_outcomes: 'intraday_outcome_resolver.py resolved outcomes; derived',
  intraday_regime_history: 'intraday_regime.py regime history; derived',
  intraday_strategy_lifts: 'intraday_strategy_learner.py strategy output; derived',
  high_flyer_candidates: 'high_flyer_retrospective.py research output; derived',
  high_flyer_daily_stats: 'high_flyer_retrospective.py research output; derived',
  high_flyer_retrospective: 'high_flyer_retrospective.py research output; derived',
  finstack_cashflow_checked: 'finstack_cashflow_fetcher.py write-validation scratch; internal',
  marketsmojo_financials_checked: 'marketsmojo_financials_fetcher.py staleness-skip scratch; internal',
  ohlcv_adjustment_factors: 'corporate-actions adjustment-factor scratch; internal',
  ohlcv_corporate_actions_checked: 'ohlcv_quality.py corporate-action validation scratch; internal',
  mf_scheme_sector_allocation: 'mf_sector_allocation_fetcher.py scheme-level scratch; internal',
  mf_holdings_no_coverage: 'mf_holdings_fetcher.py diagnostic scratch; internal',
  daily_research_reports: 'researchEngine.ts daily report output; research',
  agent_audit_reports: 'auditor agent report output; research',
  agent_data_scientist_reports: 'data-scientist agent report output; research',
  agent_optimizer_reports: 'optimizer agent report output; research',
  agent_strategy_picks: 'strategist agent pick output; research',
  mover_study_results: 'reverse_engineering_study.py research output; research',
  dalalos_financial_trends_history: 'backfill_financial_trends_all.py research backfill; research',
  trendlyne_checklist: 'trendlyneChecklistCycle.ts checklist cycle state; research',
  trendlyne_screener_pk_history: 'trendlyne_screener_discovery.py screener-discovery log; research',
  trendlyne_technical_snapshots: 'technicalIntelligenceService.ts Trendlyne snapshot; derived',
  screener_history_log: 'per-provider screener sync run log; app log',
  screener_runs: 'screener run records; app log',
  backtest_strategies: 'backtest strategy config storage; app state',
  news_symbol_link: 'data_integrity_repair.py news-symbol linking scratch; internal',
  order_book_snapshots: '0 rows, no active writer; effectively retired',
  tick_data: '0 rows, no active writer; effectively retired',
  screener_performance_history: 'screener_performance.py performance-calculation history log; app log',
  screener_reliability: 'screener reliability score history (screener_performance.py); app log',
};

describe('table-coverage gate: exclusion map', () => {
  it('every excluded entry names a real public schema table', () => {
    const bogus = Object.keys(EXCLUDED_TABLES).filter(t => !schemaTables.has(t));
    expect(bogus, `EXCLUDED_TABLES references tables not in db/schema.postgres.sql: ${bogus.join(', ')}`).toEqual([]);
  });
});

describe('table-coverage gate: every schema table is monitored or documented', () => {
  it('no public schema table is left uncovered', () => {
    const uncovered: string[] = [];
    for (const t of schemaTables) {
      if (covered.has(t)) continue;
      if (EXCLUDED_TABLES[t]) continue;
      uncovered.push(t);
    }
    uncovered.sort();
    expect(uncovered, `Uncovered schema tables (add a freshness check or documented exclusion):\n  - ${uncovered.join('\n  - ')}`).toEqual([]);
  });

  it('covered-set is non-trivial', () => {
    expect(covered.size).toBeGreaterThan(150);
  });

  it('exclusion map covers the expected tail', () => {
    expect(Object.keys(EXCLUDED_TABLES).length).toBeGreaterThan(55);
    expect(Object.keys(EXCLUDED_TABLES).length).toBeLessThan(90);
  });
});
