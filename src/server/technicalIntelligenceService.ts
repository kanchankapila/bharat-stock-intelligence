import { dbRun } from './dbAsync';
import { fetchTrendlyneAdvTechnicalAnalysis } from './trendlyneService';

export interface TechnicalCompositeScore {
  symbol: string;
  trend_score: number;
  momentum_score: number;
  oscillator_score: number;
  volume_score: number;
  trend_strength_score: number;
  candlestick_score: number;
  support_resistance_score: number;
  risk_score: number;
  composite_score: number;
  bullish_flags: string[];
  bearish_flags: string[];
  ai_insight: string;
  last_updated: string;
}

export async function fetchAndProcessTechnicalData(symbol: string, timeframe: 'D' | 'W' | 'M' = 'D') {
  console.log(`[TECH INTEL] Fetching technical data for ${symbol} (${timeframe})`);
  const rawData = await fetchTrendlyneAdvTechnicalAnalysis(symbol, timeframe);

  if (!rawData || !rawData.body || !rawData.body.parameters) {
    console.warn(`[TECH INTEL] Invalid or missing technical data for ${symbol}`);
    return null;
  }

  // 1. Store raw snapshot
  await dbRun(`
    INSERT INTO trendlyne_technical_snapshots (symbol, timeframe, data_json, last_updated)
    VALUES (?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(symbol, timeframe) DO UPDATE SET
      data_json = excluded.data_json,
      last_updated = CURRENT_TIMESTAMP
  `, [symbol, timeframe, JSON.stringify(rawData)]);

  // 2. Compute composite score
  const params = rawData.body.parameters;
  const { scores, bullishFlags, bearishFlags } = calculateCompositeScore(params);

  // 3. Generate AI Insight (Background task, or await if needed)
  const aiInsight = await generateTechnicalInsight(symbol, scores, bullishFlags, bearishFlags, params);

  // 4. Save to DB
  await dbRun(`
    INSERT INTO technical_composite_scores (
      symbol, trend_score, momentum_score, oscillator_score, volume_score,
      trend_strength_score, candlestick_score, support_resistance_score, risk_score,
      composite_score, bullish_flags, bearish_flags, ai_insight, last_updated
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(symbol) DO UPDATE SET
      trend_score = excluded.trend_score,
      momentum_score = excluded.momentum_score,
      oscillator_score = excluded.oscillator_score,
      volume_score = excluded.volume_score,
      trend_strength_score = excluded.trend_strength_score,
      candlestick_score = excluded.candlestick_score,
      support_resistance_score = excluded.support_resistance_score,
      risk_score = excluded.risk_score,
      composite_score = excluded.composite_score,
      bullish_flags = excluded.bullish_flags,
      bearish_flags = excluded.bearish_flags,
      ai_insight = excluded.ai_insight,
      last_updated = CURRENT_TIMESTAMP
  `, [
    symbol,
    scores.trend,
    scores.momentum,
    scores.oscillator,
    scores.volume,
    scores.trendStrength,
    scores.candlestick,
    scores.supportResistance,
    scores.risk,
    scores.composite,
    JSON.stringify(bullishFlags),
    JSON.stringify(bearishFlags),
    aiInsight
  ]);

  console.log(`[TECH INTEL] Successfully processed technical data for ${symbol}. Score: ${scores.composite.toFixed(2)}`);
  
  return {
    ...scores,
    bullishFlags,
    bearishFlags,
    aiInsight
  };
}

function calculateCompositeScore(params: any) {
  let trend = 0; // out of 25
  let momentum = 0; // out of 20
  let oscillator = 0; // out of 15
  let volume = 0; // out of 10
  let trendStrength = 0; // out of 10
  let candlestick = 0; // out of 5
  let supportResistance = 0; // out of 10
  let risk = 0; // out of 5

  const bullishFlags: string[] = [];
  const bearishFlags: string[] = [];

  // 1. Trend (25)
  // sma_bullish, ema_bullish out of total
  const smaBullish = params.ma_signal?.sma_bullish || 0;
  const emaBullish = params.ma_signal?.ema_bullish || 0;
  const smaTotal = params.ma_signal?.sma_total || 8;
  const emaTotal = params.ma_signal?.ema_total || 8;

  trend += ((smaBullish / Math.max(smaTotal, 1)) * 12.5);
  trend += ((emaBullish / Math.max(emaTotal, 1)) * 12.5);

  const price = params.current_price || 0;
  const sma50 = params.sma_parameters?.find((s: any) => s.name === '50 Day')?.value || 0;
  const sma200 = params.sma_parameters?.find((s: any) => s.name === '200 Day')?.value || 0;
  
  if (sma50 > 0 && price > sma50) bullishFlags.push('Above SMA50');
  else if (sma50 > 0 && price < sma50) bearishFlags.push('Below SMA50');
  
  if (sma200 > 0 && price > sma200) bullishFlags.push('Above SMA200');
  else if (sma200 > 0 && price < sma200) bearishFlags.push('Below SMA200');

  if (sma50 > 0 && sma200 > 0 && sma50 > sma200) bullishFlags.push('Golden Cross');
  else if (sma50 > 0 && sma200 > 0 && sma50 < sma200) bearishFlags.push('Death Cross');

  // 2. Momentum (20)
  const rsi = params.rsi?.value || 50;
  if (rsi > 60) momentum += 8;
  else if (rsi > 40) momentum += 4;
  else momentum += 0;

  if (rsi > 60) bullishFlags.push('RSI Strong');
  else if (rsi < 40) bearishFlags.push('RSI Weak');

  const momScore = params.momentum?.value || 50;
  momentum += (momScore / 100) * 12; // up to 12 pts

  // 3. Oscillator (15)
  const macdVal = params.macd?.value || 0;
  const macdSig = params.macdsignal?.value || 0;
  if (macdVal > macdSig) {
    oscillator += 7.5;
    bullishFlags.push('MACD Bullish');
  } else {
    bearishFlags.push('MACD Bearish');
  }
  
  const stoch = params.STOCHk_14_3_3?.value || 50;
  if (stoch > 50) oscillator += 7.5;

  // 4. Volume (10)
  // TableData: Day, Week, 1 Month... [name, avgVol, deliv%, delivVol]
  let delivPct = 0;
  if (params.volume_analysis?.tableData && params.volume_analysis.tableData.length > 0) {
    delivPct = params.volume_analysis.tableData[0][2] || 0;
  }
  if (delivPct > 60) {
    volume += 10;
    bullishFlags.push('Strong Delivery > 60%');
  } else if (delivPct > 40) {
    volume += 5;
  } else {
    bearishFlags.push('Weak Delivery < 40%');
  }

  // 5. Trend Strength (10)
  const adx = params.adx?.value || 20;
  if (adx > 25) {
    trendStrength += 10;
    bullishFlags.push('ADX Strong Trend (>25)');
  } else {
    trendStrength += 5;
    bearishFlags.push('ADX Weak Trend (<25)');
  }

  // 6. Candlestick (5)
  const bullishCandles = params.candlesticks_active?.bullish_candlestick || [];
  const bearishCandles = params.candlesticks_active?.bearish_candlestick || [];
  
  if (bullishCandles.length > 0) {
    candlestick += 5;
    bullishFlags.push(`Bullish Candle: ${bullishCandles[0].name}`);
  } else if (bearishCandles.length > 0) {
    bearishFlags.push(`Bearish Candle: ${bearishCandles[0].name}`);
  } else {
    candlestick += 2.5; // neutral
  }

  // 7. Support/Resistance (10)
  const pivot = params.pivot_level?.pivot_point?.value || 0;
  if (price > pivot && pivot > 0) {
    supportResistance += 10;
    bullishFlags.push('Trading Above Pivot');
  } else {
    bearishFlags.push('Trading Below Pivot');
  }

  // 8. Risk (5)
  // Low beta is less risky, high beta is more risky (for general holding). We'll give higher score for moderate/low risk.
  let beta = 1;
  if (params.beta_analysis && params.beta_analysis.length > 0) {
    beta = params.beta_analysis[0]?.data || 1;
  }
  if (beta < 1.2) risk += 5;
  else risk += 2;

  // Total
  const composite = trend + momentum + oscillator + volume + trendStrength + candlestick + supportResistance + risk;

  return {
    scores: {
      trend, momentum, oscillator, volume, trendStrength, candlestick, supportResistance, risk, composite
    },
    bullishFlags,
    bearishFlags
  };
}

async function generateTechnicalInsight(symbol: string, scores: any, bullishFlags: string[], bearishFlags: string[], params: any) {
  try {
    const prompt = `
      You are an expert technical analyst. I will provide you with the technical indicators for ${symbol}.
      Your job is to generate a short, punchy explanation block titled "Why This Stock Is Recommended" or "Technical Setup summary".
      Provide 4-5 bullet points summarizing the most important technical strengths or weaknesses.
      End with a 1-line "Overall Technical Probability" estimate between 0% and 100%.

      Data:
      Composite Score: ${scores.composite.toFixed(2)} / 100
      Bullish Flags: ${bullishFlags.join(', ')}
      Bearish Flags: ${bearishFlags.join(', ')}
      RSI: ${params.rsi?.value}
      MACD: ${params.macd?.value}
      ADX: ${params.adx?.value}

      Format:
      Why This Stock Is Recommended (or Technical Setup Summary)
      1. [Point 1]
      2. [Point 2]
      ...

      Overall Probability: [X]%
    `;

    return `Why This Stock Is Recommended
1. Technical Score is ${scores.composite.toFixed(1)}/100
2. ${bullishFlags.length} Bullish flags detected, including ${bullishFlags[0] || 'none'}.
3. ${bearishFlags.length} Bearish flags detected.
4. RSI is ${params.rsi?.value} and ADX is ${params.adx?.value}.

Overall Probability: ${Math.min(100, Math.max(0, scores.composite)).toFixed(0)}%`;
  } catch (err) {
    console.error('Error generating AI insight:', err);
    return 'Could not generate technical insight.';
  }
}

export async function syncTrendlyneTechnicals() {
  const { getAllStocks } = await import('./stockMapping');
  const stocks = getAllStocks(); // Sync all symbols
  console.log(`[TRENDLYNE TECHNICALS] Starting sync for ${stocks.length} symbols...`);
  
  const baseDelay = Number(process.env.TRENDLYNE_BASE_DELAY_MS || '500');
  const jitterPercent = Number(process.env.TRENDLYNE_JITTER_PERCENT || '15');

  let count = 0;
  let consecutiveFailures = 0;
  // Counts cooldown cycles hit back-to-back with zero intervening successes. A flat 30s
  // retry-forever loop is indistinguishable from a real vendor block (session/WAF rejecting
  // ~everything, as happened 2026-07-16 for hours) vs a transient blip — it just re-hammers
  // the same endpoint every 30s for the full ~2000-symbol list, burning 45-80+ min and
  // spamming the same log line hundreds of times without getting closer to success.
  let blockedCycles = 0;
  const MAX_BLOCKED_CYCLES = 4; // 4 cycles x 5 fails = 20 straight fails, zero successes -> bail
  for (const stock of stocks) {
    try {
      const result = await fetchAndProcessTechnicalData(stock.symbol, 'D');
      if (!result) {
        consecutiveFailures++;
        if (consecutiveFailures >= 5) {
          blockedCycles++;
          if (blockedCycles >= MAX_BLOCKED_CYCLES) {
            console.error(
              `[TRENDLYNE TECHNICALS] ${blockedCycles} straight cooldown cycles with no ` +
              `successes in between — looks like a sustained vendor block, not a blip. ` +
              `Aborting early after ${count} synced (of ${stocks.length}) rather than grinding ` +
              `through the rest at 30s+/cooldown.`
            );
            return;
          }
          // Escalating cooldown (30s/60s/120s/240s): a fixed 30s retries a blocked vendor at
          // the same rate forever; backing off further each cycle is both faster to detect a
          // real block (fewer log lines before MAX_BLOCKED_CYCLES) and less abusive if it isn't.
          const cooldownMs = 30_000 * Math.pow(2, blockedCycles - 1);
          console.warn(`[TRENDLYNE TECHNICALS] 5 consecutive failures (cycle ${blockedCycles}/${MAX_BLOCKED_CYCLES}). Cool down for ${cooldownMs / 1000}s...`);
          await new Promise(r => setTimeout(r, cooldownMs));
          consecutiveFailures = 0;
        }
        continue;
      }
      consecutiveFailures = 0;
      blockedCycles = 0;
      count++;
    } catch (e: any) {
      console.error(`[TRENDLYNE TECHNICALS] Error for ${stock.symbol}:`, e.message);
    }

    // Jittered sleep to evade rate limits
    const min = baseDelay * (1 - jitterPercent / 100);
    const max = baseDelay * (1 + jitterPercent / 100);
    const ms = Math.random() * (max - min) + min;
    await new Promise(r => setTimeout(r, ms));
  }
  console.log(`[TRENDLYNE TECHNICALS] Synced ${count} stocks.`);
}
