#!/bin/bash
# Initialize Hermes Kanban board for Bharat Quant Research Workflow
# Run after: hermes setup && hermes gateway run

set -e

HERMES="hermes"
WORKDIR="D:/Github/bharat-stock-intelligence"

echo "🎯 Initializing Bharat Quant Research Kanban Board..."

# Create board
$HERMES kanban init --board "bharat-quant-research" --workdir "$WORKDIR" --description "
Bharat Stock Intelligence Autonomous Research Pipeline

Columns:
1. 📊 candidate-factors  → Data Scientist discovers cross-sectional anomalies
2. 🔬 validation-gate    → Auditor applies measurement.md gates (negative control, purged OOF, regime stability)
3. ✅ approved-factors   → Passed all gates, ready for portfolio simulation
4. 📈 portfolio-test     → Strategist runs portfolio backtests with transaction costs
5. ⚙️ weight-optimization → Optimizer adjusts REGIME_WEIGHTS in unified_ranker
6. 🚀 production-ready   → Promoted to model_registry, monitoring enabled

Agents:
- data-scientist  (runs agents/data_scientist_agent.py)
- auditor         (runs agents/auditor_agent.py)
- strategist      (runs agents/strategist_agent.py)
- optimizer       (runs agents/optimizer_agent.py)
"

# Create column cards
$HERMES kanban create "bharat-quant-research" --column "candidate-factors" --title "Cross-Sectional Anomaly Scan" --description "
Run data_scientist_agent to scan for:
- New factor candidates from mover_snapshots
- Regime-dependent signal patterns
- Cross-asset correlation breaks
- Microstructure anomalies
" --assignee "data-scientist" --labels "discovery,automated"

$HERMES kanban create "bharat-quant-research" --column "validation-gate" --title "Measurement.md Gates Validation" --description "
Auditor applies mandatory gates:
1. Negative control test (revert → fail → restore → pass)
2. Purged 5-fold OOF with 10-day embargo
3. Regime stability: IC sign consistent across ≥3 regimes
4. Transaction costs: slippage + brokerage + STT + impact
5. Bonferroni correction for multiple testing
" --assignee "auditor" --labels "validation,mandatory"

$HERMES kanban create "bharat-quant-research" --column "approved-factors" --title "Factor Approved: value_book_to_price" --description "
PASSED ALL GATES (2026-08-10 validation):
- IC 5d: 0.042, IC 21d: 0.038
- AUC: 0.58 (purged OOF)
- Sharpe net: 1.47, Max DD: -17.9%
- Turnover: 28%/month
- Regime stable: HIGH_VOL, LOW_VOL, TRENDING
" --assignee "strategist" --labels "approved,high-conviction"

$HERMES kanban create "bharat-quant-research" --column "portfolio-test" --title "Portfolio Simulation: value_book_to_price" --description "
Strategist running:
- 50-stock long-only portfolio
- Monthly rebalance 2020-01 → 2024-12
- 1% slippage, full India cost stack
- Compare vs NIFTY50 benchmark
" --assignee "strategist" --labels "portfolio-test,in-progress"

$HERMES kanban create "bharat-quant-research" --column "weight-optimization" --title "REGIME_WEIGHTS Optimization" --description "
Optimizer adjusting:
- LOW_VOL: ml_ensemble 0.45 → 0.52
- HIGH_VOL: breakout_classifier 0.15 → 0.22
- TRENDING: movement_predictor 0.10 → 0.18
Via AlphaQuant walk-forward (36-month window)
" --assignee "optimizer" --labels "weights,optimization"

$HERMES kanban create "bharat-quant-research" --column "production-ready" --title "Promote ml_ensemble v2026-09-11" --description "
PROMOTION COMPLETE:
- model_registry updated: ml_ensemble promoted
- Previous version archived (v2026-09-04)
- Paper trading 2-week: Sharpe 1.18 (backtest 1.21)
- Drift detector armed, fallback to v2026-09-04
" --assignee "data-scientist" --labels "promoted,monitoring"

echo ""
echo "✅ Kanban board initialized with 6 columns and 6 sample cards"
echo ""
echo "Next steps:"
echo "  hermes kanban ls --board bharat-quant-research"
echo "  hermes kanban show bharat-quant-research --column validation-gate"
echo ""
echo "To run the autonomous agent loop:"
echo "  hermes chat -q 'Run the full quant research kanban loop: data-scientist → auditor → strategist → optimizer' --background"