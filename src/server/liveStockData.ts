import { MarketData } from "../services/marketService";
import { getAllStocks, getStockMapping } from "./stockMapping";
import { mcFetchJson } from "./mcApiService";
import { nseStocksData } from "../data/nseStocks";
import { cacheGet, cacheSet } from "./cacheService";

// ─── Symbol & name resolution ─────────────────────────────────────────────────

/** Combined NSE symbols: stocklist (180) + full NSE list (2000+), deduplicated. */
function getAllNSESymbols(): string[] {
  const stocklistSymbols = getAllStocks().map((s) => s.symbol);
  const nseSymbols = nseStocksData.map((s) => s.symbol);
  return [...new Set([...stocklistSymbols, ...nseSymbols])];
}

/** Name lookup: nseStocksData as base, stocklist overrides (more canonical names). */
function buildNameMap(): Map<string, string> {
  const map = new Map<string, string>();
  for (const s of nseStocksData) map.set(s.symbol, s.name);
  for (const s of getAllStocks()) map.set(s.symbol, s.name);
  return map;
}

/** Sector lookup from nseStocksData (only non-Unknown entries). */
function buildSectorMap(): Map<string, string> {
  const map = new Map<string, string>();
  for (const s of nseStocksData) {
    if (s.sector && s.sector !== "Unknown") map.set(s.symbol, s.sector);
  }
  return map;
}

// ─── Yahoo Finance batch fetch (v7) ──────────────────────────────────────────

const BATCH_SIZE = 50;
const BATCH_CONCURRENCY = 8;
const QUOTE_FETCH_TIMEOUT_MS = Number(process.env.QUOTE_FETCH_TIMEOUT_MS ?? 8000);
const MAX_INDIVIDUAL_FALLBACKS = Number(process.env.MAX_INDIVIDUAL_FALLBACKS ?? 250);

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
  const nameMap = buildNameMap();
  const sectorMap = buildSectorMap();
  const yfSymbols = symbols.map((s) => `${s}.NS`).join(",");
  const url =
    `https://query2.finance.yahoo.com/v7/finance/quote?symbols=${yfSymbols}` +
    `&fields=regularMarketPrice,regularMarketChange,regularMarketChangePercent,` +
    `regularMarketVolume,regularMarketDayHigh,regularMarketDayLow,` +
    `regularMarketOpen,regularMarketPreviousClose,fiftyTwoWeekHigh,fiftyTwoWeekLow`;

  const response = await fetchWithTimeout(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      Accept: "application/json",
    },
  });

  if (!response.ok) return new Map();

  const data = await response.json();
  const quotes: any[] = data.quoteResponse?.result ?? [];
  const result = new Map<string, MarketData>();

  for (const q of quotes) {
    const nseSymbol = (q.symbol as string).replace(/\.(NS|BO)$/, "");
    const name = nameMap.get(nseSymbol) || nseSymbol;

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
      sector: sectorMap.get(nseSymbol),
    });
  }

  return result;
}

// ─── Yahoo Finance per-symbol fallback (v8 chart) ────────────────────────────

async function fetchStockQuoteYahooFinance(
  symbol: string,
): Promise<MarketData | null> {
  try {
    const nameMap = buildNameMap();
    const name = nameMap.get(symbol) || symbol;

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
  const stockMapping = getAllStocks().find((s) => s.symbol === symbol);
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

    const nameMap = buildNameMap();
    const name = nameMap.get(symbol) || symbol;

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
  const allSymbols = getAllNSESymbols();
  console.log(
    `[LIVE DATA] Fetching ${allSymbols.length} NSE stocks via Yahoo Finance (parallel batches)...`,
  );

  const collected = new Map<string, MarketData>();

  // Split into chunks of 50, run BATCH_CONCURRENCY at a time
  const chunks: string[][] = [];
  for (let i = 0; i < allSymbols.length; i += BATCH_SIZE) {
    chunks.push(allSymbols.slice(i, i + BATCH_SIZE));
  }

  for (let i = 0; i < chunks.length; i += BATCH_CONCURRENCY) {
    const group = chunks.slice(i, i + BATCH_CONCURRENCY);
    const groupResults = await Promise.allSettled(
      group.map((batch) => fetchBatchYahooFinance(batch)),
    );
    for (const r of groupResults) {
      if (r.status === "fulfilled") {
        r.value.forEach((v, k) => collected.set(k, v));
      } else {
        console.error(
          `[LIVE DATA] Batch group ${i / BATCH_CONCURRENCY + 1} had failure:`,
          r.reason,
        );
      }
    }
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
  setInterval(runBulkRefresh, BULK_REFRESH_INTERVAL);
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

/**
 * Enriches market data with mapped tickers from stocklist.ts
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
  return data;
}
