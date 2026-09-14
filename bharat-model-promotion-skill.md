---
name: bharat-model-promotion
description: "Enforce ML model promotion gates per ml-model-bugs.md for Bharat Stock Intelligence."
version: 1.0.0
author: Bharat Stock Intelligence
license: MIT
metadata:
  hermes:
    tags: [bharat, ml, promotion, gate, model, validation]
    created_by: "agent"
---

# Bharat Model Promotion Skill

Enforce the promotion gates from `.claude/rules/ml-model-bugs.md` before any model enters production scoring.

## When to Use

- Before promoting a new `ml_ensemble` model to `model_registry`
- Before updating `breakout_classifier`, `movement_predictor`, `exit_policy`
- Before changing `unified_ranker` REGIME_WEIGHTS
- Weekly cron job `ml-weekly-retrain` completion validation

## Promotion Gates (MANDATORY)

### 1. Purged OOF Cross-Validation
- Use `factor_backtest.py --purged --kfold 5 --embargo 10`
- No look-ahead: train on t-embargo, test on t
- Must beat: IC > 0.02 (5d), IC > 0.03 (21d), AUC > 0.55

### 2. Walk-Forward Validation
- Monthly rebalance simulation via AlphaQuant
- Full transaction costs (slippage + brokerage + STT + impact)
- Minimum 3 years, 36+ rebalances
- Net Sharpe > 1.0, Max DD < 20%

### 3. Regime Stability
- Stratify by regime (HIGH_VOL, LOW_VOL, TRENDING, MEAN_REVERTING)
- IC sign must be consistent across ≥3 regimes
- No single regime driving all performance

### 4. Live Paper Trading (2 weeks minimum)
- Deploy to paper portfolio via `intraday_ranker.py` / `unified_ranker.py`
- Track: hit rate, avg win/loss, turnover, slippage vs backtest
- Paper Sharpe must be within 20% of backtest Sharpe

### 5. Negative Control
- Revert model → backtest fails → restore → backtest passes
- Proves the model, not data leakage, drives performance

## Model Registry Protocol

### `model_registry` Table Schema
```sql
model_name        -- e.g. 'ml_ensemble', 'breakout_classifier'
version           -- ISO timestamp or semver
status            -- 'candidate' | 'promoted' | 'deactivated' | 'archived'
metrics_json      -- {ic_5d, ic_21d, auc, sharpe, max_dd, regimes, paper_sharpe}
promoted_at       -- timestamp
promoted_by       -- 'agent' | 'user' | 'cron'
gate_results      -- JSON of each gate pass/fail
```

### Promotion Flow
```
1. Weekly retrain produces new pickle (candidate)
2. Run promotion gates (this skill)
3. If ALL pass: INSERT into model_registry as 'promoted'
4. If ANY fail: INSERT as 'candidate' with failure reasons
5. scoring_engine.py reads ONLY 'promoted' models
6. Old 'promoted' → 'archived' (keep for rollback)
```

## Blocked Models (Per measurement.md)

These models have **NO demonstrated edge** and must NOT be promoted:
- `online_learner` (SGD) — AUC 0.5017, removed from schedule 2026-08-31
- `cs_ranker` — AUC 0.176, weight zeroed in REGIME_WEIGHTS
- `rl_agent` (Q-learning) — zero edge, removed 2026-08-31
- `pead_model` — IC 0.026-0.029, AUC 0.505-0.521, retired 2026-08-20

**Do not re-add without full re-validation.**

## Current Production Models (as of 2026-09-11)

| Model | Status | Last Promoted | Key Metrics |
|-------|--------|---------------|-------------|
| `ml_ensemble` (LGBM) | promoted | weekly | IC~0.035, AUC~0.58, Sharpe~1.2 |
| `breakout_classifier` | promoted | daily | AUC~0.73 (purged), advisory only |
| `movement_predictor` | promoted | daily | AUC~0.76, advisory only |
| `exit_policy` | promoted | weekly | Calibrated win_prob |
| `intraday_strategy_learner` | promoted | daily | Blend weights |

## Procedures

### 1. Validate Weekly Retrain Output
```bash
# After ml-weekly-retrain cron completes
"Validate ml_ensemble promotion: run purged OOF, walkforward, regime check"
```

### 2. Emergency Rollback
```bash
"Rollback ml_ensemble to previous version: deactivate current, promote archived"
```
```sql
UPDATE model_registry SET status='archived' WHERE model_name='ml_ensemble' AND status='promoted';
UPDATE model_registry SET status='promoted' WHERE model_name='ml_ensemble' AND version='<prev>';
```

### 3. Weight Change Validation
```bash
"Test unified_ranker weight change: REGIME_WEIGHTS.LOW_VOL.ml_ensemble 0.45->0.50"
```
1. Run negative control (revert → test)
2. Run walk-forward with new weights
3. Check regime stability
4. Paper trade 1 week
5. Promote if all gates pass

### 4. New Factor Integration
```bash
"Integrate new factor X into unified_ranker: run factor_edge.py, then backtest, then gate"
```
1. `factor_edge.py --factor X --purged` → must pass IC/AUC
2. `factor_backtest.py --factor X --costs` → must pass Sharpe/DD
3. Add to `unified_ranker.py` FEATURE_MAP with weight 0.0
4. Optimize weight via AlphaQuant walkforward
5. Full promotion gates

## Cron Integration

The `ml-weekly-retrain` cron job (Sunday 1:30 AM IST) should:
1. Complete retrain
2. Call this skill's validation
3. Only promote if all gates pass
4. Alert on failure (don't auto-promote)

## Commands via Hermes

```bash
"Validate ml_ensemble candidate from last night's retrain"
"Check promotion gates for breakout_classifier"
"Rollback ml_ensemble to version 2026-09-04"
"Show model_registry status for all models"
"Run negative control test on unified_ranker weight change"
"Paper trade results for movement_predictor last 2 weeks"
```

## Risks

- **Assumption**: AlphaQuant API (port 8002) is running and accessible
- **Assumption**: `model_registry` table exists with correct schema
- **Calendar-blocked**: Paper trading gate needs 2 weeks elapsed time
- **EVIDENCE-lane**: Any gate failure requires measurement evidence before override