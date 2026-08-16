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

import { dbGet, dbAll, dbRun, dbTransaction } from './dbAsync';
import { wsSignalService } from './websocketService';
import { fetchDeliveryMap } from './deliveryFetcher';
import { getAtrBarriers } from './atrBarriers';

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

export async function getTechnicalSignalCount(): Promise<number> {
  const today = new Date().toISOString().slice(0, 10);
  return ((await dbGet(
    'SELECT COUNT(*) as n FROM technical_signals WHERE date = ?', [today]
  )) as { n: number }).n;
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

// 5-state HMM label (regime_detector.py) -> the 3-state vocabulary the rest of the codebase
// (win-rate lookups, gating, ml_ensemble's REGIME_MAP) understands. HIGH_VOL's mean 21d
// return ranks below SIDEWAYS (see _assign_state_labels' descending-return ordering) and vol
// spikes are typically risk-off, so it collapses to BEAR alongside CRASH rather than SIDEWAYS.
function collapseHmmRegime(hmm: string): 'BULL' | 'BEAR' | 'SIDEWAYS' {
  if (hmm === 'BULL') return 'BULL';
  if (hmm === 'SIDEWAYS') return 'SIDEWAYS';
  return 'BEAR'; // HIGH_VOL | BEAR | CRASH
}

// Nifty50 regime. Prefers the audited 5-state HMM (market_regimes, written causally by
// regime_detector.py) collapsed to this module's 3-state vocabulary; falls back to a crude
// SMA200 heuristic only for dates the HMM hasn't covered yet (market_regimes started
// 2026-05-04) so older historical rescans don't just return a flat default. Before this fix,
// this function computed its OWN SMA200-based regime independently of the HMM — the two
// disagreed ~74% of the time in a spot check (2026-07-19), and this function's (weaker) label
// was what actually fed ml_ensemble training (ts.nifty_regime), not the audited one used for
// win_probability gating (app_settings.current_nifty_regime). See regime_detector.py.
// asOf bounds the lookback so a historical scan sees the regime as it was on the scan date,
// not today's (live scans pass today → the bound is a no-op).
async function computeNiftyRegime(asOf: string): Promise<'BULL' | 'BEAR' | 'SIDEWAYS'> {
  try {
    const hmmRow = await dbAll(
      `SELECT regime FROM market_regimes WHERE date <= ? ORDER BY date DESC LIMIT 1`,
      [asOf]
    ) as { regime: string }[];
    if (hmmRow.length > 0) return collapseHmmRegime(hmmRow[0].regime);
  } catch {
    // market_regimes not populated yet / query failed — fall through to the SMA200 heuristic.
  }

  try {
    const rows = await dbAll(
      `SELECT close FROM stock_ohlcv
       WHERE symbol IN ('NIFTY50','NIFTY','NIFTY 50','^NSEI','INDIA50')
         AND date <= ?
       ORDER BY date DESC LIMIT 210`,
      [asOf]
    ) as { close: number }[];
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

// Load per-signal win rates from signal_type_stats (populated by computeSignalTypeStats).
// asOf bounds a historical rescan to the stats snapshot as it stood on that date, via
// signal_type_stats_history -- signal_type_stats itself is overwrite-in-place (no history),
// so without this bound a rescan of a past date would silently pick up win-rates that were
// only learned after that date. Live scans (asOf omitted or === today) skip the extra
// history lookup and read the current table directly, same as before.
async function loadSignalWinRates(horizonDays = 15, regime: 'BULL' | 'BEAR' | 'SIDEWAYS' | 'ALL' = 'ALL', asOf?: string): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  const today = new Date().toISOString().slice(0, 10);
  const historical = !!asOf && asOf !== today;
  try {
    if (historical) {
      const snap = await dbGet(
        `SELECT MAX(snapshot_date) as d FROM signal_type_stats_history WHERE snapshot_date <= ?`,
        [asOf]
      ) as { d: string | null } | undefined;
      if (!snap?.d) return map; // no snapshot old enough to be safe for this date
      const regimeRows = await dbAll(`
        SELECT signal_type, win_rate FROM signal_type_stats_history
        WHERE snapshot_date = ? AND horizon_days = ? AND market_regime = ? AND total_occurrences >= 10
      `, [snap.d, horizonDays, regime]) as { signal_type: string; win_rate: number }[];
      for (const r of regimeRows) map.set(r.signal_type, r.win_rate);

      const allRows = await dbAll(`
        SELECT signal_type, win_rate FROM signal_type_stats_history
        WHERE snapshot_date = ? AND horizon_days = ? AND market_regime = 'ALL' AND total_occurrences >= 20
      `, [snap.d, horizonDays]) as { signal_type: string; win_rate: number }[];
      for (const r of allRows) {
        if (!map.has(r.signal_type)) map.set(r.signal_type, r.win_rate);
      }
      return map;
    }

    // First try regime-specific rates (require ≥10 samples to be reliable)
    const regimeRows = await dbAll(`
      SELECT signal_type, win_rate FROM signal_type_stats
      WHERE horizon_days = ? AND market_regime = ? AND total_occurrences >= 10
    `, [horizonDays, regime]) as { signal_type: string; win_rate: number }[];
    for (const r of regimeRows) map.set(r.signal_type, r.win_rate);

    // Fall back to 'ALL' for types not yet seen in this regime
    const allRows = await dbAll(`
      SELECT signal_type, win_rate FROM signal_type_stats
      WHERE horizon_days = ? AND market_regime = 'ALL' AND total_occurrences >= 20
    `, [horizonDays]) as { signal_type: string; win_rate: number }[];
    for (const r of allRows) {
      if (!map.has(r.signal_type)) map.set(r.signal_type, r.win_rate);
    }
  } catch { /* table may not be populated yet */ }
  return map;
}

// asOf bounds a historical rescan the same way as loadSignalWinRates above, via
// signal_type_weights_history.
async function loadLearnedWeights(regime: string, asOf?: string): Promise<Map<string, number>> {
  const today = new Date().toISOString().slice(0, 10);
  if (asOf && asOf !== today) {
    const snap = await dbGet(
      `SELECT MAX(snapshot_date) as d FROM signal_type_weights_history WHERE snapshot_date <= ?`,
      [asOf]
    ) as { d: string | null } | undefined;
    if (!snap?.d) return new Map();
    const rows = await dbAll(`
      SELECT signal_type, weight
      FROM signal_type_weights_history
      WHERE snapshot_date = ? AND (regime = ? OR regime = 'ALL') AND sector IN ('ALL', 'Unknown')
      ORDER BY regime DESC
    `, [snap.d, regime]) as { signal_type: string; weight: number }[];
    return new Map(rows.map(r => [r.signal_type, r.weight]));
  }

  const rows = await dbAll(`
    SELECT signal_type, weight
    FROM signal_type_weights
    WHERE (regime = ? OR regime = 'ALL') AND sector IN ('ALL', 'Unknown')
    ORDER BY regime DESC
  `, [regime]) as { signal_type: string; weight: number }[];
  return new Map(rows.map(r => [r.signal_type, r.weight]));
}

// Returns symbol -> nearest upcoming earnings date (YYYY-MM-DD)
async function loadEarningsCalendar(asOf: string): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  try {
    const today = asOf;
    const in30Days = new Date(new Date(asOf).getTime() + 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const rows = await dbAll(`
      SELECT symbol, MAX(ex_date) as next_earnings
      FROM corporate_actions
      WHERE action_type IN ('Quarterly Results', 'Board Meeting', 'Earnings')
        AND ex_date >= ?
        AND ex_date <= ?
      GROUP BY symbol
    `, [today, in30Days]) as { symbol: string; next_earnings: string }[];
    for (const r of rows) map.set(r.symbol, r.next_earnings);
  } catch { /* table may not exist or have no data */ }
  return map;
}

// Load 3-day FII net flow (negative = institutions selling). asOf bounds the lookback so a
// historical scan sees the flow as of the scan date, not today's (live scans pass today).
async function loadFIIFlow3d(asOf: string): Promise<number | null> {
  try {
    const rows = await dbAll(
      `SELECT fii_net FROM fii_dii_flow WHERE date <= ? ORDER BY date DESC LIMIT 3`,
      [asOf]
    ) as { fii_net: number }[];
    if (rows.length === 0) return null;
    return rows.reduce((a, r) => a + (r.fii_net ?? 0), 0);
  } catch {
    return null;
  }
}

// ─── Signal Scoring ───────────────────────────────────────────────────────────

// Signal types with consistently negative historical returns (5d avg < 0, win rate < 30%)
const BLOCKED_SIGNAL_TYPES = new Set<SignalType>([
  'MACD_CROSSOVER',       // avg -1.01%, 21% win rate
  'NR7_COMPRESSION',      // avg -0.57%, 25% win rate
  'SUPERTREND_CROSS',     // avg -0.39%, 19% win rate
  'CONSECUTIVE_STRENGTH', // avg -0.48%, 28% win rate
]);

// "Meaningfully" bullish/bearish news sentiment threshold -- shared between scoreSignals'
// score modifier and runTechnicalSignalScan's news-only persistence gate (2026-08-06).
const NEWS_SENTIMENT_MEANINGFUL_THRESHOLD = 0.25;

/** Whether a news_sentiment_score is strong enough to persist a technical_signals row even
 * when no technical pattern fired that day (2026-08-06 fix). Before this, a symbol with a
 * quiet chart but a real, material news catalyst (confirmed live: CELLO carried a
 * correctly-tagged BULLISH M&A-talk article a full trading day before a +15.69% move) had its
 * sentiment silently discarded regardless of strength, purely because `detectSignals()` found
 * no technical pattern that day. Exported for testing -- the enclosing scan function is
 * DB-heavy orchestration with no existing mock-DB test harness, so this is the extracted,
 * independently-verifiable core of the fix. */
export function isMeaningfulNewsSentiment(sentimentScore: number): boolean {
  return Math.abs(sentimentScore) > NEWS_SENTIMENT_MEANINGFUL_THRESHOLD;
}

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

async function loadRecentNewsSentiment(asOf: string, days = 2): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  try {
    const asOfMs = new Date(asOf).getTime();
    const cutoff = new Date(asOfMs - days * 24 * 60 * 60 * 1000).toISOString();
    // Upper-bound by the scan date + 1d so a historical scan never sees news fetched after it
    // (live scans pass today → this is a no-op).
    const upper = new Date(asOfMs + 24 * 60 * 60 * 1000).toISOString();
    const rows = await dbAll(`
      SELECT symbols_json, sentiment_score
      FROM news_sentiment_items
      WHERE fetched_at >= ? AND fetched_at <= ? AND symbols_json IS NOT NULL AND symbols_json != '' AND symbols_json != '[]'
    `, [cutoff, upper]) as { symbols_json: string; sentiment_score: number }[];

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
  learnedWeights: Map<string, number> = new Map(),
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
    const learned = Math.max(0.3, Math.min(2.0, learnedWeights.get(s.type) ?? 1.0));
    total += base * wrMult * setupDiscount * learned;
  }

  // Nifty regime discount — bull market keeps full score, bear = -40%, sideways = -20%
  const regimeMult = regime === 'BEAR' ? 0.60 : regime === 'SIDEWAYS' ? 0.80 : 1.0;
  total *= regimeMult;

  // FII headwind discount — heavy selling (< -3000 Cr 3-day net) reduces score 15%
  if (fii3dNet != null && fii3dNet < -3000) total *= 0.85;

  // News Sentiment Modifier — highly bullish (>threshold) boosts score 15%, highly bearish
  // (<-threshold) penalizes 25%. Threshold shared with runTechnicalSignalScan's news-only
  // persistence gate below (2026-08-06) -- one source of truth for "meaningfully" bullish/bearish.
  //
  // MEASURED 2026-08-10, AND THIS DIRECTION IS QUESTIONABLE. News sentiment vs return, per-date
  // rank IC on the liquid universe (>=Rs 1cr ADT, winsorised):
  //     SAME DAY   (D open -> D close)          IC +0.1302  t=+6.96   <- strong, but NOT tradeable
  //     NEXT DAY   (D+1 open -> D+2 open)       IC -0.0318  t=-2.03   <- the first tradeable window
  //     NEXT 5 DAY (D+1 open -> D+6 open)       IC -0.0063  t=-0.43
  // Same-day buckets (per-date demeaned): negative -0.540%, neutral -0.143%, positive +0.291%.
  // So positive-news names really do rise ON THE DAY -- that is the market REACTING, and it is
  // not capturable, because an article printing at 2pm cannot be bought at that morning's open.
  // By the first window you can actually trade, the move partially FADES and the sign flips.
  // Both legs of this modifier therefore lean the wrong way for forward returns.
  //
  // Re-measured at the horizons these signals are actually GRADED at (signal_outcomes carries
  // h1/h5/h15 for signal_source='technical'), point-in-time, entry at next open:
  //     h1   IC -0.0434  t=-2.53      <- significantly NEGATIVE
  //     h5   IC -0.0091  t=-0.52      <- nothing
  //     h15  IC -0.0015  t=-0.10      <- nothing
  // h5 buckets (per-date demeaned): bearish +0.062, neutral +0.062, bullish -0.088.
  // So NO horizon this signal is graded at supports a bullish BOOST, and the strongest
  // relationship is against it.
  //
  // Then swept the multiplier itself against realised returns rather than picking a value:
  // back the live 1.15/0.75 out of the stored signal_score, re-apply each candidate, and rank
  // (28,613 rows / 41 dates / 1,230 symbols, liquid, winsorised, next-open entry):
  //
  //     setting              h5 IC      h15 IC
  //     1.30 / 0.60         -0.0068     +0.0128     <- strongest tilt, WORST at both horizons
  //     1.15 / 0.75 (live)  -0.0059     +0.0137
  //     1.075/ 0.875        -0.0050     +0.0146
  //     1.00 / 1.00         -0.0050     +0.0145     <- neutral
  //     0.875/ 1.075        -0.0050     +0.0146     <- inverted, NOT better than neutral
  //
  // IC degrades MONOTONICALLY with tilt strength at both horizons, and neutral / shrunk /
  // inverted are indistinguishable from each other. So the gain comes entirely from REMOVING
  // the tilt, not from reversing it -- news sentiment carries no usable directional
  // information for this score at the horizons these signals are graded at. An intermediate
  // shrink was tried first and measured identical to neutral, i.e. it was preserving a
  // mechanism with no support at any magnitude. Removed.
  //
  // NOTE the threshold constant is deliberately NOT removed: it still gates the news-only
  // PERSISTENCE path in runTechnicalSignalScan (whether a row is worth storing at all), which
  // is a coverage decision, not a directional one, and was measured separately.
  // What could still change this: splitting genuinely material news (M&A, results shocks)
  // from routine coverage. The aggregate mixes them and would wash a real event effect out.
  // Do not reinstate a blanket multiplier -- build the split and measure that instead.

  return Math.min(Math.round(total), 10);
}

// ─── Signal Detection ─────────────────────────────────────────────────────────

function detectSignals(rows: OHLCVRow[], symbol = '', latestPcr?: number | null): {
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
  // (latestPcr is pre-loaded once per scan into a symbol->pcr map to avoid an N+1 query)
  if (symbol) {
    if (latestPcr != null) {
      const pcr = latestPcr;
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
    signals: signals.filter(s => !BLOCKED_SIGNAL_TYPES.has(s.type)),
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

// ─── Trading Setup (deterministic, no LLM) ────────────────────────────────────
// REPLACED 2026-08-13: this used to call Anthropic to have an LLM invent entry_zone/
// stop_loss/targets from a text prompt. ANTHROPIC_API_KEY has been empty since inception, so
// it silently never ran (0/69,459 technical_signals rows ever got these columns populated) --
// found via a fetcher-accuracy-review sweep. Investigated the fix: this codebase already has
// a MEASURED reason not to bring an LLM back for this at all -- atrBarriers.ts's own comment:
// "The AI path previously stored the LLM's hallucinated price levels, which had no relation
// to a stock's realized range -- so ~76% of AI signals expired NEUTRAL (target unreachable
// in-horizon) while stops still fired, i.e. structurally negative expectancy despite a
// 55%-accurate model." getAtrBarriers() is the fix that was already built for that exact
// failure, elsewhere in this codebase -- reused here rather than re-adding the same bug.
// A local Ollama option was considered and rejected: this box has 23GB RAM at 95%+ used
// (1.1GB free measured live), and the configured models (mistral ~4-5GB resident, qwen3:30b
// ~18-20GB) would push it into swap. The narrative text (`insight`) has no deterministic
// equivalent and is dropped -- its only consumer was one conditional UI block that has never
// rendered anyway (aiInsight has been empty since inception), so nothing user-visible changes
// beyond entry_zone/stop_loss/targets/setup_quality/time_horizon going from always-blank to
// always-populated.
const TREND_SIGNAL_TYPES = new Set<SignalType>([
  'GOLDEN_CROSS', 'WEEK_52_BREAKOUT', 'EMA_BULL_STACK', 'CONSECUTIVE_STRENGTH', 'NEAR_52W_HIGH',
]);
// BEARISH_SIGNAL_TYPES is defined once, below, near sendTelegramSignals (its other consumer).

// Pure helpers, exported for direct unit testing (no DB) -- getTradingSetup below is a thin
// I/O wrapper (getAtrBarriers hits stock_ohlcv) around these.

/** This scanner's signal set is overwhelmingly bullish-oriented (breakouts, golden cross,
 *  oversold recovery, ...), but DEATH_CROSS/RSI_BEARISH_DIVERGENCE/DISTRIBUTION_DAY exist too
 *  -- majority-vote among what actually fired, defaulting long on a tie or no signals. */
export function inferSetupDirection(signals: TechSignal[]): 'long' | 'short' {
  const bearishCount = signals.filter(s => BEARISH_SIGNAL_TYPES.has(s.type)).length;
  return bearishCount > signals.length / 2 ? 'short' : 'long';
}

/** Strongest signal that actually fired -- reuses the strength classification detectSignals()
 *  already computed, rather than re-deriving thresholds on signalScore (whose scale is
 *  regime/win-rate/news-adjusted and not a stable 0-100 range). */
export function deriveSetupQuality(signals: TechSignal[]): 'High' | 'Medium' | 'Low' {
  if (signals.some(s => s.strength === 'HIGH')) return 'High';
  if (signals.some(s => s.strength === 'MEDIUM')) return 'Medium';
  return 'Low';
}

/** Trend/structural signals (golden cross, 52w breakout, EMA stack) play out over weeks;
 *  everything else (momentum/volatility triggers) is a shorter swing. A simple heuristic, not
 *  a measured one -- tighten if this is ever backtested against real holding periods. */
export function deriveTimeHorizon(signals: TechSignal[]): 'Positional (2-4W)' | 'Swing (3-7D)' {
  return signals.some(s => TREND_SIGNAL_TYPES.has(s.type)) ? 'Positional (2-4W)' : 'Swing (3-7D)';
}

export async function getTradingSetup(r: SignalResult): Promise<{
  aiInsight: string; entryZone: string; stopLoss: string;
  targets: string; setupQuality: string; timeHorizon: string;
}> {
  const empty = { aiInsight: '', entryZone: '', stopLoss: '', targets: '', setupQuality: '', timeHorizon: '' };
  if (r.signals.length === 0) return empty;

  const direction = inferSetupDirection(r.signals);
  const barriers = await getAtrBarriers(r.symbol, r.cmp, direction);
  if (!barriers) return empty;

  const money = (n: number) => `₹${n.toFixed(2)}`;
  const bandFrac = 0.01; // ±1% around entry, same rough magnitude the old prompt asked for
  const entryLow = barriers.entryPrice * (1 - bandFrac);
  const entryHigh = barriers.entryPrice * (1 + bandFrac);

  return {
    aiInsight: '',
    entryZone: `${money(entryLow)} – ${money(entryHigh)}`,
    stopLoss: money(barriers.stopLoss),
    targets: money(barriers.targetPrice),
    setupQuality: deriveSetupQuality(r.signals),
    timeHorizon: deriveTimeHorizon(r.signals),
  };
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

const BEARISH_SIGNAL_TYPES = new Set<SignalType>([
  'DEATH_CROSS', 'RSI_BEARISH_DIVERGENCE', 'DISTRIBUTION_DAY',
]);

async function sendTelegramSignals(results: SignalResult[], date: string): Promise<void> {
  const token  = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return;

  const buySignals = results.filter(r =>
    (r.winProbability ?? 0) >= 0.85 &&
    r.signals.every(s => !BEARISH_SIGNAL_TYPES.has(s.type))
  );
  if (buySignals.length === 0) return;

  let body = '';
  for (const r of buySignals.slice(0, 6)) {
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
      signal: AbortSignal.timeout(10000),
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
    const niftyRegime      = await computeNiftyRegime(scanDate);
    const winRates         = await loadSignalWinRates(15, niftyRegime, scanDate);
    const learnedWeights   = await loadLearnedWeights(niftyRegime, scanDate);
    const fii3dNet         = await loadFIIFlow3d(scanDate);
    const earningsCalendar = await loadEarningsCalendar(scanDate);
    const newsSentiment    = await loadRecentNewsSentiment(scanDate, 2); // 48h of news as of scan date
    console.log(`[SIGNALS] Regime: ${niftyRegime} | Win-rate records: ${winRates.size} | FII 3d: ${fii3dNet ?? 'N/A'} Cr | News Sentiment: ${newsSentiment.size} stocks | Earnings watchlist: ${earningsCalendar.size}`);

    // Pre-load latest PCR per symbol once (was an N+1 query inside detectSignals).
    // Bound by scanDate so a historical rescan doesn't pull a PCR snapshot that postdates
    // the date being scanned (mirrors the OHLCV bound just below).
    const pcrLatestMap = new Map<string, number>();
    (await dbAll(`
      SELECT symbol, pcr FROM (
        SELECT symbol, pcr, ROW_NUMBER() OVER (PARTITION BY symbol ORDER BY date DESC) AS rn
        FROM stock_options_oi
        WHERE date <= ?
      ) t WHERE rn = 1
    `, [scanDate]) as { symbol: string; pcr: number }[]).forEach(r => { if (r.pcr != null) pcrLatestMap.set(r.symbol, r.pcr); });

    console.log('[SIGNALS] Loading OHLCV data...');
    // Bound by scanDate so a historical scan (options.date in the past) never sees future
    // bars — every other feature read in this function is already scanDate-bounded. For a
    // live scan scanDate is today, so the upper bound is a no-op there.
    //
    // Fixed 2026-07-30 (Finding #34, full-stack audit): the query had no LOWER date bound,
    // so it pulled the entire multi-year stock_ohlcv table (2.57M+ rows back to 2021) into
    // Node memory every ~30-min scan cycle, even though detectSignals() below only needs
    // ~200-250 trailing days per symbol (SMA200 is the longest lookback used). 300 calendar
    // days is a generous buffer over 200 trading days (accounts for weekends/holidays).
    const lowerBoundDate = new Date(new Date(scanDate).getTime() - 300 * 86_400_000).toISOString().slice(0, 10);
    const allRows = await dbAll(
      `SELECT symbol, date, open, high, low, close, volume FROM stock_ohlcv WHERE date <= ? AND date >= ? ORDER BY symbol, date ASC`,
      [scanDate, lowerBoundDate]
    ) as (OHLCVRow & { symbol: string })[];

    // Group by symbol
    const bySymbol = new Map<string, OHLCVRow[]>();
    for (const r of allRows) {
      if (!bySymbol.has(r.symbol)) bySymbol.set(r.symbol, []);
      bySymbol.get(r.symbol)!.push(r);
    }

    // Load stock names + sectors
    const meta = new Map<string, { name: string; sector: string }>();
    (await dbAll('SELECT symbol, name, sector FROM nse_stocks') as
      { symbol: string; name: string; sector: string }[])
      .forEach(r => meta.set(r.symbol, { name: r.name, sector: r.sector }));

    const eligible = [...bySymbol.entries()].filter(([, rows]) => rows.length >= 22);
    progress.totalSymbols = eligible.length;

    console.log(`[SIGNALS] Scanning ${eligible.length} symbols for patterns...`);

    const results: SignalResult[] = [];

    for (const [symbol, rows] of eligible) {
      try {
        const { signals, ...indicators } = detectSignals(rows, symbol, pcrLatestMap.get(symbol) ?? null);
        progress.processed++;

        const sentimentScore = newsSentiment.get(symbol) ?? 0;
        // 2026-08-06: news sentiment used to be computed AFTER `if (signals.length === 0)
        // continue` -- so a stock with an unremarkable chart that day but a real, material
        // news catalyst (confirmed live: CELLO carried a correctly-tagged BULLISH M&A-talk
        // article a full trading day before a +15.69% move) had its sentiment silently
        // discarded, regardless of strength. hasMeaningfulNews lets such a symbol through the
        // signal-count/score gates below with signalScore=0 and signals=[] purely so
        // news_sentiment_score (and the technical indicators detectSignals() already computed
        // above either way) land in technical_signals -- it does NOT create a trade signal:
        // the downstream `signalScore > 0`/`>= 5` blocks (unified_signals mirror, WS broadcast,
        // recommendation_log) all correctly no-op at signalScore=0.
        const hasMeaningfulNews = isMeaningfulNewsSentiment(sentimentScore);

        if (signals.length === 0 && !hasMeaningfulNews) continue;
        const score = signals.length > 0
          ? scoreSignals(signals, winRates, niftyRegime, fii3dNet, sentimentScore, learnedWeights)
          : 0;
        if (score < minScore && !hasMeaningfulNews) continue;

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
        if (adjustedScore < minScore && !hasMeaningfulNews) continue;

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
    // signalScore===0 entries are news-only persistence rows (see hasMeaningfulNews above),
    // not real setups -- keep progress.found honest about what was actually a signal, since
    // this codebase's monitoring has repeatedly been burned by a count that looks fine but
    // doesn't reflect what actually happened.
    const realSetups = results.filter(r => r.signalScore > 0).length;
    const newsOnlyRows = results.length - realSetups;
    progress.found = realSetups;
    console.log(`[SIGNALS] Found ${realSetups} setups (score ≥ ${minScore})`
      + (newsOnlyRows > 0 ? `, +${newsOnlyRows} news-only rows persisted (no technical signal)` : ''));

    // Trading setup (entry/stop/target/quality/horizon) for top N -- bounded by realSetups,
    // not results.length, so a quiet day with few real setups doesn't compute it for score=0
    // news-only rows. Deterministic (getTradingSetup, see its own comment) -- no rate limit
    // to respect, so no artificial delay between rows either.
    const aiLimit = Math.min(aiInsightsLimit, realSetups);
    if (aiLimit > 0) {
      for (let i = 0; i < aiLimit; i++) {
        const setup = await getTradingSetup(results[i]);
        Object.assign(results[i], setup);
      }
    }

    // FII/DII rolling helper — market-wide, computed once outside the transaction
    async function getFiiDiiRolling(date: string): Promise<{ fii_10d_net: number | null; dii_3d_net: number | null }> {
      const fii10 = await dbGet(`
        SELECT SUM(f.fii_net) AS total
        FROM (SELECT fii_net FROM fii_dii_flow WHERE date <= ? ORDER BY date DESC LIMIT 10) f
      `, [date]) as { total: number | null } | undefined;

      const dii3 = await dbGet(`
        SELECT SUM(f.dii_net) AS total
        FROM (SELECT dii_net FROM fii_dii_flow WHERE date <= ? ORDER BY date DESC LIMIT 3) f
      `, [date]) as { total: number | null } | undefined;

      return {
        fii_10d_net: fii10?.total ?? null,
        dii_3d_net:  dii3?.total  ?? null,
      };
    }

    // Sector relative momentum helper — cached per sector+date within one scan run
    const sectorMomentumCache = new Map<string, { ret5: number | null; ret21: number | null }>();

    async function getSectorMomentum(sector: string | null, date: string): Promise<{ sector_ret_5d: number | null; sector_ret_21d: number | null }> {
      if (!sector) return { sector_ret_5d: null, sector_ret_21d: null };
      const key = `${sector}:${date}`;
      const cached = sectorMomentumCache.get(key);
      if (cached) return { sector_ret_5d: cached.ret5, sector_ret_21d: cached.ret21 };

      const row5 = await dbGet(`
        SELECT AVG((today.close - past.close) / past.close * 100.0) AS ret
        FROM stock_ohlcv today
        JOIN nse_stocks ns ON ns.symbol = today.symbol
        JOIN (
          SELECT o.symbol, o.close
          FROM stock_ohlcv o
          WHERE o.date = (
            SELECT date FROM stock_ohlcv WHERE symbol = o.symbol AND date < ? ORDER BY date DESC LIMIT 1 OFFSET 4
          )
        ) past ON past.symbol = today.symbol
        WHERE ns.sector = ?
          AND today.date = ?
      `, [date, sector, date]) as { ret: number | null } | undefined;

      const row21 = await dbGet(`
        SELECT AVG((today.close - past.close) / past.close * 100.0) AS ret
        FROM stock_ohlcv today
        JOIN nse_stocks ns ON ns.symbol = today.symbol
        JOIN (
          SELECT o.symbol, o.close
          FROM stock_ohlcv o
          WHERE o.date = (
            SELECT date FROM stock_ohlcv WHERE symbol = o.symbol AND date < ? ORDER BY date DESC LIMIT 1 OFFSET 20
          )
        ) past ON past.symbol = today.symbol
        WHERE ns.sector = ?
          AND today.date = ?
      `, [date, sector, date]) as { ret: number | null } | undefined;

      const result = { ret5: row5?.ret ?? null, ret21: row21?.ret ?? null };
      sectorMomentumCache.set(key, result);
      return { sector_ret_5d: result.ret5, sector_ret_21d: result.ret21 };
    }

    // Compute FII/DII rolling values once before the transaction
    const { fii_10d_net, dii_3d_net } = await getFiiDiiRolling(scanDate);
    const deliveryMap = await fetchDeliveryMap(scanDate);

    // Pre-fetch sector for each symbol in one query
    const symbolsInScan = results.map(r => r.symbol);
    const sectorRows = symbolsInScan.length
      ? (await dbAll(
          `SELECT symbol, sector FROM nse_stocks WHERE symbol IN (${symbolsInScan.map(() => '?').join(',')})`,
          symbolsInScan
        ) as { symbol: string; sector: string | null }[])
      : [];
    const symbolSectorMap = new Map(sectorRows.map(r => [r.symbol, r.sector ?? null]));

    // Pre-fetch market caps to filter micro-caps (< ₹500 Cr)
    const mcRows = symbolsInScan.length
      ? (await dbAll(
          `SELECT symbol, market_cap FROM stock_fundamentals WHERE symbol IN (${symbolsInScan.map(() => '?').join(',')})`,
          symbolsInScan
        ) as { symbol: string; market_cap: number | null }[])
      : [];
    const marketCapMap = new Map(mcRows.map(r => [r.symbol, r.market_cap]));
    const MIN_MARKET_CAP = 5e9; // ₹500 crore

    // Pre-fetch latest PCR per symbol in one windowed query (was one lookup per result).
    const pcrRows = symbolsInScan.length
      ? (await dbAll(
          `SELECT symbol, pcr AS pcr_oi, market_pcr AS pcr_vol FROM (
             SELECT symbol, pcr, market_pcr,
                    ROW_NUMBER() OVER (PARTITION BY symbol ORDER BY date DESC) AS rn
             FROM stock_options_oi
             WHERE date <= ? AND symbol IN (${symbolsInScan.map(() => '?').join(',')})
           ) t WHERE rn = 1`,
          [scanDate, ...symbolsInScan]
        ) as { symbol: string; pcr_oi: number | null; pcr_vol: number | null }[])
      : [];
    const pcrMap = new Map(pcrRows.map(r => [r.symbol, { pcr_oi: r.pcr_oi ?? null, pcr_vol: r.pcr_vol ?? null }]));

    // Pre-fetch quant_scores.rank_composite for recommendation_log.quant_score (2026-08-07,
    // dead-column sweep -- see recLogUpsertSql below for the fuller writeup).
    const quantRows = symbolsInScan.length
      ? (await dbAll(
          // quant_scores is keyed PRIMARY KEY (symbol) -- one row per symbol, no date column.
          // The latest-per-symbol window this used to carry referenced a `date` that does not
          // exist, throwing on every scan from 2026-08-10 and aborting the whole write.
          `SELECT symbol, rank_composite FROM quant_scores
           WHERE rank_composite IS NOT NULL AND symbol IN (${symbolsInScan.map(() => '?').join(',')})`,
          symbolsInScan
        ) as { symbol: string; rank_composite: number | null }[])
      : [];
    const quantMap = new Map(quantRows.map(r => [r.symbol, r.rank_composite]));

    // Pre-fetch symbols that already have an ACTIVE technical_scan signal (was one lookup per result).
    const activeRows = await dbAll(
      `SELECT DISTINCT symbol FROM recommendation_log WHERE status = 'ACTIVE' AND source = 'technical_scan'`
    ) as { symbol: string }[];
    const activeSet = new Set(activeRows.map(r => r.symbol));

    // Upsert all results into DB (including new accuracy-context columns)
    const upsertSql = `
      INSERT INTO technical_signals (
        symbol, date, signals_json, signal_score,
        rsi, sma50, sma200, macd, macd_signal, bb_width, volume_ratio, above_sma200,
        adx, nifty_regime, fii_3d_net, news_sentiment_score,
        pcr_oi, pcr_vol, fii_10d_net, dii_3d_net,
        cmp, change_pct, delivery_pct,
        sector_ret_5d, sector_ret_21d,
        ai_insight, entry_zone, stop_loss, targets, setup_quality, time_horizon,
        computed_at
      ) VALUES (
        ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?, ?,
        ?, ?,
        ?, ?, ?, ?, ?, ?,
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
        pcr_oi=excluded.pcr_oi, pcr_vol=excluded.pcr_vol,
        fii_10d_net=excluded.fii_10d_net, dii_3d_net=excluded.dii_3d_net,
        cmp=excluded.cmp, change_pct=excluded.change_pct, delivery_pct=excluded.delivery_pct,
        sector_ret_5d=excluded.sector_ret_5d, sector_ret_21d=excluded.sector_ret_21d,
        ai_insight=excluded.ai_insight, entry_zone=excluded.entry_zone,
        stop_loss=excluded.stop_loss, targets=excluded.targets,
        setup_quality=excluded.setup_quality, time_horizon=excluded.time_horizon,
        computed_at=excluded.computed_at
    `;

    // target_2/target_3/quant_score/sentiment_score fix (2026-08-07, dead-column sweep): none
    // of recommendation_log's 3 writers ever populated these 4 columns (confirmed live,
    // 23,874/23,874 rows). target_2/target_3 extend target_1's own excess-over-entry move
    // again (2x/3x) rather than a new ATR-multiplier formula. sentiment_score reuses
    // r.newsSentimentScore, already computed above for the technical_signals upsert;
    // quant_score comes from the new quantMap pre-fetch above (same pattern as pcrMap/
    // marketCapMap/sectorRows already established in this function).
    const recLogUpsertSql = `
      INSERT INTO recommendation_log
        (symbol, rec_type, signal_date, generated_at, entry_price, stop_loss,
         target_1, target_2, target_3, confidence_score, signal_score, signals_json,
         nifty_regime, win_probability, quant_score, sentiment_score,
         source, status, horizon_days)
      VALUES (?, 'BUY', ?, CURRENT_TIMESTAMP, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'technical_scan', 'ACTIVE', 5)
      ON CONFLICT DO NOTHING
    `;

    // signal_source='technical' (2026-08): must match what outcome_resolver.py /
    // signalOutcomesService.ts later UPSERT with (ON CONFLICT symbol, signal_date,
    // horizon_days, signal_source) -- seeding at the default 'unknown' would make the
    // resolver's UPDATE target a different 4-col key, silently leaving this PENDING row
    // stuck forever while a second, separate 'technical' row gets created alongside it.
    const seedOutcomeSql = `
      INSERT OR IGNORE INTO signal_outcomes
        (symbol, signal_date, horizon_days, entry_price, outcome, signal_source)
      VALUES (?, ?, ?, ?, 'PENDING', 'technical')
    `;

    const unifiedUpsertSql = `
      INSERT INTO unified_signals
        (symbol, signal_date, signal_source, signal_type,
         entry_price, target_price, stop_loss, confidence_score,
         reasoning, technical_score, status, signal_generated_at)
      -- 'technical_scan', not 'TECHNICAL' (2026-08-12): technical_analysis_engine.py writes
      -- 'technical' to this same column, and two sources differing only by case is a trap --
      -- reward_engine.py's exclusion list had already fallen through it. Matches the 'source'
      -- this same function writes to recommendation_log. Renamed in history by migration
      -- 1786930000000; grep BOTH spellings before adding a consumer.
      VALUES (?, current_date, 'technical_scan', 'BUY', ?, ?, ?, ?, ?, ?, 'ACTIVE', ?)
      ON CONFLICT(symbol, signal_source, signal_type, signal_date) DO UPDATE SET
        entry_price=excluded.entry_price,
        technical_score=excluded.technical_score,
        confidence_score=excluded.confidence_score
        -- signal_generated_at deliberately NOT refreshed (2026-08-12). This scan re-runs every
        -- 30 min from 03:00 UTC, so refreshing it walked the 03:00 pre-market stamp forward to
        -- the last intraday run: only 6 of 5,922 rows still looked pre-market, and 57% ended up
        -- with a signal_generated_at LATER than their own created_at. First write wins.
    `;

    // Resolve per-symbol pcr/sector momentum BEFORE the write transaction so the tx body
    // only writes (keeps the PG transaction short and avoids cross-connection reads mid-tx).
    const enriched = [] as Array<{
      r: SignalResult; pcr_oi: number | null; pcr_vol: number | null;
      sector_ret_5d: number | null; sector_ret_21d: number | null;
    }>;
    for (const r of results) {
      const mc = marketCapMap.get(r.symbol);
      if (mc !== null && mc !== undefined && mc < MIN_MARKET_CAP) continue; // skip micro-caps
      const { pcr_oi, pcr_vol } = pcrMap.get(r.symbol) ?? { pcr_oi: null, pcr_vol: null };
      const sector = symbolSectorMap.get(r.symbol) ?? null;
      const { sector_ret_5d, sector_ret_21d } = await getSectorMomentum(sector, scanDate);
      enriched.push({ r, pcr_oi, pcr_vol, sector_ret_5d, sector_ret_21d });
    }

    await dbTransaction(async (tx) => {
      for (const { r, pcr_oi, pcr_vol, sector_ret_5d, sector_ret_21d } of enriched) {
        // Skip if stock already has an ACTIVE signal in recommendation_log
        if (activeSet.has(r.symbol)) continue;

        await tx.run(upsertSql, [
          r.symbol, scanDate,
          JSON.stringify(r.signals),
          r.signalScore,
          r.rsi, r.sma50, r.sma200,
          r.macd, r.macdSignal,
          r.bbWidth, r.volumeRatio,
          r.aboveSma200 ? 1 : 0,
          r.adx,
          r.niftyRegime,
          r.fii3dNet ?? null,
          r.newsSentimentScore ?? 0,
          pcr_oi,
          pcr_vol,
          fii_10d_net,
          dii_3d_net,
          r.cmp, r.changePct,
          deliveryMap.get(r.symbol) ?? null,
          sector_ret_5d,
          sector_ret_21d,
          r.aiInsight    ?? null,
          r.entryZone    ?? null,
          r.stopLoss     ?? null,
          r.targets      ?? null,
          r.setupQuality ?? null,
          r.timeHorizon  ?? null,
        ]);

        // Mirror actionable signals to unified_signals for cross-source tracking
        if (r.signalScore > 0) {
          const signalTs = new Date().toISOString();
          const slNumeric = r.stopLoss
            ? (() => { const m = r.stopLoss!.match(/[\d,]+(?:\.\d+)?/); return m ? parseFloat(m[0].replace(/,/g, '')) : null; })()
            : null;
          await tx.run(unifiedUpsertSql, [
            r.symbol,
            r.cmp ?? null,
            null,                        // target_price — not computed by technical scanner
            slNumeric,
            r.signalScore * 10.0,        // 0–10 score → 0–100 confidence (db.ts: "0-100, from
                                         // any source"). Was /10.0, which put this writer on a
                                         // 0–1 scale in a column the AI path fills 0–100.
            JSON.stringify(r.signals) ?? null,
            r.signalScore,
            signalTs,
          ]);
          try {
            wsSignalService.broadcastNewSignal({
              type: 'new_signal',
              symbol: r.symbol,
              timestamp: signalTs,
              price: r.cmp ?? undefined,
              source: 'technical_scan',
              generatedAt: signalTs,
            });
          } catch {
            // broadcast is best-effort; never fail the scan
          }
        }

        if (r.signalScore >= 5) {
          // Fix 4: In BEAR regime, only log high-conviction signals (score >= 7)
          if (r.niftyRegime === 'BEAR' && r.signalScore < 7) continue;

          const sl = r.stopLoss ? parseFloat(r.stopLoss) : null;
          const t1 = r.targets
            ? (() => {
                const m = r.targets!.match(/₹([\d,]+)/);
                return m ? parseFloat(m[1].replace(/,/g, '')) : null;
              })()
            : null;
          const t2 = (t1 !== null && r.cmp) ? Math.round((r.cmp + 2 * (t1 - r.cmp)) * 100) / 100 : null;
          const t3 = (t1 !== null && r.cmp) ? Math.round((r.cmp + 3 * (t1 - r.cmp)) * 100) / 100 : null;
          await tx.run(recLogUpsertSql, [
            r.symbol, scanDate, r.cmp ?? null, sl, t1, t2, t3,
            r.signalScore, r.signalScore, JSON.stringify(r.signals),
            r.niftyRegime ?? null, (r as any).winProbability ?? null,
            quantMap.get(r.symbol) ?? null, r.newsSentimentScore ?? null,
          ]);
          if (r.cmp) {
            await tx.run(seedOutcomeSql, [r.symbol, scanDate, 5,  r.cmp]);
            await tx.run(seedOutcomeSql, [r.symbol, scanDate, 15, r.cmp]);
          }
        }
      }
    });

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

export async function getTechnicalSignalsForDate(
  date?: string,
  minScore = 1,
  minWinProbability = 0,
  limit = 100
): Promise<Record<string, unknown>[]> {
  let d = date;
  if (!d) {
    const maxRow = await dbGet<{ d: string }>('SELECT MAX(date) as d FROM technical_signals');
    d = maxRow?.d ?? new Date().toISOString().slice(0, 10);
  }
  // Ranks and filters on COALESCE(calibrated_win_probability, win_probability) — was raw
  // win_probability unconditionally, inconsistent with scoring_engine.py/unified_ranker, which
  // already prefer the regime-fair calibrated value (2026-07-18 gating follow-up).
  return await dbAll(`
    SELECT ts.*,
           ns.name,
           ns.sector,
           ROUND(ts.signal_score * (0.5 + COALESCE(ts.calibrated_win_probability, ts.win_probability, 0.5)), 2) AS effective_score
    FROM technical_signals ts
    LEFT JOIN nse_stocks ns ON ns.symbol = ts.symbol
    WHERE ts.date = ?
      AND ts.signal_score >= ?
      AND (ts.win_probability IS NULL OR COALESCE(ts.calibrated_win_probability, ts.win_probability) >= ?)
    ORDER BY effective_score DESC, ts.signal_score DESC
    LIMIT ?
  `, [d, minScore, minWinProbability, limit]) as Record<string, unknown>[];
}

export async function getSignalDates(): Promise<string[]> {
  return ((await dbAll(
    `SELECT DISTINCT date FROM technical_signals ORDER BY date DESC LIMIT 30`
  )) as { date: string }[]).map(r => r.date);
}

export async function getSignalSummary(): Promise<{
  totalToday: number;
  bySignalType: Record<string, number>;
  byScore: Record<string, number>;
  lastComputed: string | null;
}> {
  let today = new Date().toISOString().slice(0, 10);
  const maxRow = await dbGet<{ d: string }>('SELECT MAX(date) as d FROM technical_signals');
  if (maxRow?.d) {
    today = maxRow.d;
  }
  const totalToday = ((await dbGet(
    `SELECT COUNT(*) as n FROM technical_signals WHERE date = ?`, [today]
  )) as { n: number }).n;

  const rows = await dbAll(
    `SELECT signals_json, signal_score FROM technical_signals WHERE date = ?`, [today]
  ) as { signals_json: string; signal_score: number }[];

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

  const lastComputed = ((await dbGet(
    `SELECT computed_at FROM technical_signals WHERE date = ? ORDER BY computed_at DESC LIMIT 1`, [today]
  )) as { computed_at: string } | undefined)?.computed_at ?? null;

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

export async function getSectorSignalStats(date?: string): Promise<SectorSignalStat[]> {
  let d = date;
  if (!d) {
    const maxRow = await dbGet<{ d: string }>('SELECT MAX(date) as d FROM technical_signals');
    d = maxRow?.d ?? new Date().toISOString().slice(0, 10);
  }

  const rows = await dbAll(`
    SELECT ts.symbol, ts.signal_score, ts.signals_json, ts.cmp, ts.change_pct,
           ns.name, ns.sector
    FROM technical_signals ts
    LEFT JOIN nse_stocks ns ON ns.symbol = ts.symbol
    WHERE ts.date = ? AND ts.signal_score >= 2 AND ns.sector IS NOT NULL AND ns.sector != ''
    ORDER BY ts.signal_score DESC
  `, [d]) as {
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

export async function computeSignalTypeStats(): Promise<{ updated: number }> {
  const outcomes = await dbAll(`
    SELECT so.symbol, so.horizon_days, so.return_pct, so.outcome, so.signals_json,
           ts.nifty_regime
    FROM signal_outcomes so
    LEFT JOIN technical_signals ts ON ts.symbol = so.symbol AND ts.date = so.signal_date
    WHERE so.outcome IN ('WIN', 'LOSS', 'NEUTRAL') AND so.signal_source = 'technical'
  `) as {
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

  const upsertSql = `
    INSERT INTO signal_type_stats
      (signal_type, horizon_days, market_regime, total_occurrences, win_count,
       avg_return_pct, median_return_pct, win_rate, last_computed)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(signal_type, horizon_days, market_regime) DO UPDATE SET
      total_occurrences=excluded.total_occurrences, win_count=excluded.win_count,
      avg_return_pct=excluded.avg_return_pct, median_return_pct=excluded.median_return_pct,
      win_rate=excluded.win_rate, last_computed=excluded.last_computed
  `;
  // Append-only daily trail (idempotent per day) so a historical rescan can read win-rates
  // as they stood on that scan date instead of always the latest -- see loadSignalWinRates.
  const historySql = `
    INSERT INTO signal_type_stats_history
      (snapshot_date, signal_type, horizon_days, market_regime, total_occurrences, win_count,
       avg_return_pct, median_return_pct, win_rate)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(snapshot_date, signal_type, horizon_days, market_regime) DO UPDATE SET
      total_occurrences=excluded.total_occurrences, win_count=excluded.win_count,
      avg_return_pct=excluded.avg_return_pct, median_return_pct=excluded.median_return_pct,
      win_rate=excluded.win_rate
  `;
  const snapshotDate = new Date().toISOString().slice(0, 10);

  let updated = 0;
  await dbTransaction(async (tx) => {
    for (const [key, acc] of statsMap) {
      if (acc.total < 5) continue;
      const [sigType, horizon, regime] = key.split('|');
      const sorted = [...acc.returns].sort((a, b) => a - b);
      const median = sorted.length > 0 ? sorted[Math.floor(sorted.length / 2)] : 0;
      const avg    = acc.returns.length > 0
        ? acc.returns.reduce((a, b) => a + b, 0) / acc.returns.length : 0;
      const winRate = acc.wins / acc.total;
      await tx.run(upsertSql, [sigType, parseInt(horizon), regime, acc.total, acc.wins, avg, median, winRate]);
      await tx.run(historySql, [snapshotDate, sigType, parseInt(horizon), regime, acc.total, acc.wins, avg, median, winRate]);
      updated++;
    }
  });

  return { updated };
}

export async function getSignalTypeStats(horizonDays = 15): Promise<Record<string, unknown>[]> {
  return await dbAll(`
    SELECT * FROM signal_type_stats
    WHERE horizon_days = ? AND market_regime = 'ALL'
    ORDER BY win_rate DESC, total_occurrences DESC
  `, [horizonDays]) as Record<string, unknown>[];
}

export async function getLatestRSIForSymbols(symbols: string[]): Promise<Map<string, number>> {
  if (symbols.length === 0) return new Map();
  const placeholders = symbols.map(() => '?').join(',');

  // Get latest date available in the table
  const latestDateRow = await dbGet('SELECT MAX(date) as d FROM technical_signals') as { d: string };
  if (!latestDateRow?.d) return new Map();

  const rows = await dbAll(`
    SELECT symbol, rsi
    FROM technical_signals
    WHERE date = ? AND symbol IN (${placeholders})
  `, [latestDateRow.d, ...symbols]) as { symbol: string; rsi: number }[];


  const map = new Map<string, number>();
  for (const r of rows) {
    if (r.rsi != null) map.set(r.symbol, r.rsi);
  }
  return map;
}

