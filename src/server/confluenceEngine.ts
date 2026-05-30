import db from './db';
import { execFile } from 'child_process';
import path from 'path';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);
const PYTHON = process.platform === 'win32'
  ? (process.env.PYTHON_PATH || 'C:\\Users\\amit_\\AppData\\Local\\Programs\\Python\\Python311\\python.exe')
  : (process.env.PYTHON_PATH || 'python3');
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
  const risk = Math.max(atr * 1.5, price * 0.02);
  const rewardMult = score >= 80 ? 4 : score >= 60 ? 3 : 2;
  return {
    entryLow:   Math.round((price - atr * 0.25) * 100) / 100,
    entryHigh:  Math.round((price + atr * 0.25) * 100) / 100,
    stopLoss:   Math.round((price - risk) * 100) / 100,
    target1:    Math.round((price + risk * rewardMult * 0.5) * 100) / 100,
    target2:    Math.round((price + risk * rewardMult) * 100) / 100,
    target3:    Math.round((price + risk * rewardMult * 1.6) * 100) / 100,
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
  technical: any,
  quant: any,
  fundamentals: any,
  nseInfo: any,
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
  // A. Screener weighted score
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
    if (quant.above_sma200 === 1)        trendScore += 5;
    if (quant.sma200_distance_pct > 5)   trendScore += 2;
    if (quant.momentum_score > 70)       trendScore += 4;
    if (quant.rank_composite > 60)       trendScore += 4;
  }
  if (technical) {
    if (technical.above_sma200 === 1)    trendScore += 3;
  }
  trendScore = Math.min(15, trendScore);

  // C. Volume confirmation (0–10)
  let volScore = 0;
  const volRatio = technical?.volume_ratio ?? 1;
  if (volRatio > 3)        volScore = 10;
  else if (volRatio > 2)   volScore = 7;
  else if (volRatio > 1.5) volScore = 5;
  else if (volRatio > 1.2) volScore = 2;

  // D. Sector strength (0–8)
  const sectorScore = quant
    ? Math.max(0, Math.min(8, (quant.momentum_score ?? 50) / 100 * 8))
    : 4;

  // E. Fundamental overlay (0–12)
  let fundScore = 0;
  if (fundamentals) {
    if (fundamentals.piotroski_f_score >= 7)       fundScore += 4;
    else if (fundamentals.piotroski_f_score >= 5)  fundScore += 2;
    if (fundamentals.return_on_equity > 0.20)      fundScore += 3;
    else if (fundamentals.return_on_equity > 0.12) fundScore += 1;
    if (fundamentals.debt_to_equity < 0.5)         fundScore += 2;
    if (fundamentals.revenue_growth > 0.15)        fundScore += 3;
    else if (fundamentals.revenue_growth > 0.05)   fundScore += 1;
  }
  fundScore = Math.min(12, fundScore);

  // Final score (max 105 → normalize to 100)
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

  // Fetch supporting data
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
  const expiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString();

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

    const price = tech?.cmp ?? null;
    const atr = price && tech?.bb_width && tech.bb_width > 0 ? price * (tech.bb_width / 100) : (price ? price * 0.03 : null);
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

  try {
    insertMany(rows);
  } catch (err: any) {
    console.error('[CONFLUENCE] Transaction failed:', err.message);
    return { computed: 0, elite: 0, strong: 0 };
  }
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
