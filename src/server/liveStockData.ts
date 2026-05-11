import { MarketData } from '../services/marketService';
import { getAllStocks } from './stockMapping';

// ─── Yahoo Finance (primary, free, no API key) ───────────────────────────────

/**
 * Batch-fetch up to 50 NSE stocks at once via Yahoo Finance v7 quote API.
 * Returns a map of NSE symbol → raw YF quote object.
 */
async function fetchBatchYahooFinance(symbols: string[]): Promise<Map<string, MarketData>> {
  const stockList = getAllStocks();
  const yfSymbols = symbols.map(s => `${s}.NS`).join(',');
  const url =
    `https://query2.finance.yahoo.com/v7/finance/quote?symbols=${yfSymbols}` +
    `&fields=regularMarketPrice,regularMarketChange,regularMarketChangePercent,` +
    `regularMarketVolume,regularMarketDayHigh,regularMarketDayLow,` +
    `regularMarketOpen,regularMarketPreviousClose`;

  const response = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'Accept': 'application/json',
    },
  });

  if (!response.ok) return new Map();

  const data = await response.json();
  const quotes: any[] = data.quoteResponse?.result ?? [];
  const result = new Map<string, MarketData>();

  for (const q of quotes) {
    const nseSymbol = (q.symbol as string).replace(/\.(NS|BO)$/, '');
    const mapping = stockList.find(s => s.symbol === nseSymbol);
    if (!mapping) continue;

    const price: number = q.regularMarketPrice ?? 0;
    const prevClose: number = q.regularMarketPreviousClose ?? 0;
    const change: number = q.regularMarketChange ?? (price - prevClose);
    const changePct: number = q.regularMarketChangePercent ?? 0;

    result.set(nseSymbol, {
      symbol: nseSymbol,
      name: mapping.name,
      price: Number(price.toFixed(2)),
      change: Number(change.toFixed(2)),
      changePct: Number(changePct.toFixed(2)),
      volume: formatVolume(q.regularMarketVolume ?? 0),
      high: q.regularMarketDayHigh ?? 0,
      low: q.regularMarketDayLow ?? 0,
      open: q.regularMarketOpen ?? 0,
      prevClose: Number(prevClose.toFixed(2)),
    });
  }

  return result;
}

/**
 * Fetch a single stock from Yahoo Finance v8 chart API.
 * Used as a per-symbol fallback when the batch call misses a symbol.
 */
async function fetchStockQuoteYahooFinance(symbol: string): Promise<MarketData | null> {
  try {
    const stockMapping = getAllStocks().find(s => s.symbol === symbol);
    if (!stockMapping) return null;

    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}.NS?interval=1d&range=1d`;
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'application/json',
      },
    });

    if (!response.ok) return null;

    const data = await response.json();
    const result = data.chart?.result?.[0];
    if (!result) return null;

    const meta = result.meta;
    const price: number = meta.regularMarketPrice ?? 0;
    const prevClose: number = meta.chartPreviousClose ?? meta.previousClose ?? 0;
    const change = price - prevClose;
    const changePct = prevClose > 0 ? (change / prevClose) * 100 : 0;
    const volumeArr: number[] = result.indicators?.quote?.[0]?.volume ?? [];
    const volume = volumeArr.length > 0 ? (volumeArr[volumeArr.length - 1] ?? 0) : 0;

    return {
      symbol,
      name: stockMapping.name,
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

// ─── MoneyControl (secondary, kept for non-quote endpoints) ──────────────────

export async function fetchStockQuoteMoneyControl(symbol: string, retries: number = 3): Promise<MarketData | null> {
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const stockMapping = getAllStocks().find(s => s.symbol === symbol);
      if (!stockMapping) return null;

      const url = `https://www.moneycontrol.com/mcapi/v1/quote/${stockMapping.mcsymbol}`;

      const response = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
          'Accept': 'application/json, text/plain, */*',
          'Accept-Language': 'en-US,en;q=0.9',
          'Referer': 'https://www.moneycontrol.com/',
          'Origin': 'https://www.moneycontrol.com',
        },
      });

      if (!response.ok) {
        if (response.status === 503 && attempt < retries) {
          const delay = Math.min(1000 * Math.pow(2, attempt - 1), 10000) + Math.random() * 1000;
          console.warn(`Failed to fetch ${symbol} from MoneyControl: ${response.status}. Retrying in ${Math.round(delay)}ms (attempt ${attempt}/${retries})...`);
          await new Promise(resolve => setTimeout(resolve, delay));
          continue;
        }
        console.error(`Failed to fetch ${symbol} from MoneyControl:`, response.status);
        return null;
      }

      const data = await response.json();
      const quote = data.data?.quote;
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
    } catch (e) {
      lastError = e instanceof Error ? e : new Error(String(e));
      if (attempt < retries) {
        const delay = Math.min(1000 * Math.pow(2, attempt - 1), 10000) + Math.random() * 1000;
        console.warn(`MoneyControl fetch error for ${symbol}. Retrying in ${Math.round(delay)}ms (attempt ${attempt}/${retries})...`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }

  if (lastError) {
    console.error(`MoneyControl fetch failed for ${symbol} after ${retries} retries:`, lastError.message);
  }
  return null;
}

// ─── Finnhub (tertiary, requires env var) ────────────────────────────────────

export async function fetchStockQuoteFinnhub(symbol: string): Promise<MarketData | null> {
  try {
    const apiKey = process.env.FINNHUB_API_KEY;
    if (!apiKey) return null;

    const stockMapping = getAllStocks().find(s => s.symbol === symbol);
    if (!stockMapping) return null;

    const url = `https://finnhub.io/api/v1/quote?symbol=${symbol}.NS&token=${apiKey}`;
    const response = await fetch(url);
    if (!response.ok) return null;

    const data = await response.json();
    const price: number = data.c ?? 0;
    const prevClose: number = data.pc ?? 0;

    return {
      symbol,
      name: stockMapping.name,
      price,
      change: Number((price - prevClose).toFixed(2)),
      changePct: prevClose > 0 ? Number(((price - prevClose) / prevClose * 100).toFixed(2)) : 0,
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

// ─── Bulk fetch with batching ─────────────────────────────────────────────────

const BATCH_SIZE = 50;
const BATCH_DELAY_MS = 200;

export async function fetchAllLiveStocks(): Promise<MarketData[]> {
  const allStocks = getAllStocks();
  console.log(`[LIVE DATA] Fetching data for ${allStocks.length} stocks via Yahoo Finance...`);

  const allSymbols = allStocks.map(s => s.symbol);
  const collected = new Map<string, MarketData>();

  // Batch fetch via YF v7 (most efficient — 50 stocks per request)
  for (let i = 0; i < allSymbols.length; i += BATCH_SIZE) {
    const batch = allSymbols.slice(i, i + BATCH_SIZE);
    try {
      const batchResult = await fetchBatchYahooFinance(batch);
      batchResult.forEach((v, k) => collected.set(k, v));
    } catch (err) {
      console.error(`[LIVE DATA] Batch ${i / BATCH_SIZE + 1} failed:`, err);
    }
    if (i + BATCH_SIZE < allSymbols.length) {
      await new Promise(r => setTimeout(r, BATCH_DELAY_MS));
    }
  }

  // Per-symbol fallback (YF v8 chart) for anything the batch missed
  const missed = allSymbols.filter(s => !collected.has(s));
  if (missed.length > 0) {
    console.log(`[LIVE DATA] Retrying ${missed.length} symbols individually...`);
    const fallbacks = await Promise.allSettled(missed.map(s => fetchStockQuoteYahooFinance(s)));
    fallbacks.forEach(r => {
      if (r.status === 'fulfilled' && r.value) {
        collected.set(r.value.symbol, r.value);
      }
    });
  }

  // Last-resort: MoneyControl for anything still missing
  const stillMissed = allSymbols.filter(s => !collected.has(s));
  if (stillMissed.length > 0) {
    console.log(`[LIVE DATA] MoneyControl fallback for ${stillMissed.length} symbols...`);
    const mcResults = await Promise.allSettled(stillMissed.map(s => fetchStockQuoteMoneyControl(s)));
    mcResults.forEach(r => {
      if (r.status === 'fulfilled' && r.value) {
        collected.set(r.value.symbol, r.value);
      }
    });
  }

  const results = Array.from(collected.values());
  console.log(`[LIVE DATA] Successfully fetched ${results.length} stock quotes`);
  return results;
}

// ─── Per-symbol cache (30s TTL) ──────────────────────────────────────────────

const stockCache = new Map<string, { data: MarketData; timestamp: number }>();
const CACHE_DURATION = 30_000;

export async function fetchStockDataWithCache(symbol: string): Promise<MarketData | null> {
  const cached = stockCache.get(symbol);
  if (cached && Date.now() - cached.timestamp < CACHE_DURATION) {
    return cached.data;
  }

  let quoteData = await fetchStockQuoteYahooFinance(symbol);
  if (!quoteData) quoteData = await fetchStockQuoteMoneyControl(symbol);
  if (!quoteData && process.env.FINNHUB_API_KEY) quoteData = await fetchStockQuoteFinnhub(symbol);

  if (quoteData) {
    stockCache.set(symbol, { data: quoteData, timestamp: Date.now() });
  }

  return quoteData;
}

// ─── Periodic bulk refresh (every 5 min) ─────────────────────────────────────

let lastFetchTime = 0;
const REFRESH_INTERVAL = 5 * 60 * 1000;

export async function getOrRefreshAllStocks(): Promise<MarketData[]> {
  const now = Date.now();

  if (now - lastFetchTime < REFRESH_INTERVAL) {
    const stocks = getAllStocks();
    const results = await Promise.allSettled(stocks.map(s => fetchStockDataWithCache(s.symbol)));
    return results
      .filter((r): r is PromiseFulfilledResult<MarketData | null> => r.status === 'fulfilled' && r.value !== null)
      .map(r => r.value as MarketData);
  }

  lastFetchTime = now;
  return fetchAllLiveStocks();
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatVolume(volume: number): string {
  if (volume >= 1_000_000) return (volume / 1_000_000).toFixed(1) + 'M';
  if (volume >= 1_000) return (volume / 1_000).toFixed(1) + 'K';
  return volume.toString();
}
