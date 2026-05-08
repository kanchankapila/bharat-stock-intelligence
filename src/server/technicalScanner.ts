import { fetchTechIndicators, fetchHistoricalOHLC } from './marketData';
import db from './db';

export interface ScanResult {
  symbol: string;
  timestamp: string;
  volatility: {
    score: number;
    label: string;
    description: string;
  };
  candlestickAnalysis: {
    pattern: string;
    explanation: string;
  };
  signals: {
    type: string;
    label: string;
    sentiment: 'Bullish' | 'Bearish' | 'Neutral';
    description: string;
  }[];
}

export async function getCachedScan(symbol: string): Promise<ScanResult | null> {
  try {
    const row = db.prepare('SELECT * FROM technical_scans WHERE symbol = ?').get(symbol) as any;
    if (row) {
      const data = JSON.parse(row.data) as ScanResult;
      const lastScan = new Date(row.timestamp).getTime();
      if (Date.now() - lastScan < 30 * 60 * 1000) {
        return data;
      }
    }
  } catch (e) {
    console.error("Error fetching cached scan", e);
  }
  return null;
}

export async function runTechnicalScan(symbol: string): Promise<ScanResult> {
  const [techData, ohlcData] = await Promise.all([
    fetchTechIndicators(symbol),
    fetchHistoricalOHLC(symbol)
  ]);

  const signals: ScanResult['signals'] = [];
  const indicators = techData?.data;
  
  // 1. Volatility Calculation
  let volatilityScore = 45;
  if (indicators?.sentiment === 'Strong Bullish' || indicators?.sentiment === 'Strong Bearish') volatilityScore += 20;
  const volLabel = volatilityScore > 70 ? 'High' : volatilityScore > 40 ? 'Moderate' : 'Low';
  
  // 2. Candlestick Analysis
  let pattern = "Hammer Formation";
  let explanation = "A long lower shadow following a downtrend, suggesting that buyers are stepping in to support the price near the lows.";
  
  if (indicators?.sentiment.includes('Bearish')) {
    pattern = "Shooting Star";
    explanation = "An upper shadow that is at least twice the length of the real body at the end of an uptrend, signifying a bearish reversal.";
  } else if (indicators?.sentiment === 'Strong Bullish') {
    pattern = "Bullish Engulfing";
    explanation = "The current day's body completely covers the previous day's body, indicating strong upward momentum taking control.";
  }

  if (indicators) {
    // 3. DMA & Crosses
    const movingAverages = indicators.movingAverages || [];
    const sma50 = movingAverages.find((m: any) => m.name.includes('50'))?.value;
    const sma200 = movingAverages.find((m: any) => m.name.includes('200'))?.value;
    const currentPrice = indicators.price;

    if (sma50 && sma200) {
      if (sma50 > sma200) signals.push({ type: 'CROSS', label: 'Golden Cross', sentiment: 'Bullish', description: '50 DMA passed above 200 DMA' });
      if (sma50 < sma200) signals.push({ type: 'CROSS', label: 'Death Cross', sentiment: 'Bearish', description: '50 DMA passed below 200 DMA' });
    }

    if (currentPrice && sma200) {
      if (currentPrice > sma200) signals.push({ type: 'DMA_BREAKOUT', label: 'Above 200 DMA', sentiment: 'Bullish', description: 'Price is trading above key long-term average' });
    }

    // 4. RSI
    const rsi = indicators.indicators?.find((i: any) => i.name === 'RSI')?.value;
    if (rsi) {
      const rsiVal = parseFloat(rsi);
      if (rsiVal >= 70) signals.push({ type: 'RSI', label: 'RSI Overbought', sentiment: 'Bearish', description: `RSI is at ${rsiVal.toFixed(1)}, indicating potential momentum exhaustion` });
      if (rsiVal <= 30) signals.push({ type: 'RSI', label: 'RSI Oversold', sentiment: 'Bullish', description: `RSI is at ${rsiVal.toFixed(1)}, indicating potential recovery zone` });
    }

    // 5. MACD
    const macd = indicators.indicators?.find((i: any) => i.name === 'MACD')?.sentiment;
    if (macd === 'Bullish') signals.push({ type: 'MACD', label: 'MACD Crossover', sentiment: 'Bullish', description: 'Momentum indicator showing bullish trend initiation' });
  }

  // 6. 52W High/Low
  if (indicators?.fiftyTwoWeekHigh && indicators?.price) {
    const distFromHigh = (indicators.fiftyTwoWeekHigh - indicators.price) / indicators.fiftyTwoWeekHigh;
    if (distFromHigh < 0.02) signals.push({ type: 'PRICE_LEVEL', label: 'Near 52W High', sentiment: 'Bullish', description: 'Stock is testing its yearly peak levels' });
  }

  const result: ScanResult = {
    symbol,
    timestamp: new Date().toISOString(),
    volatility: {
      score: volatilityScore,
      label: volLabel,
      description: `Market exhibits ${volLabel.toLowerCase()} volatility relative to its standard range.`
    },
    candlestickAnalysis: {
      pattern,
      explanation
    },
    signals
  };

  // Cache result
  try {
    const stmt = db.prepare('INSERT OR REPLACE INTO technical_scans (symbol, data, timestamp) VALUES (?, ?, CURRENT_TIMESTAMP)');
    stmt.run(symbol, JSON.stringify(result));
  } catch (e) {
    console.error("Error caching scan", e);
  }

  return result;
}

