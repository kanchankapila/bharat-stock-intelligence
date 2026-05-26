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
        const signals = db.prepare(`
          SELECT ts.*, ns.sector, ns.industry
          FROM technical_signals ts
          LEFT JOIN nse_stocks ns ON ns.symbol = ts.symbol
          WHERE ts.date >= date('now', '-7 days') AND ts.win_probability >= 0.40
          ORDER BY ts.win_probability DESC, ts.computed_at DESC
          LIMIT 60
        `).all() as Array<Record<string, unknown>>;

        const quantRows = db.prepare(`
          SELECT symbol, composite_score, technical_score, fundamental_score,
                 momentum_score, sentiment_score, risk_score, timeframe
          FROM stock_scores WHERE timeframe = 'short'
          ORDER BY composite_score DESC LIMIT 200
        `).all() as Array<Record<string, unknown>>;

        const quantMap = new Map<string, Record<string, unknown>>();
        for (const q of quantRows) quantMap.set(q.symbol as string, q);

        let bulkDeals: Array<Record<string, unknown>> = [];
        try {
          bulkDeals = db.prepare(`SELECT symbol, deal_type, quantity, price, deal_date FROM bulk_deals WHERE deal_date >= date('now', '-14 days') ORDER BY deal_date DESC`).all() as any[];
        } catch { /* table may not exist */ }

        let insiderTrades: Array<Record<string, unknown>> = [];
        try {
          insiderTrades = db.prepare(`SELECT symbol, transaction_type, quantity, price, trade_date FROM insider_trades WHERE trade_date >= date('now', '-30 days') ORDER BY trade_date DESC`).all() as any[];
        } catch { /* table may not exist */ }

        let newsSentiment: Array<Record<string, unknown>> = [];
        try {
          newsSentiment = db.prepare(`SELECT symbol, sentiment_score, headline, published_at FROM news_sentiment_items WHERE published_at >= datetime('now', '-7 days') ORDER BY published_at DESC`).all() as any[];
        } catch { /* table may not exist */ }

        const sentimentMap = new Map<string, number[]>();
        for (const n of newsSentiment) {
          const sym = n.symbol as string;
          if (!sentimentMap.has(sym)) sentimentMap.set(sym, []);
          sentimentMap.get(sym)!.push(n.sentiment_score as number);
        }

        const bulkSet      = new Set(bulkDeals.map(d => d.symbol as string));
        const insiderBuySet = new Set(insiderTrades.filter(t => (t.transaction_type as string)?.toLowerCase().includes('buy')).map(t => t.symbol as string));

        const symbolMap = new Map<string, { signals: Array<Record<string, unknown>>; quant: Record<string, unknown> | undefined; hasBulkDeal: boolean; hasInsiderBuy: boolean; avgSentiment: number; sector: string }>();

        for (const sig of signals) {
          const sym = sig.symbol as string;
          if (!symbolMap.has(sym)) {
            const scores = sentimentMap.get(sym) || [];
            symbolMap.set(sym, {
              signals: [], quant: quantMap.get(sym),
              hasBulkDeal: bulkSet.has(sym), hasInsiderBuy: insiderBuySet.has(sym),
              avgSentiment: scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : 0,
              sector: (sig.sector as string) || 'Unknown',
            });
          }
          symbolMap.get(sym)!.signals.push(sig);
        }

        const candidates = Array.from(symbolMap.entries()).map(([symbol, data]) => {
          const avgWinProb = data.signals.reduce((s, sg) => s + ((sg.win_probability as number) || 0), 0) / data.signals.length;
          const quant = data.quant;
          const techScore  = quant ? (quant.technical_score  as number) || 0 : avgWinProb * 100;
          const fundScore  = quant ? (quant.fundamental_score as number) || 0 : 50;
          const momScore   = quant ? (quant.momentum_score    as number) || 0 : avgWinProb * 80;
          const sentScore  = data.avgSentiment > 0 ? 60 + data.avgSentiment * 40 : 50;
          const smartScore = (data.hasBulkDeal ? 20 : 0) + (data.hasInsiderBuy ? 30 : 0) + 50;
          const compositeScore = techScore * 0.35 + fundScore * 0.20 + momScore * 0.20 + sentScore * 0.15 + smartScore * 0.10;
          const actionAdvice = compositeScore >= 75 ? 'STRONG BUY' : compositeScore >= 70 ? 'BUY' : compositeScore <= 45 ? 'SELL' : 'HOLD';
          const primarySignal = data.signals[0];
          return {
            symbol, name: getStockMapping(symbol)?.name || symbol, sector: data.sector,
            advice: actionAdvice, actionAdvice,
            compositeScore: parseFloat(compositeScore.toFixed(1)),
            mlWinProbability: parseFloat((avgWinProb * 100).toFixed(1)),
            mlProbability:    parseFloat((avgWinProb * 100).toFixed(1)),
            signalCount: data.signals.length, techSignalCount: data.signals.length,
            quantRank: Math.round(100 - fundScore),
            smartMoneyCr:  parseFloat((smartScore - 50).toFixed(1)),
            newsSentiment: parseFloat(data.avgSentiment.toFixed(2)),
            factors: {
              technical:  parseFloat(techScore.toFixed(1)),
              fundamental: parseFloat(fundScore.toFixed(1)),
              momentum:   parseFloat(momScore.toFixed(1)),
              sentiment:  parseFloat(sentScore.toFixed(1)),
              smartMoney: parseFloat(smartScore.toFixed(1)),
            },
            entryPrice:  primarySignal?.entry_price  as number || null,
            targetPrice: primarySignal?.target_price as number || null,
            stopLoss:    primarySignal?.stop_loss    as number || null,
            hasBulkDeal: data.hasBulkDeal, hasInsiderBuy: data.hasInsiderBuy,
            rsi: primarySignal?.rsi || null, macd: primarySignal?.macd || null,
            macdSignal: primarySignal?.macd_signal || null,
            sma50: primarySignal?.sma50 || null, sma200: primarySignal?.sma200 || null,
            bbWidth: primarySignal?.bb_width || null, volumeRatio: primarySignal?.volume_ratio || null,
            cmp: primarySignal?.cmp || null, changePct: primarySignal?.change_pct || 0,
            aiInsight:    primarySignal?.ai_insight    || null,
            entryZone:    primarySignal?.entry_zone    || null,
            targets:      primarySignal?.targets       || null,
            setupQuality: primarySignal?.setup_quality || 'MEDIUM',
            timeHorizon:  primarySignal?.time_horizon  || 'Short Term',
            signalsJson:  primarySignal?.signals_json  || '[]',
          };
        });

        candidates.sort((a, b) => b.compositeScore - a.compositeScore);
        const top15 = candidates.slice(0, 15);
        const advances = signals.filter(s => ((s.signal_score as number) || 0) >= 0).length;
        const declines = signals.filter(s => ((s.signal_score as number) || 0) <  0).length;
        const advDecRatio = declines > 0 ? parseFloat((advances / declines).toFixed(2)) : advances > 0 ? 5 : 1;
        const avgWinProbability = signals.length
          ? parseFloat((signals.reduce((s, sg) => s + ((sg.win_probability as number) || 0), 0) / signals.length * 100).toFixed(1))
          : 0;
        const verdict = top15.length >= 3 && avgWinProbability >= 50 ? 'TRADE' : 'NO TRADE';
        const verdictReason = verdict === 'TRADE'
          ? `${top15.length} high-probability setups with ${avgWinProbability}% avg win rate`
          : top15.length < 3 ? 'Insufficient high-quality setups today' : 'Win probability below threshold';

        return {
          success: true,
          data: {
            marketOverview: { verdict, verdictReason, advDecRatio, avgWinProbability, activeSignalsCount: signals.length },
            candidates: top15,
          },
        };
      } catch (err) {
        return { success: false, data: { marketOverview: { verdict: 'NO TRADE', verdictReason: 'Data unavailable', advDecRatio: 1, avgWinProbability: 0, activeSignalsCount: 0 }, candidates: [] } };
      }
    }),
});
