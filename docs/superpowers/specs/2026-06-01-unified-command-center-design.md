# Unified Command Center — Design Spec
**Date:** 2026-06-01  
**Status:** Approved

---

## Problem

The platform has 6 fragmented recommendation surfaces and 8 scoring engines running in parallel siloes:

**Frontend surfaces:**
- `TopRatedStocks` — screener composite scores
- `DailySignals` — 20+ technical signal types with win_probability
- `TradeDecisionCockpit` — market-gated trade candidates
- `SignalIntelligence` — confluence scores
- `TodaysPicks` — getUnifiedSignals conviction tiers
- `DLDashboard` — regime + deep learning performance

**Backend engines (no aggregation):**
scoring_engine, ml_ensemble, online_learner, dl_engine, confluence_ml_engine, technical_analysis_engine, rl_agent, regime_detector

No single view combines all signals into one authoritative ranked list.

---

## Solution

**Approach: Hybrid Python offline ranker + tRPC real-time overlay**

- `unified_ranker.py` runs after market close → writes `unified_recommendations` table with regime-weighted fusion score
- `getCommandCenter` tRPC endpoint reads that table, overlays live price at query time
- `CommandCenterDashboard.tsx` — new "Alpha" tab with EOD Swing Picks + Intraday Live sections
- Old tabs (TopRatedStocks, DailySignals, TradeDecisionCockpit, SignalIntelligence, TodaysPicks, DLDashboard) hidden behind "Advanced ›" toggle, not deleted

---

## Architecture

```
Daily ops (after market close):
  regime_detector.py ──→ current regime in DB (BULL/BEAR/HIGH_VOL/CRASH)
  unified_ranker.py  ──→ reads screener_catalog + *_screener_stocks tables
                         reads stock_scores, technical_analysis_signals,
                               confluence_signals, dl_predictions, rl_q_table,
                               recommendation_log (realized returns)
                         applies screener stock score formula
                         applies regime weight map × track record modifier
                         hard-gates via RL realized return < 0%
                         writes → unified_recommendations table

At query time (tRPC getCommandCenter):
  reads unified_recommendations (today or latest computed_at)
  overlays live price from liveStockData cache
  computes realized_return_pct = (livePrice - entry_zone_low) / entry_zone_low × 100
  reads today's technical_analysis_signals (intraday, HIGH strength only)
  regime-gates intraday section (collapses in CRASH)
  returns { regime, eodPicks[], intradaySignals[], lastComputedAt, engineTrackRecord }
```

---

## Section 2: Unified Scoring Formula

### Screener Data Sources

Three files power the screener scoring:
- `screener_scoring_v2.csv` — 1534 screeners with pre-computed `score_0_100` + `tier` from `screener_scoring_engine_v2.xlsx`. Source of truth for weights. Loaded into `screener_catalog`.
- `screener_corrections.csv` — 39 bias corrections + 5 subcategory corrections from xlsx Corrections Log. Applied at seed time.
- `screener_names_categorized.csv` — original CSV (superseded by `screener_scoring_v2.csv`).

### Step 1 — Screener Stock Score

Formula (from `screener_scoring_engine_v2.xlsx` Scoring Framework):
`contribution = Base Weight × Subcategory Modifier × Bias Sign × Horizon Multiplier × Confidence`

```python
# Base weights (xlsx research-backed, sum to 1.0)
CAT_BASE_WT = {
    'composite_strategy':      0.1287,
    'fundamental_quality':     0.1188,
    'fundamental_growth':      0.0990,
    'valuation':               0.0792,
    'technical_breakout':      0.0792,
    'ownership_institutional': 0.0693,
    'technical_momentum':      0.0693,
    'technical_trend':         0.0594,
    'analyst_sentiment':       0.0495,
    'technical_reversal':      0.0396,
    'event_corporate_action':  0.0396,
    'derivatives_positioning': 0.0297,
    'income_dividend':         0.0297,
    'risk_red_flags':          0.0297,
    'volume_liquidity':        0.0297,
    'volatility':              0.0198,
    'sector_theme':            0.0198,
    'market_cap_style':        0.0099,
    'other':                   0.0,
}

# Subcategory modifiers (from xlsx)
SUBCAT_MOD = {
    'multi_factor_strategy':        1.20,
    'earnings_growth':              1.15,
    'institutional_activity':       1.15,
    'capital_efficiency':           1.10,
    'revenue_growth':               1.10,
    'price_leadership':             1.10,
    'relative_strength':            1.10,
    'balance_sheet_quality':        1.05,
    'price_breakout':               1.05,
    'volume_delivery':              1.05,
    'moving_average_trend':         1.00,
    'relative_or_absolute_value':   1.00,
    'trend_indicator':              0.95,
    'earnings_event':               0.95,
    'oscillator_signal':            0.90,
    'broker_forecast':              0.90,
    'open_interest':                0.90,
    'oscillator_reversal':          0.85,
    'dividend_income':              0.85,
    'candlestick_reversal':         0.80,
    'volatility_range':             0.75,
    'sector_or_theme':              0.70,
    'corporate_action':             0.70,
    'financial_or_governance_risk': 0.60,
    'size_style':                   0.60,
}

# Horizon multipliers (from xlsx)
HORIZON_MULT = {
    'intraday':   0.70,   # 30% discount — high noise, execution cost
    'swing':      0.95,
    'positional': 1.05,
    'long_term':  1.10,   # strongest alpha persistence
}

# Bias sign — user requirement: bearish reduces score
BIAS_SIGN = {'bullish': +1.0, 'bearish': -1.0, 'neutral': +0.3}

# Fundamental multiplier from stock_scores.composite_score
FUND_MULT = lambda score: 1.3 if score > 70 else (0.7 if score < 40 else 1.0)

for stock in universe:
    raw = sum(
        BIAS_SIGN[s.signal_bias]
        * CAT_BASE_WT.get(s.category, 0)
        * SUBCAT_MOD.get(s.subcategory, 1.0)
        * HORIZON_MULT.get(s.investment_horizon, 0.95)
        * float(s.confidence)
        for s in screeners_containing(stock)
    )
    screener_stock_score[stock] = normalize(raw * FUND_MULT(stock.fundamental_score))  # → 0–100
```

**Key invariants:**
- Fundamentally weak stock in 20 bullish intraday technical screeners: mult=0.7, horiz=0.70 → scores much lower than fundamentally strong stock in 5 long-term fundamental_quality screeners (mult=1.3, horiz=1.10, subcat=1.05)
- Bearish screeners reduce score (BIAS_SIGN = −1.0)
- `risk_red_flags` + `financial_or_governance_risk` subcategory (mod=0.60) → strong downward pull
- Intraday screeners 30% discounted vs long-term (HORIZON_MULT 0.70 vs 1.10)

### Step 2 — Engine Scores per Stock

| Engine | Source table/column |
|---|---|
| screener_stock_score | computed in Step 1 |
| ml_score | `technical_analysis_signals.win_probability` |
| confluence_score | `confluence_signals.confluence_score` |
| technical_score | `technical_analysis_signals.signal_score` (avg) |
| dl_score | `dl_predictions.probability` |

### Step 3 — Track Record Weight (dynamic, last 90 days)

```python
# win_probability = realized return % from recommendation date to today
# (current_price - entry_price) / entry_price * 100, from recommendation_log
engine_track_record[engine] = avg(realized_return_pct) over last 90 days
track_record_modifier = softmax(engine_track_record)  # normalised weight modifier
```

### Step 4 — Regime Weight Map

```python
REGIME_WEIGHTS = {
    'BULL':     {'screener': 0.30, 'ml': 0.25, 'confluence': 0.20, 'technical': 0.15, 'dl': 0.10},
    'BEAR':     {'screener': 0.35, 'ml': 0.25, 'confluence': 0.20, 'technical': 0.10, 'dl': 0.10},
    'HIGH_VOL': {'screener': 0.20, 'ml': 0.20, 'confluence': 0.15, 'technical': 0.30, 'dl': 0.15},
    'CRASH':    {'screener': 0.40, 'ml': 0.25, 'confluence': 0.15, 'technical': 0.10, 'dl': 0.10},
}

final_weight[e] = REGIME_WEIGHTS[regime][e] * track_record_modifier[e]
# renormalise so weights sum to 1
```

### Step 5 — RL Hard Gate

Exclude stock entirely if `avg(realized_return_pct)` for each engine that recommended this stock (from `recommendation_log` grouped by engine, last 90 days) is < 0% for all engines. If at least one engine has a positive track record for this stock, it passes the gate.

### Step 6 — Unified Score + Conviction

```python
unified_score = Σ (final_weight[e] * engine_score[e])   # → 0–100

CONVICTION_TIERS = [
    ('S_ELITE',    80),   # Multi-factor bullish + quality + long-term
    ('A_HIGH',     65),   # High-quality directional signal
    ('B_MEDIUM',   45),   # Useful with confirmation
    ('C_LOW',      25),   # Context-dependent
    ('D_MARGINAL',  1),   # Noisy; supplementary only
]
# Stocks scoring < 1 (F_EXCLUDED) are dropped from output entirely
```

---

## Section 3: DB Schema

```sql
-- Pre-computed daily recommendations (written by unified_ranker.py)
CREATE TABLE unified_recommendations (
    id                      INTEGER PRIMARY KEY AUTOINCREMENT,
    symbol                  TEXT NOT NULL,
    computed_at             TEXT NOT NULL,         -- ISO date YYYY-MM-DD
    regime                  TEXT NOT NULL,         -- BULL/BEAR/HIGH_VOL/CRASH
    unified_score           REAL NOT NULL,         -- 0–100
    conviction_level        TEXT NOT NULL,         -- ELITE/STRONG/MODERATE/WATCH
    screener_stock_score    REAL,
    ml_score                REAL,
    confluence_score        REAL,
    technical_score         REAL,
    dl_score                REAL,
    realized_return_pct     REAL,                  -- (live-entry)/entry*100, overlaid at query time
    avg_engine_track_record REAL,                  -- 90-day avg return across engines
    bullish_screener_count  INTEGER,
    bearish_screener_count  INTEGER,
    screener_names_json     TEXT,                  -- JSON array
    fundamental_score       REAL,
    entry_zone_low          REAL,
    entry_zone_high         REAL,
    stop_loss               REAL,
    target_1                REAL,
    target_2                REAL,
    target_3                REAL,
    risk_reward             REAL,
    timeframe               TEXT,                  -- intraday/swing/long_term
    sector                  TEXT,
    trade_reasoning         TEXT,
    UNIQUE(symbol, computed_at)
);
CREATE INDEX idx_ur_date_score   ON unified_recommendations(computed_at, unified_score DESC);
CREATE INDEX idx_ur_conviction   ON unified_recommendations(computed_at, conviction_level);

-- Screener metadata from screener_names_categorized.csv (populated on sync)
CREATE TABLE screener_catalog (
    screener_id        TEXT NOT NULL,
    source             TEXT NOT NULL,              -- trendlyne/moneycontrol/etnow
    screener_name      TEXT NOT NULL,
    category           TEXT NOT NULL,
    subcategory        TEXT,
    signal_bias        TEXT NOT NULL,              -- bullish/bearish/neutral
    investment_horizon TEXT,                       -- intraday/swing/long_term
    confidence         REAL NOT NULL,
    PRIMARY KEY (screener_id, source)
);
```

`unified_ranker.py` reads `screener_catalog` (seeded from CSV on first run), joins with `trendlyne_screener_stocks`, `moneycontrol_screener_stocks`, `etnow_screener_stocks` to find which stocks appear in each screener, applies formula, writes to `unified_recommendations`.

---

## Section 4: tRPC Endpoints

### `getCommandCenter`

```typescript
getCommandCenter: publicProcedure
  .input(z.object({
    conviction: z.enum(['ALL', 'ELITE', 'STRONG', 'MODERATE', 'WATCH']).default('ALL'),
    horizon:    z.enum(['ALL', 'intraday', 'swing', 'long_term']).default('ALL'),
    limit:      z.number().default(30),
  }))
  .query(async ({ input }) => {
    // 1. Latest regime from DB
    // 2. Read unified_recommendations for today (fallback: latest computed_at)
    // 3. Filter by conviction + horizon, ORDER BY unified_score DESC, LIMIT
    // 4. Overlay live prices from liveStockData cache (no extra API call)
    // 5. Compute realized_return_pct live: (livePrice - entry_zone_low) / entry_zone_low * 100
    // 6. Read today's technical_analysis_signals (HIGH strength only) for intraday section
    //    Exclude stocks where avg engine track record < 0 (RL gate)
    return {
      regime:            { name, confidence, updated_at },
      eodPicks:          UnifiedRec[],
      intradaySignals:   TechSignal[],
      lastComputedAt:    string,
      engineTrackRecord: Record<string, number>,   // transparency panel
    };
  }),
```

**Cache:** Redis key `cmd_center:{date}:{conviction}:{horizon}`, TTL 5 min. Live price overlay is not cached.

### `runUnifiedRanker`

```typescript
runUnifiedRanker: publicProcedure
  .mutation(async () => {
    // execFile('python', ['unified_ranker.py'])
    // returns { success, stocks_scored, duration_ms, conviction_breakdown }
  }),
```

---

## Section 5: Frontend Layout

### New file: `src/components/CommandCenterDashboard.tsx`

```
CommandCenterDashboard
│
├── Header bar
│     ├── Regime badge (BULL▲ / BEAR▼ / HIGH_VOL⚡ / CRASH☠) + confidence %
│     ├── "Last computed: Today 4:05 PM" + manual refresh (runUnifiedRanker)
│     └── Engine track record strip: 5 mini pills per engine, 90d avg return %
│
├── Filter bar
│     ├── Conviction tabs: ALL | ELITE | STRONG | MODERATE | WATCH
│     └── Horizon toggle: ALL | Intraday | Swing | Long Term
│
├── EOD SWING PICKS
│     Sorted by unified_score DESC, 10/page
│     Each card:
│       [Symbol + Name]     [Conviction badge]     [Unified score bar 0–100]
│       [Sector]            [Realized return % since rec — green/red live]
│       [Bullish ↑N  Bearish ↓N screeners]
│       [Entry zone low–high]  [SL]  [T1 / T2 / T3]  [R:R ratio]
│       [Score breakdown: 5 mini bars — screener/ml/confluence/technical/dl]
│       [Trade reasoning — collapsed, expand on click]
│
└── INTRADAY LIVE
      Collapses with ⚠ warning in CRASH regime
      Each signal card:
        [Symbol]  [Signal type badge]  [Strength: HIGH/MEDIUM]
        [Live price + change %]  [Realized return %]  [Horizon]
```

### Nav change in `App.tsx`

- Add `alpha` tab → `CommandCenterDashboard`
- Wrap existing tabs `top-rated`, `signals`, `trade-cockpit`, `today-picks`, `dl-dashboard` in `AdvancedToggle` component — hidden by default, revealed via "Advanced ›" button in nav

---

## New Files

| File | Purpose |
|---|---|
| `src/server/unified_ranker.py` | Offline scoring engine — reads all sources, writes `unified_recommendations` |
| `src/components/CommandCenterDashboard.tsx` | New "Alpha" tab UI |

## Modified Files

| File | Change |
|---|---|
| `src/server/db.ts` | Add `unified_recommendations` + `screener_catalog` tables |
| `src/server/router.ts` | Add `getCommandCenter` + `runUnifiedRanker` procedures |
| `src/App.tsx` | Add `alpha` tab, wrap old tabs in `AdvancedToggle` |
| `src/server/queues.ts` | Add BullMQ job to run `unified_ranker.py` after market close (3:45 PM IST) |

---

## Daily Ops Integration

Add to daily ops sequence (after `performance_tracker.py`):

```bash
python unified_ranker.py   # writes unified_recommendations for today
```

Triggered by: BullMQ repeatable job at 15:45 IST, also available via `runUnifiedRanker` tRPC mutation for manual re-runs.
