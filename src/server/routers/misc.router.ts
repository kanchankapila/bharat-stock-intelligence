import { z } from "zod";
import db from "../db";
import { getStockMapping } from "../stockMapping";
import { fetchWithCache } from "../cacheService";
import { generateStockAnalysis } from "../../services/aiService";
import { alphaQuant } from "../alphaQuantClient";
import {
  fetchPremarketAll,
  fetchDealsAll,
  fetchEarningsAll,
  fetchEarningsCalendar,
  fetchEarningsRapidResults,
  fetchEarningsPriceShockers,
  type FnoIndexId,
} from "../marketIntelService";
import { router, publicProcedure } from "../trpc";

export const miscRouter = router({
  getAIAnalysis: publicProcedure
    .input(z.object({ symbol: z.string(), data: z.record(z.string(), z.unknown()) }))
    .mutation(async ({ input }) => generateStockAnalysis(input.symbol, input.data)),

  getSuperstarList: publicProcedure
    .query(async () =>
      fetchWithCache('superstar_list', async () => {
        const res = await fetch(
          'https://portal.tradebrains.in/api/prices/superstar/portfolio/star/view/?page_size=100&page=1&search=',
          {
            headers: {
              Accept: 'application/json, text/plain, */*',
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
              Referer: 'https://portal.tradebrains.in/superstar-portfolio',
              Origin: 'https://portal.tradebrains.in',
            },
            signal: AbortSignal.timeout(10000),
          }
        );
        if (!res.ok) throw new Error(`TradeBrains superstar list HTTP ${res.status}`);
        return res.json();
      }, 3600)
    ),

  getSuperstarPortfolio: publicProcedure
    .input(z.object({ slug: z.string(), quarter: z.string() }))
    .query(async ({ input }) =>
      fetchWithCache(`superstar_${input.slug}_${input.quarter}`, async () => {
        const url = `https://portal.tradebrains.in/api/prices/superstar/stocklist/${encodeURIComponent(input.slug)}/?quater=${input.quarter}&sort_by=total_quantity&is_ascending=false`;
        const res = await fetch(url, {
          headers: {
            Accept: 'application/json, text/plain, */*',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
            Referer: `https://portal.tradebrains.in/superstar-portfolio/${input.slug}`,
            Origin: 'https://portal.tradebrains.in',
          },
          signal: AbortSignal.timeout(10000),
        });
        if (!res.ok) throw new Error(`TradeBrains portfolio ${input.slug} HTTP ${res.status}`);
        return res.json();
      }, 1800)
    ),

  analyzePortfolio: publicProcedure
    .input(z.object({ symbols: z.array(z.string()), weights: z.array(z.number()) }))
    .mutation(async ({ input }) => {
      try {
        return await alphaQuant.analyzePortfolio(input);
      } catch (e: any) {
        return { error: e.message };
      }
    }),

  getPremarket: publicProcedure
    .query(async () => fetchPremarketAll()),

  getDeals: publicProcedure
    .query(async () => fetchDealsAll()),

  getEarnings: publicProcedure
    .input(z.object({ date: z.string().optional() }))
    .query(async ({ input }) => fetchEarningsAll(input.date)),

  getEarningsCalendar: publicProcedure
    .input(z.object({ date: z.string().optional() }))
    .query(async ({ input }) => fetchEarningsCalendar(input.date)),

  getEarningsRapidResults: publicProcedure
    .input(z.object({ type: z.enum(['LR', 'BP']).optional().default('BP') }))
    .query(async ({ input }) => fetchEarningsRapidResults(input.type)),

  getEarningsPriceShockers: publicProcedure
    .query(async () => fetchEarningsPriceShockers()),

  getTradeDecisionCockpitData: publicProcedure
    .query(() => {
      try {
        // Pull latest technical snapshot per symbol (most recent date per symbol)
        const signals = db.prepare(`
          SELECT ts.*, ns.sector, ns.industry
          FROM technical_signals ts
          LEFT JOIN nse_stocks ns ON ns.symbol = ts.symbol
          WHERE ts.date = (
            SELECT MAX(ts2.date) FROM technical_signals ts2 WHERE ts2.symbol = ts.symbol
          )
          AND ts.cmp IS NOT NULL AND ts.cmp > 0
          ORDER BY ts.date DESC, ts.signal_score DESC
          LIMIT 200
        `).all() as Array<Record<string, unknown>>;

        // Best signal levels from the signals table (entry/target/SL)
        const signalLevels = db.prepare(`
          SELECT symbol, entry, target, stopLoss, confidence
          FROM signals
          WHERE type = 'BUY' AND status = 'ACTIVE' AND entry IS NOT NULL AND entry > 0
          ORDER BY confidence DESC, id DESC
        `).all() as Array<Record<string, unknown>>;
        const levelsMap = new Map<string, Record<string, unknown>>();
        for (const sl of signalLevels) {
          if (!levelsMap.has(sl.symbol as string)) levelsMap.set(sl.symbol as string, sl);
        }

        // stock_scores schema varies by scoring engine version — use try/catch to degrade gracefully
        let quantRows: Array<Record<string, unknown>> = [];
        try {
          quantRows = db.prepare(`
            SELECT symbol, score AS composite_score, confidence AS technical_score,
                   score AS fundamental_score, score AS momentum_score,
                   0 AS sentiment_score, 0 AS risk_score, timeframe
            FROM stock_scores WHERE timeframe IN ('intraday','short','long_term')
            ORDER BY score DESC LIMIT 400
          `).all() as Array<Record<string, unknown>>;
        } catch { /* schema mismatch — quantMap stays empty, scoring uses technical fallback */ }

        const quantMap = new Map<string, Record<string, unknown>>();
        for (const q of quantRows) quantMap.set(q.symbol as string, q);

        let newsSentiment: Array<Record<string, unknown>> = [];
        try {
          newsSentiment = db.prepare(`SELECT symbol, sentiment_score FROM news_sentiment_items WHERE published_at >= datetime('now', '-7 days') ORDER BY published_at DESC`).all() as any[];
        } catch { /* table may not exist */ }

        const sentimentMap = new Map<string, number[]>();
        for (const n of newsSentiment) {
          const sym = n.symbol as string;
          if (!sentimentMap.has(sym)) sentimentMap.set(sym, []);
          sentimentMap.get(sym)!.push(n.sentiment_score as number);
        }

        // Compute win probability from technicals (RSI, MACD cross, SMA alignment, ADX)
        const computeWinProb = (sig: Record<string, unknown>): number => {
          let score = 0.5;
          const rsi = sig.rsi as number | null;
          const macd = sig.macd as number | null;
          const macdSig = sig.macd_signal as number | null;
          const cmp = sig.cmp as number | null;
          const sma50 = sig.sma50 as number | null;
          const sma200 = sig.sma200 as number | null;
          const adx = sig.adx as number | null;

          if (rsi != null) {
            if (rsi >= 50 && rsi < 70) score += 0.06;       // bullish momentum, not overbought
            else if (rsi < 30) score += 0.04;                // oversold bounce
            else if (rsi >= 70) score -= 0.05;               // overbought risk
          }
          if (macd != null && macdSig != null) {
            score += macd > macdSig ? 0.08 : -0.05;          // MACD bullish/bearish cross
          }
          if (cmp != null && sma50 != null) {
            score += cmp > sma50 ? 0.06 : -0.04;             // above/below 50-DMA
          }
          if (cmp != null && sma200 != null) {
            score += cmp > sma200 ? 0.05 : -0.03;            // above/below 200-DMA
          }
          if (adx != null && adx > 25) score += 0.04;        // strong trend
          return Math.max(0.35, Math.min(0.85, score));
        };

        const symbolMap = new Map<string, {
          sig: Record<string, unknown>;
          quant: Record<string, unknown> | undefined;
          avgSentiment: number;
          sector: string;
          winProb: number;
        }>();

        for (const sig of signals) {
          const sym = sig.symbol as string;
          if (symbolMap.has(sym)) continue; // keep first (most recent)
          const scores = sentimentMap.get(sym) || [];
          symbolMap.set(sym, {
            sig,
            quant: quantMap.get(sym),
            avgSentiment: scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : 0,
            sector: (sig.sector as string) || 'Unknown',
            winProb: computeWinProb(sig),
          });
        }

        const candidates = Array.from(symbolMap.entries()).map(([symbol, data]) => {
          const { sig, quant, winProb } = data;
          const cmp = sig.cmp as number;

          const techScore  = quant ? (quant.technical_score  as number) || 0 : winProb * 100;
          const fundScore  = quant ? (quant.fundamental_score as number) || 0 : 50;
          const momScore   = quant ? (quant.momentum_score    as number) || 0 : winProb * 80;
          const sentScore  = data.avgSentiment > 0 ? 60 + data.avgSentiment * 40 : 50;
          const smartScore = 50;
          const compositeScore = techScore * 0.40 + fundScore * 0.20 + momScore * 0.20 + sentScore * 0.10 + smartScore * 0.10;

          // Entry/target/SL: use signals table if available, else derive from CMP + SMA
          const levels = levelsMap.get(symbol);
          const sma50 = sig.sma50 as number | null;
          const derivedEntry  = cmp;
          const derivedStop   = sma50 ? Math.max(sma50 * 0.985, cmp * 0.95) : cmp * 0.95;
          const derivedTarget = cmp * 1.10;

          const entryPrice  = levels ? (levels.entry  as number) : parseFloat(derivedEntry.toFixed(2));
          const stopLoss    = levels ? (levels.stopLoss as number) : parseFloat(derivedStop.toFixed(2));
          const targetPrice = levels ? (levels.target  as number) : parseFloat(derivedTarget.toFixed(2));

          const actionAdvice = compositeScore >= 70 ? 'STRONG BUY'
            : compositeScore >= 60 ? 'BUY'
            : compositeScore >= 50 ? 'WATCH'
            : 'HOLD';

          return {
            symbol, name: getStockMapping(symbol)?.name || symbol, sector: data.sector,
            advice: actionAdvice, actionAdvice,
            compositeScore: parseFloat(compositeScore.toFixed(1)),
            mlWinProbability: parseFloat((winProb * 100).toFixed(1)),
            mlProbability:    parseFloat((winProb * 100).toFixed(1)),
            techSignalCount: 1,
            quantRank: Math.round(100 - fundScore),
            smartMoneyCr: 0,
            newsSentiment: parseFloat(data.avgSentiment.toFixed(2)),
            factors: {
              technical:   parseFloat(techScore.toFixed(1)),
              fundamental: parseFloat(fundScore.toFixed(1)),
              momentum:    parseFloat(momScore.toFixed(1)),
              sentiment:   parseFloat(sentScore.toFixed(1)),
              smartMoney:  parseFloat(smartScore.toFixed(1)),
            },
            entryPrice, targetPrice, stopLoss,
            rsi:         sig.rsi        ?? null,
            macd:        sig.macd       ?? null,
            macdSignal:  sig.macd_signal ?? null,
            sma50:       sig.sma50      ?? null,
            sma200:      sig.sma200     ?? null,
            bbWidth:     sig.bb_width   ?? null,
            volumeRatio: sig.volume_ratio ?? null,
            cmp, changePct: (sig.change_pct as number) || 0,
            aiInsight:   (sig.ai_insight as string)  || null,
            signalsJson: (sig.signals_json as string) || '[]',
          };
        });

        candidates.sort((a, b) => b.compositeScore - a.compositeScore);
        const top20 = candidates.slice(0, 20);
        const bullish = candidates.filter(c => c.mlProbability > 55).length;
        const total   = candidates.length;
        const advDecRatio = total > 0 ? parseFloat((bullish / Math.max(1, total - bullish)).toFixed(2)) : 1;
        const avgWinProbability = candidates.length
          ? parseFloat((candidates.reduce((s, c) => s + c.mlProbability, 0) / candidates.length).toFixed(1))
          : 0;
        const verdict = top20.length >= 3 && avgWinProbability >= 52 ? 'TRADE' : 'NO TRADE';
        const verdictReason = verdict === 'TRADE'
          ? `${top20.length} setups · avg win rate ${avgWinProbability}% · ${bullish}/${total} stocks bullish`
          : top20.length < 3 ? 'Insufficient setups — run Technical Signal Scan first' : 'Win probability below threshold';

        return {
          success: true,
          data: {
            marketOverview: { verdict, verdictReason, advDecRatio, avgWinProbability, activeSignalsCount: candidates.length },
            candidates: top20,
          },
        };
      } catch (err) {
        return { success: false, data: { marketOverview: { verdict: 'NO TRADE', verdictReason: 'Data unavailable', advDecRatio: 1, avgWinProbability: 0, activeSignalsCount: 0 }, candidates: [] } };
      }
    }),
});
