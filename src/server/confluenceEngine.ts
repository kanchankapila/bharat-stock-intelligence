import { dbGet, dbAll, dbTransaction } from './dbAsync';
import { rowGroups, bulkUpsert } from './dbBulk';
import { runPython } from './pythonRunner';

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
let classCacheFetchedAt = 0;

// screener_master rows, bulk-loaded once via ensureScreenerMeta() so classifyScreener
// stays synchronous (and avoids a per-scanId N+1 query during confluence computation).
const screenerMetaCache = new Map<string, any>();
let screenerMetaCacheFetchedAt = 0;

const CONFLUENCE_CACHE_TTL = 6 * 60 * 60 * 1000; // 6 hours

// Sweep both caches every 6 hours to prevent unbounded growth
setInterval(() => {
  const now = Date.now();
  if (now - classCacheFetchedAt > CONFLUENCE_CACHE_TTL) classCache.clear();
  if (now - screenerMetaCacheFetchedAt > CONFLUENCE_CACHE_TTL) screenerMetaCache.clear();
}, CONFLUENCE_CACHE_TTL);

// scan_id is only unique WITHIN a provider -- MoneyControl and ETnow both hand out small
// sequential integers independently and 7 currently collide (e.g. scan_id 173 is MC's "Double
// Dhamaka" AND ETnow's "Warren Buffet Screener"), see the 2026-08-04 screener_master memory.
// Every cache/lookup here is keyed by (source, scanId), matching screener_master's composite PK.
function metaKey(source: string, scanId: string): string {
  return `${source}::${scanId}`;
}

export async function ensureScreenerMeta(): Promise<void> {
  if (screenerMetaCache.size > 0 && Date.now() - screenerMetaCacheFetchedAt < CONFLUENCE_CACHE_TTL) return;
  const rows = await dbAll(
    'SELECT scan_id, source, inferred_sentiment, inferred_category, inferred_timeframe, confidence, weight_override FROM screener_master'
  ) as any[];
  for (const r of rows) screenerMetaCache.set(metaKey(r.source, r.scan_id), r);
  screenerMetaCacheFetchedAt = Date.now();
}

export function classifyScreener(scanId: string, name: string, source: string): ScreenerClass {
  const key = metaKey(source, scanId);
  if (classCache.has(key) && Date.now() - classCacheFetchedAt < CONFLUENCE_CACHE_TTL) return classCache.get(key)!;

  const lname = name.toLowerCase();
  for (const entry of SCREENER_PATTERNS) {
    if (entry.patterns.some(p => lname.includes(p))) {
      const result: ScreenerClass = {
        weight: entry.weight,
        sentiment: entry.sentiment,
        category: entry.category,
        timeframe: entry.timeframe,
      };
      classCache.set(key, result);
      if (!classCacheFetchedAt) classCacheFetchedAt = Date.now();
      return result;
    }
  }

  // Fallback: screener_master NLP fields (pre-loaded by ensureScreenerMeta)
  const meta = screenerMetaCache.get(key);

  if (meta) {
    const result: ScreenerClass = {
      weight: meta.weight_override ?? (meta.confidence ? Math.round(meta.confidence * 10) : 5),
      sentiment: meta.inferred_sentiment ?? 'neutral',
      category: meta.inferred_category ?? 'technical',
      timeframe: meta.inferred_timeframe === 'intraday' ? 'intraday' : 'positional',
    };
    classCache.set(key, result);
    if (!classCacheFetchedAt) classCacheFetchedAt = Date.now();
    return result;
  }

  const fallback: ScreenerClass = { weight: 5, sentiment: 'neutral', category: 'technical', timeframe: 'positional' };
  classCache.set(key, fallback);
  if (!classCacheFetchedAt) classCacheFetchedAt = Date.now();
  return fallback;
}

// ─── Regime-Aware Weights ────────────────────────────────────────────────────

interface RegimeWeights {
  screenerMomentum: number;
  trend: number;
  vol: number;
  sector: number;
  fund: number;
}

export const REGIME_WEIGHTS: Record<string, RegimeWeights> = {
  BULL:     { screenerMomentum: 1.0,  trend: 1.0, vol: 1.0, sector: 1.0, fund: 1.0 },
  SIDEWAYS: { screenerMomentum: 0.9,  trend: 0.9, vol: 1.0, sector: 0.9, fund: 1.1 },
  HIGH_VOL: { screenerMomentum: 0.7,  trend: 0.8, vol: 0.6, sector: 0.8, fund: 1.2 },
  BEAR:     { screenerMomentum: 0.5,  trend: 0.7, vol: 0.5, sector: 0.7, fund: 1.5 },
  CRASH:    { screenerMomentum: 0.25, trend: 0.5, vol: 0.3, sector: 0.5, fund: 1.8 },
};

let _regimeCache: { regime: string; fetchedAt: number } | null = null;

// Refresh the cached market regime from the DB (≤30-min TTL). Call before any
// scoreStock() pass so the synchronous getCurrentRegime() reads a warm value.
export async function ensureRegime(): Promise<string> {
  const now = Date.now();
  if (_regimeCache && now - _regimeCache.fetchedAt < 30 * 60_000) {
    return _regimeCache.regime;
  }
  try {
    const row = await dbGet(
      'SELECT regime FROM market_regimes ORDER BY date DESC LIMIT 1'
    ) as { regime: string } | undefined;
    const regime = row?.regime ?? 'SIDEWAYS';
    _regimeCache = { regime, fetchedAt: now };
    return regime;
  } catch {
    return 'SIDEWAYS';
  }
}

export function getCurrentRegime(): string {
  return _regimeCache?.regime ?? 'SIDEWAYS';
}

export function _resetRegimeCache() { _regimeCache = null; }

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
  // True when bearish screener weight outweighs bullish (rawScreener < 0 before the
  // Math.max(0,...) floor below collapses it to the same 0 a genuinely screener-silent stock
  // gets). confluenceScore/convictionLevel can't express "actively flagged," only "not
  // flagged" -- this lets a caller distinguish the two without re-deriving rawScreener itself.
  // bearish_screener_count/bullish_screener_count are already persisted columns on
  // confluence_signals (db.ts) -- WHERE bearish_screener_count > bullish_screener_count is a
  // valid query today; this field just saves every in-process caller from re-deriving it.
  netBearish: boolean;
  timeframe: string;
  reasoning: string;
} {
  const regime = getCurrentRegime();
  const rw = REGIME_WEIGHTS[regime] ?? REGIME_WEIGHTS['SIDEWAYS'];

  // A. Screener weighted score
  let rawScreener = 0;
  let bullishCount = 0;
  let bearishCount = 0;
  const bullishClasses: ScreenerClass[] = [];

  for (const cls of data.screenerClasses) {
    if (cls.sentiment === 'bullish') {
      const isMomentumDriven = cls.category === 'momentum' || cls.timeframe === 'intraday';
      const effectiveWeight = isMomentumDriven ? cls.weight * rw.screenerMomentum : cls.weight;
      rawScreener += effectiveWeight;
      bullishCount++;
      bullishClasses.push(cls);
    } else if (cls.sentiment === 'bearish') {
      rawScreener -= cls.weight;
      bearishCount++;
    }
  }

  const multiplier = presenceMultiplier(bullishCount);
  const netBearish = rawScreener < 0;
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
  trendScore = Math.round(trendScore * rw.trend * 100) / 100;

  // C. Volume confirmation (0–10)
  let volScore = 0;
  const volRatio = technical?.volume_ratio ?? 1;
  if (volRatio > 3)        volScore = 10;
  else if (volRatio > 2)   volScore = 7;
  else if (volRatio > 1.5) volScore = 5;
  else if (volRatio > 1.2) volScore = 2;
  volScore = Math.round(volScore * rw.vol * 100) / 100;

  // D. Sector strength (0–8)
  let sectorScore = quant
    ? Math.max(0, Math.min(8, (quant.momentum_score ?? 50) / 100 * 8))
    : 4;
  sectorScore = Math.max(0, Math.min(8, sectorScore * rw.sector));

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
  fundScore = Math.min(12, Math.round(fundScore * rw.fund * 100) / 100);

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
  // netBearish: the score-floor above hides this from confluenceScore, so say it in words --
  // "weak confluence" previously described both "no signal either way" and "actively flagged
  // by N bearish/red-flag scanners" identically, which is a materially different situation for
  // anyone reading this string on a discovery/watchlist surface.
  const reasoning = netBearish
    ? `${data.symbol}: ${bearishCount} bearish scanner${bearishCount > 1 ? 's' : ''} flagged, no offsetting bullish signal (score ${confluenceScore}).`
    : parts.length > 0
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
    netBearish,
    timeframe: suggestTimeframe(confluenceScore, volRatio, bullishClasses),
    reasoning,
  };
}

// ─── Main: Compute Confluence for All Stocks ─────────────────────────────────

export async function computeConfluenceSignals(): Promise<{ computed: number; elite: number; strong: number }> {
  console.log('[CONFLUENCE] Starting confluence computation...');
  await ensureScreenerMeta();
  await ensureRegime();

  const screenerMap = new Map<string, { ids: string[]; names: string[]; classes: ScreenerClass[]; seen: Set<string> }>();

  // seen tracks (source, scanId) composites -- scan_id alone is only unique WITHIN a provider
  // (see classifyScreener's comment), so deduping on bare scanId would have silently dropped a
  // stock's real ETnow screener membership whenever it collided with an already-added MC scan_id
  // of the same number. entry.ids/.names still store the plain scanId/name (unchanged shape for
  // screener_ids_json/screener_names_json, which downstream consumers already parse).
  function addToMap(symbol: string, scanId: string, name: string, source: string) {
    const s = symbol?.trim().toUpperCase();
    if (!s) return;
    if (!screenerMap.has(s)) screenerMap.set(s, { ids: [], names: [], classes: [], seen: new Set() });
    const entry = screenerMap.get(s)!;
    const key = metaKey(source, scanId);
    if (!entry.seen.has(key)) {
      entry.seen.add(key);
      entry.ids.push(scanId);
      entry.names.push(name);
      entry.classes.push(classifyScreener(scanId, name, source));
    }
  }

  // Trendlyne
  const tlStocks = await dbAll(`
    SELECT tss.symbol, tss.screener_id, ts.screener_name
    FROM trendlyne_screener_stocks tss
    JOIN trendlyne_screeners ts ON ts.screener_id = tss.screener_id
    WHERE tss.symbol IS NOT NULL AND tss.symbol != ''
  `) as any[];
  for (const r of tlStocks) addToMap(r.symbol, r.screener_id, r.screener_name, 'Trendlyne');

  // MoneyControl
  const mcStocks = await dbAll(`
    SELECT mss.symbol, mss.scan_id, ms.screener_name
    FROM moneycontrol_screener_stocks mss
    JOIN moneycontrol_screeners ms ON ms.scan_id = mss.scan_id
    WHERE mss.symbol IS NOT NULL AND mss.symbol != ''
  `) as any[];
  for (const r of mcStocks) addToMap(r.symbol, r.scan_id, r.screener_name, 'MoneyControl');

  // ETnow
  const etStocks = await dbAll(`
    SELECT ess.symbol, ess.screener_id, es.screener_name
    FROM etnow_screener_stocks ess
    JOIN etnow_screeners es ON es.screener_id = ess.screener_id
    WHERE ess.symbol IS NOT NULL AND ess.symbol != ''
  `) as any[];
  for (const r of etStocks) addToMap(r.symbol, r.screener_id, r.screener_name, 'ETnow');

  // ET Marketstats/Technicals
  const emsStocks = await dbAll(`
    SELECT ess.symbol, ess.screener_key AS screener_id, es.label AS screener_name
    FROM et_marketstats_screener_stocks ess
    JOIN et_marketstats_screeners es ON es.screener_key = ess.screener_key
    WHERE ess.symbol IS NOT NULL AND ess.symbol != ''
  `) as any[];
  for (const r of emsStocks) addToMap(r.symbol, r.screener_id, r.screener_name, 'et_marketstats');

  if (screenerMap.size === 0) {
    console.log('[CONFLUENCE] No screener stock data found. Run screener sync first.');
    return { computed: 0, elite: 0, strong: 0 };
  }

  // Fetch supporting data
  // Fixed 2026-07-30 (Finding #33, full-stack audit): the correlated subquery re-executed
  // once per outer row scanned with no bound on which rows it correlated against -- O(total
  // historical rows) instead of O(distinct symbols), getting slower every day more history
  // accumulates. ROW_NUMBER() OVER (PARTITION BY symbol ...) is a single-pass equivalent
  // that works identically on both SQLite and Postgres (unlike DISTINCT ON, Postgres-only).
  const techMap = new Map<string, any>(
    (await dbAll(`
      SELECT * FROM (
        SELECT *, ROW_NUMBER() OVER (PARTITION BY symbol ORDER BY date DESC) AS rn
        FROM technical_signals
      ) t WHERE rn = 1
    `) as any[])
      .map((r: any) => [r.symbol, r])
  );
  const quantMap = new Map<string, any>(
    (await dbAll('SELECT * FROM quant_scores') as any[]).map((r: any) => [r.symbol, r])
  );
  const fundMap = new Map<string, any>(
    (await dbAll('SELECT * FROM stock_fundamentals') as any[]).map((r: any) => [r.symbol, r])
  );
  const nseMap = new Map<string, any>(
    (await dbAll('SELECT symbol, sector, market_cap FROM nse_stocks') as any[]).map((r: any) => [r.symbol, r])
  );
  // current_volume: 2026-08-29 finding -- technical_signals (techMap's source) has no raw
  // volume column, only volume_ratio, so this schema column had zero producers anywhere in
  // the repo since it was added. stock_ohlcv carries the real figure. A single MAX(date)
  // filter, not a per-symbol ROW_NUMBER() window (this job runs every 30 min; a window-function
  // scan over stock_ohlcv's full multi-year history would be needlessly heavy here, unlike
  // techMap's technical_signals scan which is a much smaller table).
  const volumeMap = new Map<string, number>(
    (await dbAll(
      `SELECT symbol, volume FROM stock_ohlcv WHERE date = (SELECT MAX(date) FROM stock_ohlcv)`
    ) as any[]).map((r: any) => [r.symbol, r.volume])
  );

  const now = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString();

  const COLS = 30;
  const buildUpsertSql = (n: number) => `
    INSERT INTO confluence_signals (
      symbol, computed_at, confluence_score, conviction_level,
      active_screener_count, bullish_screener_count, bearish_screener_count,
      screener_ids_json, screener_names_json, screener_weights_json,
      trend_alignment_score, volume_score, sector_strength_score, fundamental_score,
      suggested_timeframe, trade_reasoning,
      entry_zone_low, entry_zone_high, stop_loss, target_1, target_2, target_3, risk_reward,
      sector, market_cap, current_price, current_volume, rsi, atr, expires_at
    ) VALUES ${rowGroups(n, COLS)}
    ON CONFLICT(symbol, computed_at) DO UPDATE SET
      confluence_score = excluded.confluence_score,
      conviction_level = excluded.conviction_level
  `;

  const rows: unknown[][] = [];
  let elite = 0, strong = 0;

  for (const [symbol, { ids, names, classes }] of screenerMap) {
    const tech = techMap.get(symbol) ?? null;
    const quant = quantMap.get(symbol) ?? null;
    const fund = fundMap.get(symbol) ?? null;
    const nse = nseMap.get(symbol) ?? null;
    const volume = volumeMap.get(symbol) ?? null;

    const scored = scoreStock({ symbol, screenerIds: ids, screenerNames: names, screenerClasses: classes }, tech, quant, fund, nse);

    const price = tech?.cmp ?? null;
    const atr = price && tech?.bb_width && tech.bb_width > 0 ? price * (tech.bb_width / 100) : (price ? price * 0.03 : null);
    // buildTradeSetup only ever constructs a LONG setup (entry near CMP, stop below, targets
    // above) -- this platform has no short-side trade construct (cash equity, no retail
    // shorting; see unified_ranker.py's position-sizing comment "longs only"). Attaching it to
    // a netBearish stock silently manufactured a long entry/stop/target plan for a name whose
    // own screener signal is net-bearish -- exactly the geometry `unified_ranker.py` was found
    // pulling through into Sell/Strong-Sell rows via `_get_entry_targets`'s confluence_signals
    // fallback. `netBearish` is the same signed test already used above to distinguish "not
    // flagged" from "actively flagged bearish" -- gate the setup on it too.
    const setup = price && atr && !scored.netBearish ? buildTradeSetup(price, atr, scored.confluenceScore) : null;

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
      price ?? null, volume, tech?.rsi ?? null, atr ?? null, expiresAt,
    ]);

    if (scored.convictionLevel === 'ELITE') elite++;
    else if (scored.convictionLevel === 'STRONG') strong++;
  }

  try {
    await dbTransaction(tx => bulkUpsert(tx, rows, COLS, buildUpsertSql));
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
    // 120s was too tight under startup contention (5 concurrent Python slots all busy) —
    // a clean run takes ~70s, but queued behind other scripts it blew the timeout and
    // execFile killed it with SIGTERM before any stderr was written (logged as an opaque
    // "Command failed" with no detail). This only needs to finish within the 30-min cycle.
    await runPython('confluence_ml_engine.py', ['--update-probabilities'], 5 * 60_000);
  } catch (err: any) {
    console.error('[CONFLUENCE-ML] Python error:', err.message);
  }
}

// ─── Latest signals query helper ─────────────────────────────────────────────

export async function getLatestConfluenceSignals(opts: {
  minScore?: number;
  convictionLevel?: string;
  sector?: string;
  timeframe?: string;
  limit?: number;
}): Promise<any[]> {
  const { minScore = 0, convictionLevel, sector, timeframe, limit = 50 } = opts;

  const latestBatch = (await dbGet('SELECT MAX(computed_at) as ts FROM confluence_signals') as any)?.ts;
  if (!latestBatch) return [];

  const conditions: string[] = ['computed_at = ?', 'confluence_score >= ?'];
  const params: any[] = [latestBatch, minScore];

  if (convictionLevel) { conditions.push('conviction_level = ?'); params.push(convictionLevel); }
  if (sector)          { conditions.push('sector = ?');            params.push(sector); }
  if (timeframe)       { conditions.push('suggested_timeframe = ?'); params.push(timeframe); }

  params.push(limit);

  return await dbAll(`
    SELECT * FROM confluence_signals
    WHERE ${conditions.join(' AND ')}
    ORDER BY confluence_score DESC
    LIMIT ?
  `, params) as any[];
}

export async function getDailyGrowthPicks(limit: number = 20, minScore: number = 65): Promise<any[]> {
  return await getLatestConfluenceSignals({ minScore, timeframe: 'INTRADAY', limit });
}
