import { dbAll } from './dbAsync';

// ── ATR-grounded exit geometry ───────────────────────────────────────────────
// Shared target/stop placement so every signal producer uses the SAME volatility-
// scaled barriers. Mirrors technical_analysis_engine.compute_atr_barriers exactly
// (2.5×ATR target / 1.5×ATR stop, clamped). The AI path previously stored the LLM's
// hallucinated price levels, which had no relation to a stock's realized range — so
// ~76% of AI signals expired NEUTRAL (target unreachable in-horizon) while stops
// still fired, i.e. structurally negative expectancy despite a 55%-accurate model.
const STOP_ATR_MULT = 1.5, TARGET_ATR_MULT = 2.5;
const STOP_PCT_FLOOR = 0.02, STOP_PCT_CAP = 0.08;      // 2%–8%
const TARGET_PCT_FLOOR = 0.03, TARGET_PCT_CAP = 0.15;  // 3%–15%

export interface Barriers {
  entryPrice: number;
  targetPrice: number;
  stopLoss: number;
}

const round2 = (x: number): number => Math.round(x * 100) / 100;

/** ATR-multiple target/stop, clamped to % guardrails, direction-aware.
 *  Missing/zero ATR falls back to the floor % so barriers are never degenerate. */
export function atrBarriers(
  price: number, atr: number, direction: 'long' | 'short',
): { targetPrice: number; stopLoss: number } {
  if (!(price > 0)) return { targetPrice: 0, stopLoss: 0 };
  const atrFrac = atr && atr > 0 ? atr / price : 0;
  const stopFrac = Math.min(Math.max(STOP_ATR_MULT * atrFrac, STOP_PCT_FLOOR), STOP_PCT_CAP);
  const targetFrac = Math.min(Math.max(TARGET_ATR_MULT * atrFrac, TARGET_PCT_FLOOR), TARGET_PCT_CAP);
  if (direction === 'long') {
    return { targetPrice: round2(price * (1 + targetFrac)), stopLoss: round2(price * (1 - stopFrac)) };
  }
  return { targetPrice: round2(price * (1 - targetFrac)), stopLoss: round2(price * (1 + stopFrac)) };
}

/** Wilder ATR(period) from bars ascending by date. 0 when history is too short. */
export function wilderATR(
  bars: Array<{ high: number; low: number; close: number }>, period = 14,
): number {
  const n = bars.length;
  if (n < period + 1) return 0;
  const tr: number[] = [];
  for (let i = 1; i < n; i++) {
    tr.push(Math.max(
      bars[i].high - bars[i].low,
      Math.abs(bars[i].high - bars[i - 1].close),
      Math.abs(bars[i].low - bars[i - 1].close),
    ));
  }
  let val = tr.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < tr.length; i++) val = (val * (period - 1) + tr[i]) / period;
  return val;
}

/** Read recent (non-suspect) OHLCV, compute ATR, and return ATR-grounded barriers.
 *  `entryPrice` anchors the levels; when it is missing/invalid the latest close is
 *  used instead so the barriers are always anchored to a real price. Returns null
 *  when there is too little clean history to compute an ATR. */
export async function getAtrBarriers(
  symbol: string, entryPrice: number | null | undefined, direction: 'long' | 'short',
): Promise<Barriers | null> {
  const rows = await dbAll<{ high: number; low: number; close: number }>(
    `SELECT high, low, close FROM stock_ohlcv
     WHERE symbol = ? AND COALESCE(is_suspect, 0) = 0
     ORDER BY date DESC LIMIT 30`,
    [symbol],
  );
  if (!rows || rows.length < 15) return null;
  const bars = rows
    .map(r => ({ high: +r.high, low: +r.low, close: +r.close }))
    .reverse(); // ascending by date
  const atr = wilderATR(bars);
  if (!(atr > 0)) return null;
  const entry = entryPrice && entryPrice > 0 ? entryPrice : bars[bars.length - 1].close;
  if (!(entry > 0)) return null;
  const { targetPrice, stopLoss } = atrBarriers(entry, atr, direction);
  return { entryPrice: round2(entry), targetPrice, stopLoss };
}
