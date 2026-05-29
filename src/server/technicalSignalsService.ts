/**
 * Technical Signals Service
 *
 * Scans all stocks in stock_ohlcv and detects 7 daily technical patterns:
 *   1. RSI Bullish Divergence      — price falls, RSI holds/rises above SMA200
 *   2. Hidden Bullish Divergence   — price higher-low, RSI lower-low (trend continuation)
 *   3. Resistance Breakout         — price > 20-day high on ≥1.5× average volume
 *   4. MACD Bullish Crossover      — MACD crossed above signal line today
 *   5. Bollinger Band Compression  — BB width at 60-day low (coiling spring)
 *   6. Golden Cross                — SMA50 just crossed above SMA200
 *   7. Oversold Recovery           — RSI bounced from <35 to >40, price rising
 *
 * Signals are scored 0–10 (capped). Top stocks get AI insights via Anthropic API.
 * Results delivered to Telegram if TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID are set.
 *
 * Risk-free rate: 4% p.a. (Indian T-bill proxy)
 */

import db from './db';

// ─── Types ────────────────────────────────────────────────────────────────────

export type SignalType =
  | 'RSI_DIVERGENCE'
  | 'HIDDEN_DIVERGENCE'
  | 'RESISTANCE_BREAKOUT'
  | 'MACD_CROSSOVER'
  | 'BB_COMPRESSION'
  | 'GOLDEN_CROSS'
  | 'OVERSOLD_RECOVERY'
  | 'EMA_BULL_STACK'
  | 'WEEK_52_BREAKOUT'
  | 'BULLISH_ENGULFING'
  | 'SUPERTREND_CROSS'
  | 'NR7_COMPRESSION'
  | 'VOLUME_ACCUMULATION'
  | 'NEAR_52W_HIGH'
  | 'CONSECUTIVE_STRENGTH'
  | 'ATR_CONTRACTION'
  | 'PCR_EXTREME'
  | 'DEATH_CROSS'
  | 'RSI_BEARISH_DIVERGENCE'
  | 'DISTRIBUTION_DAY'
  | 'CONVERGENCE_SIGNAL'
  | 'REGIME_SECTOR_SIGNAL'
  | 'QUALITY_OVERSOLD_SIGNAL';

export type SignalStrength = 'HIGH' | 'MEDIUM' | 'WATCH';

export interface TechSignal {
  type: SignalType;
  strength: SignalStrength;
  detail: string;
}

export interface SignalResult {
  symbol: string;
  name?: string;
  sector?: string;
  cmp: number;
  changePct: number;
  rsi: number;
  sma50: number;
  sma200: number;
  macd: number;
  macdSignal: number;
  bbWidth: number;
  volumeRatio: number;
  aboveSma200: boolean;
  adx: number;
  niftyRegime: 'BULL' | 'BEAR' | 'SIDEWAYS';
  winProbability?: number;
  fii3dNet?: number | null;
  newsSentimentScore?: number;
  signals: TechSignal[];
  signalScore: number;
  aiInsight?: string;
  entryZone?: string;
  stopLoss?: string;
  targets?: string;
  setupQuality?: string;
  timeHorizon?: string;
}

export interface TechnicalSignalsProgress {
  isRunning: boolean;
  totalSymbols: number;
  processed: number;
  found: number;
  startedAt: string | null;
  completedAt: string | null;
  lastError: string | null;
}

// ─── Progress state ───────────────────────────────────────────────────────────

let progress: TechnicalSignalsProgress = {
  isRunning: false,
  totalSymbols: 0,
  processed: 0,
  found: 0,
  startedAt: null,
  completedAt: null,
  lastError: null,
};

export function getTechnicalSignalsProgress(): TechnicalSignalsProgress {
  return { ...progress };
}

export function getTechnicalSignalCount(): number {
  const today = new Date().toISOString().slice(0, 10);
  return (db.prepare(
    'SELECT COUNT(*) as n FROM technical_signals WHERE date = ?'
  ).get(today) as { n: number }).n;
}

// ─── Indicator Math ───────────────────────────────────────────────────────────

interface OHLCVRow { date: string; open: number; high: number; low: number; close: number; volume: number }

function ema(values: number[], period: number): number[] {
  const k = 2 / (period + 1);
  const out: number[] = [values[0]];
  for (let i = 1; i < values.length; i++) {
    out.push(values[i] * k + out[i - 1] * (1 - k));
  }
  return out;
}

function smaArr(values: number[], period: number): (number | null)[] {
  return values.map((_, i) => {
    if (i < period - 1) return null;
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) sum += values[j];
    return sum / period;
  });
}

// Wilder's RSI
function computeRSI(closes: number[], period = 14): (number | null)[] {
  const result: (number | null)[] = new Array(closes.length).fill(null);
  if (closes.length < period + 1) return result;

  const deltas = closes.slice(1).map((c, i) => c - closes[i]);
  let avgGain = 0, avgLoss = 0;
  for (let i = 0; i < period; i++) {
    avgGain += Math.max(deltas[i], 0);
    avgLoss += Math.max(-deltas[i], 0);
  }
  avgGain /= period;
  avgLoss /= period;
  result[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);

  for (let i = period; i < deltas.length; i++) {
    avgGain = (avgGain * (period - 1) + Math.max(deltas[i], 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-deltas[i], 0)) / period;
    result[i + 1] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return result;
}

function computeMACD(closes: number[]): { macdLine: number[]; signalLine: number[] } {
  const ema12 = ema(closes, 12);
  const ema26 = ema(closes, 26);
  const macdLine = ema12.map((v, i) => v - ema26[i]);
  const signalLine = ema(macdLine, 9);
  return { macdLine, signalLine };
}

function computeBBWidth(closes: number[], period = 20): (number | null)[] {
  return closes.map((_, i) => {
    if (i < period - 1) return null;
    const slice = closes.slice(i - period + 1, i + 1);
    const mean = slice.reduce((a, b) => a + b, 0) / period;
    const std  = Math.sqrt(slice.reduce((a, b) => a + (b - mean) ** 2, 0) / period);
    return mean > 0 ? ((mean + 2 * std) - (mean - 2 * std)) / mean : null;
  });
}

// SuperTrend(period=10, multiplier=2.5) — calibrated for Indian markets, reduces whipsaws
function computeSuperTrend(rows: OHLCVRow[], period = 10, multiplier = 2.5): boolean[] {
  const n = rows.length;
  const bullish = new Array<boolean>(n).fill(false);
  if (n < period + 2) return bullish;

  // Wilder ATR
  const tr: number[] = [0];
  for (let i = 1; i < n; i++) {
    tr.push(Math.max(
      rows[i].high - rows[i].low,
      Math.abs(rows[i].high - rows[i - 1].close),
      Math.abs(rows[i].low  - rows[i - 1].close),
    ));
  }
  let atrVal = tr.slice(1, period + 1).reduce((a, b) => a + b, 0) / period;
  const atr = new Array<number>(n).fill(0);
  atr[period] = atrVal;
  for (let i = period + 1; i < n; i++) {
    atrVal = (atrVal * (period - 1) + tr[i]) / period;
    atr[i] = atrVal;
  }

  // Final bands with continuity rule
  const up = new Array<number>(n).fill(0);
  const dn = new Array<number>(n).fill(0);

  for (let i = period; i < n; i++) {
    const mid  = (rows[i].high + rows[i].low) / 2;
    const bUp  = mid + multiplier * atr[i];
    const bDn  = mid - multiplier * atr[i];
    const pClose = rows[i - 1].close;
    up[i] = (i > period && bUp < up[i - 1]) || pClose > up[i - 1] ? bUp : up[i - 1];
    dn[i] = (i > period && bDn > dn[i - 1]) || pClose < dn[i - 1] ? bDn : dn[i - 1];
  }

  // Determine trend direction
  for (let i = period; i < n; i++) {
    if (i === period) {
      bullish[i] = rows[i].close > up[i];
    } else if (!bullish[i - 1]) {
      bullish[i] = rows[i].close > up[i];
    } else {
      bullish[i] = rows[i].close >= dn[i];
    }
  }
  return bullish;
}

// Wilder ATR(14) — returns per-bar ATR values (0 for bars with insufficient history)
function computeATR(rows: OHLCVRow[], period = 14): number[] {
  const n = rows.length;
  const atr = new Array<number>(n).fill(0);
  if (n < period + 1) return atr;

  const tr: number[] = [0];
  for (let i = 1; i < n; i++) {
    tr.push(Math.max(
      rows[i].high - rows[i].low,
      Math.abs(rows[i].high - rows[i - 1].close),
      Math.abs(rows[i].low  - rows[i - 1].close),
    ));
  }

  let val = tr.slice(1, period + 1).reduce((a, b) => a + b, 0) / period;
  atr[period] = val;
  for (let i = period + 1; i < n; i++) {
    val = (val * (period - 1) + tr[i]) / period;
    atr[i] = val;
  }
  return atr;
}

// ADX(14) — trend strength. >25 = strong trend. Returns per-bar ADX values.
function computeADX(rows: OHLCVRow[], period = 14): number[] {
  const n = rows.length;
  const adx = new Array<number>(n).fill(0);
  if (n < period * 2 + 1) return adx;

  const plusDM  = new Array<number>(n).fill(0);
  const minusDM = new Array<number>(n).fill(0);
  const tr      = new Array<number>(n).fill(0);

  for (let i = 1; i < n; i++) {
    const upMove   = rows[i].high - rows[i - 1].high;
    const downMove = rows[i - 1].low - rows[i].low;
    plusDM[i]  = upMove > downMove && upMove > 0 ? upMove : 0;
    minusDM[i] = downMove > upMove && downMove > 0 ? downMove : 0;
    tr[i] = Math.max(
      rows[i].high - rows[i].low,
      Math.abs(rows[i].high - rows[i - 1].close),
      Math.abs(rows[i].low  - rows[i - 1].close),
    );
  }

  // Wilder smoothed sums
  let trS  = tr.slice(1, period + 1).reduce((a, b) => a + b, 0);
  let pDMS = plusDM.slice(1, period + 1).reduce((a, b) => a + b, 0);
  let mDMS = minusDM.slice(1, period + 1).reduce((a, b) => a + b, 0);

  const dx = new Array<number>(n).fill(0);
  const calcDX = (i: number) => {
    const pDI = trS > 0 ? (pDMS / trS) * 100 : 0;
    const mDI = trS > 0 ? (mDMS / trS) * 100 : 0;
    const sum = pDI + mDI;
    dx[i] = sum > 0 ? Math.abs(pDI - mDI) / sum * 100 : 0;
  };
  calcDX(period);

  for (let i = period + 1; i < n; i++) {
    trS  = trS  - trS  / period + tr[i];
    pDMS = pDMS - pDMS / period + plusDM[i];
    mDMS = mDMS - mDMS / period + minusDM[i];
    calcDX(i);
  }

  // ADX = Wilder-smoothed DX over 'period' bars
  let adxVal = dx.slice(period, period * 2).reduce((a, b) => a + b, 0) / period;
  adx[period * 2 - 1] = adxVal;
  for (let i = period * 2; i < n; i++) {
    adxVal = (adxVal * (period - 1) + dx[i]) / period;
    adx[i] = adxVal;
  }
  return adx;
}

// Nifty50 regime — reads from stock_ohlcv; defaults to SIDEWAYS if Nifty data absent
function computeNiftyRegime(): 'BULL' | 'BEAR' | 'SIDEWAYS' {
  try {
    const rows = db.prepare(
      `SELECT close FROM stock_ohlcv
       WHERE symbol IN ('NIFTY50','NIFTY','NIFTY 50','^NSEI','INDIA50')
       ORDER BY date DESC LIMIT 210`
    ).all() as { close: number }[];
    if (rows.length < 50) return 'SIDEWAYS';

    const closes = rows.map(r => r.close).reverse();
    const last   = closes[closes.length - 1];
    const len200 = Math.min(closes.length, 200);
    const sma200 = closes.slice(-len200).reduce((a, b) => a + b, 0) / len200;

    if (last > sma200 * 1.02)  return 'BULL';
    if (last < sma200 * 0.98)  return 'BEAR';
    return 'SIDEWAYS';
  } catch {
    return 'SIDEWAYS';
  }
}

// Load per-signal win rates from signal_type_stats (populated by computeSignalTypeStats)
function loadSignalWinRates(horizonDays = 15, regime: 'BULL' | 'BEAR' | 'SIDEWAYS' | 'ALL' = 'ALL'): Map<string, number> {
  const map = new Map<string, number>();
  try {
    // First try regime-specific rates (require ≥10 samples to be reliable)
    const regimeRows = db.prepare(`
      SELECT signal_type, win_rate FROM signal_type_stats
      WHERE horizon_days = ? AND market_regime = ? AND total_occurrences >= 10
    `).all(horizonDays, regime) as { signal_type: string; win_rate: number }[];
    for (const r of regimeRows) map.set(r.signal_type, r.win_rate);

    // Fall back to 'ALL' for types not yet seen in this regime
    const allRows = db.prepare(`
      SELECT signal_type, win_rate FROM signal_type_stats
      WHERE horizon_days = ? AND market_regime = 'ALL' AND total_occurrences >= 20
    `).all(horizonDays) as { signal_type: string; win_rate: number }[];
    for (const r of allRows) {
      if (!map.has(r.signal_type)) map.set(r.signal_type, r.win_rate);
    }
  } catch { /* table may not be populated yet */ }
  return map;
}

// Returns symbol -> nearest upcoming earnings date (YYYY-MM-DD)
function loadEarningsCalendar(): Map<string, string> {
  const map = new Map<string, string>();
  try {
    const today = new Date().toISOString().slice(0, 10);
    const rows = db.prepare(`
      SELECT symbol, MAX(event_date) as next_earnings
      FROM corporate_actions
      WHERE event_type IN ('Quarterly Results', 'Board Meeting', 'Earnings')
        AND event_date >= ?
        AND event_date <= date(?, '+30 days')
      GROUP BY symbol
    `).all(today, today) as { symbol: string; next_earnings: string }[];
    for (const r of rows) map.set(r.symbol, r.next_earnings);
  } catch { /* table may not exist or have no data */ }
  return map;
}

// Load 3-day FII net flow (negative = institutions selling)
function loadFIIFlow3d(): number | null {
  try {
    const rows = db.prepare(
      `SELECT fii_net FROM fii_dii_flow ORDER BY date DESC LIMIT 3`
    ).all() as { fii_net: number }[];
    if (rows.length === 0) return null;
    return rows.reduce((a, r) => a + (r.fii_net ?? 0), 0);
  } catch {
    return null;
  }
}

// ─── Signal Scoring ───────────────────────────────────────────────────────────

const SIGNAL_SCORES: Record<SignalType, Record<SignalStrength, number>> = {
  RSI_DIVERGENCE:     { HIGH: 4, MEDIUM: 2, WATCH: 1 },
  HIDDEN_DIVERGENCE:  { HIGH: 5, MEDIUM: 3, WATCH: 1 },
  RESISTANCE_BREAKOUT:{ HIGH: 4, MEDIUM: 3, WATCH: 1 },
  MACD_CROSSOVER:     { HIGH: 3, MEDIUM: 2, WATCH: 1 },
  BB_COMPRESSION:     { HIGH: 2, MEDIUM: 1, WATCH: 1 },
  GOLDEN_CROSS:       { HIGH: 5, MEDIUM: 3, WATCH: 2 },
  OVERSOLD_RECOVERY:  { HIGH: 3, MEDIUM: 2, WATCH: 1 },
  EMA_BULL_STACK:     { HIGH: 4, MEDIUM: 3, WATCH: 1 },
  WEEK_52_BREAKOUT:   { HIGH: 5, MEDIUM: 4, WATCH: 2 },
  BULLISH_ENGULFING:  { HIGH: 4, MEDIUM: 2, WATCH: 1 },
  SUPERTREND_CROSS:   { HIGH: 4, MEDIUM: 3, WATCH: 1 },
  NR7_COMPRESSION:    { HIGH: 2, MEDIUM: 1, WATCH: 1 },
  VOLUME_ACCUMULATION:{ HIGH: 5, MEDIUM: 3, WATCH: 2 },
  NEAR_52W_HIGH:      { HIGH: 3, MEDIUM: 2, WATCH: 1 },
  CONSECUTIVE_STRENGTH:{ HIGH: 4, MEDIUM: 2, WATCH: 1 },
  ATR_CONTRACTION:    { HIGH: 3, MEDIUM: 2, WATCH: 1 },
  PCR_EXTREME:        { HIGH: 4, MEDIUM: 3, WATCH: 1 },
  DEATH_CROSS:            { HIGH: -5, MEDIUM: -3, WATCH: -2 },
  RSI_BEARISH_DIVERGENCE: { HIGH: -4, MEDIUM: -2, WATCH: -1 },
  DISTRIBUTION_DAY:       { HIGH: -4, MEDIUM: -3, WATCH: -2 },
  CONVERGENCE_SIGNAL:      { HIGH: 6, MEDIUM: 4, WATCH: 2 },
  REGIME_SECTOR_SIGNAL:    { HIGH: 5, MEDIUM: 3, WATCH: 2 },
  QUALITY_OVERSOLD_SIGNAL: { HIGH: 4, MEDIUM: 3, WATCH: 2 },
};

function loadRecentNewsSentiment(days = 2): Map<string, number> {
  const map = new Map<string, number>();
  try {
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    const rows = db.prepare(`
      SELECT symbols_json, sentiment_score 
      FROM news_sentiment_items
      WHERE fetched_at >= ? AND symbols_json IS NOT NULL AND symbols_json != '' AND symbols_json != '[]'
    `).all(cutoff) as { symbols_json: string; sentiment_score: number }[];

    const symbolScores = new Map<string, number[]>();
    for (const r of rows) {
      try {
        const symbols = JSON.parse(r.symbols_json) as string[];
        for (const sym of symbols) {
          if (!symbolScores.has(sym)) symbolScores.set(sym, []);
          symbolScores.get(sym)!.push(r.sentiment_score);
        }
      } catch { /* skip */ }
    }

    for (const [sym, scores] of symbolScores.entries()) {
      if (scores.length > 0) {
        const avg = scores.reduce((a, b) => a + b, 0) / scores.length;
        map.set(sym, avg);
      }
    }
  } catch (err: any) {
    console.warn('[SIGNALS] Error loading news sentiment:', err.message);
  }
  return map;
}

function scoreSignals(
  signals: TechSignal[],
  winRates: Map<string, number> = new Map(),
  regime: 'BULL' | 'BEAR' | 'SIDEWAYS' = 'BULL',
  fii3dNet: number | null = null,
  newsSentimentScore = 0,
): number {
  let total = 0;
  for (const s of signals) {
    const base = SIGNAL_SCORES[s.type]?.[s.strength] ?? 0;
    const wr = winRates.get(s.type);
    // Win-rate multiplier: if we have ≥20 historical samples, adjust score
    const wrMult = wr != null
      ? (wr >= 0.65 ? 1.25 : wr >= 0.55 ? 1.0 : wr >= 0.45 ? 0.85 : 0.70)
      : 1.0;
    // Setup signals (volatility squeeze) predict a move but not direction — 50% discount
    const setupDiscount = (s.type === 'BB_COMPRESSION' || s.type === 'ATR_CONTRACTION') ? 0.5 : 1.0;
    total += base * wrMult * setupDiscount;
  }

  // Nifty regime discount — bull market keeps full score, bear = -40%, sideways = -20%
  const regimeMult = regime === 'BEAR' ? 0.60 : regime === 'SIDEWAYS' ? 0.80 : 1.0;
  total *= regimeMult;

  // FII headwind discount — heavy selling (< -3000 Cr 3-day net) reduces score 15%
  if (fii3dNet != null && fii3dNet < -3000) total *= 0.85;

  // News Sentiment Modifier — highly bullish (>0.25) boosts score 15%, highly bearish (<-0.25) penalizes 25%
  if (newsSentimentScore > 0.25) {
    total *= 1.15;
  } else if (newsSentimentScore < -0.25) {
    total *= 0.75;
  }

  return Math.min(Math.round(total), 10);
}

// ─── Signal Detection ─────────────────────────────────────────────────────────

function detectSignals(rows: OHLCVRow[], symbol = ''): {
  signals: TechSignal[];
  rsi: number; sma50: number; sma200: number;
  macd: number; macdSignal: number; bbWidth: number;
  volumeRatio: number; aboveSma200: boolean; adx: number;
} {
  const closes  = rows.map(r => r.close);
  const opens   = rows.map(r => r.open);
  const highs   = rows.map(r => r.high);
  const lows    = rows.map(r => r.low);
  const volumes = rows.map(r => r.volume);
  const n = closes.length;

  const rsiArr     = computeRSI(closes);
  const sma50Arr   = smaArr(closes, 50);
  const sma200Arr  = smaArr(closes, 200);
  const bbWidths   = computeBBWidth(closes);
  const { macdLine, signalLine } = computeMACD(closes);
  const ema8Arr    = ema(closes, 8);
  const ema21Arr   = ema(closes, 21);
  const ema50Arr   = ema(closes, 50);
  const stBullish  = computeSuperTrend(rows);      // now period=10, mult=2.5
  const atrArr     = computeATR(rows);
  const adxArr     = computeADX(rows);
  const vol20Arr   = smaArr(volumes, 20);

  const latestRSI    = rsiArr[n - 1]    ?? 50;
  const latestSMA50  = sma50Arr[n - 1]  ?? closes[n - 1];
  const latestSMA200 = sma200Arr[n - 1] ?? closes[n - 1];
  const latestBBW    = bbWidths[n - 1]  ?? 0;
  const latestMACD   = macdLine[n - 1];
  const latestSig    = signalLine[n - 1];
  const latestADX    = adxArr[n - 1] ?? 0;
  const vol20        = vol20Arr[n - 1];
  const volRatio     = vol20 != null && vol20 > 0 ? volumes[n - 1] / vol20 : 1;
  const aboveSma200  = closes[n - 1] > latestSMA200;
  const trendStrong  = latestADX >= 20;   // ADX gate: confirms a real trend exists

  const signals: TechSignal[] = [];

  // 1. RSI Bullish Divergence (price lower 5D, RSI higher 5D, RSI 35-60, above SMA200)
  if (n >= 7 && aboveSma200) {
    const rsi5  = rsiArr[n - 6] ?? 50;
    if (closes[n - 1] < closes[n - 6] && latestRSI > rsi5 &&
        latestRSI >= 35 && latestRSI <= 60) {
      const drop = ((closes[n - 6] - closes[n - 1]) / closes[n - 6]) * 100;
      const gain = latestRSI - rsi5;
      signals.push({
        type: 'RSI_DIVERGENCE',
        strength: gain > 3 ? 'HIGH' : 'MEDIUM',
        detail: `Price fell ${drop.toFixed(1)}% but RSI rose ${gain.toFixed(1)}pts — momentum diverging`,
      });
    }
  }

  // 2. Hidden Bullish Divergence (price HL 10D, RSI LL, RSI 40-65, above SMA200)
  if (n >= 12 && aboveSma200) {
    const rsi10 = rsiArr[n - 11] ?? 50;
    if (closes[n - 1] > closes[n - 11] && latestRSI < rsi10 &&
        latestRSI >= 40 && latestRSI <= 65) {
      signals.push({
        type: 'HIDDEN_DIVERGENCE',
        strength: 'HIGH',
        detail: 'Hidden bullish divergence: price higher-low + RSI lower-low — uptrend continuation',
      });
    }
  }

  // 3. Resistance Breakout (price > 20D high, volume > 1.5× avg, ADX ≥ 20 gates fake breakouts)
  if (n >= 22) {
    const hi20 = Math.max(...highs.slice(n - 21, n - 1));
    if (closes[n - 1] > hi20 && volRatio > 1.5) {
      signals.push({
        type: 'RESISTANCE_BREAKOUT',
        strength: volRatio > 2.0 && trendStrong ? 'HIGH' : trendStrong ? 'MEDIUM' : 'WATCH',
        detail: `Broke 20-day high ₹${hi20.toFixed(2)} on ${volRatio.toFixed(1)}× volume | ADX ${latestADX.toFixed(1)}${trendStrong ? ' (trend confirmed)' : ' (weak trend — watch for fakeout)'}`,
      });
    }
  }

  // 4. MACD Bullish Crossover (crossed above signal today, above SMA200)
  if (n >= 2 && aboveSma200) {
    if (macdLine[n - 1] > signalLine[n - 1] && macdLine[n - 2] < signalLine[n - 2]) {
      signals.push({
        type: 'MACD_CROSSOVER',
        strength: 'MEDIUM',
        detail: 'MACD crossed above signal line — histogram turning positive',
      });
    }
  }

  // 5. BB Compression (BB width at 60D low, above SMA200)
  if (n >= 62 && aboveSma200) {
    const bbs = bbWidths.slice(n - 61, n - 1).filter((v): v is number => v != null);
    if (bbs.length > 0) {
      const bb60min = Math.min(...bbs);
      if (latestBBW < bb60min * 1.15) {
        signals.push({
          type: 'BB_COMPRESSION',
          strength: 'WATCH',
          detail: 'Bollinger Band width at 60-day low — volatility squeeze, breakout imminent',
        });
      }
    }
  }

  // 6. Golden Cross (SMA50 just crossed above SMA200 today)
  if (n >= 202) {
    const sma50prev  = sma50Arr[n - 2]  ?? 0;
    const sma200prev = sma200Arr[n - 2] ?? 0;
    if (latestSMA50 > latestSMA200 && sma50prev < sma200prev) {
      signals.push({
        type: 'GOLDEN_CROSS',
        strength: 'HIGH',
        detail: 'SMA50 just crossed above SMA200 — golden cross, strong long-term buy signal',
      });
    }
  }

  // 7. Oversold Recovery (RSI was <35 four sessions ago, now >40, price bouncing, above SMA200)
  if (n >= 6 && aboveSma200) {
    const rsi4 = rsiArr[n - 5] ?? 50;
    if (rsi4 < 35 && latestRSI > 40 && closes[n - 1] > closes[n - 5]) {
      signals.push({
        type: 'OVERSOLD_RECOVERY',
        strength: 'MEDIUM',
        detail: `RSI recovering from oversold (<35) — bounce play confirmed above SMA200`,
      });
    }
  }

  // 8. EMA Bull Stack (EMA8 > EMA21 > EMA50 > SMA200, price above all, RSI 45-70)
  if (n >= 55 && aboveSma200) {
    const e8  = ema8Arr[n - 1];
    const e21 = ema21Arr[n - 1];
    const e50 = ema50Arr[n - 1];
    const c   = closes[n - 1];
    if (e8 > e21 && e21 > e50 && e50 > latestSMA200 &&
        c > e8 && latestRSI >= 45 && latestRSI <= 70) {
      const e8prev  = ema8Arr[n - 4];
      const e21prev = ema21Arr[n - 4];
      const spread  = ((e8 - e21) / e21) * 100;
      const justAligned = e8prev < e21prev && e8 > e21;
      signals.push({
        type: 'EMA_BULL_STACK',
        strength: justAligned ? 'HIGH' : spread > 0.5 ? 'MEDIUM' : 'WATCH',
        detail: `EMA8 > EMA21 > EMA50 > SMA200 — perfect bull stack, price leading EMAs (spread ${spread.toFixed(2)}%)`,
      });
    }
  }

  // 9. 52-Week High Breakout (close > max of prior 252-day highs, ADX gates momentum quality)
  if (n >= 254) {
    const hi252 = Math.max(...highs.slice(n - 253, n - 1));
    if (closes[n - 1] > hi252) {
      signals.push({
        type: 'WEEK_52_BREAKOUT',
        strength: volRatio > 2.0 && trendStrong ? 'HIGH' : volRatio > 1.3 ? 'MEDIUM' : 'WATCH',
        detail: `Breaking 52-week high ₹${hi252.toFixed(2)} on ${volRatio.toFixed(1)}× volume | ADX ${latestADX.toFixed(1)}${trendStrong ? ' (strong trend)' : ' (trend weak)'}`,
      });
    }
  }

  // 10. Bullish Engulfing (today's candle fully engulfs yesterday's bearish body, volume surge)
  if (n >= 3 && aboveSma200) {
    const todayOpen  = opens[n - 1];
    const todayClose = closes[n - 1];
    const prevOpen   = opens[n - 2];
    const prevClose  = closes[n - 2];
    const prevBearish = prevClose < prevOpen;
    const engulfs     = todayOpen <= prevClose && todayClose >= prevOpen;
    const bullishToday = todayClose > todayOpen;
    if (prevBearish && engulfs && bullishToday && volRatio > 1.2) {
      const bodyPct = ((todayClose - todayOpen) / todayOpen) * 100;
      signals.push({
        type: 'BULLISH_ENGULFING',
        strength: volRatio > 2.0 && bodyPct > 1.5 ? 'HIGH' : 'MEDIUM',
        detail: `Bullish engulfing candle (body +${bodyPct.toFixed(1)}%) on ${volRatio.toFixed(1)}× volume — bears trapped`,
      });
    }
  }

  // 11. SuperTrend Crossover (was bearish yesterday, flipped bullish today)
  if (n >= 10) {
    if (!stBullish[n - 2] && stBullish[n - 1]) {
      signals.push({
        type: 'SUPERTREND_CROSS',
        strength: aboveSma200 ? 'HIGH' : 'MEDIUM',
        detail: `SuperTrend(7,3) just flipped bullish — trend reversal signal${aboveSma200 ? ' above SMA200' : ''}`,
      });
    }
  }

  // 12. NR7 Compression (today's high-low range is narrowest of last 7 bars, above SMA200)
  if (n >= 8 && aboveSma200) {
    const todayRange = highs[n - 1] - lows[n - 1];
    const ranges7 = Array.from({ length: 6 }, (_, i) => highs[n - 2 - i] - lows[n - 2 - i]);
    if (todayRange < Math.min(...ranges7) && todayRange > 0) {
      const avgRange = ranges7.reduce((a, b) => a + b, 0) / 6;
      const compression = (1 - todayRange / avgRange) * 100;
      signals.push({
        type: 'NR7_COMPRESSION',
        strength: compression > 50 ? 'MEDIUM' : 'WATCH',
        detail: `NR7: narrowest range in 7 days (${compression.toFixed(0)}% tighter than avg) — coiling before breakout`,
      });
    }
  }

  // 13. Volume Accumulation — stealth institutional buying (pre-earnings / pre-news smart money)
  // 3+ of last 5 sessions had volume > 2× 20D avg, but price is flat (<5% total move)
  // Mirrors what happened in Balaji Amines, NLC India, Saregama before their 15-20% moves
  if (n >= 22) {
    const vol20 = vol20Arr[n - 1];
    if (vol20 != null && vol20 > 0) {
      let heavyVolDays = 0;
      for (let i = n - 5; i < n; i++) {
        if (volumes[i] > 2 * vol20) heavyVolDays++;
      }
      const priceMove5d = Math.abs((closes[n - 1] - closes[n - 6]) / closes[n - 6]) * 100;
      if (heavyVolDays >= 3 && priceMove5d < 5) {
        const totalVolMult = volumes.slice(n - 5).reduce((a, b) => a + b, 0) / (5 * vol20);
        signals.push({
          type: 'VOLUME_ACCUMULATION',
          strength: heavyVolDays >= 4 && priceMove5d < 3 ? 'HIGH' : 'MEDIUM',
          detail: `${heavyVolDays}/5 sessions with >2× avg volume — price only moved ${priceMove5d.toFixed(1)}%, avg volume ${totalVolMult.toFixed(1)}× normal (smart money accumulating)`,
        });
      }
    }
  }

  // 14. Near 52-Week High — price within 3% of 52W high but not yet broken (pre-breakout watch)
  // Catches stocks like Craftsman Automation days before it hit the all-time high
  if (n >= 254) {
    const hi252 = Math.max(...highs.slice(n - 253, n - 1));
    const proximity = (hi252 - closes[n - 1]) / hi252 * 100;
    if (proximity > 0 && proximity <= 3 && closes[n - 1] > latestSMA50) {
      signals.push({
        type: 'NEAR_52W_HIGH',
        strength: proximity <= 1 ? 'HIGH' : proximity <= 2 ? 'MEDIUM' : 'WATCH',
        detail: `Just ${proximity.toFixed(1)}% below 52-week high of ₹${hi252.toFixed(2)} — breakout imminent if volume confirms`,
      });
    }
  }

  // 15. Consecutive Strength — 4+ days of higher closes with non-declining volume (momentum build)
  // Pattern seen in TVS Holdings, Afcons before their move accelerated
  if (n >= 7) {
    let streak = 0;
    let volumeConfirmed = true;
    for (let i = n - 1; i >= n - 6 && i >= 1; i--) {
      if (closes[i] > closes[i - 1]) {
        streak++;
        if (volumes[i] < volumes[i - 1] * 0.7) volumeConfirmed = false;
      } else {
        break;
      }
    }
    if (streak >= 4 && aboveSma200) {
      const totalGain = ((closes[n - 1] - closes[n - 1 - streak]) / closes[n - 1 - streak]) * 100;
      signals.push({
        type: 'CONSECUTIVE_STRENGTH',
        strength: streak >= 5 && volumeConfirmed && trendStrong ? 'HIGH' : streak >= 5 ? 'MEDIUM' : 'WATCH',
        detail: `${streak} consecutive up-closes, +${totalGain.toFixed(1)}%${volumeConfirmed ? ' vol-confirmed' : ''} | ADX ${latestADX.toFixed(1)}${trendStrong ? ' (momentum confirmed)' : ''}`,
      });
    }
  }

  // 16. ATR Contraction — 14-day ATR at a 60-day low (multi-week volatility squeeze before earnings moves)
  // Longer-timeframe version of BB Compression; caught Saregama, NLC India before their 15% surges
  if (n >= 76) {
    const todayATR = atrArr[n - 1];
    if (todayATR > 0) {
      const atr60 = atrArr.slice(n - 61, n - 1).filter(v => v > 0);
      if (atr60.length > 0) {
        const minATR60 = Math.min(...atr60);
        const avgATR60 = atr60.reduce((a, b) => a + b, 0) / atr60.length;
        const contractionPct = (1 - todayATR / avgATR60) * 100;
        if (todayATR <= minATR60 * 1.05 && aboveSma200) {
          signals.push({
            type: 'ATR_CONTRACTION',
            strength: contractionPct > 50 ? 'HIGH' : contractionPct > 30 ? 'MEDIUM' : 'WATCH',
            detail: `ATR(14) at ${contractionPct.toFixed(0)}% below 60-day avg — deepest volatility contraction in 3 months, explosive move loading`,
          });
        }
      }
    }
  }

  // 16. PCR_EXTREME — extreme put/call ratio signals support or resistance
  if (symbol) {
    const pcrRow = db.prepare(
      `SELECT pcr FROM stock_options_oi WHERE symbol = ? ORDER BY date DESC LIMIT 1`
    ).get(symbol) as { pcr: number } | undefined;

    if (pcrRow) {
      const pcr = pcrRow.pcr;
      if (pcr > 1.3) {
        // High PCR = excess puts = bearish sentiment peak = contrarian support
        signals.push({
          type: 'PCR_EXTREME',
          strength: pcr > 1.8 ? 'HIGH' : pcr > 1.5 ? 'MEDIUM' : 'WATCH',
          detail: `PCR ${pcr.toFixed(2)} > 1.3 — extreme put buildup signals bearish sentiment peak; contrarian support zone`,
        });
      } else if (pcr < 0.7) {
        // Low PCR = excess calls = complacency = potential resistance / reversal risk
        signals.push({
          type: 'PCR_EXTREME',
          strength: pcr < 0.4 ? 'HIGH' : pcr < 0.55 ? 'MEDIUM' : 'WATCH',
          detail: `PCR ${pcr.toFixed(2)} < 0.7 — excess call buying signals complacency; watch for resistance and reversal`,
        });
      }
    }
  }

  // B1. Death Cross (SMA50 just crossed below SMA200 today — strong long-term bearish)
  if (n >= 202) {
    const sma50prev  = sma50Arr[n - 2]  ?? 0;
    const sma200prev = sma200Arr[n - 2] ?? 0;
    if (latestSMA50 < latestSMA200 && sma50prev >= sma200prev) {
      signals.push({
        type: 'DEATH_CROSS',
        strength: 'HIGH',
        detail: 'SMA50 just crossed below SMA200 — death cross, strong long-term sell signal',
      });
    }
  }

  // B2. RSI Bearish Divergence (price higher high 5D, RSI lower high, RSI 55–75 zone)
  if (n >= 7) {
    const rsi5 = rsiArr[n - 6] ?? 50;
    if (closes[n - 1] > closes[n - 6] && latestRSI < rsi5 &&
        latestRSI >= 55 && latestRSI <= 75) {
      const gain   = ((closes[n - 1] - closes[n - 6]) / closes[n - 6]) * 100;
      const rsiFall = rsi5 - latestRSI;
      signals.push({
        type: 'RSI_BEARISH_DIVERGENCE',
        strength: rsiFall > 4 ? 'HIGH' : rsiFall > 2 ? 'MEDIUM' : 'WATCH',
        detail: `Price rose ${gain.toFixed(1)}% but RSI fell ${rsiFall.toFixed(1)}pts — bearish divergence, momentum fading`,
      });
    }
  }

  // B3. Distribution Day (heavy volume sell-off: 3+ of last 5 days had close < open AND vol > 1.5× 20D avg)
  if (n >= 22) {
    const vol20 = vol20Arr[n - 1];
    if (vol20 != null && vol20 > 0) {
      let distDays = 0;
      for (let i = n - 5; i < n; i++) {
        if (closes[i] < opens[i] && volumes[i] > 1.5 * vol20) distDays++;
      }
      if (distDays >= 3) {
        const priceMove5d = ((closes[n - 1] - closes[n - 6]) / closes[n - 6]) * 100;
        signals.push({
          type: 'DISTRIBUTION_DAY',
          strength: distDays >= 4 ? 'HIGH' : 'MEDIUM',
          detail: `${distDays}/5 sessions show distribution (high-vol down-close) — institutional selling pattern, price ${priceMove5d.toFixed(1)}%`,
        });
      }
    }
  }

  return {
    signals,
    rsi: latestRSI,
    sma50: latestSMA50,
    sma200: latestSMA200,
    macd: latestMACD,
    macdSignal: latestSig,
    bbWidth: latestBBW,
    volumeRatio: volRatio,
    aboveSma200,
    adx: latestADX,
  };
}

// ─── AI Insights (Anthropic API) ──────────────────────────────────────────────

async function getAIInsight(r: SignalResult): Promise<{
  aiInsight: string; entryZone: string; stopLoss: string;
  targets: string; setupQuality: string; timeHorizon: string;
}> {
  const empty = { aiInsight: '', entryZone: '', stopLoss: '', targets: '', setupQuality: '', timeHorizon: '' };
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return empty;

  const sma200gap = r.sma200 > 0 ? ((r.cmp - r.sma200) / r.sma200 * 100).toFixed(1) : '0';
  const sma50gap  = r.sma50  > 0 ? ((r.cmp - r.sma50)  / r.sma50  * 100).toFixed(1) : '0';
  const sigDetail = r.signals.map(s => `• ${s.type} (${s.strength}): ${s.detail}`).join('\n');

  const prompt = `You are a SEBI-registered technical analyst covering Indian equities (NSE).
Analyse this stock and give a CONCISE trading setup.

Stock: ${r.name ?? r.symbol} (${r.symbol})
CMP: ₹${r.cmp.toFixed(2)}  |  Day Change: ${r.changePct.toFixed(2)}%
RSI(14): ${r.rsi.toFixed(1)}  |  SMA50: ₹${r.sma50.toFixed(2)}  |  SMA200: ₹${r.sma200.toFixed(2)}
vs SMA50: ${sma50gap}%  |  vs SMA200: ${sma200gap}%
Volume ratio: ${r.volumeRatio.toFixed(2)}x 10-day average

Signals detected:
${sigDetail}

Respond in EXACTLY this JSON format (no markdown, no preamble):
{"insight":"2-sentence plain English summary of why this is a setup worth watching","entry_zone":"₹X – ₹Y","stop_loss":"₹Z (below key level)","targets":"T1: ₹A | T2: ₹B | T3: ₹C","setup_quality":"High / Medium / Low","time_horizon":"Swing (3-7D) / Positional (2-4W)"}`;

  try {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: process.env.ANTHROPIC_MODEL ?? 'claude-haiku-4-5-20251001',
        max_tokens: 400,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    const data = await resp.json() as { content?: { text?: string }[] };
    const text = data?.content?.[0]?.text?.trim() ?? '';
    const parsed = JSON.parse(text);
    return {
      aiInsight:    parsed.insight        ?? '',
      entryZone:    parsed.entry_zone     ?? '',
      stopLoss:     parsed.stop_loss      ?? '',
      targets:      parsed.targets        ?? '',
      setupQuality: parsed.setup_quality  ?? '',
      timeHorizon:  parsed.time_horizon   ?? '',
    };
  } catch (e) {
    console.error('[SIGNALS] AI insight failed for', r.symbol, ':', (e as Error).message);
    return empty;
  }
}

// ─── Telegram Delivery ────────────────────────────────────────────────────────

const STRENGTH_EMOJI: Record<SignalStrength, string> = { HIGH: '🟢', MEDIUM: '🟡', WATCH: '⚪' };
const SIG_SHORT: Record<SignalType, string> = {
  RSI_DIVERGENCE:     'RSI Div',
  HIDDEN_DIVERGENCE:  'Hidden Div',
  RESISTANCE_BREAKOUT:'Breakout',
  MACD_CROSSOVER:     'MACD ✗',
  BB_COMPRESSION:     'Squeeze',
  GOLDEN_CROSS:       'Golden ✗',
  OVERSOLD_RECOVERY:  'Oversold↑',
  EMA_BULL_STACK:      'EMA Stack',
  WEEK_52_BREAKOUT:    '52W High',
  BULLISH_ENGULFING:   'Engulfing',
  SUPERTREND_CROSS:    'SuperTrend↑',
  NR7_COMPRESSION:     'NR7',
  VOLUME_ACCUMULATION: 'Vol Accum',
  NEAR_52W_HIGH:       'Near 52W',
  CONSECUTIVE_STRENGTH:'Consec↑',
  ATR_CONTRACTION:     'ATR Squeeze',
  PCR_EXTREME:         'PCR Extreme',
  DEATH_CROSS:            'Death ✗',
  RSI_BEARISH_DIVERGENCE: 'RSI Bear Div',
  DISTRIBUTION_DAY:       'Distribution',
  CONVERGENCE_SIGNAL:      'Convergence',
  REGIME_SECTOR_SIGNAL:    'Regime+Sector',
  QUALITY_OVERSOLD_SIGNAL: 'Quality Ovsld',
};

async function sendTelegramSignals(results: SignalResult[], date: string): Promise<void> {
  const token  = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return;

  let body = '';
  for (const r of results.slice(0, 6)) {
    const e   = r.changePct >= 0 ? '📈' : '📉';
    const sig = r.signals.map(s => `${STRENGTH_EMOJI[s.strength]} ${SIG_SHORT[s.type]}`).join('  ');
    body += `*${r.name ?? r.symbol}* (${r.symbol})\n`;
    body += `₹${r.cmp.toFixed(2)} ${e}${Math.abs(r.changePct).toFixed(1)}%  RSI:${r.rsi.toFixed(0)}  Score:${r.signalScore}/10\n`;
    body += `${sig}\n`;
    if (r.entryZone) body += `Entry: ${r.entryZone}  SL: ${r.stopLoss}\n`;
    if (r.targets)   body += `Targets: ${r.targets}\n`;
    if (r.aiInsight) body += `_${r.aiInsight.slice(0, 180)}_\n`;
    body += '\n';
  }

  const message = `🇮🇳 *NSE DAILY SCAN — ${date}*\n${'─'.repeat(28)}\n\n${body}⚠️ _Educational only. Not SEBI advice. DYOR._`;

  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: message, parse_mode: 'Markdown' }),
    });
    console.log('[SIGNALS] Telegram notification sent');
  } catch (e) {
    console.error('[SIGNALS] Telegram delivery failed:', (e as Error).message);
  }
}

// ─── Main Scan ────────────────────────────────────────────────────────────────

export async function runTechnicalSignalScan(options: {
  minScore?: number;
  aiInsightsLimit?: number;
  date?: string;
} = {}): Promise<void> {
  if (progress.isRunning) {
    console.log('[SIGNALS] Scan already in progress, skipping');
    return;
  }

  const { minScore = 2, aiInsightsLimit = 10 } = options;
  const scanDate = options.date ?? new Date().toISOString().slice(0, 10);

  progress = {
    isRunning: true,
    totalSymbols: 0,
    processed: 0,
    found: 0,
    startedAt: new Date().toISOString(),
    completedAt: null,
    lastError: null,
  };

  try {
    // ── Pre-scan context (computed once, applied to all stocks) ──────────────
    const niftyRegime      = computeNiftyRegime();
    const winRates         = loadSignalWinRates(15, niftyRegime);
    const fii3dNet         = loadFIIFlow3d();
    const earningsCalendar = loadEarningsCalendar();
    const newsSentiment    = loadRecentNewsSentiment(2); // past 48 hours of news
    console.log(`[SIGNALS] Regime: ${niftyRegime} | Win-rate records: ${winRates.size} | FII 3d: ${fii3dNet ?? 'N/A'} Cr | News Sentiment: ${newsSentiment.size} stocks | Earnings watchlist: ${earningsCalendar.size}`);

    console.log('[SIGNALS] Loading OHLCV data...');
    const allRows = db.prepare(
      `SELECT symbol, date, open, high, low, close, volume FROM stock_ohlcv ORDER BY symbol, date ASC`
    ).all() as (OHLCVRow & { symbol: string })[];

    // Group by symbol
    const bySymbol = new Map<string, OHLCVRow[]>();
    for (const r of allRows) {
      if (!bySymbol.has(r.symbol)) bySymbol.set(r.symbol, []);
      bySymbol.get(r.symbol)!.push(r);
    }

    // Load stock names + sectors
    const meta = new Map<string, { name: string; sector: string }>();
    (db.prepare('SELECT symbol, name, sector FROM nse_stocks').all() as
      { symbol: string; name: string; sector: string }[])
      .forEach(r => meta.set(r.symbol, { name: r.name, sector: r.sector }));

    const eligible = [...bySymbol.entries()].filter(([, rows]) => rows.length >= 22);
    progress.totalSymbols = eligible.length;

    console.log(`[SIGNALS] Scanning ${eligible.length} symbols for patterns...`);

    const results: SignalResult[] = [];

    for (const [symbol, rows] of eligible) {
      try {
        const { signals, ...indicators } = detectSignals(rows, symbol);
        progress.processed++;

        if (signals.length === 0) continue;
        const sentimentScore = newsSentiment.get(symbol) ?? 0;
        const score = scoreSignals(signals, winRates, niftyRegime, fii3dNet, sentimentScore);
        if (score < minScore) continue;

        // Pre-earnings discount: signals within 5 days of results date are lower quality
        let adjustedScore = score;
        const earningsDate = earningsCalendar.get(symbol);
        if (earningsDate) {
          const daysToEarnings = Math.round(
            (new Date(earningsDate).getTime() - Date.now()) / (1000 * 60 * 60 * 24)
          );
          if (daysToEarnings >= 0 && daysToEarnings <= 5) {
            adjustedScore = Math.round(score * 0.70); // 30% discount within 5 days of earnings
          }
        }
        if (adjustedScore < minScore) continue;

        const latest = rows[rows.length - 1];
        const prev   = rows[rows.length - 2];
        const changePct = prev.close > 0 ? ((latest.close - prev.close) / prev.close) * 100 : 0;
        const m = meta.get(symbol);

        results.push({
          symbol,
          name:        m?.name,
          sector:      m?.sector,
          cmp:         latest.close,
          changePct,
          signals,
          signalScore: adjustedScore,
          niftyRegime,
          fii3dNet,
          newsSentimentScore: sentimentScore,
          ...indicators,
        });
      } catch {
        // skip malformed symbol data
      }
    }

    results.sort((a, b) => b.signalScore - a.signalScore);
    progress.found = results.length;
    console.log(`[SIGNALS] Found ${results.length} setups (score ≥ ${minScore})`);

    // AI insights for top N
    const aiLimit = Math.min(aiInsightsLimit, results.length);
    if (aiLimit > 0 && process.env.ANTHROPIC_API_KEY) {
      console.log(`[SIGNALS] Fetching AI insights for top ${aiLimit} stocks...`);
      for (let i = 0; i < aiLimit; i++) {
        const insight = await getAIInsight(results[i]);
        Object.assign(results[i], insight);
        if (i < aiLimit - 1) await new Promise(r => setTimeout(r, 350));
      }
    }

    // Upsert all results into DB (including new accuracy-context columns)
    const upsert = db.prepare(`
      INSERT INTO technical_signals (
        symbol, date, signals_json, signal_score,
        rsi, sma50, sma200, macd, macd_signal, bb_width, volume_ratio, above_sma200,
        adx, nifty_regime, fii_3d_net, news_sentiment_score,
        cmp, change_pct,
        ai_insight, entry_zone, stop_loss, targets, setup_quality, time_horizon,
        computed_at
      ) VALUES (
        @symbol, @date, @signals_json, @signal_score,
        @rsi, @sma50, @sma200, @macd, @macd_signal, @bb_width, @volume_ratio, @above_sma200,
        @adx, @nifty_regime, @fii_3d_net, @news_sentiment_score,
        @cmp, @change_pct,
        @ai_insight, @entry_zone, @stop_loss, @targets, @setup_quality, @time_horizon,
        CURRENT_TIMESTAMP
      )
      ON CONFLICT(symbol, date) DO UPDATE SET
        signals_json=excluded.signals_json, signal_score=excluded.signal_score,
        rsi=excluded.rsi, sma50=excluded.sma50, sma200=excluded.sma200,
        macd=excluded.macd, macd_signal=excluded.macd_signal,
        bb_width=excluded.bb_width, volume_ratio=excluded.volume_ratio,
        above_sma200=excluded.above_sma200,
        adx=excluded.adx, nifty_regime=excluded.nifty_regime, fii_3d_net=excluded.fii_3d_net,
        news_sentiment_score=excluded.news_sentiment_score,
        cmp=excluded.cmp, change_pct=excluded.change_pct,
        ai_insight=excluded.ai_insight, entry_zone=excluded.entry_zone,
        stop_loss=excluded.stop_loss, targets=excluded.targets,
        setup_quality=excluded.setup_quality, time_horizon=excluded.time_horizon,
        computed_at=excluded.computed_at
    `);

    const recLogUpsert = db.prepare(`
      INSERT INTO recommendation_log
        (symbol, rec_type, signal_date, generated_at, entry_price, stop_loss,
         target_1, confidence_score, signal_score, signals_json, nifty_regime,
         win_probability, source, status, horizon_days)
      VALUES (?, 'BUY', ?, CURRENT_TIMESTAMP, ?, ?, ?, ?, ?, ?, ?, ?, 'technical_scan', 'ACTIVE', 5)
      ON CONFLICT DO NOTHING
    `);

    const seedOutcome = db.prepare(`
      INSERT OR IGNORE INTO signal_outcomes
        (symbol, signal_date, horizon_days, entry_price, outcome)
      VALUES (?, ?, ?, ?, 'PENDING')
    `);

    db.transaction((rows: SignalResult[]) => {
      for (const r of rows) {
        upsert.run({
          symbol: r.symbol, date: scanDate,
          signals_json: JSON.stringify(r.signals),
          signal_score: r.signalScore,
          rsi: r.rsi, sma50: r.sma50, sma200: r.sma200,
          macd: r.macd, macd_signal: r.macdSignal,
          bb_width: r.bbWidth, volume_ratio: r.volumeRatio,
          above_sma200: r.aboveSma200 ? 1 : 0,
          adx:          r.adx,
          nifty_regime: r.niftyRegime,
          fii_3d_net:   r.fii3dNet ?? null,
          news_sentiment_score: r.newsSentimentScore ?? 0,
          cmp: r.cmp, change_pct: r.changePct,
          ai_insight:    r.aiInsight    ?? null,
          entry_zone:    r.entryZone    ?? null,
          stop_loss:     r.stopLoss     ?? null,
          targets:       r.targets      ?? null,
          setup_quality: r.setupQuality ?? null,
          time_horizon:  r.timeHorizon  ?? null,
        });

        if (r.signalScore >= 4) {
          const sl = r.stopLoss ? parseFloat(r.stopLoss) : null;
          const t1 = r.targets
            ? (() => {
                const m = r.targets!.match(/₹([\d,]+)/);
                return m ? parseFloat(m[1].replace(/,/g, '')) : null;
              })()
            : null;
          recLogUpsert.run(
            r.symbol, scanDate, r.cmp ?? null, sl, t1,
            r.signalScore, r.signalScore, JSON.stringify(r.signals),
            r.niftyRegime ?? null, (r as any).winProbability ?? null,
          );
          if (r.cmp) {
            seedOutcome.run(r.symbol, scanDate, 5,  r.cmp);
            seedOutcome.run(r.symbol, scanDate, 15, r.cmp);
          }
        }
      }
    })(results);

    console.log(`[SIGNALS] Upserted ${results.length} records for ${scanDate}`);

    if (results.length > 0) await sendTelegramSignals(results, scanDate);

    progress.completedAt = new Date().toISOString();
    progress.isRunning   = false;

  } catch (err) {
    progress.lastError = (err as Error).message;
    progress.isRunning = false;
    console.error('[SIGNALS] Scan failed:', (err as Error).message);
    throw err;
  }
}

// ─── Query Helpers ────────────────────────────────────────────────────────────

export function getTechnicalSignalsForDate(
  date?: string,
  minScore = 1,
  limit = 100
): Record<string, unknown>[] {
  const d = date ?? new Date().toISOString().slice(0, 10);
  return db.prepare(`
    SELECT ts.*, ns.name, ns.sector
    FROM technical_signals ts
    LEFT JOIN nse_stocks ns ON ns.symbol = ts.symbol
    WHERE ts.date = ? AND ts.signal_score >= ?
    ORDER BY ts.signal_score DESC
    LIMIT ?
  `).all(d, minScore, limit) as Record<string, unknown>[];
}

export function getSignalDates(): string[] {
  return (db.prepare(
    `SELECT DISTINCT date FROM technical_signals ORDER BY date DESC LIMIT 30`
  ).all() as { date: string }[]).map(r => r.date);
}

export function getSignalSummary(): {
  totalToday: number;
  bySignalType: Record<string, number>;
  byScore: Record<string, number>;
  lastComputed: string | null;
} {
  const today = new Date().toISOString().slice(0, 10);
  const totalToday = (db.prepare(
    `SELECT COUNT(*) as n FROM technical_signals WHERE date = ?`
  ).get(today) as { n: number }).n;

  const rows = db.prepare(
    `SELECT signals_json, signal_score FROM technical_signals WHERE date = ?`
  ).all(today) as { signals_json: string; signal_score: number }[];

  const bySignalType: Record<string, number> = {};
  const byScore: Record<string, number> = { '1-3': 0, '4-6': 0, '7-10': 0 };

  for (const row of rows) {
    try {
      const sigs = JSON.parse(row.signals_json ?? '[]') as { type: string }[];
      for (const s of sigs) bySignalType[s.type] = (bySignalType[s.type] ?? 0) + 1;
    } catch { /* skip */ }
    if (row.signal_score <= 3)      byScore['1-3']++;
    else if (row.signal_score <= 6) byScore['4-6']++;
    else                            byScore['7-10']++;
  }

  const lastComputed = (db.prepare(
    `SELECT computed_at FROM technical_signals WHERE date = ? ORDER BY computed_at DESC LIMIT 1`
  ).get(today) as { computed_at: string } | undefined)?.computed_at ?? null;

  return { totalToday, bySignalType, byScore, lastComputed };
}

export interface SectorSignalStat {
  sector: string;
  totalSignals: number;
  avgScore: number;
  highScoreCount: number;   // stocks with score >= 7
  topStocks: {
    symbol: string;
    name: string;
    score: number;
    cmp: number;
    changePct: number;
    signalTypes: string[];
  }[];
  hotFlag: boolean;         // sector has 5+ signal stocks today
}

export function getSectorSignalStats(date?: string): SectorSignalStat[] {
  const d = date ?? new Date().toISOString().slice(0, 10);

  const rows = db.prepare(`
    SELECT ts.symbol, ts.signal_score, ts.signals_json, ts.cmp, ts.change_pct,
           ns.name, ns.sector
    FROM technical_signals ts
    LEFT JOIN nse_stocks ns ON ns.symbol = ts.symbol
    WHERE ts.date = ? AND ts.signal_score >= 2 AND ns.sector IS NOT NULL AND ns.sector != ''
    ORDER BY ts.signal_score DESC
  `).all(d) as {
    symbol: string; signal_score: number; signals_json: string;
    cmp: number; change_pct: number; name: string; sector: string;
  }[];

  const bySection = new Map<string, typeof rows>();
  for (const r of rows) {
    if (!bySection.has(r.sector)) bySection.set(r.sector, []);
    bySection.get(r.sector)!.push(r);
  }

  const result: SectorSignalStat[] = [];

  for (const [sector, stocks] of bySection) {
    const avgScore = stocks.reduce((a, s) => a + s.signal_score, 0) / stocks.length;
    const highScoreCount = stocks.filter(s => s.signal_score >= 7).length;

    const topStocks = stocks.slice(0, 5).map(s => {
      let signalTypes: string[] = [];
      try { signalTypes = (JSON.parse(s.signals_json ?? '[]') as { type: string }[]).map(x => x.type); }
      catch { /* skip */ }
      return {
        symbol: s.symbol,
        name: s.name ?? s.symbol,
        score: s.signal_score,
        cmp: s.cmp ?? 0,
        changePct: s.change_pct ?? 0,
        signalTypes,
      };
    });

    result.push({
      sector,
      totalSignals: stocks.length,
      avgScore: Math.round(avgScore * 10) / 10,
      highScoreCount,
      topStocks,
      hotFlag: stocks.length >= 5,
    });
  }

  return result.sort((a, b) => b.totalSignals - a.totalSignals || b.avgScore - a.avgScore);
}

// ─── Signal Type Stats (accuracy backfill) ───────────────────────────────────

export function computeSignalTypeStats(): { updated: number } {
  const outcomes = db.prepare(`
    SELECT so.symbol, so.horizon_days, so.return_pct, so.outcome, so.signals_json,
           ts.nifty_regime
    FROM signal_outcomes so
    LEFT JOIN technical_signals ts ON ts.symbol = so.symbol AND ts.date = so.signal_date
    WHERE so.outcome IN ('WIN', 'LOSS', 'NEUTRAL')
  `).all() as {
    symbol: string; horizon_days: number; return_pct: number;
    outcome: string; signals_json: string; nifty_regime: string | null;
  }[];

  type Acc = { wins: number; total: number; returns: number[] };
  const statsMap = new Map<string, Acc>();

  for (const o of outcomes) {
    let sigs: { type: string }[] = [];
    try { sigs = JSON.parse(o.signals_json ?? '[]'); } catch { continue; }
    const regime = o.nifty_regime ?? 'ALL';

    for (const sig of sigs) {
      for (const reg of ['ALL', regime]) {
        const key = `${sig.type}|${o.horizon_days}|${reg}`;
        if (!statsMap.has(key)) statsMap.set(key, { wins: 0, total: 0, returns: [] });
        const acc = statsMap.get(key)!;
        acc.total++;
        if (o.outcome === 'WIN') acc.wins++;
        if (o.return_pct != null) acc.returns.push(o.return_pct);
      }
    }
  }

  const upsert = db.prepare(`
    INSERT INTO signal_type_stats
      (signal_type, horizon_days, market_regime, total_occurrences, win_count,
       avg_return_pct, median_return_pct, win_rate, last_computed)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(signal_type, horizon_days, market_regime) DO UPDATE SET
      total_occurrences=excluded.total_occurrences, win_count=excluded.win_count,
      avg_return_pct=excluded.avg_return_pct, median_return_pct=excluded.median_return_pct,
      win_rate=excluded.win_rate, last_computed=excluded.last_computed
  `);

  let updated = 0;
  db.transaction(() => {
    for (const [key, acc] of statsMap) {
      if (acc.total < 5) continue;
      const [sigType, horizon, regime] = key.split('|');
      const sorted = [...acc.returns].sort((a, b) => a - b);
      const median = sorted.length > 0 ? sorted[Math.floor(sorted.length / 2)] : 0;
      const avg    = acc.returns.length > 0
        ? acc.returns.reduce((a, b) => a + b, 0) / acc.returns.length : 0;
      upsert.run(sigType, parseInt(horizon), regime, acc.total, acc.wins, avg, median, acc.wins / acc.total);
      updated++;
    }
  })();

  return { updated };
}

export function getSignalTypeStats(horizonDays = 15): Record<string, unknown>[] {
  return db.prepare(`
    SELECT * FROM signal_type_stats
    WHERE horizon_days = ? AND market_regime = 'ALL'
    ORDER BY win_rate DESC, total_occurrences DESC
  `).all(horizonDays) as Record<string, unknown>[];
}

export function getLatestRSIForSymbols(symbols: string[]): Map<string, number> {
  if (symbols.length === 0) return new Map();
  const placeholders = symbols.map(() => '?').join(',');
  
  // Get latest date available in the table
  const latestDateRow = db.prepare('SELECT MAX(date) as d FROM technical_signals').get() as { d: string };
  if (!latestDateRow?.d) return new Map();

  const rows = db.prepare(`
    SELECT symbol, rsi 
    FROM technical_signals 
    WHERE date = ? AND symbol IN (${placeholders})
  `).all(latestDateRow.d, ...symbols) as { symbol: string; rsi: number }[];


  const map = new Map<string, number>();
  for (const r of rows) {
    if (r.rsi != null) map.set(r.symbol, r.rsi);
  }
  return map;
}

