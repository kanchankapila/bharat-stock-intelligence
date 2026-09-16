---
name: bharat-backtest-runner
description: "Run parameterized backtests with measurement.md gates for Bharat Stock Intelligence."
version: 1.0.0
author: Bharat Stock Intelligence
license: MIT
metadata:
  hermes:
    tags: [bharat, backtest, measurement, validation, factor]
    created_by: "agent"
---

# Bharat Backtest Runner Skill

Run rigorous backtests following measurement.md discipline: negative-control tests, out-of-sample validation, and promotion gates.

## When to Use

- Testing a new factor/signal before adding to unified_ranker
- Validating weight changes in scoring engines
- Running walk-forward optimization via AlphaQuant
- Measuring forward-return edge of any signal

## Tools Available

- MCP: `bharat-intelligence` tools for data access
- AlphaQuant API (port 8002): `/backtest`, `/walkforward`, `/optimize`
- Python: `factor_backtest.py`, `factor_edge.py`, `reverse_engineering_study.py`

## Measurement.md Discipline (MANDATORY)

**Before ANY backtest claim:**
1. **Negative control**: Revert change → test fails → restore → test passes
2. **Out-of-sample**: Train/val/test split with embargo periods
3. **Purged K-fold**: No look-ahead leakage (use `factor_backtest.py --purged`)
4. **Multiple testing correction**: Bonferroni/Benjamini-Hochberg
5. **Transaction costs**: Include slippage, brokerage, STT, impact
6. **Regime stability**: Test across bull/bear/sideways markets

## Procedures

### 1. Factor Backtest (Standard)
```bash
# Via Hermes chat
"Run factor backtest for value_book_to_price with purged k-fold, 5-year lookback, include costs"
```
Maps to:
```python
python factor_backtest.py --factor value_book_to_price --purged --start 2020-01-01 --top-k 50 --costs
```

### 2. Signal Backtest (Technical/AI)
```bash
"Backtest AI signal BUY/SELL with 1% slippage, 5-day horizon, regime-stratified"
```

### 3. Walk-Forward Optimization
```bash
"Run walk-forward optimize for unified_ranker weights, 2020-2024, monthly rebalance"
```
Calls AlphaQuant API: `POST /walkforward`

### 4. Reverse Engineering Study
```bash
"Run reverse engineering on mover_snapshots to find precursors to 5%+ moves"
```
Runs `reverse_engineering_study.py` on ground-truth mover data.

## Promotion Gates (from ml-model-bugs.md)

| Gate | Threshold | Measured On |
|------|-----------|-------------|
| IC (Information Coefficient) | > 0.02 (5d), > 0.03 (21d) | Purged OOF |
| AUC (Directional) | > 0.55 | Purged OOF |
| Sharpe (Net) | > 1.0 | Walk-forward |
| Max Drawdown | < 20% | Full period |
| Turnover | < 100%/month | Live sim |
| Stability | IC sign consistent across regimes | Regime-stratified |

**No factor enters unified_ranker without passing ALL gates.**

## Common Commands via Hermes

```bash
# Quick factor check
"Check IC for momentum_12_1 over last 2 years purged"

# Full validation pipeline
"Validate breakout_classifier: run factor_edge.py, check AUC, if >0.55 run walkforward"

# Weight optimization
"Optimize unified_ranker REGIME_WEIGHTS for LOW_VOL regime using last 3 years"

# Emergency: revert and test
"Revert last weight change, run negative control test on unified_score"
```

## Data Sources for Backtests

| Table | Purpose | Freshness |
|-------|---------|-----------|
| `stock_ohlcv` | Price/volume history | Daily EOD |
| `technical_signals` | Features + labels | Daily |
| `unified_signals` | Signal history | Intraday |
| `signal_outcomes` | Resolved labels | T+1/T+5/T+15 |
| `mover_snapshots` | Ground truth movers | Intraday |
| `quant_scores_history` | Factor values PIT | Daily |

## Risk: Common Pitfalls

1. **Using `technical_signals` without date filter** → look-ahead leak
2. **Not purging embargo periods** → contaminated OOF
3. **Ignoring transaction costs** → inflated Sharpe
4. **Single-regime testing** → fails in regime change
5. **No negative control** → false confidence

## Integration

- Cron job `agent-data-scientist-weekly` runs autonomous research
- Desktop plugin has "Run Backtest" quick action
- Webhook from GitHub PR can trigger backtest on factor changes