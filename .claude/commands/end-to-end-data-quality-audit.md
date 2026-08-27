---
description: End-to-end data quality audit and validation protocol — verifies fresh data ingestion across all sources, enforces zero-spike and value invariants, validates ML model baselines, and ensures zero recurrence of historical bug classes.
---

# End-to-End Data Quality Audit Protocol

This audit provides a comprehensive end-to-end verification of all data pipelines, fetchers, tables, models, and schedules across the platform.

## 1. Data Ingestion & Source Freshness Verification

Verify that all external data sources (MoneyControl, Trendlyne, NiftyTrader, ETNow, StockEdge, MarketsMojo, GDELT, BSE, RSS feeds, F&O options, stock futures OI, pre-open IEP, market breadth, analyst forecasts, etc.) are actively fetching fresh data into PostgreSQL:

```bash
# Run the 168+ Data Quality check suite across all ingested tables & models
npm run dq:check
```

### Key Table Freshness Invariants:
- `stock_ohlcv` & `nse_universe_history`: Fresh daily bars for all 2,400+ active NSE symbols.
- `technical_signals`: 100% win_probability coverage, valid RSI range (0-100), no stuck signal_score defaults.
- `stock_futures_oi_history`: Fresh per-stock futures OI, buildup, basis, and rollover metrics.
- `stock_options_oi`: Fresh option chain snapshots with valid ATM implied volatility (IV).
- `quant_scores` & `stock_scores`: Scored rows populated for all universe symbols.
- `unified_recommendations`: Canonical ranker output updated daily, writing NULL (not `0.0`) when an engine does not score a symbol.

---

## 2. Model Baseline & Registry Audit

Verify that active models exist for **all six machine-learning engines** in `model_registry`:
1. `ensemble` (Stacking GB+RF+ET+LR ensemble)
2. `cs_ranker` (Cross-sectional ranker)
3. `exit_policy` (MFE/MAE exit regressor)
4. `confluence_ml` (Confluence ML engine)
5. `online_sgd` (Online SGD incremental learner)
6. `BiLSTM` (Deep Learning sequence model)

```bash
# Verify active models in PostgreSQL model_registry
python -c "from db_compat import connect; conn=connect(); rows=conn.execute(\"SELECT model_name, model_version, is_active, trained_at FROM model_registry WHERE is_active = 1\").fetchall(); print(rows)"
```

---

## 3. Recurring Bug Class Enforcement

Ensure no historical bug class has recurred:
- **Zero-Spike Scores**: No score engine writes `0.0` for missing scores (must write `NULL` to avoid re-spreading noise in rank normalization).
- **Case Collision**: No `signal_source` values differ only by case (`technical` vs `Technical`).
- **Date Anchors**: Write targets use `as_of.logical_trading_date()`, avoiding `date.today()` post-midnight boundary bugs.
- **Short Lookbacks**: Lookbacks over trading-day tables use `as_of.trading_days_back()`, preventing Monday-morning empty read drops.
- **Unvarying Verdicts**: Ensure DQ checks have active, meaningful pass/fail thresholds.

```bash
# Enforce automated recurring bug patterns
python scripts/check_recurring_bugs.py src/server/backtest_optimizer.py src/server/queues.ts
```

---

## 4. Schedule Mirror Consistency Verification

Verify that all cron schedules across `queues.ts`, `jobRegistry.ts`, `monitorScripts.ts`, `ecosystem.config.cjs`, and `jobs/*.jobs.ts` are 100% synchronized:

```bash
# Run the 5 schedule mirror consistency suites (248 tests)
npx vitest run src/server/__tests__/jobRegistryCronMirror.test.ts src/server/__tests__/monitorScriptsCronMirror.test.ts src/server/__tests__/jobRegistryVsMonitorScripts.test.ts src/server/__tests__/jobRegistryGraceMinutesConsistency.test.ts src/server/__tests__/monitorScriptsStaleLimitConsistency.test.ts
```

---

## 5. PM2 Services & Port Health

Verify process uptime, port bindings, and deployment drift:

```bash
# Confirm PM2 services own expected ports with zero orphan processes
node scripts/check_port_drift.mjs

# Confirm PM2 services are running latest commit HEAD
node scripts/check_deploy_drift.mjs
```
