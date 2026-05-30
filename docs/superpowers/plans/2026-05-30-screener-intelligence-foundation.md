# Screener Intelligence Foundation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build screener tier ranking (A/B/C/D), multi-horizon performance (5d/10d/20d/60d/120d), subcategory classification, and dated appearance tracking on top of existing 1,521 screeners.

**Architecture:** DB migrations add 2 new tables + extend 2 existing ones. A Python script computes Bayesian performance metrics nightly. A TypeScript service classifies screeners via keywords + Ollama. Three existing sync functions get a 18-line diff patch each to record appearances. Five new tRPC endpoints expose the data. All changes are additive — no existing code deleted.

**Tech Stack:** TypeScript + tRPC + better-sqlite3 (Node), Python 3.11 + sqlite3 (analytics), BullMQ (scheduling), Ollama (local LLM fallback)

---

## File Map

| File | Status | Responsibility |
|---|---|---|
| `src/server/db.ts` | Modify | Add 2 migrations: new tables + ALTER TABLE columns |
| `src/server/screenerClassifier.ts` | Create | Keyword + Ollama classification service |
| `src/server/screener_performance.py` | Create | Nightly Bayesian performance + tier computation |
| `src/server/trendlyneScreener.ts` | Modify | Add appearance diff patch after saveScreenerStocksToDB |
| `src/server/moneycontrolScreener.ts` | Modify | Add appearance diff patch after DELETE+INSERT loop |
| `src/server/etnowScreenerSync.ts` | Modify | Add appearance diff patch after DELETE+INSERT loop |
| `src/server/routers/screeners.router.ts` | Modify | Add 5 new tRPC procedures |
| `src/server/routers/monitor.router.ts` | Modify | Add screener-performance to MONITOR_SCRIPTS |
| `src/server/queues.ts` | Modify | Add screener-performance BullMQ queue + worker |

---

## Task 1: DB Migrations

**Files:**
- Modify: `src/server/db.ts`

The codebase uses a `runMigration(name, sql)` pattern — each migration runs once, tracked in `_migrations` table. Add two migrations at the bottom of `db.ts`.

- [ ] **Step 1: Read the end of db.ts to find where to insert**

Open `src/server/db.ts` and find the last `runMigration(...)` call. New migrations go after it.

- [ ] **Step 2: Add the two new migrations**

Find the last `runMigration` call in `src/server/db.ts` and add after it:

```typescript
runMigration('030_screener_appearances', `
  CREATE TABLE IF NOT EXISTS screener_appearances (
    screener_id   TEXT NOT NULL,
    source        TEXT NOT NULL,
    symbol        TEXT NOT NULL,
    appeared_date DATE NOT NULL,
    exited_date   DATE,
    return_5d     REAL,
    return_10d    REAL,
    return_20d    REAL,
    return_60d    REAL,
    return_120d   REAL,
    nifty_ret_20d REAL,
    outcome_20d   TEXT,
    PRIMARY KEY (screener_id, symbol, appeared_date)
  );
  CREATE INDEX IF NOT EXISTS idx_sa_symbol   ON screener_appearances(symbol);
  CREATE INDEX IF NOT EXISTS idx_sa_date     ON screener_appearances(appeared_date);
  CREATE INDEX IF NOT EXISTS idx_sa_screener ON screener_appearances(screener_id);
`);

runMigration('031_screener_performance_v2', `
  CREATE TABLE IF NOT EXISTS screener_performance_v2 (
    screener_id        TEXT PRIMARY KEY,
    source             TEXT NOT NULL,
    total_appearances  INTEGER DEFAULT 0,
    resolved_count     INTEGER DEFAULT 0,
    wr_5d     REAL, wr_10d    REAL, wr_20d    REAL, wr_60d    REAL, wr_120d   REAL,
    avg_ret_5d  REAL, avg_ret_10d  REAL, avg_ret_20d  REAL,
    avg_ret_60d REAL, avg_ret_120d REAL,
    alpha_20d    REAL,
    alpha_60d    REAL,
    sharpe_20d   REAL,
    max_drawdown REAL,
    median_ret_20d REAL,
    bayesian_score REAL,
    tier           TEXT,
    data_source    TEXT,
    last_computed  DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

runMigration('032_screener_master_subcategory', `
  ALTER TABLE screener_master ADD COLUMN subcategory         TEXT;
  ALTER TABLE screener_master ADD COLUMN tier                TEXT;
  ALTER TABLE screener_master ADD COLUMN category_confidence REAL;
  ALTER TABLE screener_master ADD COLUMN classified_by       TEXT;
`);

runMigration('033_screener_reliability_horizons', `
  ALTER TABLE screener_reliability ADD COLUMN win_rate_5d   REAL;
  ALTER TABLE screener_reliability ADD COLUMN win_rate_10d  REAL;
  ALTER TABLE screener_reliability ADD COLUMN win_rate_20d  REAL;
  ALTER TABLE screener_reliability ADD COLUMN win_rate_60d  REAL;
  ALTER TABLE screener_reliability ADD COLUMN win_rate_120d REAL;
`);
```

- [ ] **Step 3: Verify migrations apply cleanly**

```bash
cd c:/Github/bharat-stock-intelligence
npx tsx -e "import './src/server/db'; console.log('migrations OK')"
```

Expected output: `migrations OK` with no errors.

- [ ] **Step 4: Verify tables exist**

```bash
python -c "
import sqlite3
conn = sqlite3.connect('database.sqlite')
tables = [r[0] for r in conn.execute(\"SELECT name FROM sqlite_master WHERE type='table'\").fetchall()]
print('screener_appearances' in tables, 'screener_performance_v2' in tables)
cols_master = [r[1] for r in conn.execute('PRAGMA table_info(screener_master)').fetchall()]
print('subcategory' in cols_master, 'tier' in cols_master)
conn.close()
"
```

Expected: `True True` then `True True`

- [ ] **Step 5: Commit**

```bash
git add src/server/db.ts
git commit -m "feat(db): add screener_appearances, screener_performance_v2 tables + extend screener_master/reliability"
```

---

## Task 2: screenerClassifier.ts

**Files:**
- Create: `src/server/screenerClassifier.ts`

Classifies screeners using ~120 keyword rules first, Ollama fallback for anything that scores below 0.7 confidence.

- [ ] **Step 1: Create the file**

```typescript
// src/server/screenerClassifier.ts
import db from './db';

export type ScreenerCategory =
  | 'momentum' | 'institutional' | 'fundamental' | 'volume'
  | 'trend' | 'reversal' | 'quality' | 'growth'
  | 'sector' | 'valuation' | 'delivery' | 'other';

interface ClassifyResult {
  category: ScreenerCategory;
  subcategory: string | null;
  confidence: number;
  classified_by: 'keyword' | 'ollama';
}

// ── Keyword rule tables ──────────────────────────────────────────────────────

const RULES: Array<{
  category: ScreenerCategory;
  subcategory: string;
  keywords: string[];
  confidence: number;
}> = [
  // Momentum
  { category: 'momentum', subcategory: '52W High',          keywords: ['52 week high', '52w high', '52-week high', '52wk high', 'year high', '52 high'], confidence: 0.95 },
  { category: 'momentum', subcategory: '52W Low',           keywords: ['52 week low', '52w low', '52-week low', 'year low'], confidence: 0.95 },
  { category: 'momentum', subcategory: 'Breakout',          keywords: ['breakout', 'break out', 'breaking out', 'resistance breakout', 'price breakout'], confidence: 0.90 },
  { category: 'momentum', subcategory: 'Relative Strength', keywords: ['relative strength', 'rs rating', 'momentum score', 'trendlyne momentum', 'price momentum'], confidence: 0.90 },
  { category: 'momentum', subcategory: 'Multibagger',       keywords: ['multibagger', 'multi-bagger', 'multi bagger', 'wealth creator'], confidence: 0.90 },
  { category: 'momentum', subcategory: 'Price Surge',       keywords: ['price surge', 'surge', 'rally', 'gainer', 'top gainer', 'price rise', 'all time high', 'ath'], confidence: 0.85 },

  // Institutional
  { category: 'institutional', subcategory: 'FII Buying',    keywords: ['fii buy', 'fii buying', 'fii purchased', 'foreign buy', 'foreign institutional buy'], confidence: 0.95 },
  { category: 'institutional', subcategory: 'DII Buying',    keywords: ['dii buy', 'dii buying', 'domestic institutional', 'mutual fund buy', 'mf buy'], confidence: 0.95 },
  { category: 'institutional', subcategory: 'Bulk Deal',     keywords: ['bulk deal', 'bulk purchase', 'bulk transaction'], confidence: 0.95 },
  { category: 'institutional', subcategory: 'Block Deal',    keywords: ['block deal', 'block trade', 'block transaction'], confidence: 0.95 },
  { category: 'institutional', subcategory: 'Promoter Buy',  keywords: ['promoter buy', 'promoter purchase', 'promoter increas', 'insider buy'], confidence: 0.90 },
  { category: 'institutional', subcategory: 'FII/DII',       keywords: ['fii', 'dii', 'fpi', 'institutional buying', 'institutional activity'], confidence: 0.80 },

  // Fundamental
  { category: 'fundamental', subcategory: 'Low PE',          keywords: ['low pe', 'undervalued pe', 'pe below', 'cheap pe', 'low p/e'], confidence: 0.90 },
  { category: 'fundamental', subcategory: 'PEG Undervalued', keywords: ['peg', 'peg ratio', 'peg undervalued', 'low peg'], confidence: 0.90 },
  { category: 'fundamental', subcategory: 'Earnings Growth', keywords: ['earnings growth', 'eps growth', 'profit growth qoq', 'qoq profit', 'net profit increas'], confidence: 0.85 },
  { category: 'fundamental', subcategory: 'ROCE Strong',     keywords: ['roce', 'return on capital', 'high roce', 'strong roce'], confidence: 0.90 },
  { category: 'fundamental', subcategory: 'Debt-Free',       keywords: ['debt free', 'zero debt', 'debt-free', 'no debt', 'debt to equity < 0.1'], confidence: 0.92 },
  { category: 'fundamental', subcategory: 'Strong Financials', keywords: ['strong financials', 'piotroski', 'financial health', 'fundamental'], confidence: 0.80 },

  // Volume
  { category: 'volume', subcategory: 'Volume Shock',         keywords: ['volume shock', 'vol shock', 'unusual volume', 'volume spike', 'abnormal volume'], confidence: 0.95 },
  { category: 'volume', subcategory: 'High Vol Breakout',    keywords: ['high volume breakout', 'volume breakout', 'volume expansion', 'vol breakout'], confidence: 0.90 },
  { category: 'volume', subcategory: 'Delivery Spike',       keywords: ['delivery volume', 'delivery percentage', 'delivery spike', 'high delivery', 'delivery ratio'], confidence: 0.90 },
  { category: 'volume', subcategory: 'OI Buildup',           keywords: ['oi buildup', 'open interest', 'oi increase', 'put call', 'pcr'], confidence: 0.85 },
  { category: 'volume', subcategory: 'Volume',               keywords: ['volume surge', 'high volume', 'trading volume', 'volume increase'], confidence: 0.80 },

  // Trend
  { category: 'trend', subcategory: 'Golden Cross',          keywords: ['golden cross', 'sma50 above sma200', 'death cross', '50 200 crossover'], confidence: 0.95 },
  { category: 'trend', subcategory: 'EMA Crossover',         keywords: ['ema crossover', 'ema cross', 'ema bullish', 'ema bearish', 'ema stack', 'bull stack'], confidence: 0.90 },
  { category: 'trend', subcategory: 'MA Breakout',           keywords: ['ma breakout', 'moving average breakout', 'crossed above sma', 'price above ma', 'above 200 dma'], confidence: 0.88 },
  { category: 'trend', subcategory: 'Supertrend',            keywords: ['supertrend', 'super trend'], confidence: 0.95 },
  { category: 'trend', subcategory: 'ADX Strong',            keywords: ['adx', 'average directional', 'strong trend', 'trend strength'], confidence: 0.85 },
  { category: 'trend', subcategory: 'Uptrend',               keywords: ['uptrend', 'up trend', 'trending up', 'price uptrend'], confidence: 0.82 },
  { category: 'trend', subcategory: 'Downtrend',             keywords: ['downtrend', 'down trend', 'bearish trend', 'trending down'], confidence: 0.82 },

  // Reversal
  { category: 'reversal', subcategory: 'RSI Oversold',       keywords: ['rsi oversold', 'rsi below 30', 'oversold rsi', 'rsi reversal', 'rsi bounce'], confidence: 0.92 },
  { category: 'reversal', subcategory: 'RSI Overbought',     keywords: ['rsi overbought', 'rsi above 70', 'overbought rsi'], confidence: 0.92 },
  { category: 'reversal', subcategory: 'MACD Cross',         keywords: ['macd crossover', 'macd cross', 'macd bullish', 'macd bearish', 'macd signal'], confidence: 0.90 },
  { category: 'reversal', subcategory: 'Support Bounce',     keywords: ['support bounce', 'bounce from support', 'support level', 'demand zone bounce'], confidence: 0.88 },
  { category: 'reversal', subcategory: 'BB Squeeze',         keywords: ['bollinger band', 'bb squeeze', 'bollinger squeeze', 'bb breakout', 'bandwidth'], confidence: 0.88 },
  { category: 'reversal', subcategory: 'Hammer/Doji',        keywords: ['hammer', 'doji', 'engulfing', 'candlestick pattern', 'morning star', 'evening star', 'harami'], confidence: 0.88 },
  { category: 'reversal', subcategory: 'CCI Oversold',       keywords: ['cci oversold', 'cci below', 'commodity channel'], confidence: 0.88 },
  { category: 'reversal', subcategory: 'MFI Oversold',       keywords: ['mfi oversold', 'money flow index', 'mfi below'], confidence: 0.88 },

  // Quality
  { category: 'quality', subcategory: 'Consistent Compounder', keywords: ['consistent compounder', 'compounder', 'wealth creator', 'consistent performer'], confidence: 0.92 },
  { category: 'quality', subcategory: 'High ROE',            keywords: ['high roe', 'roe above', 'return on equity', 'strong roe'], confidence: 0.90 },
  { category: 'quality', subcategory: 'High ROCE',           keywords: ['high roce', 'roce above', 'return on capital employed', 'strong roce'], confidence: 0.90 },
  { category: 'quality', subcategory: 'Dividend',            keywords: ['dividend yield', 'high dividend', 'dividend paying', 'regular dividend'], confidence: 0.90 },
  { category: 'quality', subcategory: 'Zero Debt',           keywords: ['zero debt', 'debt free', 'no debt', 'debt-free'], confidence: 0.92 },
  { category: 'quality', subcategory: 'Cash Rich',           keywords: ['cash rich', 'cash cow', 'high cash', 'cash generation'], confidence: 0.88 },

  // Growth
  { category: 'growth', subcategory: 'Sales Growth',         keywords: ['sales growth', 'revenue growth', 'topline growth', 'top line growth', 'net sales growth'], confidence: 0.90 },
  { category: 'growth', subcategory: 'Profit Growth',        keywords: ['profit growth', 'pat growth', 'net profit growth', 'earnings growth yoy', 'profit increas'], confidence: 0.90 },
  { category: 'growth', subcategory: 'Earnings Surprise',    keywords: ['earnings surprise', 'beat estimate', 'positive surprise', 'above estimate'], confidence: 0.90 },
  { category: 'growth', subcategory: 'Margin Expansion',     keywords: ['margin expansion', 'margin improvement', 'operating margin', 'ebitda margin'], confidence: 0.88 },

  // Valuation
  { category: 'valuation', subcategory: 'Low PE',            keywords: ['low pe', 'pe below average', 'cheap stock', 'undervalued pe'], confidence: 0.88 },
  { category: 'valuation', subcategory: 'Low PB',            keywords: ['price to book', 'p/b below', 'low pb', 'book value'], confidence: 0.88 },
  { category: 'valuation', subcategory: 'DVM',               keywords: ['dvm', 'dvm score', 'dvm rating', 'high dvm', 'low dvm'], confidence: 0.95 },
  { category: 'valuation', subcategory: 'Margin of Safety',  keywords: ['margin of safety', 'intrinsic value', 'graham', 'undervalued'], confidence: 0.85 },

  // Delivery
  { category: 'delivery', subcategory: 'Delivery Spike',     keywords: ['delivery spike', 'high delivery', 'delivery percentage increase', 'rising delivery'], confidence: 0.92 },
  { category: 'delivery', subcategory: 'Bulk Deal',          keywords: ['bulk deal', 'block deal', 'large transaction'], confidence: 0.90 },
  { category: 'delivery', subcategory: 'Promoter Activity',  keywords: ['promoter buying', 'promoter holding', 'promoter pledge'], confidence: 0.88 },

  // Sector
  { category: 'sector', subcategory: 'Banking/NBFC',         keywords: ['banking', 'bank stocks', 'nbfc', 'financial sector', 'fintech'], confidence: 0.88 },
  { category: 'sector', subcategory: 'IT/Tech',              keywords: ['it sector', 'technology stocks', 'software stocks', 'it companies'], confidence: 0.88 },
  { category: 'sector', subcategory: 'Pharma',               keywords: ['pharma', 'pharmaceutical', 'healthcare', 'hospital'], confidence: 0.88 },
  { category: 'sector', subcategory: 'Infra/Defence',        keywords: ['infrastructure', 'defence', 'defense', 'railway', 'roads', 'infra'], confidence: 0.88 },
  { category: 'sector', subcategory: 'PSU',                  keywords: ['psu', 'public sector', 'government company', 'psu gems', 'government owned'], confidence: 0.92 },
  { category: 'sector', subcategory: 'Auto',                 keywords: ['auto sector', 'automobile', 'automotive', 'vehicle', 'ev stocks'], confidence: 0.88 },
  { category: 'sector', subcategory: 'FMCG',                 keywords: ['fmcg', 'consumer goods', 'food and beverage', 'consumer staples'], confidence: 0.88 },
  { category: 'sector', subcategory: 'Energy',               keywords: ['energy sector', 'oil gas', 'power sector', 'renewable energy', 'solar'], confidence: 0.88 },
  { category: 'sector', subcategory: 'Tata Group',           keywords: ['tata', 'tata empire', 'tata group'], confidence: 0.95 },
  { category: 'sector', subcategory: 'Adani Group',          keywords: ['adani', 'adani group', 'adani universe'], confidence: 0.95 },
];

// ── Keyword classifier ───────────────────────────────────────────────────────

export function classifyByKeyword(name: string, description = ''): ClassifyResult {
  const text = (name + ' ' + description).toLowerCase();

  let best: ClassifyResult = { category: 'other', subcategory: null, confidence: 0, classified_by: 'keyword' };

  for (const rule of RULES) {
    for (const kw of rule.keywords) {
      if (text.includes(kw)) {
        if (rule.confidence > best.confidence) {
          best = { category: rule.category, subcategory: rule.subcategory, confidence: rule.confidence, classified_by: 'keyword' };
        }
      }
    }
  }

  return best;
}

// ── Ollama fallback ──────────────────────────────────────────────────────────

async function classifyViaOllama(name: string): Promise<ClassifyResult> {
  const prompt = `You are classifying Indian stock market screeners.
Screener name: "${name}"
Available categories: momentum, institutional, fundamental, volume, trend, reversal, quality, growth, sector, valuation, delivery
Return ONLY valid JSON with no explanation: {"category": "...", "subcategory": "...", "confidence": 0.85}
If unsure use "other" as category.`;

  try {
    const res = await fetch('http://localhost:11434/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'llama3.2', prompt, stream: false }),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new Error(`Ollama ${res.status}`);
    const data = await res.json() as { response: string };
    const match = data.response.match(/\{[^}]+\}/);
    if (!match) throw new Error('No JSON in response');
    const parsed = JSON.parse(match[0]) as { category?: string; subcategory?: string; confidence?: number };
    const validCategories: ScreenerCategory[] = ['momentum','institutional','fundamental','volume','trend','reversal','quality','growth','sector','valuation','delivery','other'];
    const cat = validCategories.includes(parsed.category as ScreenerCategory) ? (parsed.category as ScreenerCategory) : 'other';
    return { category: cat, subcategory: parsed.subcategory ?? null, confidence: parsed.confidence ?? 0.6, classified_by: 'ollama' };
  } catch {
    return { category: 'other', subcategory: null, confidence: 0, classified_by: 'keyword' };
  }
}

// ── Main export ──────────────────────────────────────────────────────────────

export async function classifyAllScreeners(): Promise<{ classified: number; ollama_used: number; remaining_other: number }> {
  const rows = db.prepare(`
    SELECT scan_id, name, source
    FROM screener_master
    WHERE subcategory IS NULL
    ORDER BY source, name
  `).all() as Array<{ scan_id: string; name: string; source: string }>;

  if (rows.length === 0) return { classified: 0, ollama_used: 0, remaining_other: 0 };

  console.log(`[Classifier] Classifying ${rows.length} unclassified screeners...`);

  const updateStmt = db.prepare(`
    UPDATE screener_master
    SET subcategory = ?, inferred_category = ?, category_confidence = ?, classified_by = ?
    WHERE scan_id = ?
  `);

  let classified = 0;
  let ollama_used = 0;
  let remaining_other = 0;

  // Batch Ollama calls: 5 at a time with 200ms between batches
  const needOllama: Array<{ scan_id: string; name: string }> = [];

  for (const row of rows) {
    const result = classifyByKeyword(row.name);
    if (result.confidence >= 0.7) {
      updateStmt.run(result.subcategory, result.category, result.confidence, 'keyword', row.scan_id);
      classified++;
    } else {
      needOllama.push({ scan_id: row.scan_id, name: row.name });
    }
  }

  // Ollama batch processing
  const BATCH_SIZE = 5;
  for (let i = 0; i < needOllama.length; i += BATCH_SIZE) {
    const batch = needOllama.slice(i, i + BATCH_SIZE);
    await Promise.all(batch.map(async (item) => {
      const result = await classifyViaOllama(item.name);
      if (result.category !== 'other' && result.confidence >= 0.6) {
        updateStmt.run(result.subcategory, result.category, result.confidence, 'ollama', item.scan_id);
        classified++;
        ollama_used++;
      } else {
        // Keep 'other' but mark as classified so we don't retry every run
        updateStmt.run('Other', 'other', 0.3, 'keyword', item.scan_id);
        remaining_other++;
      }
    }));
    if (i + BATCH_SIZE < needOllama.length) {
      await new Promise(r => setTimeout(r, 200));
    }
  }

  console.log(`[Classifier] Done: ${classified} classified, ${ollama_used} via Ollama, ${remaining_other} remain 'other'`);
  return { classified, ollama_used, remaining_other };
}
```

- [ ] **Step 2: Verify it compiles**

```bash
cd c:/Github/bharat-stock-intelligence
npx tsc --noEmit src/server/screenerClassifier.ts 2>&1 | head -20
```

Expected: no errors (warnings about unused imports are acceptable).

- [ ] **Step 3: Quick smoke test — keyword classifier only**

```bash
npx tsx -e "
import { classifyByKeyword } from './src/server/screenerClassifier';
console.log(classifyByKeyword('52 Week High Breakout'));
console.log(classifyByKeyword('FII Buying Stocks'));
console.log(classifyByKeyword('High ROE Low PE Companies'));
console.log(classifyByKeyword('RSI Oversold Bounce'));
console.log(classifyByKeyword('Random Unknown Screener Name XYZ'));
"
```

Expected output (approximately):
```
{ category: 'momentum', subcategory: '52W High', confidence: 0.95, classified_by: 'keyword' }
{ category: 'institutional', subcategory: 'FII Buying', confidence: 0.95, classified_by: 'keyword' }
{ category: 'quality', subcategory: 'High ROE', confidence: 0.9, classified_by: 'keyword' }
{ category: 'reversal', subcategory: 'RSI Oversold', confidence: 0.92, classified_by: 'keyword' }
{ category: 'other', subcategory: null, confidence: 0, classified_by: 'keyword' }
```

- [ ] **Step 4: Commit**

```bash
git add src/server/screenerClassifier.ts
git commit -m "feat(screeners): add screenerClassifier with 120 keyword rules + Ollama fallback"
```

---

## Task 3: screener_performance.py

**Files:**
- Create: `src/server/screener_performance.py`

Four phases: (A) bootstrap from confluence_signals + signal_outcomes, (B) fill return columns from stock_ohlcv, (C) compute Bayesian score + tier, (D) sync back to screener_master and screener_reliability.

**Note on Phase A:** `recommendation_log.signals_json` contains technical signal types (MACD, RSI), NOT screener IDs. Instead, use `confluence_signals.screener_ids_json` joined with `signal_outcomes` on symbol to build the bootstrap proxy.

- [ ] **Step 1: Create the file**

```python
#!/usr/bin/env python3
"""
Screener performance engine.
Computes Bayesian win rates + tiers for all 1,521 screeners.

Phases:
  A - Bootstrap proxy: confluence_signals × signal_outcomes → per-screener metrics
  B - Fill screener_appearances returns from stock_ohlcv
  C - Bayesian composite score + A/B/C/D tier assignment
  D - Sync tier back to screener_master + screener_reliability
"""

import sqlite3
import json
import math
import statistics
import datetime
from pathlib import Path
from collections import defaultdict

DB_PATH = Path(__file__).parent.parent.parent / "database.sqlite"
NIFTY_SYMBOL = "NIFTY50"
K_PRIOR = 20          # Bayesian prior weight
MIN_SIGNALS_FOR_TIER = 5   # below this = Unranked


def get_trading_days_after(conn: sqlite3.Connection, symbol: str, start_date: str, n: int) -> tuple[float | None, str | None]:
    """Return (price, actual_date) n trading days after start_date from stock_ohlcv."""
    rows = conn.execute("""
        SELECT close, date FROM stock_ohlcv
        WHERE symbol = ? AND date > ?
        ORDER BY date ASC
        LIMIT ?
    """, (symbol, start_date, n + 5)).fetchall()
    if len(rows) < n:
        return None, None
    return rows[n - 1][0], rows[n - 1][1]


def get_price_on_or_after(conn: sqlite3.Connection, symbol: str, date: str) -> float | None:
    """Return close price on date or next available trading day."""
    row = conn.execute("""
        SELECT close FROM stock_ohlcv
        WHERE symbol = ? AND date >= ?
        ORDER BY date ASC LIMIT 1
    """, (symbol, date)).fetchone()
    return row[0] if row else None


def compute_return(entry: float | None, exit_p: float | None) -> float | None:
    if entry is None or exit_p is None or entry == 0:
        return None
    return round((exit_p - entry) / entry * 100, 4)


# ── Phase A: Bootstrap proxy ─────────────────────────────────────────────────

def phase_a_bootstrap(conn: sqlite3.Connection) -> dict[str, list[tuple[float, str]]]:
    """
    Return mapping: screener_id → [(return_pct, outcome_20d), ...]
    Built by joining signal_outcomes with confluence_signals on symbol (approximate).
    Uses the most recent confluence_signals entry per symbol that predates the signal_date.
    """
    print("[PhaseA] Bootstrapping screener metrics from confluence_signals × signal_outcomes...")

    # Load all resolved signal outcomes
    outcomes = conn.execute("""
        SELECT symbol, signal_date, return_pct, outcome
        FROM signal_outcomes
        WHERE outcome IN ('WIN', 'LOSS', 'NEUTRAL')
          AND return_pct IS NOT NULL
          AND horizon_days = 20
    """).fetchall()

    # Load confluence_signals: latest per symbol (screener_ids_json, computed_at)
    conf_rows = conn.execute("""
        SELECT symbol, screener_ids_json, computed_at
        FROM confluence_signals
        WHERE screener_ids_json IS NOT NULL
        ORDER BY symbol, computed_at DESC
    """).fetchall()

    # Build: symbol → list of (computed_at, screener_ids)
    conf_by_symbol: dict[str, list[tuple[str, list[str]]]] = defaultdict(list)
    for sym, ids_json, computed_at in conf_rows:
        try:
            ids = json.loads(ids_json) if ids_json else []
            if ids:
                conf_by_symbol[sym].append((computed_at[:10], ids))  # date only
        except (json.JSONDecodeError, TypeError):
            pass

    # Attribute outcomes to screeners
    screener_outcomes: dict[str, list[tuple[float, str]]] = defaultdict(list)

    for symbol, signal_date, return_pct, outcome in outcomes:
        conf_entries = conf_by_symbol.get(symbol, [])
        if not conf_entries:
            continue
        # Find the confluence entry closest to (but not after) signal_date
        best_ids = None
        best_date = '0000-00-00'
        for conf_date, ids in conf_entries:
            if conf_date <= signal_date and conf_date > best_date:
                best_date = conf_date
                best_ids = ids
        if not best_ids:
            # Use any entry as fallback
            best_ids = conf_entries[0][1]

        for screener_id in best_ids:
            screener_outcomes[screener_id].append((return_pct, outcome))

    total_screeners = len(screener_outcomes)
    total_signals = sum(len(v) for v in screener_outcomes.values())
    print(f"[PhaseA] {total_screeners} screeners, {total_signals} attributed outcomes")
    return dict(screener_outcomes)


# ── Phase B: Fill screener_appearances returns ───────────────────────────────

def phase_b_fill_returns(conn: sqlite3.Connection) -> int:
    """Fill return columns for screener_appearances rows where return_20d IS NULL."""
    print("[PhaseB] Filling screener_appearances returns from stock_ohlcv...")

    today = datetime.date.today()
    cutoff_20d = (today - datetime.timedelta(days=30)).isoformat()  # generous buffer

    pending = conn.execute("""
        SELECT screener_id, symbol, appeared_date
        FROM screener_appearances
        WHERE return_20d IS NULL
          AND appeared_date <= ?
    """, (cutoff_20d,)).fetchall()

    if not pending:
        print("[PhaseB] Nothing to fill.")
        return 0

    print(f"[PhaseB] Filling {len(pending)} rows...")
    filled = 0

    for screener_id, symbol, appeared_date in pending:
        entry_price = get_price_on_or_after(conn, symbol, appeared_date)
        if entry_price is None:
            continue

        returns: dict[str, float | None] = {}
        for n, col in [(5, 'return_5d'), (10, 'return_10d'), (20, 'return_20d'), (60, 'return_60d'), (120, 'return_120d')]:
            exit_price, _ = get_trading_days_after(conn, symbol, appeared_date, n)
            returns[col] = compute_return(entry_price, exit_price)

        nifty_exit, _ = get_trading_days_after(conn, NIFTY_SYMBOL, appeared_date, 20)
        nifty_entry = get_price_on_or_after(conn, NIFTY_SYMBOL, appeared_date)
        nifty_ret_20d = compute_return(nifty_entry, nifty_exit)

        # Determine outcome
        r20 = returns.get('return_20d')
        if r20 is None:
            outcome_20d = 'PENDING'
        elif nifty_ret_20d is not None:
            diff = r20 - nifty_ret_20d
            outcome_20d = 'WIN' if diff > 0.5 else ('LOSS' if diff < -0.5 else 'NEUTRAL')
        else:
            outcome_20d = 'WIN' if r20 > 1.0 else ('LOSS' if r20 < -1.0 else 'NEUTRAL')

        conn.execute("""
            UPDATE screener_appearances
            SET return_5d=?, return_10d=?, return_20d=?, return_60d=?, return_120d=?,
                nifty_ret_20d=?, outcome_20d=?
            WHERE screener_id=? AND symbol=? AND appeared_date=?
        """, (
            returns['return_5d'], returns['return_10d'], returns['return_20d'],
            returns['return_60d'], returns['return_120d'],
            nifty_ret_20d, outcome_20d,
            screener_id, symbol, appeared_date
        ))
        filled += 1

    conn.commit()
    print(f"[PhaseB] Filled {filled} rows.")
    return filled


# ── Phase C: Bayesian composite + tier ──────────────────────────────────────

def compute_metrics_from_list(returns: list[float], nifty_rets: list[float | None]) -> dict:
    """Compute win_rate, avg_return, sharpe, alpha, max_drawdown from a list of returns."""
    if not returns:
        return {}
    wins = sum(1 for r in returns if r > 0)
    win_rate = wins / len(returns)
    avg_ret = statistics.mean(returns)
    median_ret = statistics.median(returns)
    std_ret = statistics.stdev(returns) if len(returns) > 1 else 0.0
    sharpe = avg_ret / std_ret if std_ret > 0 else 0.0
    max_drawdown = min(returns)

    valid_nifty = [r for r in nifty_rets if r is not None]
    alpha = None
    if valid_nifty and len(valid_nifty) == len(returns):
        alphas = [r - n for r, n in zip(returns, valid_nifty)]
        alpha = statistics.mean(alphas)

    return {
        'win_rate': round(win_rate, 4),
        'avg_ret': round(avg_ret, 4),
        'median_ret': round(median_ret, 4),
        'sharpe': round(sharpe, 4),
        'max_drawdown': round(max_drawdown, 4),
        'alpha': round(alpha, 4) if alpha is not None else None,
    }


def phase_c_bayesian(conn: sqlite3.Connection, proxy_outcomes: dict[str, list[tuple[float, str]]]) -> int:
    """Compute Bayesian scores + tiers. Write to screener_performance_v2."""
    print("[PhaseC] Computing Bayesian scores + tiers...")

    all_screeners = conn.execute("""
        SELECT sm.scan_id, sm.source
        FROM screener_master sm
    """).fetchall()

    # Compute global mean win rate from screeners with >= 10 resolved appearances
    qualified = conn.execute("""
        SELECT screener_id, COUNT(*) as n,
               AVG(CASE WHEN outcome_20d = 'WIN' THEN 1.0 ELSE 0.0 END) as wr
        FROM screener_appearances
        WHERE outcome_20d IN ('WIN','LOSS','NEUTRAL')
        GROUP BY screener_id
        HAVING n >= 10
    """).fetchall()

    if qualified:
        global_mean_wr = statistics.mean(r[2] for r in qualified)
    else:
        global_mean_wr = 0.52  # default prior
    print(f"[PhaseC] Global mean win rate: {global_mean_wr:.3f} ({len(qualified)} qualifying screeners)")

    upsert = conn.execute  # reuse connection
    updated = 0

    for screener_id, source in all_screeners:
        # Get appearance-based returns
        app_rows = conn.execute("""
            SELECT return_5d, return_10d, return_20d, return_60d, return_120d,
                   nifty_ret_20d, outcome_20d
            FROM screener_appearances
            WHERE screener_id = ? AND outcome_20d IN ('WIN','LOSS','NEUTRAL')
        """, (screener_id,)).fetchall()

        # Combine with proxy outcomes
        proxy = proxy_outcomes.get(screener_id, [])

        total_appearances = conn.execute(
            "SELECT COUNT(*) FROM screener_appearances WHERE screener_id = ?", (screener_id,)
        ).fetchone()[0]

        # Build returns lists per horizon
        ret20_list: list[float] = []
        nifty20_list: list[float | None] = []
        ret5_list: list[float] = []
        ret10_list: list[float] = []
        ret60_list: list[float] = []
        ret120_list: list[float] = []

        for row in app_rows:
            r5, r10, r20, r60, r120, nifty20, outcome = row
            if r20 is not None:
                ret20_list.append(r20)
                nifty20_list.append(nifty20)
            if r5 is not None:  ret5_list.append(r5)
            if r10 is not None: ret10_list.append(r10)
            if r60 is not None: ret60_list.append(r60)
            if r120 is not None: ret120_list.append(r120)

        # Add proxy returns (20d only, no per-horizon breakdown)
        for ret_pct, _ in proxy:
            ret20_list.append(ret_pct)
            nifty20_list.append(None)

        resolved_count = len(ret20_list)
        n = resolved_count

        # Win rates per horizon
        def wr_from_list(lst: list[float]) -> float | None:
            if not lst: return None
            return round(sum(1 for r in lst if r > 0) / len(lst), 4)

        wr_20d = wr_from_list(ret20_list) or 0.0
        wr_5d  = wr_from_list(ret5_list)
        wr_10d = wr_from_list(ret10_list)
        wr_60d = wr_from_list(ret60_list)
        wr_120d= wr_from_list(ret120_list)

        # Bayesian shrinkage on 20d win rate
        shrunk_wr = (n * wr_20d + K_PRIOR * global_mean_wr) / (n + K_PRIOR)

        # Other metrics
        m = compute_metrics_from_list(ret20_list, nifty20_list)
        alpha_20d   = m.get('alpha')
        sharpe_20d  = m.get('sharpe', 0.0)
        max_dd      = m.get('max_drawdown', 0.0)
        avg_ret_20d = m.get('avg_ret')
        median_ret_20d = m.get('median_ret')

        # Nifty 60d alpha from app_rows
        alpha_60d = None
        if ret60_list:
            nifty60_rows = conn.execute("""
                SELECT nifty_ret_20d FROM screener_appearances
                WHERE screener_id = ? AND return_60d IS NOT NULL
            """, (screener_id,)).fetchall()
            if nifty60_rows and len(nifty60_rows) == len(ret60_list):
                alphas60 = [r - (nifty[0] or 0) for r, nifty in zip(ret60_list, nifty60_rows)]
                alpha_60d = round(statistics.mean(alphas60), 4)

        # Composite score
        alpha_norm  = min(max(((alpha_20d or 0) + 5) / 15, 0.0), 1.0)
        sharpe_norm = min(max((sharpe_20d or 0) / 3.0, 0.0), 1.0)
        dd_norm     = 1.0 - min(abs(max_dd or 0) / 20.0, 1.0)

        composite = (0.40 * shrunk_wr +
                     0.30 * alpha_norm +
                     0.20 * sharpe_norm +
                     0.10 * dd_norm)
        bayesian_score = round(composite, 4)

        # Tier
        if n < MIN_SIGNALS_FOR_TIER:
            tier = 'Unranked'
        elif composite >= 0.70:
            tier = 'A'
        elif composite >= 0.55:
            tier = 'B'
        elif composite >= 0.40:
            tier = 'C'
        else:
            tier = 'D'

        data_source = 'appearances' if not proxy else ('mixed' if app_rows else 'proxy')

        conn.execute("""
            INSERT INTO screener_performance_v2
              (screener_id, source, total_appearances, resolved_count,
               wr_5d, wr_10d, wr_20d, wr_60d, wr_120d,
               avg_ret_5d, avg_ret_10d, avg_ret_20d, avg_ret_60d, avg_ret_120d,
               alpha_20d, alpha_60d, sharpe_20d, max_drawdown, median_ret_20d,
               bayesian_score, tier, data_source, last_computed)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)
            ON CONFLICT(screener_id) DO UPDATE SET
              total_appearances=excluded.total_appearances,
              resolved_count=excluded.resolved_count,
              wr_5d=excluded.wr_5d, wr_10d=excluded.wr_10d, wr_20d=excluded.wr_20d,
              wr_60d=excluded.wr_60d, wr_120d=excluded.wr_120d,
              avg_ret_20d=excluded.avg_ret_20d, avg_ret_60d=excluded.avg_ret_60d,
              alpha_20d=excluded.alpha_20d, alpha_60d=excluded.alpha_60d,
              sharpe_20d=excluded.sharpe_20d, max_drawdown=excluded.max_drawdown,
              median_ret_20d=excluded.median_ret_20d,
              bayesian_score=excluded.bayesian_score, tier=excluded.tier,
              data_source=excluded.data_source, last_computed=CURRENT_TIMESTAMP
        """, (
            screener_id, source, total_appearances, resolved_count,
            wr_5d, wr_10d, wr_20d, wr_60d, wr_120d,
            wr_from_list(ret5_list), wr_from_list(ret10_list), avg_ret_20d,
            statistics.mean(ret60_list) if ret60_list else None,
            statistics.mean(ret120_list) if ret120_list else None,
            alpha_20d, alpha_60d, sharpe_20d, max_dd, median_ret_20d,
            bayesian_score, tier, data_source
        ))
        updated += 1

    conn.commit()
    print(f"[PhaseC] Upserted {updated} rows into screener_performance_v2")
    return updated


# ── Phase D: Sync back ───────────────────────────────────────────────────────

def phase_d_sync_back(conn: sqlite3.Connection) -> None:
    """Sync tier to screener_master and win_rate_* to screener_reliability."""
    print("[PhaseD] Syncing tiers back to screener_master...")

    conn.execute("""
        UPDATE screener_master
        SET tier = (
            SELECT tier FROM screener_performance_v2
            WHERE screener_performance_v2.screener_id = screener_master.scan_id
        )
        WHERE EXISTS (
            SELECT 1 FROM screener_performance_v2
            WHERE screener_id = screener_master.scan_id
        )
    """)

    print("[PhaseD] Syncing win_rate_* to screener_reliability...")
    conn.execute("""
        UPDATE screener_reliability
        SET win_rate_5d   = spv.wr_5d,
            win_rate_10d  = spv.wr_10d,
            win_rate_20d  = spv.wr_20d,
            win_rate_60d  = spv.wr_60d,
            win_rate_120d = spv.wr_120d
        FROM screener_performance_v2 spv
        WHERE screener_reliability.scan_id = spv.screener_id
    """)

    conn.commit()
    print("[PhaseD] Sync complete.")


# ── Entry point ──────────────────────────────────────────────────────────────

def run():
    if not DB_PATH.exists():
        raise FileNotFoundError(f"DB not found: {DB_PATH}")

    conn = sqlite3.connect(DB_PATH)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")

    try:
        proxy = phase_a_bootstrap(conn)
        phase_b_fill_returns(conn)
        phase_c_bayesian(conn, proxy)
        phase_d_sync_back(conn)
        print("[ScreenerPerf] All phases complete.")
    finally:
        conn.close()


if __name__ == '__main__':
    run()
```

- [ ] **Step 2: Run a smoke test (dry pass — no OHLCV data required for Phase A)**

```bash
cd c:/Github/bharat-stock-intelligence
python src/server/screener_performance.py 2>&1 | tail -20
```

Expected: Phases A–D complete with no crash. Phase B may fill 0 rows if no appearances yet.

- [ ] **Step 3: Verify screener_performance_v2 has rows**

```bash
python -c "
import sqlite3
conn = sqlite3.connect('database.sqlite')
n = conn.execute('SELECT COUNT(*) FROM screener_performance_v2').fetchone()[0]
tier_dist = conn.execute('SELECT tier, COUNT(*) FROM screener_performance_v2 GROUP BY tier ORDER BY tier').fetchall()
print('Total rows:', n)
print('Tier distribution:', tier_dist)
print('Sample Tier A:')
for r in conn.execute('SELECT screener_id, bayesian_score, wr_20d, resolved_count FROM screener_performance_v2 WHERE tier=\"A\" LIMIT 5').fetchall():
    print(' ', r)
conn.close()
"
```

Expected: rows > 0, some tier distribution (most Unranked initially — normal).

- [ ] **Step 4: Commit**

```bash
git add src/server/screener_performance.py
git commit -m "feat(screeners): add screener_performance.py — Bayesian tiers + multi-horizon metrics"
```

---

## Task 4: Sync diff patch — Trendlyne

**Files:**
- Modify: `src/server/trendlyneScreener.ts`

`saveScreenerStocksToDB` does DELETE+INSERT. The diff patch reads the previous active set from `screener_appearances` before the delete, then inserts new appearances after.

- [ ] **Step 1: Read saveScreenerStocksToDB (lines 146–169)**

Confirm it ends at the `})()` closing of the `db.transaction` call.

- [ ] **Step 2: Add the diff patch after the transaction**

In `src/server/trendlyneScreener.ts`, replace `saveScreenerStocksToDB`:

```typescript
export function saveScreenerStocksToDB(
  screenerId: string,
  stocks: Array<{ stockId: string; name: string }>
): void {
  try {
    const deleteStmt = db.prepare(`DELETE FROM trendlyne_screener_stocks WHERE screener_id = ?`);
    const insertStmt = db.prepare(`
      INSERT INTO trendlyne_screener_stocks (screener_id, stock_id, symbol)
      VALUES (?, ?, ?)
    `);

    // Snapshot previous active symbols BEFORE delete
    const prevSymbols = new Set<string>(
      (db.prepare(`SELECT symbol FROM screener_appearances WHERE screener_id = ? AND exited_date IS NULL`)
        .all(screenerId) as Array<{ symbol: string }>)
        .map(r => r.symbol)
        .filter(Boolean)
    );

    db.transaction(() => {
      deleteStmt.run(screenerId);
      for (const stock of stocks) {
        const mapping = getStockMapping(stock.stockId);
        const symbol = mapping ? mapping.symbol : null;
        insertStmt.run(screenerId, stock.stockId, symbol);
      }
    })();

    // Diff patch: record appearances/exits
    const today = new Date().toISOString().slice(0, 10);
    const currentSymbols = new Set<string>(
      stocks.map(s => getStockMapping(s.stockId)?.symbol).filter((s): s is string => !!s)
    );

    const entered = [...currentSymbols].filter(s => !prevSymbols.has(s));
    const exited  = [...prevSymbols].filter(s => !currentSymbols.has(s));

    if (entered.length > 0) {
      const insertAppearance = db.prepare(
        `INSERT OR IGNORE INTO screener_appearances (screener_id, source, symbol, appeared_date) VALUES (?, 'trendlyne', ?, ?)`
      );
      db.transaction(() => {
        for (const sym of entered) insertAppearance.run(screenerId, sym, today);
      })();
    }

    if (exited.length > 0) {
      db.prepare(
        `UPDATE screener_appearances SET exited_date = ? WHERE screener_id = ? AND symbol IN (${exited.map(() => '?').join(',')}) AND exited_date IS NULL`
      ).run(today, screenerId, ...exited);
    }
  } catch (error) {
    console.error(`❌ Error saving screener stocks to DB:`, error);
  }
}
```

- [ ] **Step 3: Verify it compiles**

```bash
npx tsc --noEmit src/server/trendlyneScreener.ts 2>&1 | grep -E "error|Error" | head -10
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/server/trendlyneScreener.ts
git commit -m "feat(screeners): record trendlyne screener appearances on sync diff"
```

---

## Task 5: Sync diff patch — MoneyControl

**Files:**
- Modify: `src/server/moneycontrolScreener.ts`

The MC sync loop does DELETE then inserts in `syncMoneyControlScreeners`. The diff patch goes inside the per-screener loop, after the existing insert loop.

- [ ] **Step 1: Read the relevant section**

Open `src/server/moneycontrolScreener.ts` around lines 208–238 (the stock insert loop).

- [ ] **Step 2: Add the diff patch inside the per-screener loop**

Find the section that ends with:
```typescript
    // Small delay to avoid rate limits
    await new Promise(resolve => setTimeout(resolve, 500));
```

And replace the entire `if (response?.success === 1 && response.data)` block with:

```typescript
    if (response?.success === 1 && response.data) {
      const screenerName = response.data.list?.scannerName || response.data.scanName || response.data.scanname || `MC Screener ${config.scanId}`;

      db.prepare(`
        INSERT INTO moneycontrol_screeners (scan_id, cat_id, screener_name, type, is_positive)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(scan_id) DO UPDATE SET
          screener_name = excluded.screener_name,
          last_updated = CURRENT_TIMESTAMP
      `).run(config.scanId, config.catId, screenerName, config.type, config.is_positive ? 1 : 0);

      const stocks = response.data.list?.scannerDetails || response.data.stock || response.data.stocks || [];
      console.log(`✅ Fetched ${stocks.length} stocks for MC: ${screenerName}`);

      // Snapshot previous active symbols BEFORE delete
      const prevSymbols = new Set<string>(
        (db.prepare(`SELECT symbol FROM screener_appearances WHERE screener_id = ? AND exited_date IS NULL`)
          .all(config.scanId) as Array<{ symbol: string }>)
          .map(r => r.symbol).filter(Boolean)
      );

      db.prepare('DELETE FROM moneycontrol_screener_stocks WHERE scan_id = ?').run(config.scanId);

      const insertStock = db.prepare(`INSERT INTO moneycontrol_screener_stocks (scan_id, mcsymbol, stock_name, symbol) VALUES (?, ?, ?, ?)`);
      const currentSymbols = new Set<string>();

      for (const stock of stocks) {
        const mcsymbol = stock.stkId || stock.sc_id;
        const stkname  = stock.stkname || stock.stock_name || stock.shortName;
        if (mcsymbol) {
          const nseSymbol = getSymbolFromMcsymbol(mcsymbol);
          insertStock.run(config.scanId, mcsymbol, stkname, nseSymbol);
          if (nseSymbol) {
            currentSymbols.add(nseSymbol);
            mappingsToUpdate.set(stkname?.toUpperCase()?.trim() ?? '', mcsymbol);
          }
        }
      }

      // Diff patch
      const today = new Date().toISOString().slice(0, 10);
      const entered = [...currentSymbols].filter(s => !prevSymbols.has(s));
      const exited  = [...prevSymbols].filter(s => !currentSymbols.has(s));

      if (entered.length > 0) {
        const insertApp = db.prepare(`INSERT OR IGNORE INTO screener_appearances (screener_id, source, symbol, appeared_date) VALUES (?, 'moneycontrol', ?, ?)`);
        db.transaction(() => { for (const s of entered) insertApp.run(config.scanId, s, today); })();
      }
      if (exited.length > 0) {
        db.prepare(`UPDATE screener_appearances SET exited_date = ? WHERE screener_id = ? AND symbol IN (${exited.map(() => '?').join(',')}) AND exited_date IS NULL`)
          .run(today, config.scanId, ...exited);
      }
    }
```

- [ ] **Step 3: Verify compilation**

```bash
npx tsc --noEmit src/server/moneycontrolScreener.ts 2>&1 | grep -E "error|Error" | head -10
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/server/moneycontrolScreener.ts
git commit -m "feat(screeners): record moneycontrol screener appearances on sync diff"
```

---

## Task 6: Sync diff patch — ETnow

**Files:**
- Modify: `src/server/etnowScreenerSync.ts`

The ETnow sync uses a `db.transaction()` with deleteStmt + insertStmt inside a for loop. Add the diff patch after the transaction.

- [ ] **Step 1: Read the relevant section**

Open `src/server/etnowScreenerSync.ts` around lines 88–115 (the transaction block inside the screener loop).

- [ ] **Step 2: Add the diff patch after the transaction**

Find the block ending with `})();` followed by `await new Promise(resolve => setTimeout(resolve, 800));` and add between them:

```typescript
      // Diff patch: record new appearances / exits
      const today = new Date().toISOString().slice(0, 10);
      const prevSymbols = new Set<string>(
        (db.prepare(`SELECT symbol FROM screener_appearances WHERE screener_id = ? AND exited_date IS NULL`)
          .all(screener.screener_id) as Array<{ symbol: string }>)
          .map(r => r.symbol).filter(Boolean)
      );

      const currentSymbols = new Set<string>(
        records
          .map((record: any) => {
            const raw = record.assetSymbol || record.stkId || record.symbol || record.code || record.nseid || '';
            return raw.replace(/-NSE$/i, '').replace(/EQ$/i, '').replace(/BE$/i, '').trim();
          })
          .filter(Boolean)
      );

      const entered = [...currentSymbols].filter(s => !prevSymbols.has(s));
      const exited  = [...prevSymbols].filter(s => !currentSymbols.has(s));

      if (entered.length > 0) {
        const insertApp = db.prepare(`INSERT OR IGNORE INTO screener_appearances (screener_id, source, symbol, appeared_date) VALUES (?, 'etnow', ?, ?)`);
        db.transaction(() => { for (const s of entered) insertApp.run(screener.screener_id, s, today); })();
      }
      if (exited.length > 0) {
        db.prepare(`UPDATE screener_appearances SET exited_date = ? WHERE screener_id = ? AND symbol IN (${exited.map(() => '?').join(',')}) AND exited_date IS NULL`)
          .run(today, screener.screener_id, ...exited);
      }
```

- [ ] **Step 3: Verify compilation**

```bash
npx tsc --noEmit src/server/etnowScreenerSync.ts 2>&1 | grep -E "error|Error" | head -10
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/server/etnowScreenerSync.ts
git commit -m "feat(screeners): record etnow screener appearances on sync diff"
```

---

## Task 7: BullMQ queue + worker

**Files:**
- Modify: `src/server/queues.ts`

Follow the existing queue pattern: export queue name constant, create Queue + Worker + event handlers inside `initQueues()`.

- [ ] **Step 1: Add queue name constant**

Find the block of `export const QUEUE_*` constants near the top of `queues.ts` and add:

```typescript
export const QUEUE_SCREENER_PERFORMANCE = 'screener-performance';
```

- [ ] **Step 2: Export queue variable**

Find where other queue variables are exported (e.g., `export let mlDailyOpsQueue`) and add:

```typescript
export let screenerPerfQueue: Queue;
```

- [ ] **Step 3: Add the queue initialization inside initQueues()**

Find the last queue block (before the closing of `initQueues`) and add:

```typescript
    // ── Screener performance queue (daily 6 PM IST = 12:30 UTC weekdays) ──────
    screenerPerfQueue = new Queue(QUEUE_SCREENER_PERFORMANCE, { connection });

    const screenerPerfRepeatables = await screenerPerfQueue.getRepeatableJobs();
    for (const r of screenerPerfRepeatables) {
      await screenerPerfQueue.removeRepeatableByKey(r.key);
    }
    await screenerPerfQueue.add(
      'screener-performance-daily',
      {},
      {
        repeat: { cron: '30 12 * * 1-5' },
        jobId: 'screener-performance-daily',
        removeOnComplete: 3,
        removeOnFail: 3,
      },
    );

    const screenerPerfWorker = new Worker(
      QUEUE_SCREENER_PERFORMANCE,
      async (_job: Job) => {
        const pyDir = process.cwd() + '/src/server';
        await execAsync(`"${PYTHON_BIN}" screener_performance.py`, { cwd: pyDir, timeout: 15 * 60 * 1000 });
        // After Python completes, run Ollama classification for any new 'other' screeners
        try {
          const { classifyAllScreeners } = await import('./screenerClassifier');
          await classifyAllScreeners();
        } catch (e: any) {
          console.error('[QUEUE] screener classification failed:', e.message);
        }
      },
      { connection, concurrency: 1, lockDuration: 20 * 60 * 1000, lockRenewTime: 5 * 60 * 1000 },
    );

    screenerPerfWorker.on('completed', () => console.log('[QUEUE] screener-performance completed'));
    screenerPerfWorker.on('failed', (_job, err) => console.error('[QUEUE] screener-performance failed:', err.message));
    screenerPerfWorker.on('error', (err) => {
      if ((err as any).code === -2 || err.message?.includes('Missing lock')) return;
      console.error('[QUEUE] screener-performance error:', err.message);
    });
```

- [ ] **Step 4: Verify compilation**

```bash
npx tsc --noEmit src/server/queues.ts 2>&1 | grep -E "^src.*error" | head -10
```

Expected: no new errors (pre-existing hints are fine).

- [ ] **Step 5: Commit**

```bash
git add src/server/queues.ts
git commit -m "feat(queue): add screener-performance BullMQ job (daily 6PM IST weekdays)"
```

---

## Task 8: Monitor page registration

**Files:**
- Modify: `src/server/routers/monitor.router.ts`

Add one entry to `MONITOR_SCRIPTS` and one case each in `getLastRunAt` and `getScriptStats`.

- [ ] **Step 1: Add to MONITOR_SCRIPTS array**

Find the last entry in the `MONITOR_SCRIPTS` array (before `] as const`) and add:

```typescript
  {
    id: 'screener-performance',
    label: 'Screener Performance Engine',
    category: 'ML',
    critical: false,
    description: 'Fills screener_appearances returns, computes Bayesian tiers (A/B/C/D), classifies new screeners via Ollama',
    schedule: 'Daily 6 PM',
    pyScript: 'screener_performance.py',
    queueName: 'screener-performance',
    staleLimitHours: 26,
  },
```

- [ ] **Step 2: Add case to getLastRunAt switch**

In `getLastRunAt`, add before the `default:` case:

```typescript
      case 'screener-performance':
        row = db.prepare("SELECT MAX(last_computed) as t FROM screener_performance_v2").get();
        break;
```

- [ ] **Step 3: Add case to getScriptStats switch**

In `getScriptStats`, add before the `default:` case:

```typescript
      case 'screener-performance': {
        const total = (db.prepare("SELECT COUNT(*) as n FROM screener_performance_v2").get() as any)?.n ?? 0;
        const tiers = db.prepare("SELECT tier, COUNT(*) as n FROM screener_performance_v2 GROUP BY tier ORDER BY tier").all() as any[];
        const tierStr = tiers.map((t: any) => `${t.tier}:${t.n}`).join(', ');
        return { screeners: total, tiers: tierStr };
      }
```

- [ ] **Step 4: Verify compilation**

```bash
npx tsc --noEmit src/server/routers/monitor.router.ts 2>&1 | grep -E "^src.*error" | head -10
```

Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/server/routers/monitor.router.ts
git commit -m "feat(monitor): register screener-performance script in monitor page"
```

---

## Task 9: tRPC endpoints

**Files:**
- Modify: `src/server/routers/screeners.router.ts`

Add 5 procedures. They read from `screener_performance_v2` JOIN `screener_master` and `screener_appearances`.

- [ ] **Step 1: Add imports at the top of screeners.router.ts**

The file already imports `db`. No new imports needed.

- [ ] **Step 2: Add the 5 procedures inside the screenersRouter object**

Find the last procedure in `screenersRouter` (before the closing `})`), and add after it:

```typescript
  getScreenerLeaderboard: publicProcedure
    .input(z.object({
      category:    z.string().optional(),
      subcategory: z.string().optional(),
      source:      z.enum(['trendlyne', 'moneycontrol', 'etnow']).optional(),
      horizon:     z.enum(['5d', '10d', '20d', '60d', '120d']).default('20d'),
      tier:        z.enum(['A', 'B', 'C', 'D', 'Unranked']).optional(),
      limit:       z.number().min(1).max(200).default(50),
      offset:      z.number().min(0).default(0),
    }))
    .query(({ input }) => {
      const horizonCol = `wr_${input.horizon.replace('d', '')}d` as string;
      const validHorizonCols: Record<string, string> = {
        '5d': 'wr_5d', '10d': 'wr_10d', '20d': 'wr_20d', '60d': 'wr_60d', '120d': 'wr_120d',
      };
      const wrCol = validHorizonCols[input.horizon] ?? 'wr_20d';

      let where = 'WHERE 1=1';
      const params: any[] = [];

      if (input.category) {
        where += ' AND sm.inferred_category = ?';
        params.push(input.category);
      }
      if (input.subcategory) {
        where += ' AND sm.subcategory = ?';
        params.push(input.subcategory);
      }
      if (input.source) {
        where += ' AND spv.source = ?';
        params.push(input.source);
      }
      if (input.tier) {
        where += ' AND spv.tier = ?';
        params.push(input.tier);
      }

      params.push(input.limit, input.offset);

      return db.prepare(`
        SELECT
          spv.screener_id,
          sm.name,
          spv.source,
          sm.inferred_category  AS category,
          sm.subcategory,
          spv.tier,
          spv.bayesian_score,
          spv.${wrCol}          AS win_rate,
          spv.avg_ret_20d       AS avg_return,
          spv.alpha_20d         AS alpha,
          spv.sharpe_20d        AS sharpe,
          spv.resolved_count,
          spv.total_appearances,
          spv.data_source,
          spv.last_computed
        FROM screener_performance_v2 spv
        JOIN screener_master sm ON sm.scan_id = spv.screener_id
        ${where}
        ORDER BY spv.bayesian_score DESC NULLS LAST
        LIMIT ? OFFSET ?
      `).all(...params);
    }),

  getScreenerDetail: publicProcedure
    .input(z.object({ screener_id: z.string() }))
    .query(({ input }) => {
      const perf = db.prepare(`
        SELECT spv.*, sm.name, sm.inferred_category AS category, sm.subcategory,
               sm.inferred_sentiment AS sentiment, sm.inferred_timeframe AS timeframe,
               sm.classified_by
        FROM screener_performance_v2 spv
        JOIN screener_master sm ON sm.scan_id = spv.screener_id
        WHERE spv.screener_id = ?
      `).get(input.screener_id);

      const recentAppearances = db.prepare(`
        SELECT symbol, appeared_date, exited_date,
               return_5d, return_10d, return_20d, return_60d, return_120d,
               nifty_ret_20d, outcome_20d
        FROM screener_appearances
        WHERE screener_id = ?
        ORDER BY appeared_date DESC
        LIMIT 30
      `).all(input.screener_id);

      const topStocks = db.prepare(`
        SELECT symbol, COUNT(*) as appearances
        FROM screener_appearances
        WHERE screener_id = ?
        GROUP BY symbol
        ORDER BY appearances DESC
        LIMIT 15
      `).all(input.screener_id);

      return { perf, recentAppearances, topStocks };
    }),

  getScreenerCategoryStats: publicProcedure
    .input(z.object({
      horizon: z.enum(['5d', '10d', '20d', '60d', '120d']).default('20d'),
    }))
    .query(({ input }) => {
      const validHorizonCols: Record<string, string> = {
        '5d': 'wr_5d', '10d': 'wr_10d', '20d': 'wr_20d', '60d': 'wr_60d', '120d': 'wr_120d',
      };
      const wrCol = validHorizonCols[input.horizon] ?? 'wr_20d';

      return db.prepare(`
        SELECT
          sm.inferred_category              AS category,
          sm.subcategory,
          COUNT(*)                          AS screener_count,
          AVG(spv.${wrCol})                 AS avg_win_rate,
          AVG(spv.alpha_20d)                AS avg_alpha,
          SUM(CASE WHEN spv.tier = 'A' THEN 1 ELSE 0 END) AS tier_a_count,
          SUM(CASE WHEN spv.tier IN ('A','B') THEN 1 ELSE 0 END) AS tier_ab_count,
          MAX(spv.bayesian_score)           AS best_score
        FROM screener_performance_v2 spv
        JOIN screener_master sm ON sm.scan_id = spv.screener_id
        WHERE sm.inferred_category IS NOT NULL
        GROUP BY sm.inferred_category, sm.subcategory
        ORDER BY avg_win_rate DESC NULLS LAST
      `).all();
    }),

  getScreenerAppearanceHistory: publicProcedure
    .input(z.object({
      symbol:      z.string().optional(),
      screener_id: z.string().optional(),
      from_date:   z.string().optional(),
      limit:       z.number().min(1).max(500).default(100),
    }).refine(d => d.symbol || d.screener_id, { message: 'Provide symbol or screener_id' }))
    .query(({ input }) => {
      let where = 'WHERE 1=1';
      const params: any[] = [];

      if (input.symbol) {
        where += ' AND sa.symbol = ?';
        params.push(input.symbol);
      }
      if (input.screener_id) {
        where += ' AND sa.screener_id = ?';
        params.push(input.screener_id);
      }
      if (input.from_date) {
        where += ' AND sa.appeared_date >= ?';
        params.push(input.from_date);
      }
      params.push(input.limit);

      return db.prepare(`
        SELECT
          sa.screener_id, sm.name AS screener_name, sa.source,
          sa.symbol, sa.appeared_date, sa.exited_date,
          sa.return_20d, sa.outcome_20d, sa.nifty_ret_20d,
          spv.tier AS screener_tier
        FROM screener_appearances sa
        JOIN screener_master sm ON sm.scan_id = sa.screener_id
        LEFT JOIN screener_performance_v2 spv ON spv.screener_id = sa.screener_id
        ${where}
        ORDER BY sa.appeared_date DESC
        LIMIT ?
      `).all(...params);
    }),

  triggerScreenerPerformanceRecompute: publicProcedure
    .input(z.object({ force: z.boolean().optional() }))
    .mutation(async () => {
      try {
        const { screenerPerfQueue } = await import('../queues');
        await screenerPerfQueue.add('screener-performance-manual', {}, { removeOnComplete: 3 });
        return { queued: true, message: 'Screener performance job queued' };
      } catch (e: any) {
        return { queued: false, message: `Queue unavailable: ${e.message}` };
      }
    }),
```

- [ ] **Step 3: Verify compilation**

```bash
npx tsc --noEmit src/server/routers/screeners.router.ts 2>&1 | grep -E "^src.*error" | head -20
```

Expected: no errors.

- [ ] **Step 4: Start dev server and test an endpoint**

```bash
npx tsx src/server/index.ts &
sleep 3
curl -s "http://localhost:3001/trpc/getScreenerLeaderboard?input=%7B%22horizon%22%3A%2220d%22%2C%22limit%22%3A5%7D" | python -m json.tool 2>/dev/null | head -40
```

Expected: JSON response with `result.data` array (may be empty if no screener_performance_v2 rows yet — run screener_performance.py first).

- [ ] **Step 5: Run screener_performance.py then test leaderboard**

```bash
python src/server/screener_performance.py
curl -s "http://localhost:3001/trpc/getScreenerLeaderboard?input=%7B%22horizon%22%3A%2220d%22%2C%22limit%22%3A5%7D" | python -m json.tool 2>/dev/null | head -60
```

Expected: rows with `screener_id`, `name`, `tier`, `bayesian_score` fields.

- [ ] **Step 6: Commit**

```bash
kill %1 2>/dev/null  # stop dev server
git add src/server/routers/screeners.router.ts
git commit -m "feat(api): add 5 screener intelligence tRPC endpoints (leaderboard, detail, categories, appearances, trigger)"
```

---

## Task 10: Run classifyAllScreeners and verify end-to-end

- [ ] **Step 1: Run the classifier (keyword pass only first, then Ollama if available)**

```bash
cd c:/Github/bharat-stock-intelligence
npx tsx -e "
import { classifyAllScreeners } from './src/server/screenerClassifier';
classifyAllScreeners().then(r => { console.log('Result:', r); process.exit(0); }).catch(e => { console.error(e); process.exit(1); });
"
```

Expected: `Result: { classified: N, ollama_used: M, remaining_other: K }` where N > 500.

- [ ] **Step 2: Verify category distribution improved**

```bash
python -c "
import sqlite3
conn = sqlite3.connect('database.sqlite')
rows = conn.execute('SELECT inferred_category, COUNT(*) FROM screener_master GROUP BY inferred_category ORDER BY 2 DESC').fetchall()
for r in rows: print(r)
conn.close()
"
```

Expected: 'other' count < 400 (down from 633).

- [ ] **Step 3: Verify screener_master.tier populated**

```bash
python -c "
import sqlite3
conn = sqlite3.connect('database.sqlite')
rows = conn.execute('SELECT tier, COUNT(*) FROM screener_master GROUP BY tier ORDER BY tier').fetchall()
for r in rows: print(r)
conn.close()
"
```

Expected: distribution across Unranked/A/B/C/D (mostly Unranked initially since appearances data just started accumulating).

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat(screeners): Sub-project A complete — screener intelligence foundation

- screener_appearances table records stock entries/exits per sync
- screener_performance_v2 has Bayesian tiers + 5 horizon metrics
- screenerClassifier.ts: keyword + Ollama classification
- screener_performance.py: nightly Bayesian computation
- 3 sync diff patches (trendlyne/mc/etnow)
- BullMQ job + monitor page entry
- 5 new tRPC endpoints"
```

---

## Self-Review

**Spec coverage:**

| Spec requirement | Task |
|---|---|
| screener_appearances table | Task 1 ✓ |
| screener_performance_v2 table | Task 1 ✓ |
| screener_master subcategory/tier columns | Task 1 ✓ |
| screener_reliability horizon columns | Task 1 ✓ |
| screenerClassifier.ts (keyword + Ollama) | Task 2 ✓ |
| screener_performance.py Phase A (bootstrap) | Task 3 ✓ |
| screener_performance.py Phase B (fill returns) | Task 3 ✓ |
| screener_performance.py Phase C (Bayesian tiers) | Task 3 ✓ |
| screener_performance.py Phase D (sync back) | Task 3 ✓ |
| Trendlyne diff patch | Task 4 ✓ |
| MoneyControl diff patch | Task 5 ✓ |
| ETnow diff patch | Task 6 ✓ |
| BullMQ screener-performance job | Task 7 ✓ |
| Monitor page registration | Task 8 ✓ |
| getScreenerLeaderboard endpoint | Task 9 ✓ |
| getScreenerDetail endpoint | Task 9 ✓ |
| getScreenerCategoryStats endpoint | Task 9 ✓ |
| getScreenerAppearanceHistory endpoint | Task 9 ✓ |
| triggerScreenerPerformanceRecompute endpoint | Task 9 ✓ |

**No gaps found.**

**Type consistency:** `classifyAllScreeners()` exported from Task 2, imported in Task 7 worker — consistent. `screenerPerfQueue` exported in Task 7, imported in Task 9 mutation — consistent. `wrCol` SQL column interpolation in Tasks 9 endpoints uses same `validHorizonCols` map in both `getScreenerLeaderboard` and `getScreenerCategoryStats` — consistent.

**Phase A note:** Spec originally assumed signals_json had screener IDs. Actual inspection showed it contains technical signal types instead. Plan corrects this: Phase A uses `confluence_signals.screener_ids_json` × `signal_outcomes` join — this is explicitly called out in Task 3 header.
