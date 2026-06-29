import { MarketData } from "../services/marketService";
import { getAllStocks, getStockMapping } from "./stockMapping";
import { mcFetchJson } from "./mcApiService";
import { nseStocksData } from "../data/nseStocks";
import { cacheGet, cacheSet } from "./cacheService";
import { dbAll, dbRun } from "./dbAsync";

// ─── Symbol & name resolution ─────────────────────────────────────────────────

/** Combined NSE symbols: computed once at module load — avoids re-allocation on every refresh. */
const ALL_NSE_SYMBOLS: string[] = (() => {
  const stocklistSymbols = getAllStocks().map((s) => s.symbol);
  const nseSymbols = nseStocksData.map((s) => s.symbol);
  return [...new Set([...stocklistSymbols, ...nseSymbols])];
})();

/** O(1) lookup map for the 180-stock list — used by MC/Finnhub quote fetchers. */
const _stocklistMap = new Map(getAllStocks().map((s) => [s.symbol, s]));

const _nameMap: Map<string, string> = (() => {
  const m = new Map<string, string>();
  for (const s of nseStocksData) m.set(s.symbol, s.name);
  for (const s of getAllStocks()) m.set(s.symbol, s.name);
  return m;
})();

const _sectorMap: Map<string, string> = (() => {
  const m = new Map<string, string>();
  for (const s of nseStocksData)
    if (s.sector && s.sector !== "Unknown") m.set(s.symbol, s.sector);
  return m;
})();

// ─── Yahoo Finance session variables ─────────────────────────────────────────
let yfCookie: string | null = null;
let yfCrumb: string | null = null;
let lastHandshakeTime = 0;

let yfHandshakeInFlight: Promise<{ cookie: string; crumb: string } | null> | null = null;

async function ensureYahooFinanceSession(): Promise<{ cookie: string; crumb: string } | null> {
  const now = Date.now();
  if (yfCookie && yfCrumb && now - lastHandshakeTime < 3600000) {
    return { cookie: yfCookie, crumb: yfCrumb };
  }
  // Deduplicate concurrent callers — only one handshake at a time
  if (yfHandshakeInFlight) return yfHandshakeInFlight;

  yfHandshakeInFlight = (async () => {
    const headers = {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
    };

    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const resCookie = await fetchWithTimeout("https://fc.yahoo.com", { headers });
        const setCookieHeaders = resCookie.headers.getSetCookie();
        const cookies = setCookieHeaders.map((c: string) => c.split(';')[0]).join('; ');

        if (!cookies) {
          console.warn(`[LIVE DATA] YF handshake attempt ${attempt}: no cookies from fc.yahoo.com`);
          if (attempt < 3) await new Promise(r => setTimeout(r, 1000 * attempt));
          continue;
        }

        const resCrumb = await fetchWithTimeout("https://query2.finance.yahoo.com/v1/test/getcrumb", {
          headers: { ...headers, Cookie: cookies },
        });
        const crumb = (await resCrumb.text()).trim();

        if (resCrumb.status !== 200 || !crumb) {
          console.warn(`[LIVE DATA] YF handshake attempt ${attempt}: getcrumb status ${resCrumb.status}`);
          if (attempt < 3) await new Promise(r => setTimeout(r, 1000 * attempt));
          continue;
        }

        yfCookie = cookies;
        yfCrumb = crumb;
        lastHandshakeTime = Date.now();
        console.log(`[LIVE DATA] Yahoo Finance handshake OK (attempt ${attempt})`);
        return { cookie: yfCookie, crumb: yfCrumb };
      } catch (err: any) {
        console.error(`[LIVE DATA] YF handshake attempt ${attempt} error:`, err.message);
        if (attempt < 3) await new Promise(r => setTimeout(r, 1000 * attempt));
      }
    }
    // Return stale session if we have one rather than null
    if (yfCookie && yfCrumb) {
      console.warn("[LIVE DATA] YF handshake failed — reusing stale session");
      return { cookie: yfCookie, crumb: yfCrumb };
    }
    return null;
  })().finally(() => { yfHandshakeInFlight = null; });

  return yfHandshakeInFlight;
}

// ─── Yahoo Finance batch fetch (v7) ──────────────────────────────────────────

const BATCH_SIZE = 50;
const BATCH_CONCURRENCY = 8;
const QUOTE_FETCH_TIMEOUT_MS = Number(process.env.QUOTE_FETCH_TIMEOUT_MS ?? 8000);
const MAX_INDIVIDUAL_FALLBACKS = Number(process.env.MAX_INDIVIDUAL_FALLBACKS ?? 250);

// ─── Pacing + circuit breaker (avoid Yahoo throttling / ban) ──────────────────
const BATCH_GROUP_DELAY_MS = Number(process.env.YF_BATCH_GROUP_DELAY_MS ?? 250);
const YF_CIRCUIT_COOLDOWN_MS = Number(process.env.YF_CIRCUIT_COOLDOWN_MS ?? 5 * 60_000);
const YF_TRIP_FAIL_RATE = 0.5;   // trip if >50% of batches in a refresh fail
let yfCircuitOpenUntil = 0;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
/** base..2*base ms — spreads bursts so we don't hammer Yahoo on a fixed cadence. */
const jitter = (base: number) => base + Math.floor(Math.random() * base);

async function fetchWithTimeout(url: string, init: RequestInit = {}): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), QUOTE_FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchBatchYahooFinance(
  symbols: string[],
): Promise<Map<string, MarketData>> {
  const session = await ensureYahooFinanceSession();
  const crumbParam = session ? `&crumb=${session.crumb}` : '';
  const requestHeaders: Record<string, string> = {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    Accept: "application/json",
  };
  if (session) {
    requestHeaders["Cookie"] = session.cookie;
  }

  const yfSymbols = symbols.map((s) => `${s}.NS`).join(",");
  const url =
    `https://query2.finance.yahoo.com/v7/finance/quote?symbols=${yfSymbols}${crumbParam}` +
    `&fields=regularMarketPrice,regularMarketChange,regularMarketChangePercent,` +
    `regularMarketVolume,regularMarketDayHigh,regularMarketDayLow,` +
    `regularMarketOpen,regularMarketPreviousClose,fiftyTwoWeekHigh,fiftyTwoWeekLow`;

  const response = await fetchWithTimeout(url, {
    headers: requestHeaders,
  });

  if (!response.ok) {
    console.error(`[LIVE DATA] Yahoo Finance batch fetch failed with status ${response.status}`);
    return new Map();
  }

  const data = await response.json();
  const quotes: any[] = data.quoteResponse?.result ?? [];
  const result = new Map<string, MarketData>();

  for (const q of quotes) {
    const nseSymbol = (q.symbol as string).replace(/\.(NS|BO)$/, "");
    const name = _nameMap.get(nseSymbol) || nseSymbol;

    const price: number = q.regularMarketPrice ?? 0;
    const prevClose: number = q.regularMarketPreviousClose ?? 0;
    const change: number = q.regularMarketChange ?? price - prevClose;
    const changePct: number = q.regularMarketChangePercent ?? 0;

    result.set(nseSymbol, {
      symbol: nseSymbol,
      name,
      price: Number(price.toFixed(2)),
      change: Number(change.toFixed(2)),
      changePct: Number(changePct.toFixed(2)),
      volume: formatVolume(q.regularMarketVolume ?? 0),
      high: q.regularMarketDayHigh ?? 0,
      low: q.regularMarketDayLow ?? 0,
      open: q.regularMarketOpen ?? 0,
      prevClose: Number(prevClose.toFixed(2)),
      high52w: q.fiftyTwoWeekHigh ?? undefined,
      low52w: q.fiftyTwoWeekLow ?? undefined,
      sector: _sectorMap.get(nseSymbol),
    });
  }

  return result;
}

// ─── Yahoo Finance per-symbol fallback (v8 chart) ────────────────────────────

async function fetchStockQuoteYahooFinance(
  symbol: string,
): Promise<MarketData | null> {
  try {
    const name = _nameMap.get(symbol) || symbol;

    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}.NS?interval=1d&range=1d`;
    const response = await fetchWithTimeout(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        Accept: "application/json",
      },
    });

    if (!response.ok) return null;

    const data = await response.json();
    const result = data.chart?.result?.[0];
    if (!result) return null;

    const meta = result.meta;
    const price: number = meta.regularMarketPrice ?? 0;
    const prevClose: number =
      meta.chartPreviousClose ?? meta.previousClose ?? 0;
    const change = price - prevClose;
    const changePct = prevClose > 0 ? (change / prevClose) * 100 : 0;
    const volumeArr: number[] = result.indicators?.quote?.[0]?.volume ?? [];
    const volume =
      volumeArr.length > 0 ? (volumeArr[volumeArr.length - 1] ?? 0) : 0;

    return {
      symbol,
      name,
      price: Number(price.toFixed(2)),
      change: Number(change.toFixed(2)),
      changePct: Number(changePct.toFixed(2)),
      volume: formatVolume(volume),
      high: meta.regularMarketDayHigh ?? 0,
      low: meta.regularMarketDayLow ?? 0,
      open: meta.regularMarketOpen ?? 0,
      prevClose: Number(prevClose.toFixed(2)),
    };
  } catch {
    return null;
  }
}

// ─── MoneyControl (secondary, kept for stocklist stocks only) ─────────────────

export async function fetchStockQuoteMoneyControl(
  symbol: string,
  retries: number = 3,
): Promise<MarketData | null> {
  const stockMapping = _stocklistMap.get(symbol);
  if (!stockMapping) return null;

  const url = `https://www.moneycontrol.com/mcapi/v1/quote/${stockMapping.mcsymbol}`;
  const data = await mcFetchJson(url, retries, symbol);

  const quote = data?.data?.quote;
  if (!quote) return null;

  const price: number = quote.ltPrice ?? quote.lastPrice ?? 0;
  const prevClose: number = quote.previousPrice ?? quote.prevClose ?? 0;
  const change = price - prevClose;
  const changePct = prevClose > 0 ? (change / prevClose) * 100 : 0;

  return {
    symbol,
    name: stockMapping.name,
    price: Number(price.toFixed(2)),
    change: Number(change.toFixed(2)),
    changePct: Number(changePct.toFixed(2)),
    volume: formatVolume(quote.totalTradedVolume ?? 0),
    high: quote.highPrice ?? quote.high ?? 0,
    low: quote.lowPrice ?? quote.low ?? 0,
    open: quote.openPrice ?? quote.open ?? 0,
    prevClose: Number(prevClose.toFixed(2)),
  };
}

// ─── Finnhub (tertiary, requires env var) ────────────────────────────────────

export async function fetchStockQuoteFinnhub(
  symbol: string,
): Promise<MarketData | null> {
  try {
    const apiKey = process.env.FINNHUB_API_KEY;
    if (!apiKey) return null;

    const name = _nameMap.get(symbol) || symbol;

    const url = `https://finnhub.io/api/v1/quote?symbol=${symbol}.NS&token=${apiKey}`;
    const response = await fetch(url);
    if (!response.ok) return null;

    const data = await response.json();
    const price: number = data.c ?? 0;
    const prevClose: number = data.pc ?? 0;

    return {
      symbol,
      name,
      price,
      change: Number((price - prevClose).toFixed(2)),
      changePct:
        prevClose > 0
          ? Number((((price - prevClose) / prevClose) * 100).toFixed(2))
          : 0,
      volume: formatVolume(0),
      high: data.h ?? 0,
      low: data.l ?? 0,
      open: data.o ?? 0,
      prevClose,
    };
  } catch {
    return null;
  }
}

// ─── Parallel bulk fetch ──────────────────────────────────────────────────────

export async function fetchAllLiveStocks(): Promise<MarketData[]> {
  const allSymbols = ALL_NSE_SYMBOLS;

  // Circuit breaker: if Yahoo recently failed en masse, skip this refresh entirely so
  // the caller keeps serving the existing cache/mirror instead of hammering a throttled host.
  if (Date.now() < yfCircuitOpenUntil) {
    const secs = Math.ceil((yfCircuitOpenUntil - Date.now()) / 1000);
    console.warn(`[LIVE DATA] Yahoo circuit OPEN (${secs}s left) — skipping refresh, serving cache.`);
    return [];
  }

  console.log(
    `[LIVE DATA] Fetching ${allSymbols.length} NSE stocks via Yahoo Finance (parallel batches)...`,
  );

  const collected = new Map<string, MarketData>();

  // Split into chunks of 50, run BATCH_CONCURRENCY at a time
  const chunks: string[][] = [];
  for (let i = 0; i < allSymbols.length; i += BATCH_SIZE) {
    chunks.push(allSymbols.slice(i, i + BATCH_SIZE));
  }

  let batchFailures = 0;
  for (let i = 0; i < chunks.length; i += BATCH_CONCURRENCY) {
    const group = chunks.slice(i, i + BATCH_CONCURRENCY);
    const groupResults = await Promise.allSettled(
      group.map((batch) => fetchBatchYahooFinance(batch)),
    );
    for (const r of groupResults) {
      if (r.status === "fulfilled") {
        r.value.forEach((v, k) => collected.set(k, v));
      } else {
        batchFailures++;
        console.error(
          `[LIVE DATA] Batch group ${i / BATCH_CONCURRENCY + 1} had failure:`,
          r.reason,
        );
      }
    }
    // Jittered pause between groups so we don't fire ~50 requests on a fixed cadence.
    if (i + BATCH_CONCURRENCY < chunks.length) await sleep(jitter(BATCH_GROUP_DELAY_MS));
  }

  // Trip the breaker if a large fraction of batches failed (likely throttled/banned).
  if (chunks.length > 0 && batchFailures / chunks.length > YF_TRIP_FAIL_RATE) {
    yfCircuitOpenUntil = Date.now() + YF_CIRCUIT_COOLDOWN_MS;
    console.warn(
      `[LIVE DATA] ${batchFailures}/${chunks.length} batches failed — tripping Yahoo circuit for ${YF_CIRCUIT_COOLDOWN_MS / 1000}s.`,
    );
  }

  // Per-symbol YF v8 fallback for symbols the batch missed
  const missed = allSymbols.filter((s) => !collected.has(s));
  if (missed.length > 0 && collected.size > 0 && missed.length <= MAX_INDIVIDUAL_FALLBACKS) {
    console.log(
      `[LIVE DATA] Retrying ${missed.length} missed symbols individually...`,
    );
    const fallbacks = await Promise.allSettled(
      missed.map((s) => fetchStockQuoteYahooFinance(s)),
    );
    fallbacks.forEach((r) => {
      if (r.status === "fulfilled" && r.value) {
        collected.set(r.value.symbol, r.value);
      }
    });
  } else if (missed.length > MAX_INDIVIDUAL_FALLBACKS || (missed.length > 0 && collected.size === 0)) {
    console.warn(
      `[LIVE DATA] Skipping individual fallback for ${missed.length} symbols after weak/failed batch fetch.`,
    );
  }

  // MoneyControl last-resort removed to prevent API rate limits (503s) and blocking the global mcSemaphore.
  // Missing symbols will be fetched on-demand when visible via getLiveQuotesBatch.

  await ensureDbMappings();
  const results = Array.from(collected.values()).map(enrichMarketData);
  console.log(
    `[LIVE DATA] Successfully fetched ${results.length}/${allSymbols.length} stock quotes`,
  );
  return results;
}

// ─── Cache keys ───────────────────────────────────────────────────────────────

const BULK_CACHE_KEY = "live-stocks-bulk";
const PER_SYMBOL_TTL = 30; // seconds
const BULK_TTL = 5 * 60; // 5 minutes
const BULK_REFRESH_INTERVAL = BULK_TTL * 1000;

// In-memory mirror of bulk data for O(1) symbol lookups (avoids deserialising
// the full ~2000-entry JSON blob from Redis on every quote request).
let bulkMirror: Map<string, MarketData> = new Map();
let lastBulkFetchTime = 0;

// ─── Indian Market Hours Utility ─────────────────────────────────────────────

/** Checks if the current time is within Indian Market Hours (9:15 - 15:30 IST, Mon-Fri). */
export function isIndianMarketOpen(): boolean {
  const now = new Date();

  // Convert UTC time to IST (UTC + 5:30)
  const istOffset = 5.5 * 60 * 60 * 1000;
  const istTime = new Date(now.getTime() + istOffset);

  const day = istTime.getUTCDay(); // 0 is Sunday, 6 is Saturday
  if (day === 0 || day === 6) return false; // Weekend

  const hours = istTime.getUTCHours();
  const minutes = istTime.getUTCMinutes();

  const timeInMinutes = hours * 60 + minutes;
  const marketOpen = 9 * 60 + 15; // 9:15 AM
  const marketClose = 15 * 60 + 30; // 3:30 PM

  return timeInMinutes >= marketOpen && timeInMinutes <= marketClose;
}

// ─── Background refresh task ─────────────────────────────────────────────────

let refreshRunning = false;
let hasFetchedOnce = false;

async function runBulkRefresh(): Promise<void> {
  if (refreshRunning) return;

  // If market is closed and we already have data, skip fetching to reduce load
  if (!isIndianMarketOpen() && hasFetchedOnce) {
    console.log("[LIVE DATA] Market is closed. Skipping background refresh.");
    return;
  }

  refreshRunning = true;
  try {
    const freshData = await fetchAllLiveStocks();
    if (freshData.length === 0) {
      console.warn("[LIVE DATA] Refresh returned no quotes; keeping existing cache/mirror.");
      return;
    }

    bulkMirror = new Map(freshData.map((s) => [s.symbol, s]));
    lastBulkFetchTime = Date.now();
    hasFetchedOnce = true;

    // If market closed, cache for a long time (until next open approx), else standard TTL
    const ttl = isIndianMarketOpen() ? BULK_TTL : 12 * 60 * 60; // 12 hours when closed
    await cacheSet(BULK_CACHE_KEY, freshData, ttl);

    console.log(
      `[LIVE DATA] Background refresh complete: ${freshData.length} stocks cached (TTL: ${ttl}s)`,
    );
  } catch (err) {
    console.error("[LIVE DATA] Background refresh failed:", err);
  } finally {
    refreshRunning = false;
  }
}

/** Start the periodic background refresh. Call once on server start. */
export function startBackgroundRefresh(): void {
  // Kick off an immediate refresh, then repeat on interval.
  runBulkRefresh();
  const _handle = setInterval(runBulkRefresh, BULK_REFRESH_INTERVAL);
  _handle.unref?.(); // don't block process exit in test/shutdown scenarios
  console.log(
    `[LIVE DATA] Background refresh started (every ${BULK_TTL / 60} min)`,
  );
}

// ─── Per-symbol cache (Redis / in-memory, 30-sec TTL) ────────────────────────

export async function fetchStockDataWithCache(
  symbol: string,
): Promise<MarketData | null> {
  const perKey = `live-stock:${symbol}`;

  // 1. Per-symbol short-lived cache
  const cached = await cacheGet<MarketData>(perKey);
  if (cached) return cached;

  // 2. Bulk mirror (populated by background refresh)
  if (bulkMirror.has(symbol)) return bulkMirror.get(symbol)!;

  // 3. Try to hydrate bulk mirror from Redis/memory cache
  if (bulkMirror.size === 0) {
    const bulk = await cacheGet<MarketData[]>(BULK_CACHE_KEY);
    if (bulk && bulk.length > 0) {
      bulkMirror = new Map(bulk.map((s) => [s.symbol, s]));
      if (bulkMirror.has(symbol)) return bulkMirror.get(symbol)!;
    }
  }

  // 4. Individual fetch as last resort
  let quoteData = await fetchStockQuoteYahooFinance(symbol);
  if (!quoteData) quoteData = await fetchStockQuoteMoneyControl(symbol, 1);
  if (!quoteData && process.env.FINNHUB_API_KEY)
    quoteData = await fetchStockQuoteFinnhub(symbol);

  if (quoteData) {
    await ensureDbMappings();
    quoteData = enrichMarketData(quoteData);
    await cacheSet(perKey, quoteData, PER_SYMBOL_TTL);
  }

  return quoteData;
}

// ─── Bulk accessor (used by getLiveStocks route) ──────────────────────────────

export async function getOrRefreshAllStocks(): Promise<MarketData[]> {
  const now = Date.now();

  // Serve from in-process mirror if still fresh
  if (bulkMirror.size > 0 && now - lastBulkFetchTime < BULK_REFRESH_INTERVAL) {
    return Array.from(bulkMirror.values());
  }

  // Try Redis / memory cache
  const cached = await cacheGet<MarketData[]>(BULK_CACHE_KEY);
  if (cached && cached.length > 0) {
    bulkMirror = new Map(cached.map((s) => [s.symbol, s]));
    lastBulkFetchTime = now;
    return cached;
  }

  // Synchronous refresh (only happens on cold start before background task runs)
  await runBulkRefresh();
  return Array.from(bulkMirror.values());
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatVolume(volume: number): string {
  if (volume >= 1_000_000) return (volume / 1_000_000).toFixed(1) + "M";
  if (volume >= 1_000) return (volume / 1_000).toFixed(1) + "K";
  return volume.toString();
}

// ─── DB Mappings Cache ───────────────────────────────────────────────────────
let dbMappingsCache: Map<string, { mcsymbol: string | null; tlid: string | null; tlname: string | null }> | null = null;
let dbMappingsLoading: Promise<void> | null = null;  // singleton guard against concurrent init

async function ensureDbMappings() {
  if (dbMappingsCache) return;
  // If a load is already in-flight, wait for it instead of firing another DB query
  if (dbMappingsLoading) return dbMappingsLoading;
  dbMappingsLoading = (async () => {
    try {
      const rows = await dbAll<any>('SELECT symbol, mcsymbol, tlid, tlname FROM nse_stocks WHERE mcsymbol IS NOT NULL OR tlid IS NOT NULL');
      dbMappingsCache = new Map();
      for (const row of rows) {
        dbMappingsCache.set(row.symbol, { mcsymbol: row.mcsymbol, tlid: row.tlid, tlname: row.tlname });
      }
      console.log(`[LIVE DATA] Loaded ${dbMappingsCache.size} tertiary API mappings from database.`);
    } catch (err: any) {
      console.error('[LIVE DATA] Failed to load DB mappings:', err.message);
      dbMappingsCache = new Map();
    } finally {
      dbMappingsLoading = null;
    }
  })();
  return dbMappingsLoading;
}

/**
 * Enriches market data with mapped tickers from stocklist.ts and DB
 */
function enrichMarketData(data: MarketData): MarketData {
  const mapping = getStockMapping(data.symbol);
  if (mapping) {
    return {
      ...data,
      mcsymbol: mapping.mcsymbol,
      tlid: mapping.tlid,
      tlname: mapping.tlname,
    };
  }

  // Fallback to database cache (pre-loaded via ensureDbMappings before enrichment)
  const dbMapping = dbMappingsCache?.get(data.symbol);
  if (dbMapping && (dbMapping.mcsymbol || dbMapping.tlid)) {
    return {
      ...data,
      mcsymbol: dbMapping.mcsymbol || undefined,
      tlid: dbMapping.tlid || undefined,
      tlname: dbMapping.tlname || undefined,
    };
  }

  // Stock is in NSE master list but not in 180-stock mapping — provider IDs unavailable
  // console.debug(`[enrichMarketData] No provider mapping for ${data.symbol}; MC/TL calls will be skipped`);
  return data;
}

// ─── PHASE 1 FIX: Persist OHLCV data to database ───────────────────────────────

/**
 * Persists today's OHLCV data to stock_ohlcv table for backtesting
 * Called daily after market close via BullMQ queue
 */
function parseVolumeToNumber(v: string | number): number {
  if (typeof v === 'number') return Math.round(v);
  if (v.endsWith('M')) return Math.round(parseFloat(v) * 1_000_000);
  if (v.endsWith('K')) return Math.round(parseFloat(v) * 1_000);
  return Math.round(parseFloat(v) || 0);
}

export async function persistTodayOHLCVData(stocks: MarketData[]): Promise<{ inserted: number; failed: number }> {
  const today = new Date().toISOString().split('T')[0];

  const insertSql = `
    INSERT INTO stock_ohlcv (symbol, date, open, high, low, close, volume)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(symbol, date) DO UPDATE SET
      open=excluded.open,
      high=excluded.high,
      low=excluded.low,
      close=excluded.close,
      volume=excluded.volume
  `;

  let inserted = 0;
  let failed = 0;

  // Per-row upserts (not a single transaction): the loop tolerates and counts
  // per-row failures, which a Postgres transaction can't do — one failed
  // statement aborts the whole tx until rollback.
  for (const stock of stocks) {
    try {
      await dbRun(insertSql, [
        stock.symbol,
        today,
        stock.open || stock.prevClose || stock.price,
        stock.high || stock.price,
        stock.low || stock.price,
        stock.price,
        parseVolumeToNumber(stock.volume),
      ]);
      inserted++;
    } catch (err: any) {
      console.error(`[OHLCV] Failed to persist ${stock.symbol}:`, err.message);
      failed++;
    }
  }

  console.log(`[OHLCV] Persisted ${inserted}/${stocks.length} stocks for ${today}, failed: ${failed}`);
  return { inserted, failed };
}

/**
 * Wrapper for BullMQ queue worker
 * Fetches latest stocks and persists OHLCV data
 */
export async function fetchAndPersistOHLCVData(): Promise<{ count: number; persisted: number }> {
  try {
    const stocks = await fetchAllLiveStocks();
    const result = await persistTodayOHLCVData(stocks);
    
    // PHASE 2.4 FIX: Detect significant price movements and trigger signal updates
    await detectAndQueueSignalUpdates(stocks);

    // Enqueue a technical signal re-scan for stocks that moved ≥5% intraday
    try {
      const { technicalSignalsQueue } = await import('./queues');
      if (technicalSignalsQueue) {
        const bigMovers = stocks
          .filter(s => Math.abs(s.changePct) >= 5)
          .map(s => s.symbol)
          .filter(Boolean);

        if (bigMovers.length > 0) {
          await technicalSignalsQueue.add(
            'scan-movers',
            { symbols: bigMovers, reason: 'intraday-move-5pct' },
            { removeOnComplete: { age: 3600 }, attempts: 2 },
          );
          console.log(`[OHLCV] Enqueued technical scan for ${bigMovers.length} big movers`);
        }
      }
    } catch {
      // queue trigger is best-effort
    }

    return { count: stocks.length, persisted: result.inserted };
  } catch (err: any) {
    console.error('[OHLCV] Error in fetchAndPersistOHLCVData:', err.message);
    return { count: 0, persisted: 0 };
  }
}

// ─── PHASE 2.4 FIX: Detect price changes and trigger signal updates ─────────

const PRICE_CHANGE_THRESHOLD = 2.0;  // Re-evaluate signals if price moves > 2%
const lastPriceCache = new Map<string, number>();  // Track previous prices

/**
 * Detects significant price movements and queues signal re-evaluation
 * Called after each stock refresh to trigger dynamic signal updates
 */
async function detectAndQueueSignalUpdates(stocks: MarketData[]): Promise<void> {
  const symbelsToUpdate: string[] = [];

  // Import once outside the loop — best-effort; silently skip if WS not ready
  let wsSvc: { checkAndBroadcastPriceMove: (symbol: string, price: number) => void } | null = null;
  try {
    const { wsSignalService } = await import('./websocketService');
    wsSvc = wsSignalService;
  } catch { /* WS service unavailable */ }

  for (const stock of stocks) {
    // Always notify WS service so it can check its own 2% threshold and broadcast
    wsSvc?.checkAndBroadcastPriceMove(stock.symbol, stock.price);

    const lastPrice = lastPriceCache.get(stock.symbol);
    if (!lastPrice) {
      lastPriceCache.set(stock.symbol, stock.price);
      continue;
    }

    const priceChange = Math.abs((stock.price - lastPrice) / lastPrice * 100);

    if (priceChange > PRICE_CHANGE_THRESHOLD) {
      console.log(`[SIGNAL-UPDATE] ${stock.symbol}: ${priceChange.toFixed(2)}% price move detected`);
      symbelsToUpdate.push(stock.symbol);
    }

    lastPriceCache.set(stock.symbol, stock.price);
  }

  // Queue signal updates for affected symbols
  if (symbelsToUpdate.length > 0) {
    try {
      const { technicalSignalsQueue } = await import('./queues');
      if (technicalSignalsQueue) {
        await technicalSignalsQueue.add(
          'signal-update-batch',
          { symbols: symbelsToUpdate },
          {
            removeOnComplete: true,
            attempts: 1,
          }
        );
        console.log(`[SIGNAL-UPDATE] Queued ${symbelsToUpdate.length} symbols for signal re-evaluation`);
      }
    } catch (err: any) {
      console.warn('[SIGNAL-UPDATE] Could not queue signal updates:', err.message);
    }
  }
}

/**
 * Clear price cache (useful after market close or for testing)
 */
export function clearPriceCache(): void {
  lastPriceCache.clear();
  console.log('[PRICE-CACHE] Cleared');
}

// Clear price cache daily at 15:35 IST (10:05 UTC) to remove delisted/renamed symbols
function scheduleDailyPriceCacheClear() {
  const now = new Date();
  const utcH = now.getUTCHours(), utcM = now.getUTCMinutes();
  const minutesUntilClear = ((10 * 60 + 5) - (utcH * 60 + utcM) + 1440) % 1440;
  setTimeout(() => {
    clearPriceCache();
    setInterval(clearPriceCache, 24 * 60 * 60_000);
  }, minutesUntilClear * 60_000);
}
scheduleDailyPriceCacheClear();


