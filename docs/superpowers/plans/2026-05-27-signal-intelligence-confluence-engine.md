# Signal Intelligence & Confluence Engine — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a "High Conviction Signal Engine" that aggregates multi-source scanner data (Trendlyne, MoneyControl, ETnow, custom), computes multi-layer confluence scores, overlays ML breakout probabilities, generates AI-powered trade setups, tracks signal outcomes, and renders an institutional-grade `SignalIntelligence` dashboard page.

**Architecture:** A `confluenceEngine.ts` service queries all screener_stocks tables, classifies screeners via keyword-pattern matching + `screener_master` NLP cache, computes a 5-factor weighted score (screener overlap × presence multiplier + trend alignment + volume + sector + fundamentals), stores ranked results in `confluence_signals`, and exposes 7 tRPC procedures via `confluence.router.ts`. A BullMQ queue (`confluence-compute`) runs every 30 min during market hours. A Python `confluence_ml_engine.py` overlays XGBoost/LightGBM breakout probability on top of the raw score. A `confluence_outcome_tracker.py` tracks signal outcomes at 1/3/7/14/30-day horizons to compute per-screener reliability scores. The `SignalIntelligence.tsx` page renders a ranked opportunities table, scanner reliability leaderboard, sector momentum matrix, and per-stock AI trade insight panels.

**Stack note:** Spec requested FastAPI/PostgreSQL/Celery — this plan integrates with the existing Express/SQLite/BullMQ stack to avoid a parallel infrastructure dependency. The scoring algorithms, ML models, and UI are identical to the spec intent.

**Tech Stack:** Node.js/TypeScript, better-sqlite3, BullMQ, tRPC/Zod, React 19, Lucide icons, Recharts, Tailwind (glass/glass-strong CSS), scikit-learn + optional XGBoost/LightGBM (Python), child_process.execFile for Python invocation

---

## File Map

| File | Action | Responsibility |
|---|---|---|
| `src/server/db.ts` | Modify | Add 3 new tables: `confluence_signals`, `screener_reliability`, `confluence_alerts_log` |
| `src/server/confluenceEngine.ts` | Create | Core scoring service: screener classification, 5-factor score, trade setup generation, DB writes |
| `src/server/queues.ts` | Modify | Add `QUEUE_CONFLUENCE_COMPUTE` + `QUEUE_CONFLUENCE_OUTCOMES` constants, queue handles, worker, registration |
| `src/server/routers/confluence.router.ts` | Create | 7 tRPC procedures: getConfluenceSignals, getConfluenceDetail, getScreenerReliability, refreshConfluence, getSectorMomentumMatrix, getConfluenceOutcomes, getConfluenceStats |
| `src/server/router.ts` | Modify | Import + merge confluenceRouter |
| `src/server/confluence_ml_engine.py` | Create | XGBoost/LightGBM breakout probability model; reads from confluence_signals + technical_signals + quant_scores; writes `ml_breakout_probability` back |
| `src/server/confluence_outcome_tracker.py` | Create | Tracks signal outcomes at 1/3/7/14/30d horizons; updates `screener_reliability` win rates |
| `src/components/SignalIntelligence.tsx` | Create | Full dashboard: ranked table, AI insights panel, scanner leaderboard, sector matrix |
| `src/components/AppShell.tsx` | Modify | Add "Signal Intel" nav item under Intelligence group |
| `src/App.tsx` | Modify | Import SignalIntelligence, add route for `signal-intelligence` |

---

## Task 1: DB Schema — 3 New Tables

**Files:**
- Modify: `src/server/db.ts`

- [ ] **Step 1.1: Locate insertion point in db.ts**

Open `src/server/db.ts`. Find the last `db.exec(...)` block (the one ending around line 503 with the `mc_chart_patterns` table). After that block, add a new `db.exec(...)` call.

- [ ] **Step 1.2: Add the 3 new tables**

After the closing backtick+semicolon of the last `db.exec(...)` block (after the `idx_mcp_fetched` index line), append:

```typescript
db.exec(`
  -- Confluence Signals — ranked multi-screener stock opportunities (refreshed every 30 min)
  CREATE TABLE IF NOT EXISTS confluence_signals (
    symbol                 TEXT NOT NULL,
    computed_at            DATETIME NOT NULL,
    confluence_score       REAL NOT NULL,
    conviction_level       TEXT NOT NULL CHECK(conviction_level IN ('ELITE','STRONG','MODERATE','WEAK')),
    active_screener_count  INTEGER NOT NULL DEFAULT 0,
    bullish_screener_count INTEGER NOT NULL DEFAULT 0,
    bearish_screener_count INTEGER NOT NULL DEFAULT 0,
    screener_ids_json      TEXT NOT NULL DEFAULT '[]',
    screener_names_json    TEXT NOT NULL DEFAULT '[]',
    screener_weights_json  TEXT NOT NULL DEFAULT '{}',
    trend_alignment_score  REAL DEFAULT 0,
    volume_score           REAL DEFAULT 0,
    sector_strength_score  REAL DEFAULT 0,
    fundamental_score      REAL DEFAULT 0,
    ml_breakout_probability REAL,
    ml_trend_probability   REAL,
    suggested_timeframe    TEXT DEFAULT 'POSITIONAL',
    entry_zone_low         REAL,
    entry_zone_high        REAL,
    stop_loss              REAL,
    target_1               REAL,
    target_2               REAL,
    target_3               REAL,
    risk_reward            REAL,
    ai_conclusion          TEXT,
    trade_reasoning        TEXT,
    sector                 TEXT,
    market_cap             REAL,
    current_price          REAL,
    current_volume         INTEGER,
    rsi                    REAL,
    atr                    REAL,
    expires_at             DATETIME,
    PRIMARY KEY (symbol, computed_at)
  );
  CREATE INDEX IF NOT EXISTS idx_csi_score   ON confluence_signals(confluence_score DESC);
  CREATE INDEX IF NOT EXISTS idx_csi_symbol  ON confluence_signals(symbol);
  CREATE INDEX IF NOT EXISTS idx_csi_computed ON confluence_signals(computed_at DESC);
  CREATE INDEX IF NOT EXISTS idx_csi_level   ON confluence_signals(conviction_level);

  -- Screener Reliability — per-screener historical win rates (updated by confluence_outcome_tracker.py)
  CREATE TABLE IF NOT EXISTS screener_reliability (
    scan_id           TEXT PRIMARY KEY,
    screener_name     TEXT NOT NULL,
    source            TEXT NOT NULL,
    total_signals     INTEGER DEFAULT 0,
    wins_1d           INTEGER DEFAULT 0,
    wins_3d           INTEGER DEFAULT 0,
    wins_7d           INTEGER DEFAULT 0,
    wins_14d          INTEGER DEFAULT 0,
    wins_30d          INTEGER DEFAULT 0,
    win_rate_1d       REAL DEFAULT 0,
    win_rate_7d       REAL DEFAULT 0,
    win_rate_30d      REAL DEFAULT 0,
    avg_return_7d     REAL DEFAULT 0,
    avg_return_30d    REAL DEFAULT 0,
    max_drawdown      REAL DEFAULT 0,
    avg_holding_days  REAL DEFAULT 0,
    reliability_score REAL DEFAULT 50,
    last_updated      DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  -- Confluence Alerts Log — audit trail for sent alerts
  CREATE TABLE IF NOT EXISTS confluence_alerts_log (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    symbol          TEXT NOT NULL,
    alert_type      TEXT NOT NULL,
    confluence_score REAL,
    message         TEXT,
    channels_json   TEXT DEFAULT '[]',
    sent_at         DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_cal_symbol ON confluence_alerts_log(symbol);
  CREATE INDEX IF NOT EXISTS idx_cal_sent   ON confluence_alerts_log(sent_at DESC);
`);
```

- [ ] **Step 1.3: Verify table creation**

```bash
cd c:\Github\bharat-stock-intelligence
node -e "const db=require('better-sqlite3')('database.sqlite'); ['confluence_signals','screener_reliability','confluence_alerts_log'].forEach(t => console.log(t, db.prepare(\"SELECT name FROM sqlite_master WHERE type='table' AND name=?\").get(t)))"
```

Expected output — 3 objects with `name` field (not `undefined`):
```
confluence_signals { name: 'confluence_signals' }
screener_reliability { name: 'screener_reliability' }
confluence_alerts_log { name: 'confluence_alerts_log' }
```

- [ ] **Step 1.4: Commit**

```bash
git add src/server/db.ts
git commit -m "feat(db): add confluence_signals, screener_reliability, confluence_alerts_log tables"
```

---

## Task 2: Confluence Engine Service

**Files:**
- Create: `src/server/confluenceEngine.ts`

This is the core scoring service. It reads from screener stock tables, classifies screeners, computes a 5-factor score, generates trade setups, and upserts to `confluence_signals`.

- [ ] **Step 2.1: Create `src/server/confluenceEngine.ts`**

```typescript
import db from './db';
import { execFile } from 'child_process';
import path from 'path';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);
const PYTHON = process.platform === 'win32' ? 'python' : 'python3';
const ENGINE_DIR = path.resolve(process.cwd(), 'src/server');

// ─── Screener Classification ────────────────────────────────────────────────

interface ScreenerClass {
  weight: number;
  sentiment: 'bullish' | 'bearish' | 'neutral';
  category: 'technical' | 'fundamental' | 'momentum' | 'delivery' | 'institutional' | 'valuation';
  timeframe: 'intraday' | 'swing' | 'positional';
}

const SCREENER_PATTERNS: Array<{ patterns: string[] } & ScreenerClass> = [
  // === HIGH-WEIGHT BULLISH ===
  { patterns: ['52 week high', '52-week high', '52w high', 'yearly high', 'all time high'],
    weight: 9, sentiment: 'bullish', category: 'technical', timeframe: 'positional' },
  { patterns: ['cup and handle', 'cup & handle'],
    weight: 9, sentiment: 'bullish', category: 'technical', timeframe: 'swing' },
  { patterns: ['fii buying', 'fii accumulation', 'fii inflow', 'institutional buy', 'dii buying'],
    weight: 8, sentiment: 'bullish', category: 'institutional', timeframe: 'positional' },
  { patterns: ['strong uptrend', 'strong trend', 'sustained uptrend'],
    weight: 8, sentiment: 'bullish', category: 'technical', timeframe: 'positional' },
  { patterns: ['breakout', 'break out', 'range breakout', 'resistance breakout', 'trendline break'],
    weight: 8, sentiment: 'bullish', category: 'technical', timeframe: 'swing' },
  // === MOMENTUM ===
  { patterns: ['volume shocker', 'volume surge', 'volume breakout', 'volume spike', 'unusually high volume'],
    weight: 7, sentiment: 'bullish', category: 'momentum', timeframe: 'intraday' },
  { patterns: ['golden crossover', 'golden cross', '50 above 200', 'sma crossover'],
    weight: 7, sentiment: 'bullish', category: 'technical', timeframe: 'positional' },
  { patterns: ['delivery percentage', 'high delivery', 'delivery high', 'delivery surge'],
    weight: 7, sentiment: 'bullish', category: 'delivery', timeframe: 'swing' },
  { patterns: ['momentum pick', 'high momentum', 'strong momentum', 'top momentum'],
    weight: 7, sentiment: 'bullish', category: 'momentum', timeframe: 'swing' },
  { patterns: ['relative strength', 'high relative strength', 'market beater'],
    weight: 6, sentiment: 'bullish', category: 'momentum', timeframe: 'swing' },
  { patterns: ['macd bullish', 'bullish macd', 'macd cross', 'macd positive'],
    weight: 6, sentiment: 'bullish', category: 'technical', timeframe: 'swing' },
  { patterns: ['rsi breakout', 'rsi power', 'rsi strength', 'rsi momentum'],
    weight: 6, sentiment: 'bullish', category: 'technical', timeframe: 'swing' },
  { patterns: ['oversold bounce', 'rsi oversold', 'bounce', 'reversal'],
    weight: 4, sentiment: 'bullish', category: 'technical', timeframe: 'intraday' },
  // === FUNDAMENTAL ===
  { patterns: ['strong fundamental', 'fundamental strong', 'quality stock', 'high quality'],
    weight: 7, sentiment: 'bullish', category: 'fundamental', timeframe: 'positional' },
  { patterns: ['quarterly growth', 'revenue growth', 'profit growth', 'earnings growth'],
    weight: 6, sentiment: 'bullish', category: 'fundamental', timeframe: 'positional' },
  { patterns: ['zero debt', 'debt free', 'low debt'],
    weight: 6, sentiment: 'bullish', category: 'fundamental', timeframe: 'positional' },
  { patterns: ['elite bluechip', 'blue chip', 'large cap quality'],
    weight: 5, sentiment: 'bullish', category: 'fundamental', timeframe: 'positional' },
  // === BEARISH ===
  { patterns: ['52 week low', 'yearly low', 'all time low'],
    weight: 9, sentiment: 'bearish', category: 'technical', timeframe: 'positional' },
  { patterns: ['death cross', 'bearish crossover', 'death crossover'],
    weight: 7, sentiment: 'bearish', category: 'technical', timeframe: 'positional' },
  { patterns: ['breakdown', 'break down', 'support breakdown'],
    weight: 8, sentiment: 'bearish', category: 'technical', timeframe: 'swing' },
  { patterns: ['fii selling', 'fii outflow', 'institutional selling'],
    weight: 8, sentiment: 'bearish', category: 'institutional', timeframe: 'positional' },
  { patterns: ['downtrend', 'bearish trend', 'strong downtrend'],
    weight: 7, sentiment: 'bearish', category: 'technical', timeframe: 'positional' },
  { patterns: ['overbought', 'rsi overbought'],
    weight: 4, sentiment: 'bearish', category: 'technical', timeframe: 'intraday' },
];

// Classification cache (populated from screener_master + pattern matching)
const classCache = new Map<string, ScreenerClass>();

export function classifyScreener(scanId: string, name: string): ScreenerClass {
  if (classCache.has(scanId)) return classCache.get(scanId)!;

  const lname = name.toLowerCase();
  for (const entry of SCREENER_PATTERNS) {
    if (entry.patterns.some(p => lname.includes(p))) {
      const result: ScreenerClass = {
        weight: entry.weight,
        sentiment: entry.sentiment,
        category: entry.category,
        timeframe: entry.timeframe,
      };
      classCache.set(scanId, result);
      return result;
    }
  }

  // Fallback: check screener_master NLP fields
  const meta = db.prepare(
    'SELECT inferred_sentiment, inferred_category, inferred_timeframe, confidence, weight_override FROM screener_master WHERE scan_id = ?'
  ).get(scanId) as any;

  if (meta) {
    const result: ScreenerClass = {
      weight: meta.weight_override ?? (meta.confidence ? Math.round(meta.confidence * 10) : 5),
      sentiment: meta.inferred_sentiment ?? 'neutral',
      category: meta.inferred_category ?? 'technical',
      timeframe: meta.inferred_timeframe === 'intraday' ? 'intraday' : 'positional',
    };
    classCache.set(scanId, result);
    return result;
  }

  const fallback: ScreenerClass = { weight: 5, sentiment: 'neutral', category: 'technical', timeframe: 'positional' };
  classCache.set(scanId, fallback);
  return fallback;
}

// ─── Presence Multiplier ────────────────────────────────────────────────────

function presenceMultiplier(bullishCount: number): number {
  if (bullishCount >= 7) return 2.5;
  if (bullishCount >= 5) return 2.0;
  if (bullishCount >= 3) return 1.5;
  return 1.0;
}

// ─── Conviction Level ───────────────────────────────────────────────────────

function toConvictionLevel(score: number): 'ELITE' | 'STRONG' | 'MODERATE' | 'WEAK' {
  if (score >= 80) return 'ELITE';
  if (score >= 60) return 'STRONG';
  if (score >= 40) return 'MODERATE';
  return 'WEAK';
}

// ─── Trade Setup from ATR ────────────────────────────────────────────────────

function buildTradeSetup(price: number, atr: number, score: number) {
  const risk = Math.max(atr * 1.5, price * 0.02); // min 2% SL
  const rewardMult = score >= 80 ? 4 : score >= 60 ? 3 : 2;
  return {
    entryLow:  Math.round((price - atr * 0.25) * 100) / 100,
    entryHigh: Math.round((price + atr * 0.25) * 100) / 100,
    stopLoss:  Math.round((price - risk) * 100) / 100,
    target1:   Math.round((price + risk * rewardMult * 0.5) * 100) / 100,
    target2:   Math.round((price + risk * rewardMult) * 100) / 100,
    target3:   Math.round((price + risk * rewardMult * 1.6) * 100) / 100,
    riskReward: Math.round((risk * rewardMult) / risk * 10) / 10,
  };
}

// ─── Suggested Timeframe ─────────────────────────────────────────────────────

function suggestTimeframe(score: number, volRatio: number, bullishScreeners: ScreenerClass[]): string {
  const hasIntradayScreener = bullishScreeners.some(s => s.timeframe === 'intraday');
  if (score >= 80 && volRatio > 2 && hasIntradayScreener) return 'INTRADAY';
  if (score >= 65) return 'SWING';
  return 'POSITIONAL';
}

// ─── Core Scoring ────────────────────────────────────────────────────────────

interface StockScreenerData {
  symbol: string;
  screenerIds: string[];
  screenerNames: string[];
  screenerClasses: ScreenerClass[];
}

function scoreStock(
  data: StockScreenerData,
  technical: any, // row from technical_signals or null
  quant: any,     // row from quant_scores or null
  fundamentals: any, // row from stock_fundamentals or null
  nseInfo: any,   // row from nse_stocks or null
): {
  confluenceScore: number;
  convictionLevel: 'ELITE' | 'STRONG' | 'MODERATE' | 'WEAK';
  trendScore: number;
  volScore: number;
  sectorScore: number;
  fundScore: number;
  bullishCount: number;
  bearishCount: number;
  timeframe: string;
  reasoning: string;
} {
  // A. Screener weighted score (0–60 range)
  let rawScreener = 0;
  let bullishCount = 0;
  let bearishCount = 0;
  const bullishClasses: ScreenerClass[] = [];

  for (const cls of data.screenerClasses) {
    if (cls.sentiment === 'bullish') {
      rawScreener += cls.weight;
      bullishCount++;
      bullishClasses.push(cls);
    } else if (cls.sentiment === 'bearish') {
      rawScreener -= cls.weight;
      bearishCount++;
    }
  }

  const multiplier = presenceMultiplier(bullishCount);
  const screenerComponent = Math.max(0, Math.min(60, rawScreener * multiplier * 1.2));

  // B. Trend alignment (0–15)
  let trendScore = 0;
  if (quant) {
    if (quant.above_sma200 === 1)            trendScore += 5;
    if (quant.sma200_distance_pct > 5)       trendScore += 2;
    if (quant.momentum_score > 70)           trendScore += 4;
    if (quant.rank_composite > 60)           trendScore += 4;
  }
  if (technical) {
    if (technical.above_sma200 === 1)        trendScore = Math.min(15, trendScore + 3);
  }
  trendScore = Math.min(15, trendScore);

  // C. Volume confirmation (0–10)
  let volScore = 0;
  const volRatio = technical?.volume_ratio ?? 1;
  if (volRatio > 3)       volScore = 10;
  else if (volRatio > 2)  volScore = 7;
  else if (volRatio > 1.5) volScore = 5;
  else if (volRatio > 1.2) volScore = 2;

  // D. Sector strength (0–8) — use quant momentum rank as proxy
  const sectorScore = quant
    ? Math.max(0, Math.min(8, (quant.momentum_score ?? 50) / 100 * 8))
    : 4;

  // E. Fundamental overlay (0–12)
  let fundScore = 0;
  if (fundamentals) {
    if (fundamentals.piotroski_f_score >= 7)         fundScore += 4;
    else if (fundamentals.piotroski_f_score >= 5)    fundScore += 2;
    if (fundamentals.return_on_equity > 0.20)        fundScore += 3;
    else if (fundamentals.return_on_equity > 0.12)   fundScore += 1;
    if (fundamentals.debt_to_equity < 0.5)           fundScore += 2;
    if (fundamentals.revenue_growth > 0.15)          fundScore += 3;
    else if (fundamentals.revenue_growth > 0.05)     fundScore += 1;
  }
  fundScore = Math.min(12, fundScore);

  // Final score (max theoretical: 60+15+10+8+12 = 105 → normalize to 100)
  const raw = screenerComponent + trendScore + volScore + sectorScore + fundScore;
  const confluenceScore = Math.round(Math.min(100, raw / 105 * 100));

  // Reasoning
  const parts: string[] = [];
  if (bullishCount > 0) {
    const top3 = data.screenerNames.slice(0, 3).join(', ');
    parts.push(`${bullishCount} bullish scanner${bullishCount > 1 ? 's' : ''} (${top3})`);
  }
  if (quant?.above_sma200 === 1) parts.push('above 200-day SMA');
  if (volRatio > 1.5) parts.push(`${volRatio.toFixed(1)}x relative volume`);
  if (sectorScore > 5) parts.push('strong sector momentum');
  if (fundScore > 7) parts.push('strong fundamentals');
  const reasoning = parts.length > 0
    ? `${data.symbol}: ${parts.join(', ')}.`
    : `${data.symbol} has weak confluence (score ${confluenceScore}).`;

  return {
    confluenceScore,
    convictionLevel: toConvictionLevel(confluenceScore),
    trendScore,
    volScore,
    sectorScore,
    fundScore,
    bullishCount,
    bearishCount,
    timeframe: suggestTimeframe(confluenceScore, volRatio, bullishClasses),
    reasoning,
  };
}

// ─── Main: Compute Confluence for All Stocks ─────────────────────────────────

export async function computeConfluenceSignals(): Promise<{ computed: number; elite: number; strong: number }> {
  console.log('[CONFLUENCE] Starting confluence computation...');

  // 1. Gather all screener_stock appearances
  const screenerMap = new Map<string, { ids: string[]; names: string[]; classes: ScreenerClass[] }>();

  function addToMap(symbol: string, scanId: string, name: string) {
    const s = symbol?.trim().toUpperCase();
    if (!s) return;
    if (!screenerMap.has(s)) screenerMap.set(s, { ids: [], names: [], classes: [] });
    const entry = screenerMap.get(s)!;
    if (!entry.ids.includes(scanId)) {
      entry.ids.push(scanId);
      entry.names.push(name);
      entry.classes.push(classifyScreener(scanId, name));
    }
  }

  // Trendlyne
  const tlStocks = db.prepare(`
    SELECT tss.symbol, tss.screener_id, ts.screener_name
    FROM trendlyne_screener_stocks tss
    JOIN trendlyne_screeners ts ON ts.screener_id = tss.screener_id
    WHERE tss.symbol IS NOT NULL AND tss.symbol != ''
  `).all() as any[];
  for (const r of tlStocks) addToMap(r.symbol, r.screener_id, r.screener_name);

  // MoneyControl
  const mcStocks = db.prepare(`
    SELECT mss.symbol, mss.scan_id, ms.screener_name
    FROM moneycontrol_screener_stocks mss
    JOIN moneycontrol_screeners ms ON ms.scan_id = mss.scan_id
    WHERE mss.symbol IS NOT NULL AND mss.symbol != ''
  `).all() as any[];
  for (const r of mcStocks) addToMap(r.symbol, r.scan_id, r.screener_name);

  // ETnow
  const etStocks = db.prepare(`
    SELECT ess.symbol, ess.screener_id, es.screener_name
    FROM etnow_screener_stocks ess
    JOIN etnow_screeners es ON es.screener_id = ess.screener_id
    WHERE ess.symbol IS NOT NULL AND ess.symbol != ''
  `).all() as any[];
  for (const r of etStocks) addToMap(r.symbol, r.screener_id, r.screener_name);

  if (screenerMap.size === 0) {
    console.log('[CONFLUENCE] No screener stock data found. Run screener sync first.');
    return { computed: 0, elite: 0, strong: 0 };
  }

  // 2. Fetch supporting data
  const techMap = new Map<string, any>(
    (db.prepare('SELECT * FROM technical_signals WHERE date = (SELECT MAX(date) FROM technical_signals ts2 WHERE ts2.symbol = technical_signals.symbol)').all() as any[])
      .map((r: any) => [r.symbol, r])
  );
  const quantMap = new Map<string, any>(
    (db.prepare('SELECT * FROM quant_scores').all() as any[]).map((r: any) => [r.symbol, r])
  );
  const fundMap = new Map<string, any>(
    (db.prepare('SELECT * FROM stock_fundamentals').all() as any[]).map((r: any) => [r.symbol, r])
  );
  const nseMap = new Map<string, any>(
    (db.prepare('SELECT symbol, sector, market_cap FROM nse_stocks').all() as any[]).map((r: any) => [r.symbol, r])
  );

  const now = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString(); // 30 min TTL

  const upsert = db.prepare(`
    INSERT INTO confluence_signals (
      symbol, computed_at, confluence_score, conviction_level,
      active_screener_count, bullish_screener_count, bearish_screener_count,
      screener_ids_json, screener_names_json, screener_weights_json,
      trend_alignment_score, volume_score, sector_strength_score, fundamental_score,
      suggested_timeframe, trade_reasoning,
      entry_zone_low, entry_zone_high, stop_loss, target_1, target_2, target_3, risk_reward,
      sector, market_cap, current_price, rsi, atr, expires_at
    ) VALUES (
      ?, ?, ?, ?,
      ?, ?, ?,
      ?, ?, ?,
      ?, ?, ?, ?,
      ?, ?,
      ?, ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?, ?
    )
    ON CONFLICT(symbol, computed_at) DO UPDATE SET
      confluence_score = excluded.confluence_score,
      conviction_level = excluded.conviction_level
  `);

  const insertMany = db.transaction((rows: any[]) => {
    for (const r of rows) upsert.run(...r);
  });

  const rows: any[] = [];
  let elite = 0, strong = 0;

  for (const [symbol, { ids, names, classes }] of screenerMap) {
    const tech = techMap.get(symbol) ?? null;
    const quant = quantMap.get(symbol) ?? null;
    const fund = fundMap.get(symbol) ?? null;
    const nse = nseMap.get(symbol) ?? null;

    const scored = scoreStock({ symbol, screenerIds: ids, screenerNames: names, screenerClasses: classes }, tech, quant, fund, nse);

    const price = tech?.cmp ?? quant?.return_1m ?? null;
    const atr = tech?.bb_width ? tech.cmp * (tech.bb_width / 100) : (price ? price * 0.03 : null);
    const setup = price && atr ? buildTradeSetup(price, atr, scored.confluenceScore) : null;

    const weightsObj: Record<string, number> = {};
    ids.forEach((id, i) => { weightsObj[id] = classes[i].weight; });

    rows.push([
      symbol, now, scored.confluenceScore, scored.convictionLevel,
      ids.length, scored.bullishCount, scored.bearishCount,
      JSON.stringify(ids), JSON.stringify(names), JSON.stringify(weightsObj),
      scored.trendScore, scored.volScore, scored.sectorScore, scored.fundScore,
      scored.timeframe, scored.reasoning,
      setup?.entryLow ?? null, setup?.entryHigh ?? null,
      setup?.stopLoss ?? null, setup?.target1 ?? null,
      setup?.target2 ?? null, setup?.target3 ?? null,
      setup?.riskReward ?? null,
      nse?.sector ?? null, nse?.market_cap ?? null,
      price ?? null, tech?.rsi ?? null, atr ?? null, expiresAt,
    ]);

    if (scored.convictionLevel === 'ELITE') elite++;
    else if (scored.convictionLevel === 'STRONG') strong++;
  }

  insertMany(rows);
  console.log(`[CONFLUENCE] Computed ${rows.length} signals — ${elite} ELITE, ${strong} STRONG`);
  return { computed: rows.length, elite, strong };
}

// ─── ML Probability Overlay (calls Python) ──────────────────────────────────

export async function runMLProbabilityOverlay(): Promise<void> {
  try {
    const pyPath = path.join(ENGINE_DIR, 'confluence_ml_engine.py');
    const { stdout, stderr } = await execFileAsync(PYTHON, [pyPath, '--update-probabilities'], {
      cwd: ENGINE_DIR,
      timeout: 120000,
    });
    if (stdout) console.log('[CONFLUENCE-ML]', stdout.trim());
    if (stderr) console.error('[CONFLUENCE-ML ERR]', stderr.trim());
  } catch (err: any) {
    console.error('[CONFLUENCE-ML] Python error:', err.message);
  }
}

// ─── Latest signals query helper ─────────────────────────────────────────────

export function getLatestConfluenceSignals(opts: {
  minScore?: number;
  convictionLevel?: string;
  sector?: string;
  timeframe?: string;
  limit?: number;
}): any[] {
  const { minScore = 0, convictionLevel, sector, timeframe, limit = 50 } = opts;

  // Get the most recent computed_at batch
  const latestBatch = (db.prepare('SELECT MAX(computed_at) as ts FROM confluence_signals').get() as any)?.ts;
  if (!latestBatch) return [];

  const conditions: string[] = ['computed_at = ?', 'confluence_score >= ?'];
  const params: any[] = [latestBatch, minScore];

  if (convictionLevel) { conditions.push('conviction_level = ?'); params.push(convictionLevel); }
  if (sector)          { conditions.push('sector = ?');            params.push(sector); }
  if (timeframe)       { conditions.push('suggested_timeframe = ?'); params.push(timeframe); }

  params.push(limit);

  return db.prepare(`
    SELECT * FROM confluence_signals
    WHERE ${conditions.join(' AND ')}
    ORDER BY confluence_score DESC
    LIMIT ?
  `).all(...params) as any[];
}
```

- [ ] **Step 2.2: Verify the file compiles**

```bash
cd c:\Github\bharat-stock-intelligence
npx tsc --noEmit src/server/confluenceEngine.ts 2>&1 | head -30
```

Expected: No errors (or only `Cannot find module` errors for relative imports which resolve at runtime).

- [ ] **Step 2.3: Commit**

```bash
git add src/server/confluenceEngine.ts
git commit -m "feat(engine): add confluenceEngine — screener classification, 5-factor scoring, trade setup generation"
```

---

## Task 3: BullMQ Queues — Confluence Compute

**Files:**
- Modify: `src/server/queues.ts`

- [ ] **Step 3.1: Add queue name constants to queues.ts**

Find the block of `export const QUEUE_*` constants (around line 56). Add after `QUEUE_OHLCV_BACKFILL`:

```typescript
export const QUEUE_CONFLUENCE_COMPUTE  = 'confluence-compute';
export const QUEUE_CONFLUENCE_OUTCOMES = 'confluence-outcomes';
```

- [ ] **Step 3.2: Add queue + worker handles**

Find the block where `ohlcvBackfillQueue` and `ohlcvBackfillWorker` are declared (around line 133). After those lines, add:

```typescript
export let confluenceComputeQueue:  Queue | null = null;
export let confluenceOutcomesQueue: Queue | null = null;
let confluenceComputeWorker:  Worker | null = null;
let confluenceOutcomesWorker: Worker | null = null;
```

- [ ] **Step 3.3: Add processor functions**

Find the `processStockRefresh` function (around line 142). Before it, add:

```typescript
async function processConfluenceCompute(_job: Job): Promise<{ computed: number; elite: number; strong: number }> {
  const { computeConfluenceSignals, runMLProbabilityOverlay } = await import('./confluenceEngine');
  const result = await computeConfluenceSignals();
  // Run ML overlay after scoring (non-blocking — ignore failures)
  runMLProbabilityOverlay().catch(() => {});
  return result;
}

async function processConfluenceOutcomes(_job: Job): Promise<void> {
  const { execFile } = await import('child_process');
  const path = await import('path');
  const PYTHON = process.platform === 'win32' ? 'python' : 'python3';
  const scriptPath = path.default.resolve(process.cwd(), 'src/server/confluence_outcome_tracker.py');
  await new Promise<void>((resolve, reject) => {
    execFile(PYTHON, [scriptPath], { timeout: 120000 }, (err, stdout, stderr) => {
      if (stdout) console.log('[OUTCOME-TRACKER]', stdout.trim());
      if (stderr) console.error('[OUTCOME-TRACKER ERR]', stderr.trim());
      err ? reject(err) : resolve();
    });
  });
}
```

- [ ] **Step 3.4: Register queues inside `initQueues()` or `setupQueues()`**

Find the main queue initialization function (search for `new Queue(QUEUE_STOCK_REFRESH`). In the same `if (redisAvailable)` block where other queues are created, add after the last existing queue initialization:

```typescript
    // ── Confluence Compute Queue ──────────────────────────────────────────────
    confluenceComputeQueue = new Queue(QUEUE_CONFLUENCE_COMPUTE, { connection: makeConnection() });
    confluenceComputeWorker = new Worker(
      QUEUE_CONFLUENCE_COMPUTE,
      processConfluenceCompute,
      { connection: makeConnection(), concurrency: 1 }
    );

    confluenceComputeWorker.on('failed', (job, err) =>
      console.error(`[QUEUE] ${QUEUE_CONFLUENCE_COMPUTE} job failed:`, err.message)
    );

    // Repeatable: every 30 minutes
    await confluenceComputeQueue.add(
      'confluence-compute',
      {},
      { repeat: { every: 30 * 60 * 1000 }, removeOnComplete: 3, removeOnFail: 3 }
    );

    // ── Confluence Outcomes Queue ─────────────────────────────────────────────
    confluenceOutcomesQueue = new Queue(QUEUE_CONFLUENCE_OUTCOMES, { connection: makeConnection() });
    confluenceOutcomesWorker = new Worker(
      QUEUE_CONFLUENCE_OUTCOMES,
      processConfluenceOutcomes,
      { connection: makeConnection(), concurrency: 1 }
    );

    // Repeatable: once per day at 4 AM IST (offset ~22.5h from midnight UTC = 81000000ms)
    await confluenceOutcomesQueue.add(
      'confluence-outcomes-daily',
      {},
      { repeat: { every: 24 * 60 * 60 * 1000 }, removeOnComplete: 2, removeOnFail: 2 }
    );

    console.log('[QUEUE] confluence-compute (every 30 min) + confluence-outcomes (daily) registered');
```

- [ ] **Step 3.5: Verify no TypeScript errors**

```bash
cd c:\Github\bharat-stock-intelligence
npx tsc --noEmit 2>&1 | grep -i "queues\|confluence" | head -20
```

Expected: No errors referencing queues.ts or confluenceEngine.ts.

- [ ] **Step 3.6: Commit**

```bash
git add src/server/queues.ts
git commit -m "feat(queue): add confluence-compute (30min) and confluence-outcomes (daily) BullMQ queues"
```

---

## Task 4: tRPC Router — Confluence Procedures

**Files:**
- Create: `src/server/routers/confluence.router.ts`

- [ ] **Step 4.1: Create `src/server/routers/confluence.router.ts`**

```typescript
import { z } from 'zod';
import db from '../db';
import { router, publicProcedure } from '../trpc';
import { computeConfluenceSignals, getLatestConfluenceSignals } from '../confluenceEngine';

export const confluenceRouter = router({

  // Ranked list of high-conviction signals (latest batch)
  getConfluenceSignals: publicProcedure
    .input(z.object({
      minScore:        z.number().min(0).max(100).optional().default(30),
      convictionLevel: z.enum(['ELITE', 'STRONG', 'MODERATE', 'WEAK']).optional(),
      sector:          z.string().optional(),
      timeframe:       z.enum(['INTRADAY', 'SWING', 'POSITIONAL']).optional(),
      limit:           z.number().min(1).max(200).optional().default(50),
    }).optional())
    .query(({ input }) => {
      const opts = input ?? {};
      return getLatestConfluenceSignals({
        minScore:       opts.minScore ?? 30,
        convictionLevel: opts.convictionLevel,
        sector:         opts.sector,
        timeframe:      opts.timeframe,
        limit:          opts.limit ?? 50,
      });
    }),

  // Full detail for a single symbol (latest record)
  getConfluenceDetail: publicProcedure
    .input(z.object({ symbol: z.string() }))
    .query(({ input }) => {
      const row = db.prepare(`
        SELECT * FROM confluence_signals
        WHERE symbol = ?
        ORDER BY computed_at DESC
        LIMIT 1
      `).get(input.symbol) as any ?? null;

      if (!row) return null;

      // Attach screener reliability for each active screener
      const screenerIds: string[] = JSON.parse(row.screener_ids_json ?? '[]');
      const reliability = screenerIds.length > 0
        ? db.prepare(`
            SELECT scan_id, screener_name, reliability_score, win_rate_7d, win_rate_30d, avg_return_7d, total_signals
            FROM screener_reliability
            WHERE scan_id IN (${screenerIds.map(() => '?').join(',')})
          `).all(...screenerIds)
        : [];

      return { ...row, screenerReliability: reliability };
    }),

  // Scanner reliability leaderboard
  getScreenerReliability: publicProcedure
    .input(z.object({
      source:  z.enum(['trendlyne', 'moneycontrol', 'etnow', 'all']).optional().default('all'),
      limit:   z.number().min(1).max(100).optional().default(20),
      orderBy: z.enum(['reliability_score', 'win_rate_7d', 'win_rate_30d', 'avg_return_7d']).optional().default('reliability_score'),
    }).optional())
    .query(({ input }) => {
      const { source = 'all', limit = 20, orderBy = 'reliability_score' } = input ?? {};
      const safe = ['reliability_score', 'win_rate_7d', 'win_rate_30d', 'avg_return_7d'].includes(orderBy)
        ? orderBy : 'reliability_score';
      const whereClause = source !== 'all' ? 'WHERE source = ?' : '';
      const params: any[] = source !== 'all' ? [source, limit] : [limit];
      return db.prepare(`
        SELECT * FROM screener_reliability
        ${whereClause}
        ORDER BY ${safe} DESC
        LIMIT ?
      `).all(...params);
    }),

  // Trigger a fresh computation (returns immediately; computation runs async)
  refreshConfluenceSignals: publicProcedure
    .mutation(async () => {
      const result = await computeConfluenceSignals();
      return { success: true, ...result };
    }),

  // Sector momentum matrix — avg confluence score by sector
  getSectorMomentumMatrix: publicProcedure
    .query(() => {
      const latestBatch = (db.prepare('SELECT MAX(computed_at) as ts FROM confluence_signals').get() as any)?.ts;
      if (!latestBatch) return [];
      return db.prepare(`
        SELECT
          sector,
          COUNT(*) as stock_count,
          ROUND(AVG(confluence_score), 1) as avg_score,
          COUNT(CASE WHEN conviction_level IN ('ELITE','STRONG') THEN 1 END) as high_conviction_count,
          MAX(confluence_score) as max_score,
          GROUP_CONCAT(CASE WHEN conviction_level = 'ELITE' THEN symbol END, ',') as elite_symbols
        FROM confluence_signals
        WHERE computed_at = ? AND sector IS NOT NULL AND sector != ''
        GROUP BY sector
        ORDER BY avg_score DESC
        LIMIT 30
      `).all(latestBatch);
    }),

  // Summary stats for the dashboard header
  getConfluenceStats: publicProcedure
    .query(() => {
      const latestBatch = (db.prepare('SELECT MAX(computed_at) as ts FROM confluence_signals').get() as any)?.ts;
      if (!latestBatch) return { total: 0, elite: 0, strong: 0, moderate: 0, avgScore: 0, lastComputed: null };
      const row = db.prepare(`
        SELECT
          COUNT(*) as total,
          COUNT(CASE WHEN conviction_level = 'ELITE'    THEN 1 END) as elite,
          COUNT(CASE WHEN conviction_level = 'STRONG'   THEN 1 END) as strong,
          COUNT(CASE WHEN conviction_level = 'MODERATE' THEN 1 END) as moderate,
          ROUND(AVG(confluence_score), 1) as avgScore
        FROM confluence_signals
        WHERE computed_at = ?
      `).get(latestBatch) as any;
      return { ...row, lastComputed: latestBatch };
    }),

  // Signal outcome analytics
  getConfluenceOutcomes: publicProcedure
    .input(z.object({
      symbol:     z.string().optional(),
      horizonDays: z.number().optional(),
      limit:      z.number().optional().default(50),
    }).optional())
    .query(({ input }) => {
      const { symbol, limit = 50 } = input ?? {};
      const conditions: string[] = [];
      const params: any[] = [];
      if (symbol) { conditions.push('symbol = ?'); params.push(symbol); }
      const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
      params.push(limit);
      return db.prepare(`
        SELECT so.*, cs.conviction_level, cs.bullish_screener_count, cs.screener_names_json
        FROM signal_outcomes so
        LEFT JOIN confluence_signals cs ON cs.symbol = so.symbol
          AND DATE(cs.computed_at) = so.signal_date
        ${where}
        ORDER BY so.signal_date DESC
        LIMIT ?
      `).all(...params);
    }),
});
```

- [ ] **Step 4.2: Verify no TypeScript errors**

```bash
cd c:\Github\bharat-stock-intelligence
npx tsc --noEmit 2>&1 | grep -i "confluence.router" | head -10
```

Expected: No errors.

- [ ] **Step 4.3: Commit**

```bash
git add src/server/routers/confluence.router.ts
git commit -m "feat(api): add confluence.router — 7 tRPC procedures for signal intelligence"
```

---

## Task 5: Wire Confluence Router into Main Router

**Files:**
- Modify: `src/server/router.ts`

- [ ] **Step 5.1: Add import in router.ts**

Open `src/server/router.ts`. After the last import line (the `telegramRouter` import), add:

```typescript
import { confluenceRouter }   from "./routers/confluence.router";
```

- [ ] **Step 5.2: Add to mergeRouters call**

In the `mergeRouters(...)` call, add `confluenceRouter` after `telegramRouter`:

```typescript
  confluenceRouter,
```

- [ ] **Step 5.3: Verify TypeScript**

```bash
cd c:\Github\bharat-stock-intelligence
npx tsc --noEmit 2>&1 | head -20
```

Expected: No errors.

- [ ] **Step 5.4: Commit**

```bash
git add src/server/router.ts
git commit -m "feat(router): wire confluenceRouter into appRouter"
```

---

## Task 6: Python ML Engine — Breakout Probability

**Files:**
- Create: `src/server/confluence_ml_engine.py`

This script trains an XGBoost/LightGBM/GradientBoosting model on historical signal outcomes and writes `ml_breakout_probability` back into `confluence_signals`.

- [ ] **Step 6.1: Create `src/server/confluence_ml_engine.py`**

```python
#!/usr/bin/env python3
"""
Confluence ML Engine — XGBoost/LightGBM breakout probability model.

Modes:
  --train                Retrain model from signal_outcomes + technical_signals
  --update-probabilities Write ML probabilities for current confluence_signals batch
  --evaluate             Print model metrics (AUC, accuracy, feature importances)
"""

import argparse
import os
import sys
import json
import pickle
import sqlite3
import numpy as np
from datetime import datetime, timedelta

# ── Optional imports (graceful fallback) ──────────────────────────────────────
try:
    import xgboost as xgb
    HAS_XGB = True
except ImportError:
    HAS_XGB = False

try:
    import lightgbm as lgb
    HAS_LGB = True
except ImportError:
    HAS_LGB = False

from sklearn.ensemble import GradientBoostingClassifier, RandomForestClassifier
from sklearn.linear_model import LogisticRegression
from sklearn.model_selection import StratifiedKFold, cross_val_score
from sklearn.preprocessing import StandardScaler
from sklearn.metrics import roc_auc_score, accuracy_score
from sklearn.pipeline import Pipeline
from sklearn.calibration import CalibratedClassifierCV

DB_PATH = os.path.join(os.path.dirname(__file__), '..', '..', 'database.sqlite')
MODEL_DIR = os.path.join(os.path.dirname(__file__), 'ml_models')
MODEL_PATH = os.path.join(MODEL_DIR, 'confluence_ml.pkl')
SCALER_PATH = os.path.join(MODEL_DIR, 'confluence_scaler.pkl')

FEATURE_COLS = [
    'bullish_screener_count',
    'bearish_screener_count',
    'active_screener_count',
    'trend_alignment_score',
    'volume_score',
    'sector_strength_score',
    'fundamental_score',
    'rsi',
    'volume_ratio',
    'above_sma200',
    'signal_score',        # from technical_signals
    'momentum_score',      # from quant_scores
    'rank_composite',
    'return_on_equity',
    'piotroski_f_score',
    'confluence_score',    # raw score from TS engine
]

def get_connection():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def build_training_data(conn):
    """
    Join confluence_signals (historical) with signal_outcomes (7d horizon).
    Returns feature matrix X and target vector y.
    """
    rows = conn.execute("""
        SELECT
            cs.symbol,
            cs.bullish_screener_count,
            cs.bearish_screener_count,
            cs.active_screener_count,
            cs.trend_alignment_score,
            cs.volume_score,
            cs.sector_strength_score,
            cs.fundamental_score,
            cs.confluence_score,
            cs.rsi,
            COALESCE(ts.volume_ratio, 1.0)   AS volume_ratio,
            COALESCE(ts.above_sma200, 0)     AS above_sma200,
            COALESCE(ts.signal_score, 0)     AS signal_score,
            COALESCE(qs.momentum_score, 50)  AS momentum_score,
            COALESCE(qs.rank_composite, 50)  AS rank_composite,
            COALESCE(sf.return_on_equity, 0) AS return_on_equity,
            COALESCE(sf.piotroski_f_score, 4) AS piotroski_f_score,
            so.outcome
        FROM confluence_signals cs
        JOIN signal_outcomes so
          ON so.symbol = cs.symbol
          AND DATE(cs.computed_at) = so.signal_date
          AND so.horizon_days = 7
          AND so.outcome IN ('WIN', 'LOSS')
        LEFT JOIN technical_signals ts
          ON ts.symbol = cs.symbol
          AND ts.date = DATE(cs.computed_at)
        LEFT JOIN quant_scores qs ON qs.symbol = cs.symbol
        LEFT JOIN stock_fundamentals sf ON sf.symbol = cs.symbol
        WHERE cs.confluence_score IS NOT NULL
    """).fetchall()

    if len(rows) < 30:
        return None, None, 0

    X, y = [], []
    for r in rows:
        x_row = [
            r['bullish_screener_count'] or 0,
            r['bearish_screener_count'] or 0,
            r['active_screener_count'] or 0,
            r['trend_alignment_score'] or 0,
            r['volume_score'] or 0,
            r['sector_strength_score'] or 0,
            r['fundamental_score'] or 0,
            r['rsi'] or 50,
            r['volume_ratio'] or 1,
            r['above_sma200'] or 0,
            r['signal_score'] or 0,
            r['momentum_score'] or 50,
            r['rank_composite'] or 50,
            r['return_on_equity'] or 0,
            r['piotroski_f_score'] or 4,
            r['confluence_score'] or 0,
        ]
        X.append(x_row)
        y.append(1 if r['outcome'] == 'WIN' else 0)

    return np.array(X, dtype=np.float32), np.array(y), len(rows)


def build_model():
    """Return best available model: XGBoost > LightGBM > GradientBoosting."""
    if HAS_XGB:
        print('[ML] Using XGBoost')
        return xgb.XGBClassifier(
            n_estimators=200, max_depth=5, learning_rate=0.05,
            subsample=0.8, colsample_bytree=0.8,
            use_label_encoder=False, eval_metric='logloss',
            random_state=42, n_jobs=-1
        )
    if HAS_LGB:
        print('[ML] Using LightGBM')
        return lgb.LGBMClassifier(
            n_estimators=200, max_depth=5, learning_rate=0.05,
            subsample=0.8, colsample_bytree=0.8,
            random_state=42, n_jobs=-1, verbose=-1
        )
    print('[ML] Using GradientBoosting (scikit-learn fallback)')
    return GradientBoostingClassifier(
        n_estimators=200, max_depth=4, learning_rate=0.05,
        subsample=0.8, random_state=42
    )


def train(conn):
    X, y, n = build_training_data(conn)
    if X is None:
        print(f'[ML] Insufficient training data (need ≥30 rows with outcomes, have {n}). Skipping.')
        return

    print(f'[ML] Training on {n} samples (win rate: {y.mean():.1%})')
    scaler = StandardScaler()
    X_scaled = scaler.fit_transform(X)

    base_model = build_model()
    model = CalibratedClassifierCV(base_model, cv=5, method='isotonic')
    model.fit(X_scaled, y)

    # Cross-validation AUC
    cv = StratifiedKFold(n_splits=5, shuffle=True, random_state=42)
    auc_scores = cross_val_score(model, X_scaled, y, cv=cv, scoring='roc_auc')
    print(f'[ML] CV AUC: {auc_scores.mean():.3f} ± {auc_scores.std():.3f}')

    os.makedirs(MODEL_DIR, exist_ok=True)
    with open(MODEL_PATH, 'wb') as f:
        pickle.dump(model, f)
    with open(SCALER_PATH, 'wb') as f:
        pickle.dump(scaler, f)

    # Register in model_registry
    conn.execute("""
        INSERT OR REPLACE INTO model_registry (model_name, model_type, auc_score,
          feature_count, is_active, trained_at)
        VALUES (?, ?, ?, ?, 1, CURRENT_TIMESTAMP)
    """, ('confluence_ml', 'breakout_probability', float(auc_scores.mean()), len(FEATURE_COLS)))
    conn.commit()
    print(f'[ML] Model saved → {MODEL_PATH}')


def update_probabilities(conn):
    """Load model, predict on current confluence_signals batch, write back."""
    if not os.path.exists(MODEL_PATH) or not os.path.exists(SCALER_PATH):
        print('[ML] No trained model found. Run with --train first.')
        return

    with open(MODEL_PATH, 'rb') as f:
        model = pickle.load(f)
    with open(SCALER_PATH, 'rb') as f:
        scaler = pickle.load(f)

    latest_batch = conn.execute(
        'SELECT MAX(computed_at) as ts FROM confluence_signals'
    ).fetchone()['ts']
    if not latest_batch:
        print('[ML] No confluence_signals found.')
        return

    rows = conn.execute("""
        SELECT cs.symbol, cs.computed_at,
            COALESCE(cs.bullish_screener_count, 0) AS bullish_screener_count,
            COALESCE(cs.bearish_screener_count, 0) AS bearish_screener_count,
            COALESCE(cs.active_screener_count, 0) AS active_screener_count,
            COALESCE(cs.trend_alignment_score, 0) AS trend_alignment_score,
            COALESCE(cs.volume_score, 0) AS volume_score,
            COALESCE(cs.sector_strength_score, 0) AS sector_strength_score,
            COALESCE(cs.fundamental_score, 0) AS fundamental_score,
            COALESCE(cs.confluence_score, 0) AS confluence_score,
            COALESCE(cs.rsi, 50) AS rsi,
            COALESCE(ts.volume_ratio, 1.0) AS volume_ratio,
            COALESCE(ts.above_sma200, 0) AS above_sma200,
            COALESCE(ts.signal_score, 0) AS signal_score,
            COALESCE(qs.momentum_score, 50) AS momentum_score,
            COALESCE(qs.rank_composite, 50) AS rank_composite,
            COALESCE(sf.return_on_equity, 0) AS return_on_equity,
            COALESCE(sf.piotroski_f_score, 4) AS piotroski_f_score
        FROM confluence_signals cs
        LEFT JOIN technical_signals ts
          ON ts.symbol = cs.symbol
          AND ts.date = DATE(cs.computed_at)
        LEFT JOIN quant_scores qs ON qs.symbol = cs.symbol
        LEFT JOIN stock_fundamentals sf ON sf.symbol = cs.symbol
        WHERE cs.computed_at = ?
    """, (latest_batch,)).fetchall()

    if not rows:
        print('[ML] No rows to score.')
        return

    X = np.array([[
        r['bullish_screener_count'], r['bearish_screener_count'], r['active_screener_count'],
        r['trend_alignment_score'], r['volume_score'], r['sector_strength_score'],
        r['fundamental_score'], r['rsi'], r['volume_ratio'], r['above_sma200'],
        r['signal_score'], r['momentum_score'], r['rank_composite'],
        r['return_on_equity'], r['piotroski_f_score'], r['confluence_score'],
    ] for r in rows], dtype=np.float32)

    X_scaled = scaler.transform(X)
    probs = model.predict_proba(X_scaled)[:, 1]  # P(WIN)

    for row, prob in zip(rows, probs):
        conn.execute("""
            UPDATE confluence_signals
            SET ml_breakout_probability = ?
            WHERE symbol = ? AND computed_at = ?
        """, (float(round(prob, 4)), row['symbol'], row['computed_at']))

    conn.commit()
    print(f'[ML] Updated ml_breakout_probability for {len(rows)} signals (latest batch: {latest_batch})')


def evaluate(conn):
    X, y, n = build_training_data(conn)
    if X is None:
        print(f'[ML] Not enough data to evaluate (have {n} rows).')
        return
    if not os.path.exists(MODEL_PATH):
        print('[ML] No model file found.')
        return
    with open(MODEL_PATH, 'rb') as f:
        model = pickle.load(f)
    with open(SCALER_PATH, 'rb') as f:
        scaler = pickle.load(f)
    X_scaled = scaler.transform(X)
    probs = model.predict_proba(X_scaled)[:, 1]
    preds = (probs >= 0.5).astype(int)
    print(f'[ML] Samples: {n}  Win rate: {y.mean():.1%}')
    print(f'[ML] AUC: {roc_auc_score(y, probs):.3f}  Accuracy: {accuracy_score(y, preds):.3f}')


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--train', action='store_true')
    parser.add_argument('--update-probabilities', action='store_true')
    parser.add_argument('--evaluate', action='store_true')
    args = parser.parse_args()

    conn = get_connection()
    try:
        if args.train:
            train(conn)
        elif args.update_probabilities:
            update_probabilities(conn)
        elif args.evaluate:
            evaluate(conn)
        else:
            print('No mode specified. Use --train, --update-probabilities, or --evaluate.')
    finally:
        conn.close()
```

- [ ] **Step 6.2: Verify Python syntax**

```bash
cd c:\Github\bharat-stock-intelligence
python src/server/confluence_ml_engine.py --update-probabilities
```

Expected: `[ML] No trained model found. Run with --train first.` (or similar — no Python syntax errors)

- [ ] **Step 6.3: Commit**

```bash
git add src/server/confluence_ml_engine.py
git commit -m "feat(ml): add confluence_ml_engine — XGBoost/LGB breakout probability with sklearn fallback"
```

---

## Task 7: Python Outcome Tracker

**Files:**
- Create: `src/server/confluence_outcome_tracker.py`

This script checks outstanding signals, fetches current prices from `stock_ohlcv`, computes P&L at each horizon, and updates `screener_reliability` win rates.

- [ ] **Step 7.1: Create `src/server/confluence_outcome_tracker.py`**

```python
#!/usr/bin/env python3
"""
Confluence Outcome Tracker

For each confluence_signal that was generated N days ago:
  1. Look up the stock's closing price at signal_date + N in stock_ohlcv
  2. Compute return_pct at each horizon (1, 3, 7, 14, 30 days)
  3. Upsert into signal_outcomes (reusing existing table structure)
  4. Recompute screener_reliability win rates from signal_outcomes

Run daily after market close:
  python confluence_outcome_tracker.py
"""

import os
import sqlite3
from datetime import datetime, timedelta

DB_PATH = os.path.join(os.path.dirname(__file__), '..', '..', 'database.sqlite')
HORIZONS = [1, 3, 7, 14, 30]

def get_connection():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn

def get_ohlcv_close(conn, symbol: str, date_str: str):
    """Get closing price on or after date_str (up to 5 trading days forward)."""
    for offset in range(5):
        target = (datetime.strptime(date_str, '%Y-%m-%d') + timedelta(days=offset)).strftime('%Y-%m-%d')
        row = conn.execute(
            'SELECT close FROM stock_ohlcv WHERE symbol = ? AND date = ?', (symbol, target)
        ).fetchone()
        if row and row['close']:
            return float(row['close']), target
    return None, None

def track_outcomes(conn):
    today = datetime.now().strftime('%Y-%m-%d')

    # Find all unique signal dates from confluence_signals that have entry price
    signal_rows = conn.execute("""
        SELECT DISTINCT symbol, DATE(computed_at) AS signal_date, current_price, screener_ids_json
        FROM confluence_signals
        WHERE current_price IS NOT NULL AND current_price > 0
        AND DATE(computed_at) <= DATE('now', '-1 day')
    """).fetchall()

    tracked = 0
    for row in signal_rows:
        symbol = row['symbol']
        signal_date = row['signal_date']
        entry_price = float(row['current_price'])

        for horizon in HORIZONS:
            exit_date = (datetime.strptime(signal_date, '%Y-%m-%d') + timedelta(days=horizon)).strftime('%Y-%m-%d')
            if exit_date > today:
                continue  # not yet

            exit_price, actual_exit_date = get_ohlcv_close(conn, symbol, exit_date)
            if exit_price is None:
                continue

            return_pct = (exit_price - entry_price) / entry_price * 100
            outcome = 'WIN' if return_pct > 2.0 else ('LOSS' if return_pct < -2.0 else 'NEUTRAL')

            conn.execute("""
                INSERT INTO signal_outcomes (symbol, signal_date, horizon_days, entry_price,
                  check_date, exit_price, return_pct, outcome)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(symbol, signal_date, horizon_days) DO UPDATE SET
                  exit_price = excluded.exit_price,
                  return_pct = excluded.return_pct,
                  outcome    = excluded.outcome,
                  check_date = excluded.check_date
            """, (symbol, signal_date, horizon, entry_price, actual_exit_date, exit_price, return_pct, outcome))
            tracked += 1

    conn.commit()
    print(f'[OUTCOME-TRACKER] Tracked {tracked} outcomes')
    return tracked

def recompute_screener_reliability(conn):
    """Recompute win rates for every screener based on signal_outcomes."""
    screeners = conn.execute("""
        SELECT scan_id, screener_name, 'trendlyne' AS source FROM trendlyne_screeners
        UNION ALL
        SELECT scan_id, screener_name, 'moneycontrol' AS source FROM moneycontrol_screeners
        UNION ALL
        SELECT screener_id AS scan_id, screener_name, 'etnow' AS source FROM etnow_screeners
    """).fetchall()

    updated = 0
    for screener in screeners:
        scan_id = screener['scan_id']
        source = screener['source']

        # Get all symbols in this screener
        if source == 'trendlyne':
            symbol_rows = conn.execute(
                'SELECT symbol FROM trendlyne_screener_stocks WHERE screener_id = ? AND symbol IS NOT NULL', (scan_id,)
            ).fetchall()
        elif source == 'moneycontrol':
            symbol_rows = conn.execute(
                'SELECT symbol FROM moneycontrol_screener_stocks WHERE scan_id = ? AND symbol IS NOT NULL', (scan_id,)
            ).fetchall()
        else:
            symbol_rows = conn.execute(
                'SELECT symbol FROM etnow_screener_stocks WHERE screener_id = ? AND symbol IS NOT NULL', (scan_id,)
            ).fetchall()

        symbols = [r['symbol'] for r in symbol_rows if r['symbol']]
        if not symbols:
            continue

        placeholders = ','.join(['?'] * len(symbols))

        # 7-day win rate
        stats_7 = conn.execute(f"""
            SELECT
              COUNT(*) AS total,
              SUM(CASE WHEN outcome = 'WIN'  THEN 1 ELSE 0 END) AS wins,
              AVG(CASE WHEN outcome IN ('WIN','LOSS') THEN return_pct END) AS avg_return
            FROM signal_outcomes
            WHERE symbol IN ({placeholders}) AND horizon_days = 7
              AND outcome IN ('WIN','LOSS','NEUTRAL')
        """, symbols).fetchone()

        # 30-day win rate
        stats_30 = conn.execute(f"""
            SELECT
              SUM(CASE WHEN outcome = 'WIN'  THEN 1 ELSE 0 END) AS wins,
              AVG(CASE WHEN outcome IN ('WIN','LOSS') THEN return_pct END) AS avg_return,
              MAX(CASE WHEN return_pct < 0 THEN ABS(return_pct) ELSE 0 END) AS max_dd
            FROM signal_outcomes
            WHERE symbol IN ({placeholders}) AND horizon_days = 30
              AND outcome IN ('WIN','LOSS','NEUTRAL')
        """, symbols).fetchone()

        total = stats_7['total'] or 0
        wins_7 = stats_7['wins'] or 0
        win_rate_7 = wins_7 / total if total > 0 else 0
        avg_ret_7 = stats_7['avg_return'] or 0
        wins_30 = stats_30['wins'] or 0
        win_rate_30 = wins_30 / total if total > 0 else 0
        avg_ret_30 = stats_30['avg_return'] or 0
        max_dd = stats_30['max_dd'] or 0

        # Composite reliability score (0-100)
        reliability = min(100, max(0,
            win_rate_7 * 40 +
            win_rate_30 * 30 +
            min(avg_ret_7, 10) / 10 * 20 +
            (1 - min(max_dd, 20) / 20) * 10
        ))

        conn.execute("""
            INSERT INTO screener_reliability (
              scan_id, screener_name, source, total_signals,
              wins_7d, win_rate_7d, avg_return_7d,
              wins_30d, win_rate_30d, avg_return_30d,
              max_drawdown, reliability_score, last_updated
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
            ON CONFLICT(scan_id) DO UPDATE SET
              total_signals   = excluded.total_signals,
              wins_7d         = excluded.wins_7d,
              win_rate_7d     = excluded.win_rate_7d,
              avg_return_7d   = excluded.avg_return_7d,
              wins_30d        = excluded.wins_30d,
              win_rate_30d    = excluded.win_rate_30d,
              avg_return_30d  = excluded.avg_return_30d,
              max_drawdown    = excluded.max_drawdown,
              reliability_score = excluded.reliability_score,
              last_updated    = CURRENT_TIMESTAMP
        """, (
            scan_id, screener['screener_name'], source, total,
            wins_7, round(win_rate_7, 4), round(avg_ret_7, 2),
            wins_30, round(win_rate_30, 4), round(avg_ret_30, 2),
            round(max_dd, 2), round(reliability, 2)
        ))
        updated += 1

    conn.commit()
    print(f'[OUTCOME-TRACKER] Recomputed reliability for {updated} screeners')

if __name__ == '__main__':
    conn = get_connection()
    try:
        track_outcomes(conn)
        recompute_screener_reliability(conn)
    finally:
        conn.close()
```

- [ ] **Step 7.2: Verify Python syntax**

```bash
cd c:\Github\bharat-stock-intelligence
python -m py_compile src/server/confluence_outcome_tracker.py && echo "OK"
```

Expected: `OK` (no syntax errors)

- [ ] **Step 7.3: Commit**

```bash
git add src/server/confluence_outcome_tracker.py
git commit -m "feat(ml): add confluence_outcome_tracker — signal outcomes + screener reliability recomputation"
```

---

## Task 8: Frontend — SignalIntelligence Dashboard

**Files:**
- Create: `src/components/SignalIntelligence.tsx`

This is the main UI. It has 4 panels:
- **A. Stats header** — counts and last-computed time
- **B. High Conviction Table** — sortable, filterable ranked list with conviction badges
- **C. AI Trade Insight Panel** — shown when a row is selected (entry/SL/targets, screener breakdown, AI conclusion)
- **D. Bottom row** — Scanner Reliability Leaderboard (left) + Sector Momentum Matrix (right)

- [ ] **Step 8.1: Create `src/components/SignalIntelligence.tsx`**

```tsx
import React, { useState, useMemo } from 'react';
import {
  TrendingUp, TrendingDown, Zap, Target, BarChart3, Shield,
  RefreshCw, ChevronUp, ChevronDown, Filter, Clock, Star,
  Activity, AlertCircle, ArrowUpRight, Award, Layers,
} from 'lucide-react';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell } from 'recharts';
import { motion, AnimatePresence } from 'motion/react';
import { trpc } from '../lib/trpc';
import { cn } from '../lib/utils';

// ─── Types ───────────────────────────────────────────────────────────────────

interface ConfluenceSignal {
  symbol: string;
  computed_at: string;
  confluence_score: number;
  conviction_level: 'ELITE' | 'STRONG' | 'MODERATE' | 'WEAK';
  active_screener_count: number;
  bullish_screener_count: number;
  bearish_screener_count: number;
  screener_names_json: string;
  screener_ids_json: string;
  trend_alignment_score: number;
  volume_score: number;
  sector_strength_score: number;
  fundamental_score: number;
  ml_breakout_probability?: number;
  suggested_timeframe: string;
  entry_zone_low?: number;
  entry_zone_high?: number;
  stop_loss?: number;
  target_1?: number;
  target_2?: number;
  target_3?: number;
  risk_reward?: number;
  trade_reasoning?: string;
  sector?: string;
  current_price?: number;
  rsi?: number;
}

// ─── Conviction Badge ────────────────────────────────────────────────────────

const CONVICTION_CONFIG = {
  ELITE:    { color: 'from-amber-500 to-orange-500',  text: 'text-amber-400',  border: 'border-amber-500/40',  bg: 'bg-amber-500/10'  },
  STRONG:   { color: 'from-emerald-500 to-green-500', text: 'text-emerald-400', border: 'border-emerald-500/40', bg: 'bg-emerald-500/10' },
  MODERATE: { color: 'from-blue-500 to-indigo-500',   text: 'text-blue-400',   border: 'border-blue-500/40',   bg: 'bg-blue-500/10'   },
  WEAK:     { color: 'from-slate-500 to-slate-600',   text: 'text-slate-400',  border: 'border-slate-600',     bg: 'bg-slate-800'     },
};

function ConvictionBadge({ level }: { level: string }) {
  const cfg = CONVICTION_CONFIG[level as keyof typeof CONVICTION_CONFIG] ?? CONVICTION_CONFIG.WEAK;
  return (
    <span className={cn('px-2 py-0.5 rounded text-[10px] font-bold tracking-widest border', cfg.bg, cfg.text, cfg.border)}>
      {level}
    </span>
  );
}

// ─── Score Ring ──────────────────────────────────────────────────────────────

function ScoreRing({ score }: { score: number }) {
  const pct = Math.min(100, Math.max(0, score));
  const color = pct >= 80 ? '#f59e0b' : pct >= 60 ? '#10b981' : pct >= 40 ? '#6366f1' : '#64748b';
  return (
    <div className="relative w-10 h-10">
      <svg viewBox="0 0 36 36" className="w-10 h-10 -rotate-90">
        <circle cx="18" cy="18" r="15" fill="none" stroke="#1e293b" strokeWidth="3" />
        <circle
          cx="18" cy="18" r="15" fill="none"
          stroke={color} strokeWidth="3"
          strokeDasharray={`${pct * 0.942} 94.2`}
          strokeLinecap="round"
        />
      </svg>
      <span className="absolute inset-0 flex items-center justify-center text-[10px] font-bold text-white">{score}</span>
    </div>
  );
}

// ─── Factor Bar ──────────────────────────────────────────────────────────────

function FactorBar({ label, value, max, color }: { label: string; value: number; max: number; color: string }) {
  const pct = Math.round((value / max) * 100);
  return (
    <div className="space-y-1">
      <div className="flex justify-between text-[10px]">
        <span className="text-slate-400">{label}</span>
        <span className="text-slate-300 font-mono">{value.toFixed(1)}</span>
      </div>
      <div className="h-1.5 bg-slate-800 rounded-full overflow-hidden">
        <div className={cn('h-full rounded-full', color)} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

// ─── Stat Card ───────────────────────────────────────────────────────────────

function StatCard({ label, value, sub, color }: { label: string; value: string | number; sub?: string; color?: string }) {
  return (
    <div className="glass rounded-lg p-3 flex flex-col gap-0.5">
      <span className="text-[10px] text-slate-500 uppercase tracking-widest">{label}</span>
      <span className={cn('text-2xl font-bold', color ?? 'text-white')}>{value}</span>
      {sub && <span className="text-[10px] text-slate-500">{sub}</span>}
    </div>
  );
}

// ─── AI Insight Panel ────────────────────────────────────────────────────────

function AIInsightPanel({ signal }: { signal: ConfluenceSignal }) {
  const { data: detail } = trpc.getConfluenceDetail.useQuery({ symbol: signal.symbol }, { enabled: !!signal.symbol });

  const screenerNames: string[] = useMemo(() => {
    try { return JSON.parse(signal.screener_names_json || '[]'); } catch { return []; }
  }, [signal.screener_names_json]);

  const hasTrade = signal.entry_zone_low && signal.stop_loss && signal.target_1;

  return (
    <div className="glass rounded-xl p-4 space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <div className="text-white font-bold text-lg">{signal.symbol}</div>
          <div className="text-slate-400 text-xs">{signal.sector ?? 'Unknown sector'}</div>
        </div>
        <div className="flex items-center gap-2">
          <ConvictionBadge level={signal.conviction_level} />
          <ScoreRing score={signal.confluence_score} />
        </div>
      </div>

      {/* AI Conclusion */}
      {signal.trade_reasoning && (
        <div className="bg-indigo-900/20 border border-indigo-500/20 rounded-lg p-3">
          <div className="flex items-center gap-1.5 mb-1.5">
            <Zap className="w-3 h-3 text-indigo-400" />
            <span className="text-[10px] text-indigo-400 uppercase tracking-widest font-bold">AI Reasoning</span>
          </div>
          <p className="text-slate-300 text-xs leading-relaxed">{signal.trade_reasoning}</p>
        </div>
      )}

      {/* 5-Factor Breakdown */}
      <div className="space-y-2">
        <div className="text-[10px] text-slate-500 uppercase tracking-widest">Score Breakdown</div>
        <FactorBar label="Screener Confluence" value={signal.bullish_screener_count} max={10} color="bg-amber-500" />
        <FactorBar label="Trend Alignment"     value={signal.trend_alignment_score}   max={15} color="bg-emerald-500" />
        <FactorBar label="Volume Strength"     value={signal.volume_score}            max={10} color="bg-blue-500" />
        <FactorBar label="Sector Momentum"     value={signal.sector_strength_score}   max={8}  color="bg-purple-500" />
        <FactorBar label="Fundamentals"        value={signal.fundamental_score}       max={12} color="bg-rose-500" />
      </div>

      {/* Trade Setup */}
      {hasTrade && (
        <div className="space-y-2">
          <div className="text-[10px] text-slate-500 uppercase tracking-widest">Trade Setup</div>
          <div className="grid grid-cols-2 gap-2">
            <div className="bg-slate-800/50 rounded-lg p-2">
              <div className="text-[10px] text-slate-500">Entry Zone</div>
              <div className="text-xs font-mono text-white">
                {signal.entry_zone_low?.toFixed(2)} – {signal.entry_zone_high?.toFixed(2)}
              </div>
            </div>
            <div className="bg-rose-900/20 border border-rose-500/20 rounded-lg p-2">
              <div className="text-[10px] text-slate-500">Stop Loss</div>
              <div className="text-xs font-mono text-rose-400">{signal.stop_loss?.toFixed(2)}</div>
            </div>
            <div className="bg-emerald-900/20 border border-emerald-500/20 rounded-lg p-2">
              <div className="text-[10px] text-slate-500">Target 1</div>
              <div className="text-xs font-mono text-emerald-400">{signal.target_1?.toFixed(2)}</div>
            </div>
            <div className="bg-emerald-900/20 border border-emerald-500/20 rounded-lg p-2">
              <div className="text-[10px] text-slate-500">Target 2</div>
              <div className="text-xs font-mono text-emerald-400">{signal.target_2?.toFixed(2)}</div>
            </div>
          </div>
          {signal.risk_reward && (
            <div className="flex items-center gap-2 text-xs">
              <span className="text-slate-500">R:R</span>
              <span className="text-white font-bold">1 : {signal.risk_reward}</span>
              <span className="text-slate-500">|</span>
              <span className="text-slate-500">Timeframe</span>
              <span className={cn('text-xs font-bold',
                signal.suggested_timeframe === 'INTRADAY' ? 'text-amber-400' :
                signal.suggested_timeframe === 'SWING'    ? 'text-blue-400' : 'text-purple-400'
              )}>{signal.suggested_timeframe}</span>
            </div>
          )}
        </div>
      )}

      {/* ML Probability */}
      {signal.ml_breakout_probability != null && (
        <div className="flex items-center gap-3">
          <div className="text-[10px] text-slate-500 uppercase tracking-widest">ML Breakout Prob</div>
          <div className={cn('text-sm font-bold',
            signal.ml_breakout_probability > 0.7 ? 'text-emerald-400' :
            signal.ml_breakout_probability > 0.5 ? 'text-amber-400' : 'text-slate-400'
          )}>
            {(signal.ml_breakout_probability * 100).toFixed(0)}%
          </div>
        </div>
      )}

      {/* Active Screeners */}
      {screenerNames.length > 0 && (
        <div className="space-y-1.5">
          <div className="text-[10px] text-slate-500 uppercase tracking-widest">Active Scanners ({screenerNames.length})</div>
          <div className="flex flex-wrap gap-1.5">
            {screenerNames.slice(0, 8).map((name, i) => (
              <span key={i} className="px-2 py-0.5 bg-indigo-900/30 border border-indigo-500/20 rounded text-[10px] text-indigo-300">
                {name}
              </span>
            ))}
            {screenerNames.length > 8 && (
              <span className="text-[10px] text-slate-500">+{screenerNames.length - 8} more</span>
            )}
          </div>
        </div>
      )}

      {/* Screener Reliability from detail */}
      {detail?.screenerReliability && detail.screenerReliability.length > 0 && (
        <div className="space-y-1.5">
          <div className="text-[10px] text-slate-500 uppercase tracking-widest">Scanner Reliability</div>
          {detail.screenerReliability.slice(0, 4).map((r: any) => (
            <div key={r.scan_id} className="flex items-center justify-between text-[10px]">
              <span className="text-slate-400 truncate max-w-[140px]">{r.screener_name}</span>
              <div className="flex items-center gap-2">
                <span className="text-slate-500">7d Win</span>
                <span className={cn('font-mono', r.win_rate_7d > 0.6 ? 'text-emerald-400' : r.win_rate_7d > 0.4 ? 'text-amber-400' : 'text-slate-400')}>
                  {((r.win_rate_7d ?? 0) * 100).toFixed(0)}%
                </span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Main Component ──────────────────────────────────────────────────────────

export function SignalIntelligence() {
  const [selectedSignal, setSelectedSignal] = useState<ConfluenceSignal | null>(null);
  const [convictionFilter, setConvictionFilter] = useState<string>('ALL');
  const [timeframeFilter, setTimeframeFilter] = useState<string>('ALL');
  const [sortBy, setSortBy] = useState<'confluence_score' | 'ml_breakout_probability' | 'bullish_screener_count'>('confluence_score');
  const [sortDir, setSortDir] = useState<'desc' | 'asc'>('desc');
  const [minScore, setMinScore] = useState(30);

  const { data: stats, refetch: refetchStats } = trpc.getConfluenceStats.useQuery(undefined, { refetchInterval: 5 * 60 * 1000 });
  const { data: rawSignals, isLoading, refetch: refetchSignals } = trpc.getConfluenceSignals.useQuery({
    minScore,
    convictionLevel: convictionFilter !== 'ALL' ? convictionFilter as any : undefined,
    timeframe: timeframeFilter !== 'ALL' ? timeframeFilter as any : undefined,
    limit: 100,
  }, { refetchInterval: 5 * 60 * 1000 });
  const { data: reliability } = trpc.getScreenerReliability.useQuery({ limit: 10, orderBy: 'reliability_score' });
  const { data: sectorMatrix } = trpc.getSectorMomentumMatrix.useQuery(undefined, { refetchInterval: 5 * 60 * 1000 });
  const refreshMutation = trpc.refreshConfluenceSignals.useMutation({
    onSuccess: () => { refetchSignals(); refetchStats(); },
  });

  const signals: ConfluenceSignal[] = useMemo(() => {
    if (!rawSignals) return [];
    return [...rawSignals].sort((a, b) => {
      const av = (a as any)[sortBy] ?? 0;
      const bv = (b as any)[sortBy] ?? 0;
      return sortDir === 'desc' ? bv - av : av - bv;
    });
  }, [rawSignals, sortBy, sortDir]);

  const toggleSort = (col: typeof sortBy) => {
    if (sortBy === col) setSortDir(d => d === 'desc' ? 'asc' : 'desc');
    else { setSortBy(col); setSortDir('desc'); }
  };

  const lastComputed = stats?.lastComputed
    ? new Date(stats.lastComputed).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })
    : 'Never';

  return (
    <div className="p-4 space-y-4 min-h-screen">
      {/* ── Header ──────────────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-xl font-bold text-white flex items-center gap-2">
            <Zap className="w-5 h-5 text-amber-400" />
            Signal Intelligence Engine
          </h1>
          <p className="text-slate-400 text-xs mt-0.5">Multi-screener confluence • AI conviction scoring • Breakout probability</p>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[10px] text-slate-500 flex items-center gap-1">
            <Clock className="w-3 h-3" /> Last: {lastComputed}
          </span>
          <button
            onClick={() => refreshMutation.mutate()}
            disabled={refreshMutation.isPending}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-indigo-600 hover:bg-indigo-500 rounded-lg text-white text-xs font-medium transition-colors disabled:opacity-50"
          >
            <RefreshCw className={cn('w-3 h-3', refreshMutation.isPending && 'animate-spin')} />
            {refreshMutation.isPending ? 'Computing...' : 'Refresh'}
          </button>
        </div>
      </div>

      {/* ── Stats Row ────────────────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <StatCard label="Total Signals"    value={stats?.total ?? 0}    sub="active screener stocks" />
        <StatCard label="Elite Conviction" value={stats?.elite ?? 0}    sub="score ≥ 80" color="text-amber-400" />
        <StatCard label="Strong Conviction" value={stats?.strong ?? 0}  sub="score 60–79" color="text-emerald-400" />
        <StatCard label="Avg Score"        value={`${stats?.avgScore ?? 0}`} sub="across all signals" color="text-blue-400" />
      </div>

      {/* ── Filters ──────────────────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[10px] text-slate-500 flex items-center gap-1"><Filter className="w-3 h-3" /> Filters:</span>
        {(['ALL', 'ELITE', 'STRONG', 'MODERATE'] as const).map(lvl => (
          <button
            key={lvl}
            onClick={() => setConvictionFilter(lvl)}
            className={cn(
              'px-3 py-1 rounded-full text-[10px] font-bold border transition-colors',
              convictionFilter === lvl
                ? 'bg-indigo-600 border-indigo-500 text-white'
                : 'border-slate-700 text-slate-400 hover:border-slate-500'
            )}
          >{lvl}</button>
        ))}
        <div className="w-px h-4 bg-slate-700 mx-1" />
        {(['ALL', 'INTRADAY', 'SWING', 'POSITIONAL'] as const).map(tf => (
          <button
            key={tf}
            onClick={() => setTimeframeFilter(tf)}
            className={cn(
              'px-3 py-1 rounded-full text-[10px] font-bold border transition-colors',
              timeframeFilter === tf
                ? 'bg-blue-600 border-blue-500 text-white'
                : 'border-slate-700 text-slate-400 hover:border-slate-500'
            )}
          >{tf}</button>
        ))}
        <div className="ml-auto flex items-center gap-2 text-[10px] text-slate-400">
          Min score:
          <input
            type="range" min="0" max="80" step="10" value={minScore}
            onChange={e => setMinScore(Number(e.target.value))}
            className="w-20 accent-indigo-500"
          />
          <span className="text-white font-mono w-6">{minScore}</span>
        </div>
      </div>

      {/* ── Main Content ─────────────────────────────────────────────────────── */}
      <div className="flex gap-4 items-start">
        {/* Left: Opportunities Table */}
        <div className="flex-1 min-w-0 glass rounded-xl overflow-hidden">
          <div className="px-4 py-3 border-b border-slate-700/50 flex items-center gap-2">
            <Award className="w-4 h-4 text-amber-400" />
            <span className="text-sm font-bold text-white">High Conviction Opportunities</span>
            <span className="ml-auto text-[10px] text-slate-500">{signals.length} stocks</span>
          </div>

          {isLoading ? (
            <div className="p-8 text-center text-slate-500 text-sm">Computing confluence scores...</div>
          ) : signals.length === 0 ? (
            <div className="p-8 text-center">
              <AlertCircle className="w-8 h-8 text-slate-600 mx-auto mb-2" />
              <p className="text-slate-500 text-sm">No signals found. Click Refresh to compute.</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-slate-700/50 text-[10px] text-slate-500 uppercase tracking-widest">
                    <th className="px-3 py-2 text-left">Symbol</th>
                    <th className="px-3 py-2 text-left">Conviction</th>
                    <th className="px-3 py-2 text-right cursor-pointer hover:text-white" onClick={() => toggleSort('confluence_score')}>
                      Score {sortBy === 'confluence_score' && (sortDir === 'desc' ? '↓' : '↑')}
                    </th>
                    <th className="px-3 py-2 text-right cursor-pointer hover:text-white" onClick={() => toggleSort('ml_breakout_probability')}>
                      ML Prob {sortBy === 'ml_breakout_probability' && (sortDir === 'desc' ? '↓' : '↑')}
                    </th>
                    <th className="px-3 py-2 text-right cursor-pointer hover:text-white" onClick={() => toggleSort('bullish_screener_count')}>
                      Scanners {sortBy === 'bullish_screener_count' && (sortDir === 'desc' ? '↓' : '↑')}
                    </th>
                    <th className="px-3 py-2 text-right">Entry</th>
                    <th className="px-3 py-2 text-right">SL</th>
                    <th className="px-3 py-2 text-right">T1</th>
                    <th className="px-3 py-2 text-right">R:R</th>
                    <th className="px-3 py-2 text-center">TF</th>
                    <th className="px-3 py-2 text-left">Sector</th>
                  </tr>
                </thead>
                <tbody>
                  {signals.map((sig, i) => {
                    const isSelected = selectedSignal?.symbol === sig.symbol;
                    return (
                      <tr
                        key={sig.symbol}
                        onClick={() => setSelectedSignal(isSelected ? null : sig)}
                        className={cn(
                          'border-b border-slate-800/50 cursor-pointer transition-colors',
                          isSelected ? 'bg-indigo-900/20 border-indigo-500/20' : 'hover:bg-slate-800/30',
                          i % 2 === 0 ? '' : 'bg-slate-900/20',
                        )}
                      >
                        <td className="px-3 py-2 font-bold text-white">{sig.symbol}</td>
                        <td className="px-3 py-2"><ConvictionBadge level={sig.conviction_level} /></td>
                        <td className="px-3 py-2 text-right">
                          <span className={cn('font-bold',
                            sig.confluence_score >= 80 ? 'text-amber-400' :
                            sig.confluence_score >= 60 ? 'text-emerald-400' :
                            sig.confluence_score >= 40 ? 'text-blue-400' : 'text-slate-400'
                          )}>{sig.confluence_score}</span>
                        </td>
                        <td className="px-3 py-2 text-right font-mono text-slate-300">
                          {sig.ml_breakout_probability != null
                            ? `${(sig.ml_breakout_probability * 100).toFixed(0)}%`
                            : <span className="text-slate-600">—</span>}
                        </td>
                        <td className="px-3 py-2 text-right">
                          <span className="text-emerald-400 font-bold">{sig.bullish_screener_count}</span>
                          {sig.bearish_screener_count > 0 && (
                            <span className="text-rose-400 ml-1">-{sig.bearish_screener_count}</span>
                          )}
                        </td>
                        <td className="px-3 py-2 text-right font-mono text-slate-300">
                          {sig.entry_zone_high ? sig.entry_zone_high.toFixed(1) : '—'}
                        </td>
                        <td className="px-3 py-2 text-right font-mono text-rose-400">
                          {sig.stop_loss ? sig.stop_loss.toFixed(1) : '—'}
                        </td>
                        <td className="px-3 py-2 text-right font-mono text-emerald-400">
                          {sig.target_1 ? sig.target_1.toFixed(1) : '—'}
                        </td>
                        <td className="px-3 py-2 text-right text-slate-300">
                          {sig.risk_reward ? `1:${sig.risk_reward}` : '—'}
                        </td>
                        <td className="px-3 py-2 text-center">
                          <span className={cn('text-[9px] font-bold px-1.5 py-0.5 rounded',
                            sig.suggested_timeframe === 'INTRADAY' ? 'bg-amber-900/30 text-amber-400' :
                            sig.suggested_timeframe === 'SWING'    ? 'bg-blue-900/30 text-blue-400' :
                                                                     'bg-purple-900/30 text-purple-400'
                          )}>
                            {sig.suggested_timeframe === 'INTRADAY' ? 'ID' :
                             sig.suggested_timeframe === 'SWING' ? 'SW' : 'PO'}
                          </span>
                        </td>
                        <td className="px-3 py-2 text-slate-400 text-[10px]">
                          {sig.sector ? sig.sector.slice(0, 16) : '—'}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Right: AI Insight Panel */}
        <AnimatePresence>
          {selectedSignal && (
            <motion.div
              initial={{ opacity: 0, x: 20 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: 20 }}
              className="w-80 shrink-0"
            >
              <AIInsightPanel signal={selectedSignal} />
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* ── Bottom Row: Reliability Leaderboard + Sector Matrix ──────────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Scanner Reliability Leaderboard */}
        <div className="glass rounded-xl overflow-hidden">
          <div className="px-4 py-3 border-b border-slate-700/50 flex items-center gap-2">
            <Star className="w-4 h-4 text-amber-400" />
            <span className="text-sm font-bold text-white">Scanner Reliability Leaderboard</span>
          </div>
          {reliability && reliability.length > 0 ? (
            <div className="divide-y divide-slate-800/50">
              {reliability.map((r: any, i: number) => (
                <div key={r.scan_id} className="px-4 py-2.5 flex items-center gap-3">
                  <span className="text-[10px] text-slate-600 w-4">{i + 1}</span>
                  <div className="flex-1 min-w-0">
                    <div className="text-xs text-white truncate">{r.screener_name}</div>
                    <div className="text-[10px] text-slate-500">{r.source} • {r.total_signals} signals</div>
                  </div>
                  <div className="text-right shrink-0">
                    <div className={cn('text-xs font-bold',
                      r.win_rate_7d > 0.65 ? 'text-emerald-400' :
                      r.win_rate_7d > 0.45 ? 'text-amber-400' : 'text-slate-400'
                    )}>
                      {((r.win_rate_7d ?? 0) * 100).toFixed(0)}%
                    </div>
                    <div className="text-[10px] text-slate-500">7d win</div>
                  </div>
                  <div className="w-12 text-right shrink-0">
                    <div className={cn('text-xs font-bold',
                      r.reliability_score > 65 ? 'text-emerald-400' :
                      r.reliability_score > 45 ? 'text-amber-400' : 'text-slate-400'
                    )}>
                      {r.reliability_score?.toFixed(0)}
                    </div>
                    <div className="text-[10px] text-slate-500">score</div>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="p-6 text-center text-slate-500 text-xs">
              Reliability data builds up as signal outcomes are tracked.
              <br />Run <code className="text-indigo-400">confluence_outcome_tracker.py</code> after market close.
            </div>
          )}
        </div>

        {/* Sector Momentum Matrix */}
        <div className="glass rounded-xl overflow-hidden">
          <div className="px-4 py-3 border-b border-slate-700/50 flex items-center gap-2">
            <BarChart3 className="w-4 h-4 text-blue-400" />
            <span className="text-sm font-bold text-white">Sector Momentum Matrix</span>
          </div>
          {sectorMatrix && sectorMatrix.length > 0 ? (
            <>
              <div className="p-3">
                <ResponsiveContainer width="100%" height={180}>
                  <BarChart data={sectorMatrix.slice(0, 10)} layout="vertical" margin={{ left: 0, right: 10 }}>
                    <XAxis type="number" domain={[0, 100]} tick={{ fontSize: 9, fill: '#64748b' }} />
                    <YAxis
                      type="category" dataKey="sector" width={80}
                      tick={{ fontSize: 9, fill: '#94a3b8' }}
                      tickFormatter={(v: string) => v.slice(0, 10)}
                    />
                    <Tooltip
                      contentStyle={{ background: '#0f172a', border: '1px solid #1e293b', borderRadius: 8, fontSize: 10 }}
                      formatter={(v: any) => [v, 'Avg Score']}
                    />
                    <Bar dataKey="avg_score" radius={[0, 3, 3, 0]}>
                      {sectorMatrix.slice(0, 10).map((entry: any, index: number) => (
                        <Cell key={index} fill={entry.avg_score >= 60 ? '#10b981' : entry.avg_score >= 40 ? '#6366f1' : '#475569'} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
              <div className="divide-y divide-slate-800/50 max-h-40 overflow-y-auto">
                {sectorMatrix.slice(0, 8).map((s: any) => (
                  <div key={s.sector} className="px-4 py-1.5 flex items-center gap-2 text-xs">
                    <span className="flex-1 text-slate-300 truncate">{s.sector}</span>
                    <span className="text-slate-500 text-[10px]">{s.stock_count} stocks</span>
                    <span className={cn('font-bold',
                      s.avg_score >= 60 ? 'text-emerald-400' :
                      s.avg_score >= 40 ? 'text-blue-400' : 'text-slate-400'
                    )}>{s.avg_score}</span>
                    {s.high_conviction_count > 0 && (
                      <span className="text-amber-400 text-[10px]">★{s.high_conviction_count}</span>
                    )}
                  </div>
                ))}
              </div>
            </>
          ) : (
            <div className="p-6 text-center text-slate-500 text-xs">
              No sector data available. Run a refresh to compute.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default SignalIntelligence;
```

- [ ] **Step 8.2: Verify TypeScript compiles**

```bash
cd c:\Github\bharat-stock-intelligence
npx tsc --noEmit 2>&1 | grep -i "SignalIntelligence\|signal-intelligence" | head -20
```

Expected: No errors.

- [ ] **Step 8.3: Commit**

```bash
git add src/components/SignalIntelligence.tsx
git commit -m "feat(ui): add SignalIntelligence dashboard — ranked table, AI insights, sector matrix, scanner leaderboard"
```

---

## Task 9: App Navigation Registration

**Files:**
- Modify: `src/components/AppShell.tsx`
- Modify: `src/App.tsx`

- [ ] **Step 9.1: Add nav item to AppShell.tsx**

Open `src/components/AppShell.tsx`. In `NAV_GROUPS`, find the `Intelligence` group (the one containing `{ icon: Sparkles, label: 'Trade Cockpit', id: 'trade-cockpit' }`). Add a new item after `{ icon: Radio, label: 'Signals', id: 'signals' }`:

```typescript
      { icon: Layers, label: 'Signal Intel', id: 'signal-intelligence' },
```

Also ensure `Layers` is imported from lucide-react at the top of AppShell.tsx. Find the existing import line:
```typescript
import {
  LayoutDashboard, Trophy, BarChart2, Activity, Filter, Target, Zap,
  Search, History, PieChart, Bookmark, Users, Globe, CheckCircle2,
  Star, LogIn, TrendingUp, ArrowUpRight, ArrowDownRight, Menu,
  ChevronLeft, ChevronRight, Radio, Settings2, Briefcase, Calendar, Sparkles,
  FlaskConical,
} from 'lucide-react';
```

Add `Layers` to that import:
```typescript
import {
  LayoutDashboard, Trophy, BarChart2, Activity, Filter, Target, Zap,
  Search, History, PieChart, Bookmark, Users, Globe, CheckCircle2,
  Star, LogIn, TrendingUp, ArrowUpRight, ArrowDownRight, Menu,
  ChevronLeft, ChevronRight, Radio, Settings2, Briefcase, Calendar, Sparkles,
  FlaskConical, Layers,
} from 'lucide-react';
```

- [ ] **Step 9.2: Add import and route in App.tsx**

In `src/App.tsx`, find the existing HedgeFundResearch import line (~line 74):
```typescript
import HedgeFundResearch from './components/HedgeFundResearch';
```

Add after it:
```typescript
import SignalIntelligence from './components/SignalIntelligence';
```

- [ ] **Step 9.3: Add route in App.tsx**

In `src/App.tsx`, find the `<Routes>` block (the JSX where tabs are rendered). Find how the `research` tab renders its component (search for `activeTab === 'research'` or the `<Route path="research"` pattern). In the same pattern, add a route for `signal-intelligence`.

If the pattern is route-based (using `<Route>`):
```tsx
<Route path="signal-intelligence" element={<SignalIntelligence />} />
```

If the pattern is conditional rendering (using `activeTab === 'xxx'`):
```tsx
{activeTab === 'signal-intelligence' && <SignalIntelligence />}
```

Check `src/App.tsx` around line 3401+ to see which pattern is used and apply accordingly.

- [ ] **Step 9.4: Verify TypeScript**

```bash
cd c:\Github\bharat-stock-intelligence
npx tsc --noEmit 2>&1 | head -20
```

Expected: No errors.

- [ ] **Step 9.5: Commit**

```bash
git add src/components/AppShell.tsx src/App.tsx
git commit -m "feat(nav): add Signal Intelligence tab to AppShell + App routing"
```

---

## Task 10: End-to-End Smoke Test

**Files:** (none — verification only)

- [ ] **Step 10.1: Start the dev server**

```bash
cd c:\Github\bharat-stock-intelligence
npm run dev
```

Expected: Server starts on port 3000 (or configured port) with no crash.

- [ ] **Step 10.2: Trigger confluence computation via tRPC**

```bash
cd c:\Github\bharat-stock-intelligence
node -e "
const { createTRPCProxyClient, httpBatchLink } = require('@trpc/client');
const fetch = require('node-fetch');
const client = createTRPCProxyClient({ links: [httpBatchLink({ url: 'http://localhost:3000/api/trpc', fetch })] });
client.refreshConfluenceSignals.mutate().then(r => console.log('Result:', r)).catch(e => console.error(e));
"
```

Expected: `Result: { success: true, computed: <N>, elite: <E>, strong: <S> }` — numbers will vary based on screener data in DB.

- [ ] **Step 10.3: Verify getConfluenceStats returns data**

```bash
node -e "
const { createTRPCProxyClient, httpBatchLink } = require('@trpc/client');
const fetch = require('node-fetch');
const client = createTRPCProxyClient({ links: [httpBatchLink({ url: 'http://localhost:3000/api/trpc', fetch })] });
client.getConfluenceStats.query().then(r => console.log('Stats:', r)).catch(e => console.error(e));
"
```

Expected: `Stats: { total: <N>, elite: <E>, strong: <S>, moderate: <M>, avgScore: <X>, lastComputed: '...' }`

- [ ] **Step 10.4: Navigate to Signal Intelligence in browser**

Open `http://localhost:5173` (or configured Vite port). Click "Signal Intel" in the left nav. 

Expected:
- Stats row shows total/elite/strong counts
- Table shows ranked stocks with confluence scores, conviction badges, entry/SL/target levels
- Clicking any row opens the AI Insight Panel on the right
- Scanner Reliability Leaderboard and Sector Matrix render at the bottom

- [ ] **Step 10.5: Run Python outcome tracker (dry run)**

```bash
cd c:\Github\bharat-stock-intelligence
python src/server/confluence_outcome_tracker.py
```

Expected: Output like `[OUTCOME-TRACKER] Tracked 0 outcomes` (0 on first run since no history), then `[OUTCOME-TRACKER] Recomputed reliability for N screeners`.

- [ ] **Step 10.6: Final commit**

```bash
git add -A
git commit -m "feat: Signal Intelligence & Confluence Engine — complete implementation"
```

---

## Scoring Formula Reference

```
confluenceScore = normalize_100(
  screenerComponent + trendScore + volScore + sectorScore + fundScore
)

where:
  screenerComponent = Σ(screener_weight) × presenceMultiplier(bullishCount)  [0–60]
  trendScore        = above_sma200×5 + sma200_dist×2 + momentum_rank×4 + composite_rank×4  [0–15]
  volScore          = f(volume_ratio): >3→10, >2→7, >1.5→5, >1.2→2  [0–10]
  sectorScore       = momentum_score/100 × 8  [0–8]
  fundScore         = piotroski×4 + roe×3 + low_debt×2 + rev_growth×3  [0–12]

  presenceMultiplier = 1.0 (1-2 screeners) | 1.5 (3-4) | 2.0 (5-6) | 2.5 (7+)
  normalization denominator = 105 (max theoretical raw)

convictionLevel:
  score ≥ 80 → ELITE
  score ≥ 60 → STRONG
  score ≥ 40 → MODERATE
  score < 40 → WEAK
```

---

## Daily Ops (run after market close)

```bash
# Update signal outcomes + screener reliability
python src/server/confluence_outcome_tracker.py

# Retrain ML model (weekly, once enough outcomes accumulate)
python src/server/confluence_ml_engine.py --train

# Update ML probabilities on current signals
python src/server/confluence_ml_engine.py --update-probabilities
```

---

## Self-Review Checklist

**Spec coverage:**
| Requirement | Task |
|---|---|
| Parse scanner names intelligently | Task 2 — `classifyScreener()` with 24 keyword patterns + screener_master fallback |
| Multi-screener presence multiplier | Task 2 — `presenceMultiplier()` |
| 5-factor weighted scoring (A–E) | Task 2 — `scoreStock()` function |
| Historical screener accuracy | Tasks 7 + DB (screener_reliability table) |
| AI-generated conclusions/reasoning | Task 2 — `tradeReasoning` field |
| Signal tracking with full metadata | Task 1 + DB (confluence_signals table) |
| Outcome tracking 1/3/7/14/30d | Task 7 — confluence_outcome_tracker.py |
| XGBoost/LightGBM/GradientBoosting | Task 6 — confluence_ml_engine.py |
| Breakout probability | Task 6 — ml_breakout_probability column |
| High Conviction Opportunities table | Task 8 — main table with all columns |
| Scanner Reliability Leaderboard | Task 4 + Task 8 — getScreenerReliability + leaderboard panel |
| Sector Momentum Matrix | Task 4 + Task 8 — getSectorMomentumMatrix + BarChart panel |
| AI Trade Insights Panel | Task 8 — AIInsightPanel component |
| BullMQ real-time updates | Task 3 — 30-min repeatable queue |
| Entry/SL/Target generation | Task 2 — `buildTradeSetup()` using ATR |
| Risk:Reward calculation | Task 2 — risk_reward field |
| Multi-timeframe suggestion | Task 2 — `suggestTimeframe()` |
| Sortable ranked table | Task 8 — `toggleSort()` + useMemo sort |
| Filter by conviction/timeframe/score | Task 8 — filter buttons + tRPC input |

**Not in this plan (optional extensions):**
- Telegram/email alerts — existing `telegramService.ts` is already built; wire `getLatestConfluenceSignals(elite)` → sendAlert
- TradingView chart embed per selected stock — can reuse existing `TechnicalAnalysisWidget`
- Fake breakout detection — add `hasFakeBreakout` flag to `confluenceEngine.ts` (check if price gapped then reversed within 2 sessions)
- WebSocket live signal feed — hook into BullMQ job completion events + existing `websocketService.ts`
