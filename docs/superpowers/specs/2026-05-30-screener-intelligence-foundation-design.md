# Screener Intelligence Foundation — Design Spec
**Sub-project A of Signal Intelligence Platform**
**Date:** 2026-05-30
**Scope:** Phases 1 + 2 of 13-phase Signal Intelligence Platform

---

## Problem

The platform ingests 1,521 screeners from Trendlyne, MoneyControl, and ETnow. These screeners are currently treated as equal signals. No system exists to:

- Rank screeners by historical predictive power
- Classify them into categories and subcategories beyond basic NLP
- Track when a stock first appeared in a screener (no dated history)
- Compute multi-horizon performance (5d/10d/20d/60d/120d) per screener
- Assign tiers (A/B/C/D) that downstream systems can use as signal weights

This spec covers the foundation layer that all later phases (signal combination, recommendation engine, ML) depend on.

---

## Scope

**In scope:**
- Screener category + subcategory classification (keywords + Ollama fallback)
- `screener_appearances` table — dated history of stock entries/exits per screener
- `screener_performance_v2` table — multi-horizon metrics + Bayesian composite + tier
- `screener_performance.py` — nightly Python job that computes all metrics
- `screenerClassifier.ts` — classification service
- Diff patch on existing sync functions to record appearances
- 5 new tRPC endpoints
- Monitor page registration

**Out of scope:**
- Signal combination analytics (Sub-project B)
- Recommendation engine changes (Sub-project C)
- Frontend dashboard pages (Sub-project E)
- Changes to any data ingestion pipeline

---

## Existing Infrastructure Reused

| Asset | How used |
|---|---|
| `screener_master` (1,521 rows) | Extended with `subcategory`, `tier`, `category_confidence`, `classified_by` |
| `screener_reliability` (1,391 rows) | Extended with 5 new horizon columns; kept for backward compat |
| `signal_outcomes` (4,957 resolved) | Bootstrap source for initial tier computation |
| `recommendation_log` (22,175 rows) | Bootstrap: extract per-screener win/loss from `signals_json` |
| `stock_ohlcv` | Return computation at +5/10/20/60/120 trading days |
| `categorizeScreener()` in trendlyneScreener.ts | Replaced by `screenerClassifier.ts` (superset) |
| `MONITOR_SCRIPTS` in monitor.router.ts | New script registered here |
| BullMQ queues.ts | New `screener-performance` repeatable job |

---

## Database Schema

### New: `screener_appearances`

Records every time a stock enters or exits a screener during a sync run. The sync diff patch writes to this table; `screener_performance.py` fills in the return columns nightly.

```sql
CREATE TABLE IF NOT EXISTS screener_appearances (
  screener_id   TEXT NOT NULL,
  source        TEXT NOT NULL,          -- 'trendlyne' | 'moneycontrol' | 'etnow'
  symbol        TEXT NOT NULL,
  appeared_date DATE NOT NULL,
  exited_date   DATE,                   -- NULL = still active in screener
  return_5d     REAL,                   -- % return 5 trading days after appeared_date
  return_10d    REAL,
  return_20d    REAL,
  return_60d    REAL,
  return_120d   REAL,
  nifty_ret_20d REAL,                   -- Nifty benchmark for same window
  outcome_20d   TEXT,                   -- 'WIN' | 'LOSS' | 'NEUTRAL' | 'PENDING'
  PRIMARY KEY (screener_id, symbol, appeared_date)
);

CREATE INDEX IF NOT EXISTS idx_sa_symbol   ON screener_appearances(symbol);
CREATE INDEX IF NOT EXISTS idx_sa_date     ON screener_appearances(appeared_date);
CREATE INDEX IF NOT EXISTS idx_sa_screener ON screener_appearances(screener_id);
```

**WIN/LOSS definition:** `return_20d > nifty_ret_20d + 0.5%` → WIN. `return_20d < nifty_ret_20d - 0.5%` → LOSS. Within ±0.5% of Nifty → NEUTRAL. Pending if 20 trading days haven't elapsed.

### New: `screener_performance_v2`

One row per screener. Canonical source of truth for tiers and metrics.

```sql
CREATE TABLE IF NOT EXISTS screener_performance_v2 (
  screener_id        TEXT PRIMARY KEY,
  source             TEXT NOT NULL,
  total_appearances  INTEGER DEFAULT 0,
  resolved_count     INTEGER DEFAULT 0, -- appearances where outcome_20d != 'PENDING'

  -- Win rates per horizon
  wr_5d    REAL,  wr_10d  REAL,  wr_20d  REAL,  wr_60d  REAL,  wr_120d REAL,

  -- Average returns per horizon
  avg_ret_5d  REAL,  avg_ret_10d  REAL,  avg_ret_20d  REAL,
  avg_ret_60d REAL,  avg_ret_120d REAL,

  -- Risk-adjusted metrics (20d primary)
  alpha_20d    REAL,     -- avg(return_20d - nifty_ret_20d)
  alpha_60d    REAL,
  sharpe_20d   REAL,     -- avg_ret_20d / stddev(return_20d)
  max_drawdown REAL,     -- worst single return_20d in resolved appearances
  median_ret_20d REAL,

  -- Bayesian composite and tier
  bayesian_score REAL,   -- 0.0–1.0, Bayesian-shrunk composite
  tier           TEXT,   -- 'A' | 'B' | 'C' | 'D' | 'Unranked'
  data_source    TEXT,   -- 'proxy' | 'appearances' | 'mixed'

  last_computed  DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

### Extended: `screener_master`

Four columns added. All existing rows/columns unchanged.

```sql
ALTER TABLE screener_master ADD COLUMN subcategory         TEXT;
ALTER TABLE screener_master ADD COLUMN tier                TEXT;   -- synced from screener_performance_v2
ALTER TABLE screener_master ADD COLUMN category_confidence REAL;   -- 0.0–1.0
ALTER TABLE screener_master ADD COLUMN classified_by       TEXT;   -- 'keyword' | 'ollama' | 'manual'
```

### Extended: `screener_reliability`

Five columns added. Existing win_rate_1d/7d/30d columns unchanged.

```sql
ALTER TABLE screener_reliability ADD COLUMN win_rate_5d   REAL;
ALTER TABLE screener_reliability ADD COLUMN win_rate_10d  REAL;
ALTER TABLE screener_reliability ADD COLUMN win_rate_20d  REAL;
ALTER TABLE screener_reliability ADD COLUMN win_rate_60d  REAL;
ALTER TABLE screener_reliability ADD COLUMN win_rate_120d REAL;
```

---

## Category + Subcategory Taxonomy

| Category | Subcategories |
|---|---|
| **Momentum** | 52W High, Breakout, Relative Strength, Multibagger, Price Surge |
| **Institutional** | FII Buying, DII Buying, Bulk Deal, Block Deal, Promoter Buy |
| **Fundamental** | Low PE, PEG Undervalued, Earnings Growth, ROCE Strong, Debt-Free |
| **Volume** | Volume Shock, Unusual Volume, High Vol Breakout, Delivery Spike, OI Buildup |
| **Trend** | Golden Cross, EMA Crossover, MA Breakout, Supertrend, ADX Strong |
| **Reversal** | RSI Oversold, MACD Cross, Support Bounce, Hammer/Doji, BB Squeeze |
| **Quality** | Consistent Compounder, High ROE, High ROCE, Dividend, Zero Debt |
| **Growth** | Sales Growth, Profit Growth, Earnings Surprise, PAT Growth, Margin Expansion |
| **Sector** | Banking/NBFC, IT/Tech, Pharma, Infra/Defence, PSU, Auto, FMCG |
| **Valuation** | Low PE, PEG, Price/Book, Margin of Safety *(existing)* |
| **Delivery** | Delivery Spike, Bulk Deal, Block Deal, Promoter Buying *(existing)* |

Special tag (not a category): `intraday` — applied as `inferred_timeframe` when name contains intraday/breakout/BTST/STBT/momentum/squeeze etc.

---

## Services

### 1. `src/server/screenerClassifier.ts`

**Purpose:** Classify screeners into category + subcategory. Runs once on startup for unclassified rows; re-runs nightly for any new screeners added since last run.

**Algorithm:**
```
for each screener in screener_master WHERE subcategory IS NULL:
  1. Run keyword rules (~120 rules, expanded from existing categorizeScreener())
     → if confidence >= 0.7: save, mark classified_by = 'keyword'
  2. If confidence < 0.7 (lands in 'other'):
     → call Ollama (llama3 or gemma2) with structured prompt
     → parse JSON response {category, subcategory, confidence}
     → if Ollama fails or returns low confidence: keep 'other', classified_by = 'keyword'
     → else: save, mark classified_by = 'ollama'
```

**Ollama prompt template:**
```
You are classifying Indian stock market screeners. 
Screener name: "{name}"
Available categories: Momentum, Institutional, Fundamental, Volume, Trend, Reversal, Quality, Growth, Sector, Valuation, Delivery
Return ONLY valid JSON: {"category": "...", "subcategory": "...", "confidence": 0.85}
No explanation. If unsure, use "other" as category.
```

**Rate limiting:** Ollama calls batched 5 at a time with 200ms delay between batches. Total expected: ~633 Ollama calls, ~2 minutes.

**Export:** `classifyAllScreeners(): Promise<{classified: number, ollama_used: number, remaining_other: number}>`

---

### 2. `src/server/screener_performance.py`

**Purpose:** Nightly job — fill appearance returns, compute Bayesian scores, assign tiers.

**Phase A — Bootstrap from recommendation_log (proxy):**
```python
# Parse signals_json for each resolved recommendation
# signals_json contains screener_ids active at rec time
# Accumulate: per screener_id → list of (return_pct, outcome, horizon_days)
# Minimum 5 resolved recs to use a screener's proxy data
```

**Phase B — Fill screener_appearances returns:**
```python
# For each row WHERE return_20d IS NULL AND appeared_date <= today - 20 trading days:
#   price_entry = stock_ohlcv WHERE symbol=? AND date = appeared_date (or next trading day)
#   price_exit  = stock_ohlcv WHERE symbol=? AND date = appeared_date + N trading days
#   return_Nd = (price_exit - price_entry) / price_entry * 100
#   outcome_20d: WIN if return_20d > nifty_ret_20d + 0.5, LOSS if < -0.5, else NEUTRAL
```

**Phase C — Bayesian score + tier computation:**
```python
K = 20  # prior weight (need 20+ signals to trust own win rate)
GLOBAL_MEAN_WR = 0.52  # updated each run from avg of all screeners with >= 10 signals

for screener in all_screeners:
    n = resolved_count
    shrunk_wr = (n * wr_20d + K * GLOBAL_MEAN_WR) / (n + K)
    
    # Normalise each component to 0–1
    alpha_norm  = min(max((alpha_20d + 5) / 15, 0), 1)  # -5% to +10% range
    sharpe_norm = min(max(sharpe_20d / 3.0, 0), 1)
    dd_norm     = 1 - min(abs(max_drawdown) / 20, 1)
    
    composite = (0.40 * shrunk_wr +
                 0.30 * alpha_norm +
                 0.20 * sharpe_norm +
                 0.10 * dd_norm)
    
    # Tier assignment (absolute thresholds — Bayesian shrinkage prevents gaming)
    if n < 5:          tier = 'Unranked'
    elif composite >= 0.70: tier = 'A'
    elif composite >= 0.55: tier = 'B'
    elif composite >= 0.40: tier = 'C'
    else:              tier = 'D'
```

**Phase D — Sync back:**
```python
UPDATE screener_master SET tier = (
  SELECT tier FROM screener_performance_v2 WHERE screener_id = screener_master.scan_id
)
UPDATE screener_reliability SET win_rate_5d=?, win_rate_10d=?, win_rate_20d=?, ...
```

---

### 3. Sync diff patch (minimal change to existing sync functions)

Added to the end of each sync function's main loop — after the existing DELETE+INSERT transaction:

```typescript
// In syncAllScreenerStocksToDB() / syncMoneyControlScreeners() / syncETnowScreeners()
// AFTER the existing DELETE+INSERT transaction:

const today = new Date().toISOString().slice(0, 10);

// Get previous set from screener_appearances (still-active entries)
const prevSymbols = new Set(
  db.prepare(`SELECT symbol FROM screener_appearances
              WHERE screener_id = ? AND exited_date IS NULL`)
    .all(screenerId).map((r: any) => r.symbol)
);

const currentSymbols = new Set(newStocks.map(s => s.symbol).filter(Boolean));

// New entries
const entered = [...currentSymbols].filter(s => !prevSymbols.has(s));
for (const symbol of entered) {
  db.prepare(`INSERT OR IGNORE INTO screener_appearances
              (screener_id, source, symbol, appeared_date)
              VALUES (?, ?, ?, ?)`)
    .run(screenerId, source, symbol, today);
}

// Exited entries
const exited = [...prevSymbols].filter(s => !currentSymbols.has(s));
if (exited.length > 0) {
  db.prepare(`UPDATE screener_appearances SET exited_date = ?
              WHERE screener_id = ? AND symbol IN (${exited.map(() => '?').join(',')})
              AND exited_date IS NULL`)
    .run(today, screenerId, ...exited);
}
```

This is ~18 lines added to each of 3 sync functions. No other changes.

---

### 4. BullMQ job — `screener-performance`

Added to `src/server/queues.ts`:

```typescript
// Daily at 6 PM IST (12:30 UTC) — after screener sync completes
await screenerPerfQueue.add('screener-performance-daily', {}, {
  repeat: { cron: '30 12 * * 1-5' },  // weekdays only
  removeOnComplete: 3,
  removeOnFail: 3,
});
```

Worker runs `screener_performance.py` then `classifyAllScreeners()` for any new "other" screeners.

Added to `MONITOR_SCRIPTS` in `monitor.router.ts`:
```typescript
{
  id: 'screener-performance',
  label: 'Screener Performance Engine',
  category: 'ML',
  critical: false,
  description: 'Fills screener_appearances returns, computes Bayesian tiers, classifies new screeners',
  schedule: 'Daily 6 PM',
  pyScript: 'screener_performance.py',
  queueName: 'screener-performance',
  staleLimitHours: 26,
}
```

---

## tRPC Endpoints

All 5 added to `src/server/routers/screeners.router.ts`.

### `getScreenerLeaderboard`
```typescript
input: z.object({
  category:  z.string().optional(),
  subcategory: z.string().optional(),
  source:    z.enum(['trendlyne','moneycontrol','etnow']).optional(),
  horizon:   z.enum(['5d','10d','20d','60d','120d']).default('20d'),
  tier:      z.enum(['A','B','C','D','Unranked']).optional(),
  limit:     z.number().default(50),
  offset:    z.number().default(0),
})
// Returns: ranked list with tier badge, Bayesian score, win rate, alpha, resolved_count
// ORDER BY bayesian_score DESC
```

### `getScreenerDetail`
```typescript
input: z.object({ screener_id: z.string() })
// Returns: full metrics across all horizons + last 20 appearances with outcomes
// + top_stocks (symbols appearing most in this screener historically)
```

### `getScreenerCategoryStats`
```typescript
input: z.object({ horizon: z.enum(['5d','10d','20d','60d','120d']).default('20d') })
// Returns: per-category aggregate — count, avg win rate, avg alpha, tier A count, best screener
// Useful for "Momentum category has 3 Tier-A screeners, avg 63% win rate"
```

### `getScreenerAppearanceHistory`
```typescript
input: z.object({
  symbol:      z.string().optional(),
  screener_id: z.string().optional(),
  from_date:   z.string().optional(),
  limit:       z.number().default(100),
})
// At least one of symbol or screener_id required
// Returns: dated appearances with outcomes — enables reverse lookup per stock
```

### `triggerScreenerPerformanceRecompute`
```typescript
// mutation — queues screener_performance BullMQ job
// Returns: { queued: true, message: 'Screener performance job queued' }
```

---

## Data Flow Summary

```
Daily (weekdays 6 PM):

[Screener sync runs — existing]
  ↓ diff patch (15 lines per sync file)
  → screener_appearances: new rows with appeared_date

[screener_performance.py]
  Phase A: recommendation_log → bootstrap proxy metrics
  Phase B: screener_appearances + stock_ohlcv → fill return_5d…120d
  Phase C: Bayesian composite + tier assignment
  Phase D: sync tier back to screener_master + screener_reliability
  → screener_performance_v2: 1 row per screener, all metrics

[screenerClassifier.ts — after Python job]
  Keywords → fast path
  Ollama → ambiguous screeners (~15 min one-time, seconds ongoing)
  → screener_master: subcategory + classified_by updated

[tRPC layer]
  getScreenerLeaderboard → reads screener_performance_v2 JOIN screener_master
  getScreenerDetail      → reads screener_performance_v2 + screener_appearances
  getScreenerCategoryStats → aggregate on screener_master + screener_performance_v2
```

---

## Key Design Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Tier scoring | Bayesian shrinkage (k=20) | 4,957 outcomes spread thin across 1,521 screeners; prevents 2-win screeners ranking as Tier A |
| WIN/LOSS definition | Alpha vs Nifty ±0.5% | Avoids rewarding screeners that just capture bull market beta |
| Historical data strategy | Proxy now + appearances going forward | Immediate usefulness; data quality improves organically over 60–90 days |
| Classification fallback | Ollama (local) | No API cost; consistent with existing Ollama usage in codebase |
| Performance computation | Python (not TypeScript) | Consistent with existing ml_ensemble.py, performance_tracker.py pattern |
| Primary horizon | 20 days | Best balance of signal clarity vs. holding period realism for Indian markets |

---

## Out of Scope (Phase B–F)

- Signal combination analytics (`screener_combinations` table) — Sub-project B
- Recommendation tier system (Strong Buy/Sell) — Sub-project C
- Dashboard pages — Sub-project E
- Continuous learning feedback loop — Sub-project F
- ML probability forecasts — Sub-project D

---

## Files Changed

| File | Change |
|---|---|
| `src/server/db.ts` | 2 new tables, 9 ALTER TABLE statements |
| `src/server/screenerClassifier.ts` | New file (~180 lines) |
| `src/server/screener_performance.py` | New file (~250 lines) |
| `src/server/trendlyneScreener.ts` | +18 lines (diff patch) |
| `src/server/moneycontrolScreener.ts` | +18 lines (diff patch) |
| `src/server/etnowScreenerSync.ts` | +18 lines (diff patch) |
| `src/server/routers/screeners.router.ts` | +5 procedures (~120 lines) |
| `src/server/routers/monitor.router.ts` | +1 entry in MONITOR_SCRIPTS |
| `src/server/queues.ts` | +1 BullMQ queue + worker (~40 lines) |

**Total:** ~650 new lines across 9 files. No deletions from existing code.
