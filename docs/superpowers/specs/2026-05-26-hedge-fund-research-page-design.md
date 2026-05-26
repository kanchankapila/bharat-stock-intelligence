# Hedge Fund Research Page — Design Spec
**Date:** 2026-05-26  
**Status:** Approved  

---

## Overview

A new "Research" tab in Bharat Stock Intelligence that publishes a daily institutional-grade stock analysis report. The report is generated twice daily (pre-market + post-close) by a quant engine that cross-validates signals across 5 data layers, then uses Ollama/Gemini to write short narrative blurbs per stock. Users see a dual-tier UI: a fast trader view (top picks table) and an expandable analyst view (score breakdowns, AI narratives, technical/fundamental metrics). Last 7 reports are archived and accessible via date picker.

---

## Goals

- Surface the highest-conviction stock opportunities daily without manual effort
- Cross-validate across quant scores, technical signals, XGBoost ML, screener confluence, and news sentiment
- Serve both traders (entry/SL/target, quick) and analysts (score methodology, drill-down)
- Regenerate automatically at 8:30 AM IST (pre-market) and 4:15 PM IST (post-close)
- Persist 7-day archive for comparison

---

## Data Layer

### New DB Table: `daily_research_reports`

```sql
CREATE TABLE daily_research_reports (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  report_date     TEXT NOT NULL,
  report_type     TEXT NOT NULL CHECK(report_type IN ('PRE_MARKET', 'POST_CLOSE')),
  status          TEXT NOT NULL DEFAULT 'PENDING'
                  CHECK(status IN ('PENDING','GENERATING','READY','FAILED')),
  generated_at    DATETIME,
  market_regime   TEXT,
  sentiment_score REAL,
  fii_net_5d      REAL,
  top_picks_json  TEXT,   -- JSON array: top 10 picks (symbol, scores, entry/SL/target)
  report_json     TEXT,   -- full report: avoid list, watchlist, sector rankings, context
  ai_blurbs_json  TEXT,   -- AI narratives keyed by symbol: {bull, bear, risk}
  error_message   TEXT,
  UNIQUE(report_date, report_type)
);
```

Schema added in `src/server/db.ts` alongside existing table definitions.

### DB Query Sources

Report generation reads from these existing tables (no schema changes to any of them):

| Table | Data Used |
|---|---|
| `quant_scores` | rank_composite, rank_momentum, rank_quality, rank_value, screener counts, piotroski |
| `technical_signals` | signal_score, win_probability, rsi, adx, volume_ratio, signals_json |
| `xgboost_predictions` | xgboost_score, signal, is_growth, is_breakout |
| `institutional_rankings` | composite_score, pass_safety, f_score |
| `news_sentiment_items` | sentiment, impact, published_at (last 48h HIGH/MEDIUM only) |
| `fii_dii_flow` | fii_net, dii_net (last 5 days) |
| `market_sentiment_snapshots` | overall_score, nifty_bias, global_cue, key_themes_json |
| `stock_fundamentals` | trailing_pe, return_on_equity, debt_to_equity, operating_margins |

---

## Backend

### Report Generation Engine: `src/server/researchEngine.ts`

Exported function: `generateDailyReport(date: string, type: 'PRE_MARKET' | 'POST_CLOSE'): Promise<void>`

**Pipeline (sequential):**

```
1. MARKET CONTEXT
   ├── Query fii_dii_flow — 5-day FII + DII net totals
   ├── Query market_sentiment_snapshots — latest snapshot
   └── Classify regime: BULL | BEAR | SIDEWAYS | TRANSITIONAL
       Rule: FII 5d net > 3000 AND sentiment > 20 → BULL
             FII 5d net < -3000 OR sentiment < -20 → BEAR
             Midcap breadth strong + large-cap sideways → TRANSITIONAL
             else → SIDEWAYS

2. CANDIDATE SCORING (parallel DB queries)
   ├── quant_scores WHERE composite_class IN ('Strong Buy','Buy') AND ohlcv_days >= 60
   ├── technical_signals (latest per symbol) WHERE signal_score >= 5
   ├── xgboost_predictions WHERE signal = 'BUY'
   ├── institutional_rankings WHERE pass_safety = 1
   └── news_sentiment_items WHERE impact IN ('HIGH','MEDIUM') AND published_at >= now-48h

3. CROSS-VALIDATION ENGINE
   For each candidate stock, compute conviction_score (0–100):
   
   conviction_score =
     (quant_rank_composite / 100) * 30        -- 30% weight
   + (signal_score / 10) * 25                 -- 25% weight
   + xgboost_score * 20                       -- 20% weight
   + (screener_net_score / 50) * 15           -- 15% weight (capped at 50)
   + (news_sentiment_boost) * 10              -- 10% weight (1.0 if HIGH bullish news, else 0)

   Risk penalties applied after:
   - RSI > 80: conviction_score *= 0.75
   - debt_to_equity > 100: conviction_score *= 0.80
   - max_drawdown_1y > 40: conviction_score *= 0.85
   - piotroski_f_score < 4: conviction_score *= 0.70

   Outputs:
   - top_picks: top 10 by conviction_score (minimum 2 signal layers must agree)
   - watchlist: ranks 11–20
   - avoid_list: stocks with RSI>80 OR max_drawdown>40 OR piotroski<4 that appeared in any layer

4. AI BLURBS (per top-10 stock)
   Provider: Ollama (model: llama3) → Gemini fallback → skip if both unavailable
   Prompt per stock: structured JSON request for:
     - bull_case: 2-sentence upside thesis
     - bear_case: 1-sentence key risk
     - key_risk: 1 specific risk factor
   Timeout: 20s per stock. If AI unavailable, blurbs field left null (page renders fine without it).
   
   Also generates:
   - executive_summary: 3-sentence market overview (regime + FII + top theme)

5. PERSIST
   INSERT OR REPLACE INTO daily_research_reports
   SET status = 'READY', generated_at = NOW()
   On any uncaught error: SET status = 'FAILED', error_message = err.message
```

### BullMQ: Two New Queues (`src/server/queues.ts`)

```
QUEUE_RESEARCH_PREMARKET  = 'research-premarket'
  Cron: '0 3 * * 1-5'  (UTC) = 8:30 AM IST, Mon–Fri
  Job: generateDailyReport(today, 'PRE_MARKET')

QUEUE_RESEARCH_POSTCLOSE  = 'research-postclose'  
  Cron: '45 10 * * 1-5' (UTC) = 4:15 PM IST, Mon–Fri
  Job: generateDailyReport(today, 'POST_CLOSE')
```

Both queues follow the existing pattern in `queues.ts`: exported Queue handle, Worker processor function, registered in `initQueues()`.

### tRPC Procedures (added to `src/server/router.ts`)

| Procedure | Input | Output | Cache TTL |
|---|---|---|---|
| `getDailyResearch` | `{ date?: string, type?: 'PRE_MARKET'\|'POST_CLOSE' }` | Full report object or null | None (always fresh) |
| `getDailyResearchHistory` | `{ limit?: number }` (default 7) | Array of report metadata (no JSON blobs) | 5 min |
| `triggerResearchGeneration` | `{ date: string, type: string }` | `{ queued: true }` | — |
| `getResearchStatus` | `{ date?: string, type?: string }` | `{ status, generated_at, error_message }` | None |

`getDailyResearch` with no args defaults to: today's POST_CLOSE if READY, else today's PRE_MARKET if READY, else most recent READY report of either type.

---

## Frontend

### New File: `src/components/HedgeFundResearch.tsx`

Single file component (~500 lines). Uses existing patterns: `trpc.*`, `motion/react`, Lucide icons, `glass`/`glass-strong` CSS classes, dark theme.

### Sub-components (all in same file as named functions)

| Component | Props | Purpose |
|---|---|---|
| `ResearchHeader` | `{ reportDate, reportType, onDateChange, onTypeChange, status }` | Date picker (7 days), PRE/POST toggle, regime badge, generation timestamp |
| `MarketContextBar` | `{ regime, sentimentScore, fiiNet5d, globalCue, themes }` | Always-visible market summary strip |
| `TopPicksTable` | `{ picks, onSelectStock, onAddWatchlist }` | Sortable 10-row table: rank, symbol, conviction score, entry, SL, T1, R:R, conviction dots |
| `StockDeepDive` | `{ pick, aiBlurbs, expanded, onToggle }` | Expandable per-stock panel: score breakdown bars (5 dimensions), AI bull/bear/risk text, technical indicators, fundamental metrics |
| `ResearchSidebar` | `{ avoidList, watchlist, sectorRankings }` | Three collapsible sections below main table |
| `ReportStatusBadge` | `{ status, generatedAt }` | PENDING/GENERATING (animated pulse)/READY/FAILED |

### Page Structure

```
HedgeFundResearch (root)
├── ResearchHeader
│   ├── Title + FlaskConical icon
│   ├── ReportStatusBadge
│   ├── Date selector (last 7 dates as pills)
│   └── Type toggle: [PRE-MARKET] [POST-CLOSE]
├── MarketContextBar (always visible, collapses on scroll)
├── TopPicksTable
│   └── rows: click to expand → StockDeepDive inline
├── ResearchSidebar
│   ├── Avoid List (red badges)
│   ├── Watchlist Candidates (yellow badges)
│   └── Sector Rankings (bar chart)
└── Empty/Loading/Error states
```

### Navigation

In `src/App.tsx`:
- Import `HedgeFundResearch` 
- Add `research` to the tab list with icon `FlaskConical`, label "Research"
- Position: between `signals` and `sentiment` tabs
- Route: `/research`

### Data Flow

```
Mount → getDailyResearch() [no args, auto-selects best available]
      → getResearchStatus() [poll every 30s ONLY if status = GENERATING]

Date/type change → getDailyResearch({ date, type })

Stock row click → toggle expanded state (no fetch — all data in report_json)

Add to watchlist → existing addToWatchlist tRPC procedure

Status = GENERATING → show skeleton loader + animated badge + retry poll
Status = FAILED     → show error message + "Regenerate" button → triggerResearchGeneration
Status = null       → show "Report not yet generated" + manual trigger button
```

### Rendering Without AI Blurbs

If `ai_blurbs_json` is null (AI unavailable during generation), `StockDeepDive` renders the score breakdown bars and metrics but omits the narrative section. No broken states.

---

## Non-Goals (explicitly excluded)

- No intraday report (only twice daily)
- No per-user personalization of picks
- No email/push delivery of reports
- No real-time price updates within the report (snapshot at generation time)
- No backtesting of report recommendations (separate backtest tab handles this)

---

## File Changelist

| File | Change |
|---|---|
| `src/server/db.ts` | Add `daily_research_reports` table creation |
| `src/server/researchEngine.ts` | **New** — full generation pipeline |
| `src/server/queues.ts` | Add 2 queues + 2 workers + register in `initQueues()` |
| `src/server/router.ts` | Add 4 tRPC procedures |
| `src/components/HedgeFundResearch.tsx` | **New** — full page component |
| `src/App.tsx` | Import component, add `research` tab + route |
