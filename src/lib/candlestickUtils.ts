
export interface Candlestick {
  open: number;
  high: number;
  low: number;
  close: number;
  timestamp: string | number;
}

export interface PatternResult {
  name: string;
  sentiment: 'bullish' | 'bearish' | 'neutral';
  description: string;
  confidence: 'high' | 'medium' | 'low';
}

export function detectCandlestickPatterns(candles: Candlestick[]): PatternResult[] {
  if (candles.length < 2) return [];

  const results: PatternResult[] = [];
  const latest = candles[candles.length - 1];
  const previous = candles[candles.length - 2];

  const bodySize = Math.abs(latest.close - latest.open);
  const candleRange = latest.high - latest.low;
  const upperShadow = latest.high - Math.max(latest.close, latest.open);
  const lowerShadow = Math.min(latest.close, latest.open) - latest.low;
  const isBullish = latest.close > latest.open;
  
  const prevBodySize = Math.abs(previous.close - previous.open);
  const prevIsBullish = previous.close > previous.open;

  // 1. Doji Detection
  if (bodySize <= candleRange * 0.1) {
    results.push({
      name: 'Doji',
      sentiment: 'neutral',
      description: 'Signifies indecision in the market. Neither buyers nor sellers gain control.',
      confidence: 'medium'
    });
  }

  // 2. Hammer / Hanging Man
  if (lowerShadow >= bodySize * 2 && upperShadow <= bodySize * 0.5) {
    results.push({
      name: isBullish ? 'Hammer' : 'Hanging Man',
      sentiment: isBullish ? 'bullish' : 'bearish',
      description: isBullish 
        ? 'A bullish reversal pattern signaling that the bottom may be near.' 
        : 'A bearish reversal pattern that can occur during an uptrend.',
      confidence: 'high'
    });
  }

  // 3. Shooting Star / Inverted Hammer
  if (upperShadow >= bodySize * 2 && lowerShadow <= bodySize * 0.5) {
     results.push({
      name: isBullish ? 'Inverted Hammer' : 'Shooting Star',
      sentiment: isBullish ? 'bullish' : 'bearish',
      description: isBullish 
        ? 'A potential bullish reversal pattern after a downtrend.' 
        : 'A bearish reversal pattern that looks like a falling star.',
      confidence: 'medium'
    });
  }

  // 4. Bullish/Bearish Engulfing
  if (isBullish && !prevIsBullish && latest.close > previous.open && latest.open < previous.close) {
    results.push({
      name: 'Bullish Engulfing',
      sentiment: 'bullish',
      description: 'A large green candle fully "engulfing" the previous red candle. Strong reversal signal.',
      confidence: 'high'
    });
  } else if (!isBullish && prevIsBullish && latest.close < previous.open && latest.open > previous.close) {
    results.push({
      name: 'Bearish Engulfing',
      sentiment: 'bearish',
      description: 'A large red candle fully "engulfing" the previous green candle. Indicates sellers have taken over.',
      confidence: 'high'
    });
  }

  // 5. Marubozu
  if (bodySize >= candleRange * 0.9) {
    results.push({
      name: isBullish ? 'Bullish Marubozu' : 'Bearish Marubozu',
      sentiment: isBullish ? 'bullish' : 'bearish',
      description: 'A candle with long body and very short shadows, indicating strong one-sided momentum.',
      confidence: 'medium'
    });
  }

  return results;
}
