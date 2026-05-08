import { MarketData } from '../services/marketService';
import { getAllStocks } from './stockMapping';

/**
 * LIVE DATA FETCHING MODULE
 * 
 * This module fetches real-time stock data from external APIs instead of using dummy data.
 * 
 * Data Sources:
 * 1. MoneyControl API - Primary source for Indian stock quotes
 * 2. Finnhub API - Alternative source (requires API key)
 * 3. BSE/NSE Direct APIs - Direct exchange data
 */

/**
 * Fetch stock quote data from MoneyControl
 * API: https://www.moneycontrol.com/mcapi/v1/quote/
 */
export async function fetchStockQuoteMoneyControl(symbol: string): Promise<MarketData | null> {
  try {
    const stockMapping = getAllStocks().find(s => s.symbol === symbol);
    if (!stockMapping) return null;

    // MoneyControl API endpoint for stock quote
    const url = `https://www.moneycontrol.com/mcapi/v1/quote/${stockMapping.mcsymbol}`;
    
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    });

    if (!response.ok) {
      console.error(`Failed to fetch ${symbol} from MoneyControl:`, response.status);
      return null;
    }

    const data = await response.json();
    
    // Transform MoneyControl data to MarketData format
    const quote = data.data?.quote;
    if (!quote) return null;

    return {
      symbol: symbol,
      name: stockMapping.name,
      price: quote.ltPrice || quote.lastPrice || 0,
      change: (quote.ltPrice || quote.lastPrice || 0) - (quote.previousPrice || quote.prevClose || 0),
      changePct: ((quote.ltPrice || quote.lastPrice || 0) - (quote.previousPrice || quote.prevClose || 0)) / (quote.previousPrice || quote.prevClose || 1) * 100,
      volume: formatVolume(quote.totalTradedVolume || 0),
      high: quote.highPrice || quote.high || 0,
      low: quote.lowPrice || quote.low || 0,
      open: quote.openPrice || quote.open || 0,
      prevClose: quote.previousPrice || quote.prevClose || 0,
    };
  } catch (error) {
    console.error(`Error fetching ${symbol} from MoneyControl:`, error);
    return null;
  }
}

/**
 * Fetch stock data from Finnhub API
 * Requires API key in environment: FINNHUB_API_KEY
 * Register at: https://finnhub.io/
 */
export async function fetchStockQuoteFinnhub(symbol: string): Promise<MarketData | null> {
  try {
    const apiKey = process.env.FINNHUB_API_KEY;
    if (!apiKey) {
      console.warn('FINNHUB_API_KEY not configured');
      return null;
    }

    const stockMapping = getAllStocks().find(s => s.symbol === symbol);
    if (!stockMapping) return null;

    // For Indian stocks, Finnhub uses NSE or BSE prefix
    const finnhubSymbol = `${symbol}.NS`; // NSE (National Stock Exchange)
    
    const url = `https://finnhub.io/api/v1/quote?symbol=${finnhubSymbol}&token=${apiKey}`;
    
    const response = await fetch(url);
    if (!response.ok) return null;

    const data = await response.json();
    
    return {
      symbol: symbol,
      name: stockMapping.name,
      price: data.c || 0, // current price
      change: (data.c || 0) - (data.pc || 0), // change from prev close
      changePct: ((data.c || 0) - (data.pc || 0)) / (data.pc || 1) * 100,
      volume: formatVolume(0), // Finnhub doesn't provide volume in free tier
      high: data.h || 0, // day high
      low: data.l || 0, // day low
      open: data.o || 0, // open price
      prevClose: data.pc || 0, // previous close
    };
  } catch (error) {
    console.error(`Error fetching ${symbol} from Finnhub:`, error);
    return null;
  }
}

/**
 * Fetch all stock data in parallel with fallback mechanism
 * Tries MoneyControl first, then falls back to other sources if available
 */
export async function fetchAllLiveStocks(): Promise<MarketData[]> {
  const allStocks = getAllStocks();
  
  console.log(`[LIVE DATA] Fetching data for ${allStocks.length} stocks...`);
  
  // Fetch all stocks in parallel with Promise.allSettled for error handling
  const stockPromises = allStocks.map(async (stock) => {
    // Try MoneyControl first
    let quoteData = await fetchStockQuoteMoneyControl(stock.symbol);
    
    // Fallback to Finnhub if MoneyControl fails
    if (!quoteData && process.env.FINNHUB_API_KEY) {
      quoteData = await fetchStockQuoteFinnhub(stock.symbol);
    }
    
    return quoteData;
  });

  const results = await Promise.allSettled(stockPromises);
  
  // Filter successful results
  const liveData = results
    .filter((result): result is PromiseFulfilledResult<MarketData | null> => 
      result.status === 'fulfilled' && result.value !== null
    )
    .map(result => result.value);

  console.log(`[LIVE DATA] Successfully fetched ${liveData.length} stock quotes`);
  
  return liveData;
}

/**
 * Fetch single stock with caching (cache for 30 seconds)
 */
const stockCache = new Map<string, { data: MarketData; timestamp: number }>();
const CACHE_DURATION = 30000; // 30 seconds

export async function fetchStockDataWithCache(symbol: string): Promise<MarketData | null> {
  // Check cache first
  const cached = stockCache.get(symbol);
  if (cached && Date.now() - cached.timestamp < CACHE_DURATION) {
    return cached.data;
  }

  // Fetch fresh data
  let quoteData = await fetchStockQuoteMoneyControl(symbol);
  
  if (!quoteData && process.env.FINNHUB_API_KEY) {
    quoteData = await fetchStockQuoteFinnhub(symbol);
  }

  if (quoteData) {
    stockCache.set(symbol, { data: quoteData, timestamp: Date.now() });
  }

  return quoteData;
}

/**
 * Format volume number to human-readable format (e.g., 1.2M, 500K)
 */
function formatVolume(volume: number): string {
  if (volume >= 1000000) {
    return (volume / 1000000).toFixed(1) + 'M';
  } else if (volume >= 1000) {
    return (volume / 1000).toFixed(1) + 'K';
  }
  return volume.toString();
}

/**
 * Setup periodic data refresh (refresh every 5 minutes)
 */
let lastFetchTime = 0;
const REFRESH_INTERVAL = 5 * 60 * 1000; // 5 minutes

export async function getOrRefreshAllStocks(): Promise<MarketData[]> {
  const now = Date.now();
  
  // Only fetch if last fetch was more than REFRESH_INTERVAL ago
  if (now - lastFetchTime < REFRESH_INTERVAL) {
    // Return cached data if available
    const stocks = getAllStocks();
    const promises = stocks.map(s => fetchStockDataWithCache(s.symbol));
    const results = await Promise.allSettled(promises);
    
    return results
      .filter((result): result is PromiseFulfilledResult<MarketData | null> => 
        result.status === 'fulfilled' && result.value !== null
      )
      .map(result => result.value);
  }
  
  lastFetchTime = now;
  return await fetchAllLiveStocks();
}
