// Scoped AI regen: enqueue ONLY the top high-conviction unified_recommendations names
// (not the whole universe) to the live server's ai-signals queue via tRPC. The running
// worker applies the confidence gate. LLM narrative is generated where it earns its keep.
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const env = fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8');
const connectionString = env.match(/^POSTGRES_URL=(.+)$/m)[1].trim();
const LIMIT = Number(process.argv[2] ?? 100);
const TRPC = 'http://localhost:3000/api/trpc/enqueueSignals?batch=1';

(async () => {
  const pool = new Pool({ connectionString });

  // Latest batch, actionable high-conviction names, richest first.
  const rows = (await pool.query(`
    WITH latest AS (SELECT MAX(computed_at) AS d FROM unified_recommendations)
    SELECT ur.symbol, ur.unified_score, ur.conviction_level, ur.classification,
           ur.technical_score, ur.ml_score, ur.fundamental_score, ur.confluence_score,
           ur.screener_stock_score, ur.bullish_screener_count, ur.bearish_screener_count,
           ur.sector, ur.regime, ur.entry_zone_low, ur.entry_zone_high,
           ur.stop_loss, ur.target_1, ur.risk_reward, ur.trade_reasoning,
           ts.rsi, ts.macd, ts.macd_signal, ts.sma50, ts.sma200,
           ts.volume_ratio, ts.above_sma200, ts.cmp
    FROM unified_recommendations ur
    JOIN latest ON ur.computed_at = latest.d
    LEFT JOIN technical_signals ts
      ON ts.symbol = ur.symbol AND ts.date = (SELECT MAX(date) FROM technical_signals)
    WHERE ur.conviction_level IN ('S_ELITE','A_HIGH')
      AND ur.classification IN ('Strong Buy','Buy','Sell','Strong Sell')
    ORDER BY ur.unified_score DESC
    LIMIT $1`, [LIMIT])).rows;

  console.log(`Candidates: ${rows.length}`);

  const payload = rows.map(r => ({
    symbol: r.symbol,
    stockData: {
      symbol: r.symbol,
      price: r.cmp ?? r.entry_zone_low ?? null,
      sector: r.sector,
      nifty_regime: r.regime,
      quant_class: r.classification,
      unified_score: r.unified_score,
      conviction_level: r.conviction_level,
      factor_scores: {
        technical: r.technical_score, fundamental: r.fundamental_score,
        ml: r.ml_score, confluence: r.confluence_score, screener: r.screener_stock_score,
      },
      bullish_screener_count: r.bullish_screener_count,
      bearish_screener_count: r.bearish_screener_count,
      rsi: r.rsi, macd: r.macd, macd_signal: r.macd_signal,
      sma50: r.sma50, sma200: r.sma200, volume_ratio: r.volume_ratio,
      above_sma200: r.above_sma200 === 1 || r.above_sma200 === true,
      ranker_entry_zone: [r.entry_zone_low, r.entry_zone_high],
      ranker_stop_loss: r.stop_loss, ranker_target: r.target_1, risk_reward: r.risk_reward,
      ranker_reasoning: r.trade_reasoning,
    },
  }));
  await pool.end();

  if (payload.length === 0) { console.log('No candidates — aborting.'); return; }

  // superjson batch body: { "0": { "json": <input> } }
  const res = await fetch(TRPC, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ '0': { json: payload } }),
  });
  const text = await res.text();
  console.log(`HTTP ${res.status}`);
  console.log(text.slice(0, 800));
})();
