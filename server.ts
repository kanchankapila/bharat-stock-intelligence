import "dotenv/config";

import { validateEnv } from "./src/server/envConfig";
// Fail fast on misconfiguration (e.g. USE_POSTGRES unset/malformed) before anything else
// touches the DB — this is what would have caught the AlphaQuant SQLite split-brain at
// startup instead of silently writing to the wrong database for hours.
validateEnv();

import { initSentry, sentryEnabled, Sentry } from "./src/server/sentry";
// As early as possible so startup-path errors are captured too. No-op without SENTRY_DSN.
initSentry();

// Suppress ioredis connection-time WARN about Redis 7 + requirepass ACL mismatch.
// Every one of the 88 BullMQ connections logs this on startup — it's cosmetic;
// auth still works (88 clients connected, zero rejections).
const _origWarn = console.warn.bind(console);
console.warn = (...args: unknown[]) => {
  const msg = String(args[0] ?? '');
  if (msg.includes('does not require a password')) return;
  _origWarn(...args);
};

// EPIPE and ETIMEDOUT on startup are harmless ioredis reconnection noise caused by
// TIME_WAIT sockets from the previous server instance. ioredis auto-reconnects.
// Without this handler, Node.js escalates them to uncaughtException and PM2 logs the
// full stack trace on every restart.
process.on('uncaughtException', (err: any) => {
  if (err.code === 'EPIPE' || err.code === 'ETIMEDOUT') return;
  console.error('[UNCAUGHT EXCEPTION]', err);
  process.exit(1);
});
process.on('unhandledRejection', (reason: any) => {
  if (reason?.code === 'EPIPE' || reason?.code === 'ETIMEDOUT') return;
  console.error('[UNHANDLED REJECTION]', reason);
  process.exit(1);
});

import express from "express";
import { createServer as createHttpServer } from "http";

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
import { wsSignalService } from "./src/server/websocketService";  // PHASE 3.2: WebSocket
import log from "./src/server/logger";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

import { updateSignalAccuracy } from "./src/server/signals";

async function startServer() {
  const { validateEnv } = await import('./src/server/envConfig');
  validateEnv();

  // Wait for Postgres to accept connections before any DB-dependent bootstrap. On a cold
  // stack start (or a DB container restart) the server process can come up before
  // TimescaleDB finishes booting, and bootstrapQuantScoring's first query would throw
  // "connection refused" and hard-crash the whole server ("Failed to start server").
  const { usePostgres } = await import('./src/server/pgConfig');
  if (usePostgres()) {
    const { pgHealthy } = await import('./src/server/pgClient');
    for (let attempt = 1; attempt <= 30; attempt++) {
      if (await pgHealthy()) break;
      if (attempt === 30) {
        console.error('[SERVER] Postgres not reachable after 30 attempts (~60s) — aborting boot; PM2 will retry.');
        throw new Error('Postgres unavailable at startup');
      }
      console.log(`[SERVER] Waiting for Postgres (attempt ${attempt}/30)...`);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }

  const app = express();
  const PORT = parseInt(process.env.PORT || '3000', 10);

  // Initialise AI & Redis (gracefully managed)
  await startOllama();
  
  // Initialise Redis cache (gracefully falls back to in-memory if Redis is down)
  const cacheStarted = await initCache();

  if (!cacheStarted) {
    // Only spawn a local redis-server.exe when no external Redis is configured.
    // If REDIS_PASSWORD is set the user has Docker/remote Redis — don't conflict with it.
    const hasExternalRedis = !!process.env.REDIS_PASSWORD || !!process.env.REDIS_HOST;
    if (!hasExternalRedis) {
      console.log('[SERVER] Redis not found. Attempting to start local Redis server...');
      const redisLaunched = await startRedis();
      if (redisLaunched) {
        await initCache(); // Try connecting again
      }
    } else {
      console.log('[SERVER] External Redis configured — skipping local redis-server.exe spawn; will retry automatically.');
    }
  }

  // Initialise BullMQ queues + workers (stock-refresh repeatable + ai-signals)
  // Falls back to legacy setInterval if Redis is unavailable
  const bullmqReady = await initQueues();

  const { bootstrapQuantScoring } = await import('./src/server/quantScoringService');
  await bootstrapQuantScoring(bullmqReady);

  const { bootstrapFundamentals } = await import('./src/server/fundamentalsSyncService');
  await bootstrapFundamentals(bullmqReady);

  // ── Technical signals: schedule daily + fallback ──────────────────────────
  const { getTechnicalSignalCount, runTechnicalSignalScan } = await import('./src/server/technicalSignalsService');
  const { technicalSignalsQueue } = await import('./src/server/queues');
  const signalCount = await getTechnicalSignalCount();

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
    // Fallback: run every 30 minutes
    setInterval(() => {
      console.log('[FALLBACK] Triggering scheduled 30-min technical signal scan...');
      runTechnicalSignalScan().catch(console.error);
    }, 30 * 60 * 1000);
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
    console.log('[SERVER] No Redis — starting first-time Trendlyne intraday sync & scan directly...');
    (async () => {
      const { syncAllScreenerStocksToDB } = await import('./src/server/trendlyneScreener');
      const { syncMoneyControlScreeners } = await import('./src/server/moneycontrolScreener');
      const { syncETnowScreeners } = await import('./src/server/etnowScreenerSync');
      
      await syncAllScreenerStocksToDB('intraday').catch(console.error);
      await syncMoneyControlScreeners('intraday').catch(console.error);
      await syncETnowScreeners('intraday').catch(console.error);
      await runIntradayScreenerScan();
    })().catch(err =>
      console.error('[SERVER] First-time Trendlyne scan error:', err.message)
    );
    // Legacy fallback: run every 15 minutes
    setInterval(async () => {
      console.log('[FALLBACK] Triggering scheduled Trendlyne intraday scan & sync...');
      const { syncAllScreenerStocksToDB } = await import('./src/server/trendlyneScreener');
      const { syncMoneyControlScreeners } = await import('./src/server/moneycontrolScreener');
      const { syncETnowScreeners } = await import('./src/server/etnowScreenerSync');
      
      await syncAllScreenerStocksToDB('intraday').catch(console.error);
      await syncMoneyControlScreeners('intraday').catch(console.error);
      await syncETnowScreeners('intraday').catch(console.error);
      runIntradayScreenerScan().catch(console.error);
    }, 15 * 60 * 1000);
  }
  // ─── ETnow screener stocks: first-time trigger ───────────────────────────
  const { getETnowStockCount, syncETnowScreeners } = await import('./src/server/etnowScreenerSync');
  const { etnowScreenerSyncQueue } = await import('./src/server/queues');
  const etnowStockCount = await getETnowStockCount();

  if (etnowStockCount === 0) {
    if (bullmqReady && etnowScreenerSyncQueue) {
      console.log('[SERVER] ETnow screener stocks empty — triggering first-time sync via BullMQ...');
      await etnowScreenerSyncQueue.add(
        'etnow-sync-first-run',
        {},
        { removeOnComplete: 3, removeOnFail: 3, attempts: 1, priority: 2 },
      );
    } else {
      console.log('[SERVER] No Redis — starting ETnow sync directly...');
      syncETnowScreeners().catch(err =>
        console.error('[SERVER] ETnow first-time sync error:', err.message)
      );
    }
  } else {
    console.log(`[SERVER] ETnow screener stocks has ${etnowStockCount} rows — skipping first-run trigger`);
  }
  // ─────────────────────────────────────────────────────────────────────────

  if (!bullmqReady) {
    // Legacy fallback: simple periodic refresh without job queue
    const { startBackgroundRefresh } = await import('./src/server/liveStockData');
    startBackgroundRefresh();

    // Fallback for daily OHLCV persistence (Mon-Fri at 4:30 PM IST / 11:00 AM UTC)
    setInterval(async () => {
      const now = new Date();
      const hours = now.getUTCHours();
      if (hours === 11) { // 11:00 AM UTC = 4:30 PM IST
        console.log('[FALLBACK] Triggering daily OHLCV persistence...');
        const { getOrRefreshAllStocks, persistTodayOHLCVData } = await import('./src/server/liveStockData');
        try {
          const stocks = await getOrRefreshAllStocks();
          await persistTodayOHLCVData(stocks);
        } catch (err: any) {
          console.error('[FALLBACK] Failed to persist daily OHLCV:', err.message);
        }
      }
    }, 60 * 60 * 1000); // Check hourly

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

    // Fallback for News Sentiment sync: run every 30 seconds
    setInterval(async () => {
      console.log('[FALLBACK] Triggering News Sentiment cycle...');
      const { runNewsSentimentCycle } = await import('./src/server/newsSentimentService');
      await runNewsSentimentCycle();
    }, 30 * 1000);

    // Trigger immediate sync on start if fallback
    syncAndScore();
    import('./src/server/moneycontrolScreener').then(m => m.syncMoneyControlScreeners());
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

  // MoneyControl API Proxy
  app.all('/mcapi/*', async (req, res) => {
    try {
      let path = req.originalUrl;

      // Normalize common variants of endpoints in the user request
      // 1. Fundamentals/Get Indices Details
      if (path.includes('/indices/fundamentals/get-indices-details')) {
        path = path.replace('/indices/fundamentals/get-indices-details', '/indices/get-indices-details');
      }
      
      // 2. Financial Historical Overview
      if (path.includes('/financial-historical/overview') && !path.includes('/stock/financial-historical/overview')) {
        path = path.replace('/financial-historical/overview', '/stock/financial-historical/overview');
      }

      // 3. Earning / Price / Consensus / Valuation Forecasts
      if (path.includes('/earning-forecast') && !path.includes('/stock/estimates/earning-forecast')) {
        path = path.replace('/earning-forecast', '/stock/estimates/earning-forecast');
      }
      if (path.includes('/price-forecast') && !path.includes('/stock/estimates/price-forecast')) {
        path = path.replace('/price-forecast', '/stock/estimates/price-forecast');
      }
      if (path.includes('/consensus') && !path.includes('/stock/estimates/consensus')) {
        path = path.replace('/consensus', '/stock/estimates/consensus');
      }
      if (path.includes('/valuation') && !path.includes('/stock/estimates/valuation')) {
        path = path.replace('/valuation', '/stock/estimates/valuation');
      }

      // 4. SWOT and essentials/insights
      if (path.includes('/mcapi/v1/mc-insights')) {
        path = path.replace('/mcapi/v1/mc-insights', '/mcapi/v1/extdata/mc-insights');
      }
      if (path.includes('/mcapi/v1/mc-essentials')) {
        path = path.replace('/mcapi/v1/mc-essentials', '/mcapi/v1/extdata/mc-essentials');
      }

      // 5. Normalize v1/stock/extdata/v2 -> extdata/v2 (newer, more stable API)
      if (path.includes('/mcapi/v1/stock/extdata/v2/')) {
        path = path.replace('/mcapi/v1/stock/extdata/v2/', '/mcapi/extdata/v2/');
      }

      // 6. Normalize mc-insights 422 error by rewriting /mcapi/v1/extdata/mc-insights with deviceType/appVersion to v2
      // (MoneyControl's v1 insights endpoint returns 422 if deviceType/appVersion query params are present, but v2 supports them)
      if (path.includes('/mcapi/v1/extdata/mc-insights') && (path.includes('deviceType') || path.includes('appVersion'))) {
        path = path.replace('/mcapi/v1/extdata/mc-insights', '/mcapi/extdata/v2/mc-insights');
      }

      const targetUrl = `https://api.moneycontrol.com${path}`;
      
      const response = await fetch(targetUrl, {
        method: req.method,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'application/json, text/plain, */*',
          'Referer': 'https://www.moneycontrol.com/'
        },
        signal: AbortSignal.timeout(15000)
      });

      if (!response.ok) {
        res.status(response.status).send(await response.text());
        return;
      }

      const contentType = response.headers.get('content-type') || '';
      res.setHeader('Content-Type', contentType);
      
      if (contentType.includes('application/json')) {
        const json = await response.json();
        res.json(json);
      } else {
        const text = await response.text();
        res.send(text);
      }
    } catch (error: any) {
      console.error(`Error proxying to MoneyControl API: ${req.originalUrl}`, error);
      res.status(500).json({ error: error?.message || 'Failed to fetch from MoneyControl API' });
    }
  });

  // tRPC middleware
  app.use(
    "/api/trpc",
    trpcExpress.createExpressMiddleware({
      router: appRouter,
      createContext,
    })
  );

  // Export picks endpoint — returns portfolio JSON for a given strategy and can run backtest
  app.post('/api/export-picks', async (req, res) => {
    try {
      const {
        strategy = 'composite',
        limit = 20,
        riskModel = 'risk_parity',
        start,
        end,
        horizon = 15,
        minScore = 0,
        runBacktest = false,
      } = req.body || {};

      const { getStrategyStocks } = await import('./src/server/quantScoringService');
      const portfolioModule = await import('./src/server/portfolio');
      const rows = await Promise.resolve(getStrategyStocks(strategy, limit, {}));
      const symbols = rows.map((r: any) => r.symbol).slice(0, limit);
      let picks: any;
      if (riskModel === 'equal') {
        const w = 1 / Math.max(1, symbols.length);
        picks = symbols.map((s: string) => ({ symbol: s, weight: w }));
      } else {
        picks = await Promise.resolve(portfolioModule.default.buildRiskParityWeights(symbols, 90));
      }

      const result: any = { success: true, strategy, limit, riskModel, picks };

      if (runBacktest) {
        // Write symbols to temp file
        const tmp = require('path').join(process.cwd(), 'picks_export_tmp.json');
        const fs = require('fs');
        fs.writeFileSync(tmp, JSON.stringify(symbols));

        // Determine python executable
        const isWin = process.platform === 'win32';
        const py = isWin ? 'backend-python\\venv\\Scripts\\python.exe' : 'backend-python/venv/bin/python';
        const { spawn } = require('child_process');
        const args = ['scripts/run_portfolio_backtest.py', '--symbols-file', tmp, '--start', (start || ''), '--end', (end || ''), '--horizon', String(horizon), '--name', `export_run_${Date.now()}`];
        // Filter out empty start/end
        const cleanArgs = args.filter(a => a !== '');

        const child = spawn(py, cleanArgs, { cwd: process.cwd() });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
        child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });

        const exitCode: number = await new Promise((resolve) => {
          child.on('close', (code: number) => resolve(code ?? 0));
        });

        // Attempt to extract the final JSON object from stdout
        let btStats: any = null;
        try {
          const lastBrace = stdout.lastIndexOf('{');
          if (lastBrace !== -1) {
            const candidate = stdout.slice(lastBrace);
            btStats = JSON.parse(candidate);
          }
        } catch (e) {
          try {
            // fallback: look for the last JSON-looking block
            const match = stdout.match(/\{[\s\S]*\}$/);
            if (match) btStats = JSON.parse(match[0]);
          } catch (e2) {
            btStats = { error: 'Failed to parse backtester output', stdout, stderr };
          }
        }

        // Remove temp file
        try { fs.unlinkSync(tmp); } catch (e) { /* ignore */ }

        result.backtest = { exitCode, stdoutSnippet: stdout.slice(-2000), stderrSnippet: stderr.slice(-2000), stats: btStats };
      }

      res.json(result);
    } catch (err: any) {
      console.error('/api/export-picks error', err?.message || err);
      res.status(500).json({ success: false, error: err?.message || String(err) });
    }
  });

  // Health check
  app.get("/api/health", (req, res) => {
    res.json({ status: "ok", timestamp: new Date().toISOString() });
  });

  // SSE and Webhook for Alerts
  const { sseHandler, broadcastAlert } = await import('./src/server/sse');
  app.get("/api/stream", sseHandler);
  app.post("/api/internal/notify", (req, res) => {
    broadcastAlert(req.body);
    res.json({ success: true });
  });

  // Must come after all routes, before the Vite/static-file catch-alls -- no-op without
  // SENTRY_DSN (sentryEnabled() guards it so an unconfigured Sentry client never intercepts
  // Express's default error handling).
  if (sentryEnabled()) {
    Sentry.setupExpressErrorHandler(app);
  }

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

  // PHASE 3.2: Create HTTP server and attach WebSocket service
  const httpServer = createHttpServer(app);
  wsSignalService.initialize(httpServer);

  httpServer.listen(PORT, "0.0.0.0", () => {
    console.log(`🚀 Server running on http://localhost:${PORT}`);
    console.log(`📡 WebSocket signals available on ws://localhost:${PORT}/signals`);
  });
}

startServer().catch((error) => {
  log.error("Failed to start server", { error: error?.message || String(error), stack: error?.stack });
  process.exit(1);
});

// Graceful shutdown — close BullMQ workers before exiting
for (const sig of ['SIGTERM', 'SIGINT'] as NodeJS.Signals[]) {
  process.on(sig, async () => {
    console.log(`[SERVER] ${sig} received, shutting down services...`);
    wsSignalService.shutdown();  // PHASE 3.2: Shutdown WebSocket
    await shutdownQueues();
    await stopRedis();
    await stopOllama();
    process.exit(0);
  });
}
