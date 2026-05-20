import "dotenv/config";
import express from "express";

import { createServer as createViteServer } from "vite";
import path from "path";
import { fileURLToPath } from "url";
import * as trpcExpress from "@trpc/server/adapters/express";
import { appRouter } from "./src/server/router";
import { createContext } from "./src/server/context";
import { fetchStockDataWithCache } from "./src/server/liveStockData";
import { initCache } from "./src/server/cacheService";
import { initQueues, shutdownQueues } from "./src/server/queues";
import { startRedis, stopRedis } from "./src/server/redisManager";
import { startOllama, stopOllama } from "./src/server/ollamaManager";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

import { updateSignalAccuracy } from "./src/server/signals";

async function startServer() {
  const app = express();
  const PORT = parseInt(process.env.PORT || '3000', 10);

  // Initialise AI & Redis (gracefully managed)
  await startOllama();
  
  // Initialise Redis cache (gracefully falls back to in-memory if Redis is down)
  const cacheStarted = await initCache();
  
  if (!cacheStarted) {
    console.log('[SERVER] Redis not found. Attempting to start local Redis server...');
    const redisLaunched = await startRedis();
    if (redisLaunched) {
      await initCache(); // Try connecting again
    }
  }

  // Initialise BullMQ queues + workers (stock-refresh repeatable + ai-signals)
  // Falls back to legacy setInterval if Redis is unavailable
  const bullmqReady = await initQueues();

  // ── Quant strategy scoring: first-time trigger + daily scheduling ─────────
  const { getQuantScoreCount, runQuantScoring } = await import('./src/server/quantScoringService');
  const { quantScoringQueue } = await import('./src/server/queues');
  const quantCount = getQuantScoreCount();

  if (bullmqReady && quantScoringQueue) {
    if (quantCount === 0) {
      console.log('[SERVER] quant_scores is empty — triggering first-time scoring via BullMQ...');
      await quantScoringQueue.add(
        'quant-score-first-run',
        {},
        { removeOnComplete: 3, removeOnFail: 3, attempts: 1, priority: 2 },
      );
    } else {
      console.log(`[SERVER] quant_scores has ${quantCount} rows — skipping first-run trigger`);
    }
  } else {
    if (quantCount === 0) {
      console.log('[SERVER] No Redis — starting first-time quant scoring directly...');
      runQuantScoring().catch(err =>
        console.error('[SERVER] First-time quant scoring error:', err.message)
      );
    }
    setInterval(() => {
      console.log('[FALLBACK] Triggering daily quant strategy scoring...');
      runQuantScoring().catch(console.error);
    }, 24 * 60 * 60 * 1000);
  }
  // ─────────────────────────────────────────────────────────────────────────

  // ── Fundamentals sync: first-time trigger + scheduling ────────────────────
  const { getFundamentalsCount, runFullFundamentalsSync } = await import('./src/server/fundamentalsSyncService');
  const { fundamentalsSyncQueue } = await import('./src/server/queues');
  const fundCounts = getFundamentalsCount();
  const isFirstRun = fundCounts.phase1 === 0;

  if (bullmqReady && fundamentalsSyncQueue) {
    if (isFirstRun) {
      console.log('[SERVER] stock_fundamentals is empty — triggering first-time sync via BullMQ...');
      await fundamentalsSyncQueue.add(
        'sync-fundamentals-first-run',
        { phase2Only: false },
        { removeOnComplete: 3, removeOnFail: 3, attempts: 1, priority: 1 },
      );
    } else {
      console.log(`[SERVER] stock_fundamentals has ${fundCounts.phase1} Phase-1 rows — skipping first-run trigger`);
    }
  } else {
    // No Redis — run directly in background (non-blocking)
    if (isFirstRun) {
      console.log('[SERVER] No Redis — starting first-time fundamentals sync directly...');
      runFullFundamentalsSync(false).catch(err =>
        console.error('[SERVER] First-time fundamentals sync error:', err.message)
      );
    }
    // Schedule weekly re-sync via setInterval fallback
    setInterval(() => {
      console.log('[FALLBACK] Triggering weekly fundamentals sync...');
      runFullFundamentalsSync(false).catch(console.error);
    }, 7 * 24 * 60 * 60 * 1000);
  }
  // ─────────────────────────────────────────────────────────────────────────

  // ── Technical signals: schedule daily + fallback ──────────────────────────
  const { getTechnicalSignalCount, runTechnicalSignalScan } = await import('./src/server/technicalSignalsService');
  const { technicalSignalsQueue } = await import('./src/server/queues');
  const signalCount = getTechnicalSignalCount();

  if (bullmqReady && technicalSignalsQueue) {
    if (signalCount === 0) {
      console.log('[SERVER] No technical signals today — triggering first scan via BullMQ...');
      await technicalSignalsQueue.add(
        'technical-signals-first-run',
        {},
        { removeOnComplete: 3, removeOnFail: 3, attempts: 1, priority: 3 },
      );
    } else {
      console.log(`[SERVER] technical_signals already has ${signalCount} rows for today — skipping`);
    }
  } else {
    if (signalCount === 0) {
      console.log('[SERVER] No Redis — starting technical signal scan directly...');
      runTechnicalSignalScan().catch(err =>
        console.error('[SERVER] Technical signal scan error:', err.message)
      );
    }
    // Fallback: run every 24 hours
    setInterval(() => {
      console.log('[FALLBACK] Triggering daily technical signal scan...');
      runTechnicalSignalScan().catch(console.error);
    }, 24 * 60 * 60 * 1000);
  }
  // ─── Trendlyne Intraday Screeners: scheduling & startup trigger ─────────
  const { runIntradayScreenerScan } = await import('./src/server/trendlyneScreener');
  const { trendlyneIntradayQueue } = await import('./src/server/queues');

  if (bullmqReady && trendlyneIntradayQueue) {
    console.log('[SERVER] Triggering first-time Trendlyne intraday scan via BullMQ...');
    await trendlyneIntradayQueue.add(
      'trendlyne-intraday-first-run',
      {},
      { removeOnComplete: 3, removeOnFail: 3, attempts: 1, priority: 2 },
    );
  } else {
    console.log('[SERVER] No Redis — starting first-time Trendlyne intraday scan directly...');
    runIntradayScreenerScan().catch(err =>
      console.error('[SERVER] First-time Trendlyne scan error:', err.message)
    );
    // Legacy fallback: run every 5 minutes
    setInterval(() => {
      console.log('[FALLBACK] Triggering scheduled Trendlyne intraday scan...');
      runIntradayScreenerScan().catch(console.error);
    }, 5 * 60 * 1000);
  }
  // ─────────────────────────────────────────────────────────────────────────

  if (!bullmqReady) {
    // Legacy fallback: simple periodic refresh without job queue
    const { startBackgroundRefresh } = await import('./src/server/liveStockData');
    startBackgroundRefresh();

    // Fallback for scoring: run once every 24 hours
    const { syncAndScore } = await import('./src/server/scoringService');
    setInterval(async () => {
      console.log('[FALLBACK] Triggering scheduled stock scoring...');
      await syncAndScore();
    }, 24 * 60 * 60 * 1000);

    // Fallback for MC screener sync: run every 12 hours
    setInterval(async () => {
      console.log('[FALLBACK] Triggering MoneyControl screener sync...');
      const { syncMoneyControlScreeners } = await import('./src/server/moneycontrolScreener');
      await syncMoneyControlScreeners();
    }, 12 * 60 * 60 * 1000);

    // Fallback for news sentiment cycle: run every 15 minutes
    const { runNewsSentimentCycle } = await import('./src/server/newsSentimentService');
    setInterval(async () => {
      console.log('[FALLBACK] Triggering scheduled news sentiment refresh...');
      await runNewsSentimentCycle().catch(console.error);
    }, 15 * 60 * 1000);

    // Trigger immediate sync on start if fallback
    syncAndScore();
    import('./src/server/moneycontrolScreener').then(m => m.syncMoneyControlScreeners());
    runNewsSentimentCycle().catch(console.error);
  }

  // Background job for signal accuracy tracking (Phase 4)
  setInterval(() => {
    // In a real app, this would iterate through all active signals
    // For demo, we'll just simulate updates for a few stocks
    const symbols = ['RELIANCE', 'TCS', 'HDFCBANK'];
    symbols.forEach(async symbol => {
      try {
        const data = await fetchStockDataWithCache(symbol);
        if (data && data.price) {
          await updateSignalAccuracy(symbol, data.price);
        }
      } catch (error) {
        console.error(`Failed to update signal accuracy for ${symbol}`, error);
      }
    });
  }, 30000); // Every 30 seconds

  // JSON body parser with increased limit for large payloads (e.g. stock list sync)
  app.use(express.json({ limit: '50mb' }));
  app.use(express.urlencoded({ limit: '50mb', extended: true }));

  // tRPC middleware
  app.use(
    "/api/trpc",
    trpcExpress.createExpressMiddleware({
      router: appRouter,
      createContext,
    })
  );

  // Health check
  app.get("/api/health", (req, res) => {
    res.json({ status: "ok", timestamp: new Date().toISOString() });
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    // Production static files
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`🚀 Server running on http://localhost:${PORT}`);
  });
}

startServer().catch((error) => {
  console.error("Failed to start server:", error);
  process.exit(1);
});

// Graceful shutdown — close BullMQ workers before exiting
for (const sig of ['SIGTERM', 'SIGINT'] as NodeJS.Signals[]) {
  process.on(sig, async () => {
    console.log(`[SERVER] ${sig} received, shutting down services...`);
    await shutdownQueues();
    await stopRedis();
    await stopOllama();
    process.exit(0);
  });
}
