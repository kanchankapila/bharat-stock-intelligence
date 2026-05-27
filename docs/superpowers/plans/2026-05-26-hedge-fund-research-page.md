
# Hedge Fund Research Page — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a daily-generated institutional research page showing top 10 stock picks with conviction scores, entry/SL/target levels, AI narrative blurbs, and 7-day report archive — auto-generated twice daily via BullMQ.

**Architecture:** A `researchEngine.ts` module queries 8 DB tables to compute weighted conviction scores, calls Ollama/Gemini for 2-sentence blurbs, and writes a structured JSON report to `daily_research_reports`. Two BullMQ queues (pre-market 8:30 AM IST, post-close 4:15 PM IST) trigger generation. Frontend reads via 4 tRPC procedures and renders a dual-tier React component: always-visible trader table + expandable analyst deep-dive.

**Tech Stack:** Node.js/TypeScript, better-sqlite3, BullMQ, tRPC/Zod, React 19, Lucide icons, motion/react, Tailwind (glass/glass-strong CSS classes)

---

## File Map

| File | Action | Responsibility |
|---|---|---|
| `src/server/db.ts` | Modify | Add `daily_research_reports` table |
| `src/server/researchEngine.ts` | Create | Full report generation pipeline |
| `src/server/queues.ts` | Modify | Add 2 queues + 2 workers + register |
| `src/server/routers/research.router.ts` | Create | 4 tRPC procedures |
| `src/server/router.ts` | Modify | Import + merge researchRouter |
| `src/components/HedgeFundResearch.tsx` | Create | Full page component (all sub-components) |
| `src/App.tsx` | Modify | Import component, add tab + route |

---

## Task 1: DB Migration — `daily_research_reports` table

**Files:**
- Modify: `src/server/db.ts`

- [ ] **Step 1.1: Add table definition to db.ts**

Find the last `CREATE TABLE IF NOT EXISTS` block in `src/server/db.ts` and append the following inside the `db.exec(...)` template literal (before the closing backtick):

```sql
  CREATE TABLE IF NOT EXISTS daily_research_reports (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    report_date     TEXT NOT NULL,
    report_type     TEXT NOT NULL CHECK(report_type IN ('PRE_MARKET','POST_CLOSE')),
    status          TEXT NOT NULL DEFAULT 'PENDING'
                    CHECK(status IN ('PENDING','GENERATING','READY','FAILED')),
    generated_at    DATETIME,
    market_regime   TEXT,
    sentiment_score REAL,
    fii_net_5d      REAL,
    top_picks_json  TEXT,
    report_json     TEXT,
    ai_blurbs_json  TEXT,
    error_message   TEXT,
    UNIQUE(report_date, report_type)
  );
```

- [ ] **Step 1.2: Verify table creation**

```bash
cd c:\Github\bharat-stock-intelligence
node -e "const db = require('better-sqlite3')('database.sqlite'); console.log(db.prepare(\"SELECT name FROM sqlite_master WHERE type='table' AND name='daily_research_reports'\").get())"
```

Expected output: `{ name: 'daily_research_reports' }`

- [ ] **Step 1.3: Commit**

```bash
git add src/server/db.ts
git commit -m "feat: add daily_research_reports table"
```

---

## Task 2: Research Engine — Market Context + Conviction Scoring

**Files:**
- Create: `src/server/researchEngine.ts`

- [ ] **Step 2.1: Create researchEngine.ts with market context + scoring**

```typescript
// src/server/researchEngine.ts
import db from './db';
import { generateAIAnalysis } from '../services/aiService';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface StockPick {
  symbol: string;
  conviction_score: number;
  quant_rank: number;
  signal_score: number;
  xgboost_score: number;
  screener_net: number;
  news_boost: number;
  rsi: number | null;
  adx: number | null;
  trailing_pe: number | null;
  roe: number | null;
  debt_to_equity: number | null;
  piotroski: number | null;
  bullish_screeners: number;
  return_1m: number | null;
  return_3m: number | null;
  above_sma200: number;
  entry_note: string;
  stop_loss_pct: number;
  target_1_pct: number;
  target_2_pct: number;
  risk_reward: number;
  layers_confirmed: number;
  flags: string[];
}

export interface ResearchReport {
  report_date: string;
  report_type: 'PRE_MARKET' | 'POST_CLOSE';
  market_regime: string;
  sentiment_score: number;
  fii_net_5d: number;
  global_cue: string;
  hot_themes: string[];
  top_picks: StockPick[];
  watchlist: Pick<StockPick, 'symbol' | 'conviction_score' | 'layers_confirmed'>[];
  avoid_list: { symbol: string; reason: string }[];
  sector_rankings: { sector: string; score: number; momentum: string }[];
  executive_summary: string;
}

// ─── Market Context ────────────────────────────────────────────────────────────

function getMarketContext(): {
  regime: string;
  sentiment_score: number;
  fii_net_5d: number;
  global_cue: string;
  hot_themes: string[];
} {
  const sentiment = db.prepare(`
    SELECT overall_score, nifty_bias, global_cue, key_themes_json
    FROM market_sentiment_snapshots
    ORDER BY snapshot_at DESC LIMIT 1
  `).get() as any;

  const fiiRows = db.prepare(`
    SELECT fii_net, dii_net FROM fii_dii_flow
    ORDER BY date DESC LIMIT 5
  `).all() as any[];

  const fii_net_5d = fiiRows.reduce((sum: number, r: any) => sum + (r.fii_net || 0), 0);
  const dii_net_5d = fiiRows.reduce((sum: number, r: any) => sum + (r.dii_net || 0), 0);

  // Regime classification
  let regime = 'SIDEWAYS';
  if (fii_net_5d > 3000 && (sentiment?.overall_score ?? 0) > 20) regime = 'BULL';
  else if (fii_net_5d < -3000 || (sentiment?.overall_score ?? 0) < -20) regime = 'BEAR';
  else if (fii_net_5d > 1000 && dii_net_5d > 1000) regime = 'TRANSITIONAL_BULL';

  const themes = (() => {
    try { return JSON.parse(sentiment?.key_themes_json || '[]'); } catch { return []; }
  })();

  return {
    regime,
    sentiment_score: sentiment?.overall_score ?? 0,
    fii_net_5d,
    global_cue: sentiment?.global_cue ?? 'Mixed',
    hot_themes: themes,
  };
}

// ─── Conviction Scoring ────────────────────────────────────────────────────────

function scoreStocks(): { picks: StockPick[]; avoid: { symbol: string; reason: string }[] } {
  const today = new Date().toISOString().split('T')[0];

  // Layer 1: Quant scores (Strong Buy / Buy)
  const quantRows = db.prepare(`
    SELECT symbol, rank_composite, rank_momentum, momentum_score, screener_net_score,
           bullish_screener_count, bearish_screener_count, trailing_pe, return_on_equity,
           debt_to_equity, piotroski_f_score, return_1m, return_3m, above_sma200,
           max_drawdown_1y, annualized_vol, sharpe_ratio
    FROM quant_scores
    WHERE composite_class IN ('Strong Buy','Buy') AND ohlcv_days >= 60
  `).all() as any[];

  // Layer 2: Technical signals (latest per symbol)
  const techMap = new Map<string, any>();
  (db.prepare(`
    SELECT ts.symbol, ts.signal_score, ts.win_probability, ts.rsi, ts.adx,
           ts.volume_ratio, ts.above_sma200, ts.signals_json, ts.news_sentiment_score
    FROM technical_signals ts
    INNER JOIN (
      SELECT symbol, MAX(date) as max_date FROM technical_signals GROUP BY symbol
    ) latest ON ts.symbol = latest.symbol AND ts.date = latest.max_date
    WHERE ts.signal_score >= 5
  `).all() as any[]).forEach(r => techMap.set(r.symbol, r));

  // Layer 3: XGBoost predictions
  const xgbMap = new Map<string, any>();
  (db.prepare(`
    SELECT symbol, xgboost_score, signal, is_growth, is_breakout
    FROM xgboost_predictions WHERE signal = 'BUY'
  `).all() as any[]).forEach(r => xgbMap.set(r.symbol, r));

  // Layer 4: News sentiment (last 48h, HIGH/MEDIUM impact)
  const newsMap = new Map<string, number>();
  (db.prepare(`
    SELECT symbols_json, sentiment_score, impact
    FROM news_sentiment_items
    WHERE impact IN ('HIGH','MEDIUM')
      AND published_at >= datetime('now', '-2 days')
      AND sentiment IN ('BULLISH')
  `).all() as any[]).forEach((r: any) => {
    try {
      const syms: string[] = JSON.parse(r.symbols_json || '[]');
      syms.forEach(s => newsMap.set(s, (newsMap.get(s) || 0) + (r.impact === 'HIGH' ? 1 : 0.5)));
    } catch {}
  });

  const avoidList: { symbol: string; reason: string }[] = [];
  const scored: StockPick[] = [];

  for (const q of quantRows) {
    const tech = techMap.get(q.symbol);
    const xgb  = xgbMap.get(q.symbol);

    // Risk gate — flag for avoid list
    const flags: string[] = [];
    if (tech?.rsi > 80) flags.push('RSI_OVERBOUGHT');
    if ((q.debt_to_equity ?? 0) > 100) flags.push('HIGH_LEVERAGE');
    if ((q.max_drawdown_1y ?? 0) > 40) flags.push('HIGH_DRAWDOWN');
    if ((q.piotroski_f_score ?? 5) < 4) flags.push('WEAK_FUNDAMENTALS');

    // Avoid: 2+ risk flags
    if (flags.length >= 2) {
      avoidList.push({ symbol: q.symbol, reason: flags.join(', ') });
      continue;
    }

    // Layer counts for minimum confirmation
    let layers_confirmed = 1; // quant always present in this loop
    if (tech) layers_confirmed++;
    if (xgb)  layers_confirmed++;
    if ((newsMap.get(q.symbol) ?? 0) > 0) layers_confirmed++;

    if (layers_confirmed < 2) continue; // need at least 2 layers

    // Weighted conviction score (0–100)
    const quant_component   = (q.rank_composite / 100) * 30;
    const tech_component    = tech ? (tech.signal_score / 10) * 25 : 0;
    const xgb_component     = xgb ? xgb.xgboost_score * 20 : 0;
    const screener_component = Math.min((q.screener_net_score || 0) / 50, 1) * 15;
    const news_component    = Math.min((newsMap.get(q.symbol) || 0) / 3, 1) * 10;

    let conviction_score =
      quant_component + tech_component + xgb_component + screener_component + news_component;

    // Risk penalties
    if (flags.includes('RSI_OVERBOUGHT'))   conviction_score *= 0.75;
    if (flags.includes('HIGH_LEVERAGE'))    conviction_score *= 0.80;
    if (flags.includes('HIGH_DRAWDOWN'))    conviction_score *= 0.85;
    if (flags.includes('WEAK_FUNDAMENTALS')) conviction_score *= 0.70;

    // Asymmetric R:R targets based on vol
    const vol = q.annualized_vol || 30;
    const stop_loss_pct  = Math.round(Math.max(6, Math.min(15, vol * 0.4)));
    const target_1_pct   = stop_loss_pct * 2.5;
    const target_2_pct   = stop_loss_pct * 4;
    const risk_reward    = parseFloat((target_1_pct / stop_loss_pct).toFixed(1));

    scored.push({
      symbol:           q.symbol,
      conviction_score: parseFloat(conviction_score.toFixed(1)),
      quant_rank:       q.rank_composite,
      signal_score:     tech?.signal_score ?? 0,
      xgboost_score:    xgb?.xgboost_score ?? 0,
      screener_net:     q.screener_net_score ?? 0,
      news_boost:       newsMap.get(q.symbol) ?? 0,
      rsi:              tech?.rsi ?? null,
      adx:              tech?.adx ?? null,
      trailing_pe:      q.trailing_pe,
      roe:              q.return_on_equity,
      debt_to_equity:   q.debt_to_equity,
      piotroski:        q.piotroski_f_score,
      bullish_screeners: q.bullish_screener_count ?? 0,
      return_1m:        q.return_1m,
      return_3m:        q.return_3m,
      above_sma200:     q.above_sma200 ?? 0,
      entry_note:       tech?.rsi > 65 ? 'Wait for pullback' : 'CMP entry acceptable',
      stop_loss_pct:    -stop_loss_pct,
      target_1_pct:     target_1_pct,
      target_2_pct:     target_2_pct,
      risk_reward,
      layers_confirmed,
      flags,
    });
  }

  scored.sort((a, b) => b.conviction_score - a.conviction_score);

  return { picks: scored, avoid: avoidList };
}

// ─── AI Blurbs ────────────────────────────────────────────────────────────────

async function generateBlurbs(
  picks: StockPick[],
  regime: string
): Promise<Record<string, { bull: string; bear: string; risk: string; exec_summary?: string }>> {
  const blurbs: Record<string, { bull: string; bear: string; risk: string }> = {};

  for (const pick of picks.slice(0, 10)) {
    const prompt = `You are an institutional equity analyst. For ${pick.symbol} stock on NSE India:
Regime: ${regime}
PE: ${pick.trailing_pe?.toFixed(1) ?? 'N/A'}, ROE: ${((pick.roe ?? 0) * 100).toFixed(1)}%
Return 1M: ${pick.return_1m?.toFixed(1) ?? 'N/A'}%, Conviction: ${pick.conviction_score}/100
Piotroski: ${pick.piotroski ?? 'N/A'}/9, Screeners bullish: ${pick.bullish_screeners}

Respond ONLY with valid JSON, no markdown, exactly this shape:
{"bull":"2 sentence upside thesis","bear":"1 sentence downside risk","risk":"1 specific risk factor"}`;

    try {
      const raw = await generateAIAnalysis(pick.symbol, { prompt });
      const parsed = typeof raw === 'string'
        ? JSON.parse(raw.replace(/```json\n?|\n?```/g, '').trim())
        : raw;
      blurbs[pick.symbol] = {
        bull: parsed.bull ?? '',
        bear: parsed.bear ?? '',
        risk: parsed.risk ?? '',
      };
    } catch {
      // AI unavailable — skip gracefully
    }

    await new Promise(r => setTimeout(r, 500)); // rate limit
  }

  return blurbs;
}

// ─── Sector Rankings ─────────────────────────────────────────────────────────

function getSectorRankings(): { sector: string; score: number; momentum: string }[] {
  return db.prepare(`
    SELECT n.sector,
           AVG(q.rank_composite) as score,
           AVG(q.return_1m) as avg_1m
    FROM quant_scores q
    JOIN nse_stocks n ON q.symbol = n.symbol
    WHERE q.composite_class IN ('Strong Buy','Buy')
      AND n.sector IS NOT NULL
    GROUP BY n.sector
    HAVING COUNT(*) >= 3
    ORDER BY score DESC
    LIMIT 10
  `).all().map((r: any) => ({
    sector: r.sector,
    score: parseFloat((r.score || 0).toFixed(1)),
    momentum: (r.avg_1m || 0) > 5 ? 'STRONG' : (r.avg_1m || 0) > 0 ? 'MODERATE' : 'WEAK',
  }));
}

// ─── Main Entry Point ─────────────────────────────────────────────────────────

export async function generateDailyReport(
  report_date: string,
  report_type: 'PRE_MARKET' | 'POST_CLOSE'
): Promise<void> {
  // Mark as generating
  db.prepare(`
    INSERT INTO daily_research_reports (report_date, report_type, status)
    VALUES (?, ?, 'GENERATING')
    ON CONFLICT(report_date, report_type) DO UPDATE SET status = 'GENERATING', error_message = NULL
  `).run(report_date, report_type);

  try {
    const ctx     = getMarketContext();
    const { picks, avoid } = scoreStocks();
    const top10   = picks.slice(0, 10);
    const watch10 = picks.slice(10, 20).map(p => ({
      symbol: p.symbol,
      conviction_score: p.conviction_score,
      layers_confirmed: p.layers_confirmed,
    }));
    const sectors = getSectorRankings();
    const blurbs  = await generateBlurbs(top10, ctx.regime);

    const report: ResearchReport = {
      report_date,
      report_type,
      market_regime:    ctx.regime,
      sentiment_score:  ctx.sentiment_score,
      fii_net_5d:       ctx.fii_net_5d,
      global_cue:       ctx.global_cue,
      hot_themes:       ctx.hot_themes,
      top_picks:        top10,
      watchlist:        watch10,
      avoid_list:       avoid.slice(0, 10),
      sector_rankings:  sectors,
      executive_summary: blurbs['__exec__']?.bull ?? '',
    };

    db.prepare(`
      UPDATE daily_research_reports SET
        status         = 'READY',
        generated_at   = datetime('now'),
        market_regime  = ?,
        sentiment_score = ?,
        fii_net_5d     = ?,
        top_picks_json = ?,
        report_json    = ?,
        ai_blurbs_json = ?
      WHERE report_date = ? AND report_type = ?
    `).run(
      ctx.regime,
      ctx.sentiment_score,
      ctx.fii_net_5d,
      JSON.stringify(top10),
      JSON.stringify(report),
      JSON.stringify(blurbs),
      report_date,
      report_type,
    );
  } catch (err: any) {
    db.prepare(`
      UPDATE daily_research_reports SET status = 'FAILED', error_message = ?
      WHERE report_date = ? AND report_type = ?
    `).run(String(err?.message ?? err), report_date, report_type);
    throw err;
  }
}
```

- [ ] **Step 2.2: Verify TypeScript compiles**

```bash
cd c:\Github\bharat-stock-intelligence
npx tsc --noEmit 2>&1 | head -30
```

Expected: no errors related to `researchEngine.ts` (ignore pre-existing errors if any).

- [ ] **Step 2.3: Commit**

```bash
git add src/server/researchEngine.ts
git commit -m "feat: add research engine with market context and conviction scoring"
```

---

## Task 3: BullMQ Queues — Pre-market + Post-close

**Files:**
- Modify: `src/server/queues.ts`

- [ ] **Step 3.1: Add queue constants** (after existing `QUEUE_ML_DAILY_OPS` line)

```typescript
export const QUEUE_RESEARCH_PREMARKET = 'research-premarket';
export const QUEUE_RESEARCH_POSTCLOSE = 'research-postclose';
```

- [ ] **Step 3.2: Add queue handle exports** (after existing `export let mlDailyOpsQueue` line)

```typescript
export let researchPremarketQueue: Queue | null = null;
export let researchPostcloseQueue: Queue | null = null;
```

- [ ] **Step 3.3: Add worker variables** (after existing `let mlDailyOpsWorker` line)

```typescript
let researchPremarketWorker: Worker | null = null;
let researchPostcloseWorker: Worker | null = null;
```

- [ ] **Step 3.4: Add worker processor functions** (before `initQueues` function)

```typescript
async function processResearchPremarket(_job: Job): Promise<{ success: boolean }> {
  const { generateDailyReport } = await import('./researchEngine');
  const today = new Date().toISOString().split('T')[0];
  await generateDailyReport(today, 'PRE_MARKET');
  return { success: true };
}

async function processResearchPostclose(_job: Job): Promise<{ success: boolean }> {
  const { generateDailyReport } = await import('./researchEngine');
  const today = new Date().toISOString().split('T')[0];
  await generateDailyReport(today, 'POST_CLOSE');
  return { success: true };
}
```

- [ ] **Step 3.5: Register queues inside `initQueues()`**

Find the last queue registration block inside `initQueues()` (before the `return true` at the end) and add:

```typescript
    // ── Research report queues ────────────────────────────────────────────
    researchPremarketQueue = new Queue(QUEUE_RESEARCH_PREMARKET, { connection });
    const premarketRepeatables = await researchPremarketQueue.getRepeatableJobs();
    for (const r of premarketRepeatables) {
      await researchPremarketQueue.removeRepeatableByKey(r.key);
    }
    await researchPremarketQueue.add(
      'research-premarket-daily',
      {},
      {
        repeat: { pattern: '0 3 * * 1-5' },   // 3:00 AM UTC = 8:30 AM IST weekdays
        jobId: 'research-premarket-repeatable',
        removeOnComplete: { age: 86400 },
        removeOnFail: { age: 604800 },
        attempts: 2,
        backoff: { type: 'exponential', delay: 5000 },
      },
    );
    researchPremarketWorker = new Worker(
      QUEUE_RESEARCH_PREMARKET,
      processResearchPremarket,
      { connection, concurrency: 1 },
    );

    researchPostcloseQueue = new Queue(QUEUE_RESEARCH_POSTCLOSE, { connection });
    const postcloseRepeatables = await researchPostcloseQueue.getRepeatableJobs();
    for (const r of postcloseRepeatables) {
      await researchPostcloseQueue.removeRepeatableByKey(r.key);
    }
    await researchPostcloseQueue.add(
      'research-postclose-daily',
      {},
      {
        repeat: { pattern: '45 10 * * 1-5' },  // 10:45 AM UTC = 4:15 PM IST weekdays
        jobId: 'research-postclose-repeatable',
        removeOnComplete: { age: 86400 },
        removeOnFail: { age: 604800 },
        attempts: 2,
        backoff: { type: 'exponential', delay: 5000 },
      },
    );
    researchPostcloseWorker = new Worker(
      QUEUE_RESEARCH_POSTCLOSE,
      processResearchPostclose,
      { connection, concurrency: 1 },
    );
```

- [ ] **Step 3.6: Verify compilation**

```bash
npx tsc --noEmit 2>&1 | head -20
```

- [ ] **Step 3.7: Commit**

```bash
git add src/server/queues.ts
git commit -m "feat: add pre-market and post-close research queues"
```

---

## Task 4: tRPC Router — 4 Research Procedures

**Files:**
- Create: `src/server/routers/research.router.ts`
- Modify: `src/server/router.ts`

- [ ] **Step 4.1: Create research.router.ts**

```typescript
// src/server/routers/research.router.ts
import { z } from 'zod';
import db from '../db';
import { router, publicProcedure } from '../trpc';
import {
  researchPremarketQueue,
  researchPostcloseQueue,
} from '../queues';

export const researchRouter = router({

  getDailyResearch: publicProcedure
    .input(z.object({
      date: z.string().optional(),
      type: z.enum(['PRE_MARKET', 'POST_CLOSE']).optional(),
    }).optional())
    .query(({ input }) => {
      const date = input?.date;
      const type = input?.type;

      if (date && type) {
        return db.prepare(`
          SELECT id, report_date, report_type, status, generated_at,
                 market_regime, sentiment_score, fii_net_5d,
                 top_picks_json, report_json, ai_blurbs_json, error_message
          FROM daily_research_reports
          WHERE report_date = ? AND report_type = ?
        `).get(date, type) as any ?? null;
      }

      // Auto-select: today's POST_CLOSE → today's PRE_MARKET → latest READY
      const today = new Date().toISOString().split('T')[0];
      const candidates = [
        db.prepare(`
          SELECT id, report_date, report_type, status, generated_at,
                 market_regime, sentiment_score, fii_net_5d,
                 top_picks_json, report_json, ai_blurbs_json, error_message
          FROM daily_research_reports
          WHERE report_date = ? AND report_type = 'POST_CLOSE' AND status = 'READY'
        `).get(today),
        db.prepare(`
          SELECT id, report_date, report_type, status, generated_at,
                 market_regime, sentiment_score, fii_net_5d,
                 top_picks_json, report_json, ai_blurbs_json, error_message
          FROM daily_research_reports
          WHERE report_date = ? AND report_type = 'PRE_MARKET' AND status = 'READY'
        `).get(today),
        db.prepare(`
          SELECT id, report_date, report_type, status, generated_at,
                 market_regime, sentiment_score, fii_net_5d,
                 top_picks_json, report_json, ai_blurbs_json, error_message
          FROM daily_research_reports
          WHERE status = 'READY'
          ORDER BY generated_at DESC LIMIT 1
        `).get(),
      ];

      return candidates.find(Boolean) ?? null;
    }),

  getDailyResearchHistory: publicProcedure
    .input(z.object({ limit: z.number().min(1).max(14).default(7) }).optional())
    .query(({ input }) => {
      return db.prepare(`
        SELECT id, report_date, report_type, status, generated_at,
               market_regime, sentiment_score, fii_net_5d, error_message
        FROM daily_research_reports
        ORDER BY generated_at DESC
        LIMIT ?
      `).all(input?.limit ?? 7);
    }),

  getResearchStatus: publicProcedure
    .input(z.object({
      date: z.string().optional(),
      type: z.enum(['PRE_MARKET', 'POST_CLOSE']).optional(),
    }).optional())
    .query(({ input }) => {
      const today = new Date().toISOString().split('T')[0];
      const date  = input?.date ?? today;
      const type  = input?.type ?? 'POST_CLOSE';
      return db.prepare(`
        SELECT status, generated_at, error_message
        FROM daily_research_reports
        WHERE report_date = ? AND report_type = ?
      `).get(date, type) ?? { status: 'PENDING', generated_at: null, error_message: null };
    }),

  triggerResearchGeneration: publicProcedure
    .input(z.object({
      date: z.string(),
      type: z.enum(['PRE_MARKET', 'POST_CLOSE']),
    }))
    .mutation(async ({ input }) => {
      const queue = input.type === 'PRE_MARKET'
        ? researchPremarketQueue
        : researchPostcloseQueue;

      if (!queue) {
        // Redis unavailable — run inline
        const { generateDailyReport } = await import('../researchEngine');
        generateDailyReport(input.date, input.type).catch(console.error);
        return { queued: false, inline: true };
      }

      await queue.add('manual-trigger', { date: input.date, type: input.type }, {
        removeOnComplete: { age: 3600 },
        attempts: 1,
      });
      return { queued: true, inline: false };
    }),
});
```

- [ ] **Step 4.2: Register router in router.ts**

Add import after existing imports:

```typescript
import { researchRouter } from "./routers/research.router";
```

Add to `mergeRouters(...)` call:

```typescript
  researchRouter,
```

- [ ] **Step 4.3: Test procedures compile**

```bash
npx tsc --noEmit 2>&1 | grep -i research
```

Expected: no output (no errors).

- [ ] **Step 4.4: Commit**

```bash
git add src/server/routers/research.router.ts src/server/router.ts
git commit -m "feat: add research tRPC router with 4 procedures"
```

---

## Task 5: React Component — HedgeFundResearch

**Files:**
- Create: `src/components/HedgeFundResearch.tsx`

- [ ] **Step 5.1: Create HedgeFundResearch.tsx**

```tsx
// src/components/HedgeFundResearch.tsx
import React, { useState, useEffect } from 'react';
import { trpc } from '../lib/trpc';
import { motion, AnimatePresence } from 'motion/react';
import {
  FlaskConical, TrendingUp, TrendingDown, AlertTriangle,
  ChevronDown, ChevronUp, RefreshCw, Clock, CheckCircle2,
  XCircle, Eye, Plus, BarChart2, Target, Shield, Zap,
  Globe, Activity, Star
} from 'lucide-react';
import { cn } from '../lib/utils';

// ─── Types ────────────────────────────────────────────────────────────────────

interface StockPick {
  symbol: string;
  conviction_score: number;
  quant_rank: number;
  signal_score: number;
  xgboost_score: number;
  screener_net: number;
  rsi: number | null;
  adx: number | null;
  trailing_pe: number | null;
  roe: number | null;
  debt_to_equity: number | null;
  piotroski: number | null;
  bullish_screeners: number;
  return_1m: number | null;
  return_3m: number | null;
  above_sma200: number;
  entry_note: string;
  stop_loss_pct: number;
  target_1_pct: number;
  target_2_pct: number;
  risk_reward: number;
  layers_confirmed: number;
  flags: string[];
}

interface ResearchReport {
  report_date: string;
  report_type: 'PRE_MARKET' | 'POST_CLOSE';
  market_regime: string;
  sentiment_score: number;
  fii_net_5d: number;
  global_cue: string;
  hot_themes: string[];
  top_picks: StockPick[];
  watchlist: { symbol: string; conviction_score: number; layers_confirmed: number }[];
  avoid_list: { symbol: string; reason: string }[];
  sector_rankings: { sector: string; score: number; momentum: string }[];
  executive_summary: string;
}

interface ReportRow {
  id: number;
  report_date: string;
  report_type: 'PRE_MARKET' | 'POST_CLOSE';
  status: 'PENDING' | 'GENERATING' | 'READY' | 'FAILED';
  generated_at: string | null;
  market_regime: string | null;
  sentiment_score: number | null;
  fii_net_5d: number | null;
  top_picks_json: string | null;
  report_json: string | null;
  ai_blurbs_json: string | null;
  error_message: string | null;
}

// ─── Sub-components ───────────────────────────────────────────────────────────

const RegimeBadge: React.FC<{ regime: string }> = ({ regime }) => {
  const colors: Record<string, string> = {
    BULL: 'bg-emerald-500/20 text-emerald-400 border-emerald-500/30',
    TRANSITIONAL_BULL: 'bg-blue-500/20 text-blue-400 border-blue-500/30',
    SIDEWAYS: 'bg-yellow-500/20 text-yellow-400 border-yellow-500/30',
    BEAR: 'bg-red-500/20 text-red-400 border-red-500/30',
  };
  return (
    <span className={cn(
      'px-2 py-0.5 rounded-full text-[10px] font-bold uppercase border',
      colors[regime] ?? 'bg-slate-700 text-slate-400 border-slate-600'
    )}>
      {regime.replace('_', ' ')}
    </span>
  );
};

const StatusBadge: React.FC<{ status: string }> = ({ status }) => {
  if (status === 'READY') return (
    <span className="flex items-center gap-1 text-emerald-400 text-xs font-bold">
      <CheckCircle2 className="w-3 h-3" /> READY
    </span>
  );
  if (status === 'GENERATING') return (
    <span className="flex items-center gap-1 text-blue-400 text-xs font-bold animate-pulse">
      <RefreshCw className="w-3 h-3 animate-spin" /> GENERATING
    </span>
  );
  if (status === 'FAILED') return (
    <span className="flex items-center gap-1 text-red-400 text-xs font-bold">
      <XCircle className="w-3 h-3" /> FAILED
    </span>
  );
  return (
    <span className="flex items-center gap-1 text-slate-400 text-xs font-bold">
      <Clock className="w-3 h-3" /> PENDING
    </span>
  );
};

const ConvictionDots: React.FC<{ score: number }> = ({ score }) => {
  const filled = Math.round((score / 100) * 5);
  return (
    <div className="flex gap-0.5">
      {Array.from({ length: 5 }).map((_, i) => (
        <div key={i} className={cn(
          'w-2 h-2 rounded-full',
          i < filled
            ? filled >= 4 ? 'bg-emerald-400' : filled >= 3 ? 'bg-blue-400' : 'bg-yellow-400'
            : 'bg-slate-700'
        )} />
      ))}
    </div>
  );
};

const LayerBadge: React.FC<{ count: number }> = ({ count }) => (
  <span className={cn(
    'text-[9px] font-black px-1.5 py-0.5 rounded border',
    count >= 4 ? 'bg-emerald-500/20 text-emerald-400 border-emerald-500/30' :
    count >= 3 ? 'bg-blue-500/20 text-blue-400 border-blue-500/30' :
                 'bg-slate-700/50 text-slate-400 border-slate-600'
  )}>
    {count}L
  </span>
);

const ScoreBar: React.FC<{ label: string; value: number; max?: number; color?: string }> = ({
  label, value, max = 100, color = 'bg-blue-500'
}) => (
  <div className="space-y-1">
    <div className="flex justify-between text-[10px]">
      <span className="text-slate-400">{label}</span>
      <span className="text-white font-bold">{value.toFixed(0)}</span>
    </div>
    <div className="h-1.5 bg-slate-800 rounded-full overflow-hidden">
      <div
        className={cn('h-full rounded-full', color)}
        style={{ width: `${Math.min((value / max) * 100, 100)}%` }}
      />
    </div>
  </div>
);

const StockDeepDive: React.FC<{
  pick: StockPick;
  blurbs: Record<string, { bull: string; bear: string; risk: string }>;
  onAddWatchlist: (symbol: string) => void;
}> = ({ pick, blurbs, onAddWatchlist }) => {
  const blurb = blurbs[pick.symbol];
  return (
    <motion.div
      initial={{ opacity: 0, height: 0 }}
      animate={{ opacity: 1, height: 'auto' }}
      exit={{ opacity: 0, height: 0 }}
      className="overflow-hidden"
    >
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 p-4 border-t border-slate-800/50">
        {/* Score breakdown */}
        <div className="space-y-3">
          <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Signal Layers</p>
          <ScoreBar label="Quant Rank" value={pick.quant_rank} color="bg-purple-500" />
          <ScoreBar label="Technical" value={pick.signal_score * 10} color="bg-blue-500" />
          <ScoreBar label="XGBoost ML" value={(pick.xgboost_score ?? 0) * 100} color="bg-emerald-500" />
          <ScoreBar label="Screener Net" value={Math.min(pick.screener_net, 100)} color="bg-yellow-500" />
        </div>

        {/* Fundamental snapshot */}
        <div className="space-y-2">
          <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Fundamentals</p>
          {[
            ['PE', pick.trailing_pe?.toFixed(1) ?? '—'],
            ['ROE', pick.roe ? `${(pick.roe * 100).toFixed(1)}%` : '—'],
            ['D/E', pick.debt_to_equity?.toFixed(2) ?? '—'],
            ['Piotroski', `${pick.piotroski ?? '—'}/9`],
            ['Screeners ↑', String(pick.bullish_screeners)],
            ['1M Return', pick.return_1m ? `${pick.return_1m.toFixed(1)}%` : '—'],
          ].map(([k, v]) => (
            <div key={k} className="flex justify-between text-xs">
              <span className="text-slate-400">{k}</span>
              <span className="text-white font-bold">{v}</span>
            </div>
          ))}
          {pick.flags.length > 0 && (
            <div className="flex flex-wrap gap-1 pt-1">
              {pick.flags.map(f => (
                <span key={f} className="text-[9px] px-1.5 py-0.5 bg-red-500/10 text-red-400 border border-red-500/20 rounded">
                  {f}
                </span>
              ))}
            </div>
          )}
        </div>

        {/* AI blurbs */}
        <div className="space-y-3">
          <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest">AI Analysis</p>
          {blurb ? (
            <>
              <div className="space-y-1">
                <p className="text-[10px] text-emerald-400 font-bold">BULL CASE</p>
                <p className="text-xs text-slate-300 leading-relaxed">{blurb.bull}</p>
              </div>
              <div className="space-y-1">
                <p className="text-[10px] text-red-400 font-bold">KEY RISK</p>
                <p className="text-xs text-slate-300 leading-relaxed">{blurb.risk}</p>
              </div>
            </>
          ) : (
            <p className="text-xs text-slate-500 italic">AI analysis unavailable</p>
          )}
          <button
            onClick={() => onAddWatchlist(pick.symbol)}
            className="mt-2 w-full text-xs py-1.5 rounded-lg border border-blue-500/30 text-blue-400 hover:bg-blue-500/10 transition-all"
          >
            + Add to Watchlist
          </button>
        </div>
      </div>
    </motion.div>
  );
};

const TopPicksTable: React.FC<{
  picks: StockPick[];
  blurbs: Record<string, { bull: string; bear: string; risk: string }>;
  onAddWatchlist: (symbol: string) => void;
}> = ({ picks, blurbs, onAddWatchlist }) => {
  const [expanded, setExpanded] = useState<string | null>(null);

  return (
    <div className="glass-strong border border-slate-800/30 rounded-2xl overflow-hidden">
      <div className="p-4 border-b border-slate-800/50 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Trophy className="w-4 h-4 text-yellow-400" />
          <h3 className="text-sm font-black text-white uppercase tracking-widest">Top 10 Picks</h3>
        </div>
        <p className="text-[10px] text-slate-500 uppercase">Click row to expand analysis</p>
      </div>

      {/* Header */}
      <div className="grid grid-cols-10 gap-2 px-4 py-2 text-[10px] font-black text-slate-500 uppercase tracking-widest border-b border-slate-800/30">
        <span>#</span>
        <span className="col-span-2">Symbol</span>
        <span className="text-right">Score</span>
        <span className="text-right">Layers</span>
        <span className="text-right">Entry</span>
        <span className="text-right">SL</span>
        <span className="text-right">T1</span>
        <span className="text-right">R:R</span>
        <span className="text-right">Conv.</span>
      </div>

      {picks.map((pick, i) => (
        <div key={pick.symbol}>
          <motion.div
            initial={{ opacity: 0, x: -10 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ delay: i * 0.03 }}
            onClick={() => setExpanded(expanded === pick.symbol ? null : pick.symbol)}
            className="grid grid-cols-10 gap-2 px-4 py-3 hover:bg-slate-800/30 cursor-pointer transition-all border-b border-slate-800/20 items-center"
          >
            <span className="text-xs font-black text-slate-500">#{i + 1}</span>
            <div className="col-span-2">
              <p className="text-sm font-black text-white">{pick.symbol}</p>
              <p className="text-[10px] text-slate-500 truncate">{pick.entry_note}</p>
            </div>
            <span className="text-right text-sm font-bold text-white">{pick.conviction_score}</span>
            <span className="text-right"><LayerBadge count={pick.layers_confirmed} /></span>
            <span className="text-right text-xs text-slate-400">CMP</span>
            <span className="text-right text-xs text-red-400 font-bold">{pick.stop_loss_pct}%</span>
            <span className="text-right text-xs text-emerald-400 font-bold">+{pick.target_1_pct.toFixed(0)}%</span>
            <span className="text-right text-xs text-blue-400 font-bold">1:{pick.risk_reward}</span>
            <div className="flex justify-end">
              <ConvictionDots score={pick.conviction_score} />
            </div>
          </motion.div>

          <AnimatePresence>
            {expanded === pick.symbol && (
              <StockDeepDive pick={pick} blurbs={blurbs} onAddWatchlist={onAddWatchlist} />
            )}
          </AnimatePresence>
        </div>
      ))}
    </div>
  );
};

const MarketContextBar: React.FC<{
  regime: string;
  sentimentScore: number;
  fiiNet5d: number;
  globalCue: string;
  hotThemes: string[];
}> = ({ regime, sentimentScore, fiiNet5d, globalCue, hotThemes }) => (
  <div className="glass border border-slate-800/30 rounded-2xl p-4 flex flex-wrap gap-6 items-center">
    <div className="flex items-center gap-2">
      <Activity className="w-4 h-4 text-slate-400" />
      <div>
        <p className="text-[10px] text-slate-500 uppercase font-bold">Regime</p>
        <RegimeBadge regime={regime} />
      </div>
    </div>
    <div>
      <p className="text-[10px] text-slate-500 uppercase font-bold">Sentiment</p>
      <p className={cn('text-sm font-black', sentimentScore > 0 ? 'text-emerald-400' : 'text-red-400')}>
        {sentimentScore.toFixed(1)}/100
      </p>
    </div>
    <div>
      <p className="text-[10px] text-slate-500 uppercase font-bold">FII 5D Net</p>
      <p className={cn('text-sm font-black', fiiNet5d > 0 ? 'text-emerald-400' : 'text-red-400')}>
        {fiiNet5d > 0 ? '+' : ''}₹{(fiiNet5d / 100).toFixed(0)}Cr
      </p>
    </div>
    <div>
      <p className="text-[10px] text-slate-500 uppercase font-bold">Global</p>
      <p className={cn('text-sm font-black',
        globalCue === 'Positive' ? 'text-emerald-400' :
        globalCue === 'Negative' ? 'text-red-400' : 'text-yellow-400'
      )}>{globalCue}</p>
    </div>
    {hotThemes.length > 0 && (
      <div className="flex flex-wrap gap-1">
        {hotThemes.slice(0, 5).map(t => (
          <span key={t} className="text-[10px] px-2 py-0.5 bg-blue-500/10 text-blue-400 border border-blue-500/20 rounded-full">
            {t}
          </span>
        ))}
      </div>
    )}
  </div>
);

const ResearchSidebar: React.FC<{
  avoid: { symbol: string; reason: string }[];
  watchlist: { symbol: string; conviction_score: number; layers_confirmed: number }[];
  sectors: { sector: string; score: number; momentum: string }[];
}> = ({ avoid, watchlist, sectors }) => (
  <div className="space-y-4">
    {/* Avoid list */}
    <div className="glass-strong border border-slate-800/30 rounded-2xl p-4">
      <div className="flex items-center gap-2 mb-3">
        <AlertTriangle className="w-4 h-4 text-red-400" />
        <h3 className="text-sm font-black text-white uppercase tracking-widest">Avoid</h3>
      </div>
      <div className="space-y-2">
        {avoid.slice(0, 5).map(a => (
          <div key={a.symbol} className="flex items-center justify-between">
            <span className="text-sm font-bold text-red-400">{a.symbol}</span>
            <span className="text-[10px] text-slate-500 truncate max-w-[100px]">{a.reason.split(',')[0]}</span>
          </div>
        ))}
      </div>
    </div>

    {/* Watchlist candidates */}
    <div className="glass-strong border border-slate-800/30 rounded-2xl p-4">
      <div className="flex items-center gap-2 mb-3">
        <Eye className="w-4 h-4 text-yellow-400" />
        <h3 className="text-sm font-black text-white uppercase tracking-widest">Watchlist</h3>
      </div>
      <div className="space-y-2">
        {watchlist.slice(0, 8).map(w => (
          <div key={w.symbol} className="flex items-center justify-between">
            <span className="text-sm font-bold text-slate-300">{w.symbol}</span>
            <div className="flex items-center gap-2">
              <LayerBadge count={w.layers_confirmed} />
              <span className="text-xs text-slate-500">{w.conviction_score.toFixed(0)}</span>
            </div>
          </div>
        ))}
      </div>
    </div>

    {/* Sector rankings */}
    <div className="glass-strong border border-slate-800/30 rounded-2xl p-4">
      <div className="flex items-center gap-2 mb-3">
        <BarChart2 className="w-4 h-4 text-blue-400" />
        <h3 className="text-sm font-black text-white uppercase tracking-widest">Sectors</h3>
      </div>
      <div className="space-y-2">
        {sectors.slice(0, 6).map((s, i) => (
          <div key={s.sector} className="space-y-1">
            <div className="flex justify-between text-[10px]">
              <span className="text-slate-400 truncate max-w-[110px]">#{i + 1} {s.sector}</span>
              <span className={cn('font-bold',
                s.momentum === 'STRONG' ? 'text-emerald-400' :
                s.momentum === 'MODERATE' ? 'text-yellow-400' : 'text-red-400'
              )}>{s.momentum}</span>
            </div>
            <div className="h-1 bg-slate-800 rounded-full overflow-hidden">
              <div className="h-full bg-blue-500/60 rounded-full" style={{ width: `${s.score}%` }} />
            </div>
          </div>
        ))}
      </div>
    </div>
  </div>
);

// Need to import Trophy since it's used in TopPicksTable
import { Trophy } from 'lucide-react';

// ─── Main Page Component ──────────────────────────────────────────────────────

interface HedgeFundResearchProps {
  onAddWatchlist?: (symbol: string, meta?: any) => void;
}

const HedgeFundResearch: React.FC<HedgeFundResearchProps> = ({ onAddWatchlist }) => {
  const [selectedDate, setSelectedDate] = useState<string | undefined>(undefined);
  const [selectedType, setSelectedType] = useState<'PRE_MARKET' | 'POST_CLOSE' | undefined>(undefined);
  const [pollStatus, setPollStatus] = useState(false);

  const { data: reportRow, isLoading, refetch } = trpc.getDailyResearch.useQuery(
    { date: selectedDate, type: selectedType },
    { refetchInterval: pollStatus ? 15000 : false }
  );

  const { data: history } = trpc.getDailyResearchHistory.useQuery({ limit: 7 });
  const triggerMutation = trpc.triggerResearchGeneration.useMutation({
    onSuccess: () => refetch(),
  });

  // Poll while generating
  useEffect(() => {
    setPollStatus(reportRow?.status === 'GENERATING');
  }, [reportRow?.status]);

  // Parse report JSON
  const report: ResearchReport | null = (() => {
    if (!reportRow?.report_json) return null;
    try { return JSON.parse(reportRow.report_json); } catch { return null; }
  })();

  const blurbs: Record<string, { bull: string; bear: string; risk: string }> = (() => {
    if (!reportRow?.ai_blurbs_json) return {};
    try { return JSON.parse(reportRow.ai_blurbs_json); } catch { return {}; }
  })();

  // Last 7 unique dates from history
  const historyDates = [...new Set((history ?? []).map((r: any) => r.report_date))].slice(0, 7);

  const handleAddWatchlist = (symbol: string) => {
    onAddWatchlist?.(symbol, { source: 'research' });
  };

  const handleTrigger = () => {
    const today = new Date().toISOString().split('T')[0];
    triggerMutation.mutate({
      date: selectedDate ?? today,
      type: selectedType ?? 'POST_CLOSE',
    });
  };

  return (
    <div className="space-y-6 pb-12">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl glass border border-slate-800/50 flex items-center justify-center">
            <FlaskConical className="w-5 h-5 text-blue-400" />
          </div>
          <div>
            <h1 className="text-xl font-black text-white uppercase tracking-widest">
              Hedge Fund Research
            </h1>
            <p className="text-xs text-slate-400">
              Daily institutional-grade analysis · AI-powered conviction scoring
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          {/* Status */}
          <StatusBadge status={reportRow?.status ?? 'PENDING'} />
          {reportRow?.generated_at && (
            <span className="text-[10px] text-slate-500">
              {new Date(reportRow.generated_at).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}
            </span>
          )}

          {/* Type toggle */}
          <div className="flex rounded-lg overflow-hidden border border-slate-700">
            {(['PRE_MARKET', 'POST_CLOSE'] as const).map(t => (
              <button
                key={t}
                onClick={() => setSelectedType(selectedType === t ? undefined : t)}
                className={cn(
                  'px-3 py-1.5 text-[10px] font-black uppercase transition-all',
                  selectedType === t
                    ? 'bg-blue-600 text-white'
                    : 'bg-slate-800/50 text-slate-400 hover:text-white'
                )}
              >
                {t === 'PRE_MARKET' ? 'Pre-Mkt' : 'Post-Close'}
              </button>
            ))}
          </div>

          {/* Trigger button */}
          {(reportRow?.status === 'FAILED' || !reportRow) && (
            <button
              onClick={handleTrigger}
              disabled={triggerMutation.isPending}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-blue-600/20 border border-blue-500/30 text-blue-400 text-xs font-bold hover:bg-blue-600/30 transition-all disabled:opacity-50"
            >
              <RefreshCw className={cn('w-3 h-3', triggerMutation.isPending && 'animate-spin')} />
              Generate
            </button>
          )}
        </div>
      </div>

      {/* Date pills */}
      {historyDates.length > 0 && (
        <div className="flex gap-2 flex-wrap">
          <button
            onClick={() => setSelectedDate(undefined)}
            className={cn(
              'px-3 py-1 text-xs rounded-full border transition-all font-bold',
              !selectedDate
                ? 'bg-blue-600 border-blue-500 text-white'
                : 'border-slate-700 text-slate-400 hover:border-slate-600'
            )}
          >
            Latest
          </button>
          {historyDates.map((d: string) => (
            <button
              key={d}
              onClick={() => setSelectedDate(d)}
              className={cn(
                'px-3 py-1 text-xs rounded-full border transition-all font-bold',
                selectedDate === d
                  ? 'bg-blue-600 border-blue-500 text-white'
                  : 'border-slate-700 text-slate-400 hover:border-slate-600'
              )}
            >
              {d}
            </button>
          ))}
        </div>
      )}

      {/* Loading state */}
      {isLoading && (
        <div className="glass border border-slate-800/30 rounded-2xl p-12 flex items-center justify-center">
          <RefreshCw className="w-6 h-6 text-blue-400 animate-spin" />
        </div>
      )}

      {/* Generating state */}
      {!isLoading && reportRow?.status === 'GENERATING' && (
        <div className="glass border border-blue-500/20 rounded-2xl p-8 text-center space-y-3">
          <RefreshCw className="w-8 h-8 text-blue-400 animate-spin mx-auto" />
          <p className="text-white font-bold">Generating report...</p>
          <p className="text-slate-400 text-sm">Querying 8 signal layers · Computing conviction scores · Writing AI blurbs</p>
        </div>
      )}

      {/* No report state */}
      {!isLoading && !reportRow && (
        <div className="glass border border-slate-800/30 rounded-2xl p-8 text-center space-y-3">
          <FlaskConical className="w-8 h-8 text-slate-600 mx-auto" />
          <p className="text-slate-400">No report available for this date/type.</p>
          <button
            onClick={handleTrigger}
            className="px-4 py-2 rounded-lg bg-blue-600/20 border border-blue-500/30 text-blue-400 text-sm font-bold hover:bg-blue-600/30 transition-all"
          >
            Generate Now
          </button>
        </div>
      )}

      {/* Failed state */}
      {!isLoading && reportRow?.status === 'FAILED' && (
        <div className="glass border border-red-500/20 rounded-2xl p-6 space-y-2">
          <p className="text-red-400 font-bold">Report generation failed</p>
          <p className="text-slate-500 text-sm">{reportRow.error_message}</p>
          <button onClick={handleTrigger} className="text-xs text-blue-400 hover:underline">
            Retry
          </button>
        </div>
      )}

      {/* Report content */}
      {!isLoading && report && (
        <>
          {/* Market context bar */}
          <MarketContextBar
            regime={report.market_regime}
            sentimentScore={report.sentiment_score}
            fiiNet5d={report.fii_net_5d}
            globalCue={report.global_cue}
            hotThemes={report.hot_themes}
          />

          {/* Executive summary */}
          {report.executive_summary && (
            <div className="glass border border-slate-800/30 rounded-2xl p-4">
              <p className="text-[10px] font-black text-slate-500 uppercase tracking-widest mb-2">
                Executive Summary
              </p>
              <p className="text-sm text-slate-300 leading-relaxed">{report.executive_summary}</p>
            </div>
          )}

          {/* Main grid */}
          <div className="grid grid-cols-1 xl:grid-cols-4 gap-6">
            <div className="xl:col-span-3">
              <TopPicksTable
                picks={report.top_picks}
                blurbs={blurbs}
                onAddWatchlist={handleAddWatchlist}
              />
            </div>
            <div className="xl:col-span-1">
              <ResearchSidebar
                avoid={report.avoid_list}
                watchlist={report.watchlist}
                sectors={report.sector_rankings}
              />
            </div>
          </div>
        </>
      )}
    </div>
  );
};

export default HedgeFundResearch;
```

- [ ] **Step 5.2: Fix duplicate Trophy import** (it's imported twice in the file above — remove the second one at the top level, keep the one in the Lucide import block at the top)

Edit the file: remove the standalone `import { Trophy } from 'lucide-react';` line that appears just before the main component, since Trophy is already in the top-level import.

- [ ] **Step 5.3: Check TypeScript**

```bash
npx tsc --noEmit 2>&1 | grep -i "HedgeFundResearch\|research"
```

Expected: no errors.

- [ ] **Step 5.4: Commit**

```bash
git add src/components/HedgeFundResearch.tsx
git commit -m "feat: add HedgeFundResearch page component"
```

---

## Task 6: App.tsx Integration — Tab + Route

**Files:**
- Modify: `src/App.tsx`

- [ ] **Step 6.1: Add import**

Add after the last component import in `src/App.tsx`:

```typescript
import HedgeFundResearch from './components/HedgeFundResearch';
```

- [ ] **Step 6.2: Add tab to navigation array**

Find the nav tab array in `App.tsx` (look for the object containing `{ id: 'signals', ... }` and `{ id: 'sentiment', ... }`). Add between them:

```typescript
{ id: 'research', label: 'Research', icon: FlaskConical },
```

- [ ] **Step 6.3: Add FlaskConical to Lucide imports**

Find the existing Lucide import block in `App.tsx` and add `FlaskConical` to it.

- [ ] **Step 6.4: Add route/case for research tab**

Find the switch/conditional that renders tab content (look for `case 'signals':` or `activeTab === 'signals'`) and add:

```tsx
{activeTab === 'research' && (
  <HedgeFundResearch
    onAddWatchlist={handleAddToWatchlist}
  />
)}
```

- [ ] **Step 6.5: Start dev server and verify**

```bash
npm run dev
```

Navigate to Research tab. Expect:
- "No report available" state with Generate button
- Clicking Generate queues/runs report generation
- After completion, market context bar + picks table appear

- [ ] **Step 6.6: Manually trigger a report to test**

```bash
node -e "
const { generateDailyReport } = require('./src/server/researchEngine');
const today = new Date().toISOString().split('T')[0];
generateDailyReport(today, 'POST_CLOSE').then(() => console.log('done')).catch(console.error);
"
```

Expected: `done` printed, report visible in UI.

- [ ] **Step 6.7: Commit**

```bash
git add src/App.tsx
git commit -m "feat: add Research tab to main navigation"
```

---

## Verification Checklist

- [ ] `daily_research_reports` table exists in database.sqlite
- [ ] `generateDailyReport()` completes without errors for today's date
- [ ] Report status transitions: PENDING → GENERATING → READY
- [ ] TopPicksTable renders 10 rows with score/SL/target columns
- [ ] Clicking a row expands StockDeepDive with score bars
- [ ] AI blurbs show when Ollama is running (silently absent when not)
- [ ] Date pills show last 7 report dates
- [ ] PRE_MARKET / POST_CLOSE toggle switches report type
- [ ] Avoid list, watchlist, sector rankings render in sidebar
- [ ] BullMQ queues registered (check logs for `[QUEUE] research-premarket` on server start)
