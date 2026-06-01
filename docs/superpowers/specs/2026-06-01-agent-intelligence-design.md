# Agent Intelligence System — Design Spec

**Date:** 2026-06-01  
**Status:** Approved for implementation

---

## Goal

Build a four-agent quantitative intelligence pipeline that combines Python computation with local Ollama LLM reasoning. Agents run on a daily post-market schedule, write structured results to the DB, generate natural-language narratives via Ollama, expose findings through dedicated tRPC procedures and React UI pages, and push high-conviction alerts to Telegram.

---

## Approach

**Shared DB Pipeline (Approach A):** Python computes metrics → Ollama narrates → results stored in DB → tRPC exposes to UI → Telegram fires on triggers. Sequential daily pipeline, each agent reading the previous agent's output from the DB. Reuses `pythonRunner.ts`, `TelegramNotificationService`, BullMQ queues, and existing tRPC router pattern.

---

## System Architecture

```
[BullMQ — weekday crons]
        │
        ▼  07:00 IST  (01:30 UTC)
DataScientistAgent      → agent_data_scientist_reports
        │
        ▼  08:30 IST  (03:00 UTC)
StrategistAgent         → agent_strategy_picks (×4 timeframes)
        │               → Telegram: HIGH-conviction picks
        ▼  16:30 IST  (11:00 UTC)
AuditorAgent            → agent_audit_reports
        │
        ▼  17:30 IST  (12:00 UTC)
OptimizerAgent          → agent_optimizer_reports
                        → Telegram: weight-change alerts
```

---

## Timeframes

| Key | Label | Holding period | Signal source |
|-----|-------|----------------|---------------|
| `intraday` | Intraday | Same day | `technical_signals.time_horizon = 'intraday'` |
| `swing` | Swing | 3–10 days | `time_horizon = 'swing'` |
| `positional` | Positional | 3–6 weeks | `time_horizon = 'positional'` |
| `investment` | Investment | 3–12 months | `quant_scores` composite + fundamentals |

---

## DB Schema — 4 New Tables

### `agent_data_scientist_reports`
```sql
CREATE TABLE agent_data_scientist_reports (
  id                        INTEGER PRIMARY KEY AUTOINCREMENT,
  run_date                  TEXT NOT NULL,
  ohlcv_coverage_pct        REAL,
  stale_symbols_count       INTEGER,
  fundamentals_fresh_count  INTEGER,
  model_auc                 REAL,
  model_drift_detected      INTEGER DEFAULT 0,
  signal_resolution_rate    REAL,
  data_quality_score        REAL,
  quality_grade             TEXT,
  issues_json               TEXT,
  narrative                 TEXT,
  created_at                DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_ads_run_date ON agent_data_scientist_reports(run_date);
```

### `agent_strategy_picks`
```sql
CREATE TABLE agent_strategy_picks (
  id                       INTEGER PRIMARY KEY AUTOINCREMENT,
  run_date                 TEXT NOT NULL,
  timeframe                TEXT NOT NULL,
  symbol                   TEXT NOT NULL,
  rank                     INTEGER NOT NULL,
  conviction               TEXT NOT NULL,
  entry_zone_low           REAL,
  entry_zone_high          REAL,
  stop_loss                REAL,
  target_1                 REAL,
  target_2                 REAL,
  target_3                 REAL,
  composite_score          REAL,
  quant_rank               REAL,
  confluence_score         REAL,
  regime_alignment         TEXT,
  supporting_signals_json  TEXT,
  narrative                TEXT,
  created_at               DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_asp_run_date_tf ON agent_strategy_picks(run_date, timeframe);
CREATE INDEX idx_asp_symbol      ON agent_strategy_picks(symbol);
```

### `agent_audit_reports`
```sql
CREATE TABLE agent_audit_reports (
  id                        INTEGER PRIMARY KEY AUTOINCREMENT,
  run_date                  TEXT NOT NULL,
  audit_for_date            TEXT NOT NULL,
  timeframe                 TEXT NOT NULL,
  total_picks               INTEGER,
  hits                      INTEGER,
  misses                    INTEGER,
  open_positions            INTEGER,
  hit_rate                  REAL,
  avg_return_pct            REAL,
  profit_factor             REAL,
  nifty_return_pct          REAL,
  alpha_pct                 REAL,
  best_pick                 TEXT,
  worst_pick                TEXT,
  signal_attribution_json   TEXT,
  narrative                 TEXT,
  created_at                DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_aar_run_date_tf ON agent_audit_reports(run_date, timeframe);
```

### `agent_optimizer_reports`
```sql
CREATE TABLE agent_optimizer_reports (
  id                             INTEGER PRIMARY KEY AUTOINCREMENT,
  run_date                       TEXT NOT NULL,
  trigger                        TEXT NOT NULL,
  baseline_win_rate              REAL,
  new_win_rate                   REAL,
  improvement_pct                REAL,
  weights_changed                INTEGER DEFAULT 0,
  full_optimizer_triggered       INTEGER DEFAULT 0,
  changes_json                   TEXT,
  underperforming_segments_json  TEXT,
  narrative                      TEXT,
  created_at                     DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_aor_run_date ON agent_optimizer_reports(run_date);
```

---

## Python Agents — `src/server/agents/`

### `data_scientist_agent.py`

**Reads:** `stock_ohlcv`, `stock_fundamentals`, `signal_outcomes`, `model_registry`, `technical_signals`

**Computes:**
- `ohlcv_coverage_pct` — symbols with ≥240 OHLCV days / total symbols × 100
- `stale_symbols_count` — symbols where max(date) < today − 3 business days
- `fundamentals_fresh_count` — symbols where phase1_synced_at > now − 7 days
- `model_auc` — latest `cv_roc_auc` from `model_registry WHERE is_active=1 ORDER BY trained_at DESC LIMIT 1`
- `model_drift_detected` — 1 if current AUC < previous run AUC − 0.03
- `signal_resolution_rate` — COUNT(outcome != 'PENDING') / COUNT(*) × 100 from `signal_outcomes`
- `data_quality_score` — 0.35×coverage + 0.25×(model_auc×100) + 0.25×resolution_rate + 0.15×(fundamentals_fresh/total×100)
- `quality_grade` — A (≥85), B (≥70), C (≥55), D (<55)
- `issues_json` — array of flagged problems with severity

**Ollama prompt:**
```
You are a quant data scientist. Given these metrics:
- OHLCV coverage: {ohlcv_coverage_pct:.1f}% ({stale_symbols_count} symbols stale)
- Model AUC: {model_auc:.3f} (drift detected: {model_drift_detected})
- Signal resolution rate: {signal_resolution_rate:.1f}%
- Data quality score: {data_quality_score:.0f}/100 (Grade {quality_grade})
- Issues flagged: {issues_json}

Write a 4-sentence analyst briefing: data health status, key risks,
what the strategist should be aware of today, and one recommended action.
```

**Outputs:** Inserts one row into `agent_data_scientist_reports`.

---

### `strategist_agent.py`

**Reads:** `quant_scores`, `confluence_signals`, `technical_signals`, `market_regimes`, `fii_dii_flow`, `screener_reliability`, `agent_data_scientist_reports` (latest, for quality gate)

**Quality gate:** If DS report `quality_grade = 'D'`, abort with warning. If `stale_symbols_count > 100`, log warning but continue.

**Per timeframe scoring:**
```
composite_score = (
  0.35 × quant_composite_rank +
  0.30 × confluence_score +
  0.20 × regime_alignment_bonus +
  0.15 × screener_reliability_avg
)
```

- `regime_alignment_bonus`: +15 if regime=BULL and sentiment=bullish; −15 if regime=BULL and sentiment=bearish; 0 if SIDEWAYS or BEAR
- `screener_reliability_avg`: mean of `screener_reliability.reliability_score` for screeners that fired on this symbol
- Filter `technical_signals` by `time_horizon` for intraday/swing/positional; use `quant_scores` composite rank for investment
- Entry zone: CMP ± 0.5%; SL: CMP − 2×ATR14; T1: entry + 1.5R; T2: entry + 2.5R; T3: entry + 4R
- Conviction: HIGH if score ≥75 AND ≥3 confirming signals; MEDIUM if score ≥60; LOW otherwise
- Top 5 per timeframe written to DB; top 3 passed to Ollama

**Ollama prompt (one call per timeframe):**
```
You are a senior equity strategist for Indian markets.
Market regime: {regime}. FII net flow: ₹{fii_net}Cr ({fii_direction}).

Top {timeframe} picks:
{symbol} | Score: {score:.0f} | Conviction: {conviction} | Entry: {entry_low}–{entry_high} | SL: {sl} | T1: {t1}
(repeat for top 3)

Supporting signals: {top_signals}

Write a 5-sentence strategy brief: market context, timeframe rationale,
top pick conviction reasoning, key risk, and action trigger.
```

**Telegram trigger:** picks where `conviction = 'HIGH'`, formatted as:
```
🎯 STRATEGY ALERT — {timeframe.upper()}
{symbol} | Entry: ₹{entry_low}–{entry_high} | SL: ₹{sl}
T1: ₹{t1} | T2: ₹{t2} | T3: ₹{t3}
Conviction: HIGH | Score: {score:.0f}
{narrative first sentence}
```

---

### `auditor_agent.py`

**Reads:** `agent_strategy_picks` (yesterday's run_date), `stock_ohlcv` (latest closes), `market_regimes`

**Per pick resolution:**
- Fetch close prices from entry date to today
- HIT: any close reached target_1 before stop_loss was breached
- STOP: any close breached stop_loss before target_1
- OPEN: neither triggered yet
- `actual_return_pct` = (latest_close − entry_zone_mid) / entry_zone_mid × 100

**Per timeframe aggregates:**
- `hit_rate` = hits / (hits + misses) × 100
- `profit_factor` = sum(positive returns) / abs(sum(negative returns))
- `nifty_return_pct` — Nifty 50 close-to-close for same period (from `stock_ohlcv WHERE symbol = '^NSEI'`)
- `alpha_pct` = avg_return_pct − nifty_return_pct
- Signal attribution: group picks by dominant signal type from `supporting_signals_json`, compute win_rate per signal type

**Ollama prompt:**
```
You are a quantitative analyst auditing yesterday's Indian market picks.
Timeframe: {timeframe}
Hit rate: {hit_rate:.0f}% | Avg return: {avg_return_pct:+.2f}% | Alpha vs Nifty: {alpha_pct:+.2f}%
Best: {best_pick} ({best_ret:+.2f}%) | Worst: {worst_pick} ({worst_ret:+.2f}%)
Top signals: {top_signals} | Weak signals: {weak_signals}

Write a 4-sentence audit report: overall performance verdict, what worked,
what failed and why, and one actionable insight for the strategist.
```

---

### `optimizer_agent.py`

**Reads:** `agent_audit_reports` (last 30 days), `screener_master`, `signal_type_weights`, `screener_weight_history`

**Logic:**
1. Compute rolling 30-day `win_rate` per timeframe from audit table
2. Identify underperforming timeframes (win_rate < 55% for ≥5 consecutive days)
3. For each underperforming timeframe:
   - Read `signal_attribution_json` from recent audit rows
   - Reduce `screener_master.weight_override` by 12% for signal types with win_rate < 45%
   - Increase `screener_master.weight_override` by 10% for signal types with win_rate > 65%
   - Clamp weights to [0.3, 2.0]
4. If overall win_rate < 50% for ≥5 consecutive days: set `full_optimizer_triggered = 1`, call `strategy_optimizer.py` via HTTP to `pythonApi`
5. Log `changes_json` as `{signal_type: {before, after}}` dict

**Ollama prompt:**
```
You are a quantitative portfolio optimizer for Indian equities.
30-day performance by timeframe:
{timeframe_table}

Weight adjustments made: {changes_json}
Full optimizer triggered: {full_optimizer_triggered}

Write a 4-sentence optimization report: performance trend assessment,
which adjustments were made and the rationale, expected improvement,
and one metric to monitor over the next 5 trading days.
```

**Telegram trigger:** when any weight changes by >10% or full optimizer fires:
```
⚙️ OPTIMIZER ALERT
Win rate: {baseline:.0f}% → {new:.0f}% ({improvement:+.1f}%)
Weights adjusted: {len(changes)} signal types
Full optimizer: {'YES 🔄' if triggered else 'NO'}
{narrative first sentence}
```

---

## BullMQ Queues — additions to `queues.ts`

| Constant | Queue name | Cron | Lock duration |
|----------|-----------|------|---------------|
| `QUEUE_AGENT_DATA_SCIENTIST` | `agent-data-scientist` | `30 1 * * 1-5` | 10 min |
| `QUEUE_AGENT_STRATEGIST` | `agent-strategist` | `0 3 * * 1-5` | 15 min |
| `QUEUE_AGENT_AUDITOR` | `agent-auditor` | `0 11 * * 1-5` | 15 min |
| `QUEUE_AGENT_OPTIMIZER` | `agent-optimizer` | `0 12 * * 1-5` | 20 min |

Each worker: `runPython('agents/<name>_agent.py')` → on completion reads latest DB row → fires Telegram if trigger condition met.

---

## tRPC Router — `src/server/routers/agents.router.ts`

### Queries

```typescript
getDataScientistReport   // input: { limit?: number (default 30) }
                         // returns latest + history from agent_data_scientist_reports

getStrategyPicks         // input: { date?: string, timeframe?: string }
                         // returns picks for that run, all timeframes if no filter

getAuditReport           // input: { date?: string, timeframe?: string }
                         // returns audit rows for that date

getOptimizerReport       // input: { limit?: number (default 30) }
                         // returns latest + history

getAgentStatus           // returns last run_date + quality_grade + pick count
                         // for all 4 agents in one call (for dashboard header)
```

### Mutations

```typescript
runDataScientistAgent    // enqueues agent-data-scientist job or runs directly
runStrategistAgent       // enqueues agent-strategist job or runs directly
runAuditorAgent          // enqueues agent-auditor job or runs directly
runOptimizerAgent        // enqueues agent-optimizer job or runs directly
runFullAgentPipeline     // enqueues all 4 in sequence with 5-min delay between each
```

---

## React UI — 4 New Pages

### Shared layout per page
- Header: agent name, last run timestamp, status badge (SUCCESS / RUNNING / FAILED), manual trigger button
- Narrative card: Ollama output displayed prominently
- Metrics panel: agent-specific data
- History panel: last 30 runs sparkline or table

### `AgentDataScientistPage.tsx`
- Quality score gauge (0–100) with grade badge
- Metric row: OHLCV coverage %, stale count, model AUC, resolution rate
- Issues list (from `issues_json`)
- 30-day quality score trend line chart

### `AgentStrategistPage.tsx`
- 4 tabs: Intraday | Swing | Positional | Investment
- Per tab: picks table — Symbol | Conviction badge | Entry zone | SL | T1/T2/T3 | Score bar
- Timeframe narrative card below table
- Historical pick count by conviction (30 days)

### `AgentAuditorPage.tsx`
- 4 tabs (same timeframes)
- Per tab: hit rate donut chart, avg return vs Nifty bar, alpha badge
- Pick outcomes table: Symbol | Status (✅ HIT / ❌ MISS / ⏳ OPEN) | Actual return | vs Nifty
- Signal attribution table: Signal type | Win rate | Count

### `AgentOptimizerPage.tsx`
- 30-day win rate line chart per timeframe (4 lines)
- Latest weight changes table: Signal type | Before | After | Δ
- Full optimizer event log
- Improvement metrics: baseline → new win rate

### App.tsx integration
New tab group `agent-intelligence` with 4 sub-tabs. Add to nav alongside existing tabs.

---

## File Map

| Action | Path |
|--------|------|
| Create | `src/server/agents/data_scientist_agent.py` |
| Create | `src/server/agents/strategist_agent.py` |
| Create | `src/server/agents/auditor_agent.py` |
| Create | `src/server/agents/optimizer_agent.py` |
| Create | `src/server/agents/__init__.py` |
| Create | `src/server/routers/agents.router.ts` |
| Create | `src/components/AgentDataScientistPage.tsx` |
| Create | `src/components/AgentStrategistPage.tsx` |
| Create | `src/components/AgentAuditorPage.tsx` |
| Create | `src/components/AgentOptimizerPage.tsx` |
| Modify | `src/server/db.ts` — add 4 new table migrations |
| Modify | `src/server/queues.ts` — add 4 new queue constants + workers |
| Modify | `src/server/router.ts` — add `agentsRouter` to `mergeRouters` |
| Modify | `src/App.tsx` — add 4 new tab routes |

---

## Spec Self-Review

- [x] No TBD or TODO placeholders
- [x] Ollama prompt templates fully written — no "add appropriate prompt" gaps
- [x] All 4 table schemas include indexes
- [x] Scoring formula coefficients sum to 1.0 (0.35 + 0.30 + 0.20 + 0.15 = 1.00)
- [x] Conviction thresholds explicit: HIGH ≥75 + ≥3 signals; MEDIUM ≥60; LOW otherwise
- [x] Optimizer weight clamp bounds explicit: [0.3, 2.0]
- [x] Underperformance threshold explicit: win_rate < 55% for ≥5 consecutive days
- [x] Full optimizer trigger explicit: overall win_rate < 50% for ≥5 consecutive days
- [x] BullMQ crons convert correctly: 01:30 UTC = 07:00 IST; 03:00 UTC = 08:30 IST; 11:00 UTC = 16:30 IST; 12:00 UTC = 17:30 IST
- [x] Telegram message templates fully specified
- [x] `runPython` path: `'agents/data_scientist_agent.py'` — correct relative to PY_DIR
- [x] All 4 pages wired through `agentsRouter` — no orphan procedures
- [x] `agent_strategy_picks` has both `run_date` and `timeframe` index for efficient UI queries
- [x] DS quality gate in strategist: abort on grade D, warn on stale > 100
- [x] Investment timeframe correctly uses `quant_scores` not `technical_signals`
