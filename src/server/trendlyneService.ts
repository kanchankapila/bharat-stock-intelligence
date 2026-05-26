import { getStockMapping } from './stockMapping';
import * as fs from 'fs';
import * as path from 'path';
import db from './db';

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'application/json'
};

export async function fetchTrendlyneFundamentals(symbol: string) {
  const map = getStockMapping(symbol);
  if (!map) return null;

  console.log(`[TRENDLYNE] Fetching fundamentals for ${symbol} using tlid: ${map.tlid}`);
  const url = `https://trendlyne.com/fundamentals/get-fundamental_results/${map.tlid}/`;
  const response = await fetch(url, { headers: HEADERS });
  if (!response.ok) return null;
  return response.json();
}

export async function fetchTrendlyneSwot(symbol: string) {
  const map = getStockMapping(symbol);
  if (!map) return null;

  console.log(`[TRENDLYNE] Fetching SWOT for ${symbol} using tlid: ${map.tlid}`);
  // https://trendlyne.com/swot-analysis/get-swot-data/140/
  const url = `https://trendlyne.com/swot-analysis/get-swot-data/${map.tlid}/`;
  const response = await fetch(url, { headers: HEADERS });
  if (!response.ok) return null;
  return response.json();
}

export async function fetchTrendlyneChecklist(symbol: string) {
  const map = getStockMapping(symbol);
  if (!map) return null;

  console.log(`[TRENDLYNE] Fetching checklist for ${symbol} using tlid: ${map.tlid}`);
  // https://trendlyne.com/checklist/get-checklist-data/140/
  const url = `https://trendlyne.com/checklist/get-checklist-data/${map.tlid}/`;
  const response = await fetch(url, { headers: HEADERS });
  if (!response.ok) return null;
  return response.json();
}

export async function fetchTrendlyneDVM(symbol: string) {
  const map = getStockMapping(symbol);
  if (!map) return null;

  console.log(`[TRENDLYNE] Fetching DVM for ${symbol} using tlid: ${map.tlid}`);
  // https://trendlyne.com/fundamentals/get-dvm-data/140/
  const url = `https://trendlyne.com/fundamentals/get-dvm-data/${map.tlid}/`;
  const response = await fetch(url, { headers: HEADERS });
  if (!response.ok) return null;
  return response.json();
}

export async function fetchTrendlyneStockMetrics(symbol: string) {
  const map = getStockMapping(symbol);
  let tlid = map?.tlid;

  if (!tlid) {
    try {
      const row = db.prepare('SELECT DISTINCT stock_id FROM trendlyne_screener_stocks WHERE symbol = ?').get(symbol) as { stock_id: string } | undefined;
      if (row?.stock_id) {
        tlid = row.stock_id;
        console.log(`[TRENDLYNE] Resolved tlid dynamically from database for metrics: ${symbol} -> ${tlid}`);
      }
    } catch (dbErr: any) {
      console.warn(`[TRENDLYNE] Database metrics lookup failed for ${symbol}:`, dbErr.message);
    }
  }

  if (!tlid) {
    console.log(`[TRENDLYNE] No metrics tlid found for ${symbol}. Returning mock metrics.`);
    try {
      const mockDir = typeof __dirname !== 'undefined' ? __dirname : path.resolve(process.cwd(), 'src/server');
      const mockDataPath = path.join(mockDir, 'mockTrendlyneMetrics.json');
      return JSON.parse(fs.readFileSync(mockDataPath, 'utf8'));
    } catch (mockError) {
      return null;
    }
  }

  console.log(`[TRENDLYNE] Fetching Stock Metrics for ${symbol} using tlid: ${tlid}`);
  const url = `https://trendlyne.com/equity/getStockMetricParameterList/${tlid}/`;
  try {
    const response = await fetch(url, { headers: HEADERS });
    if (!response.ok) {
      console.warn(`[TRENDLYNE] Metrics API failed with status ${response.status} for ${symbol}. Returning mock.`);
      const mockDir = typeof __dirname !== 'undefined' ? __dirname : path.resolve(process.cwd(), 'src/server');
      const mockDataPath = path.join(mockDir, 'mockTrendlyneMetrics.json');
      return JSON.parse(fs.readFileSync(mockDataPath, 'utf8'));
    }
    const data = await response.json();
    if (data.html || !data.body) {
      const mockDir = typeof __dirname !== 'undefined' ? __dirname : path.resolve(process.cwd(), 'src/server');
      const mockDataPath = path.join(mockDir, 'mockTrendlyneMetrics.json');
      return JSON.parse(fs.readFileSync(mockDataPath, 'utf8'));
    }
    return data;
  } catch (error) {
    console.error(`[TRENDLYNE] Error fetching stock metrics for ${symbol}:`, error);
    try {
      const mockDir = typeof __dirname !== 'undefined' ? __dirname : path.resolve(process.cwd(), 'src/server');
      const mockDataPath = path.join(mockDir, 'mockTrendlyneMetrics.json');
      return JSON.parse(fs.readFileSync(mockDataPath, 'utf8'));
    } catch (mockError) {
      return null;
    }
  }
}

const taCache = new Map<string, { data: any; timestamp: number }>();

export async function fetchTrendlyneAdvTechnicalAnalysis(symbol: string, timeframe: 'D' | 'W' | 'M' = 'D') {
  const cacheKey = `${symbol}_${timeframe}`;
  const cached = taCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < 300_000) { // 5-minute cache
    return cached.data;
  }

  const data = await fetchTrendlyneAdvTechnicalAnalysisRaw(symbol, timeframe);
  if (data) {
    taCache.set(cacheKey, { data, timestamp: Date.now() });
  }
  return data;
}

async function fetchTrendlyneAdvTechnicalAnalysisRaw(symbol: string, timeframe: 'D' | 'W' | 'M' = 'D') {
  const map = getStockMapping(symbol);
  let tlid = map?.tlid;

  if (!tlid) {
    try {
      const row = db.prepare('SELECT DISTINCT stock_id FROM trendlyne_screener_stocks WHERE symbol = ?').get(symbol) as { stock_id: string } | undefined;
      if (row?.stock_id) {
        tlid = row.stock_id;
        console.log(`[TRENDLYNE] Resolved tlid dynamically from database for TA: ${symbol} -> ${tlid}`);
      }
    } catch (dbErr: any) {
      console.warn(`[TRENDLYNE] Database TA lookup failed for ${symbol}:`, dbErr.message);
    }
  }

  if (!tlid) {
    console.log(`[TRENDLYNE] No TA tlid found for ${symbol}. Returning mock TA data.`);
    try {
      const mockDir = typeof __dirname !== 'undefined' ? __dirname : path.resolve(process.cwd(), 'src/server');
      const mockDataPath = path.join(mockDir, 'mockTrendlyneTa.json');
      return JSON.parse(fs.readFileSync(mockDataPath, 'utf8'));
    } catch (mockError) {
      return null;
    }
  }

  const durationMap = { 'D': '24', 'W': '25', 'M': '26' };
  const dur = durationMap[timeframe] || '24';

  console.log(`[TRENDLYNE] Fetching Adv Technical Analysis (${timeframe}) for ${symbol} using tlid: ${tlid}`);
  const url = `https://trendlyne.com/equity/api/stock/adv-technical-analysis/${tlid}/${dur}/`;
  try {
    const response = await fetch(url, { headers: HEADERS });
    if (!response.ok) {
      console.warn(`[TRENDLYNE] TA API failed with status ${response.status} for ${symbol}. Returning mock.`);
      const mockDir = typeof __dirname !== 'undefined' ? __dirname : path.resolve(process.cwd(), 'src/server');
      const mockDataPath = path.join(mockDir, 'mockTrendlyneTa.json');
      return JSON.parse(fs.readFileSync(mockDataPath, 'utf8'));
    }
    const data = await response.json();
    if (data.html || !data.body) {
      const mockDir = typeof __dirname !== 'undefined' ? __dirname : path.resolve(process.cwd(), 'src/server');
      const mockDataPath = path.join(mockDir, 'mockTrendlyneTa.json');
      return JSON.parse(fs.readFileSync(mockDataPath, 'utf8'));
    }
    return data;
  } catch (error) {
    console.error(`[TRENDLYNE] Error fetching adv technical analysis for ${symbol}:`, error);
    try {
      const mockDir = typeof __dirname !== 'undefined' ? __dirname : path.resolve(process.cwd(), 'src/server');
      const mockDataPath = path.join(mockDir, 'mockTrendlyneTa.json');
      return JSON.parse(fs.readFileSync(mockDataPath, 'utf8'));
    } catch (mockError) {
      return null;
    }
  }
}

/**
 * Returns a complete Trendlyne overview for a stock
 */
export async function getTrendlyneOverview(symbol: string) {
  const [fundamentals, swot, checklist, dvm] = await Promise.all([
    fetchTrendlyneFundamentals(symbol),
    fetchTrendlyneSwot(symbol),
    fetchTrendlyneChecklist(symbol),
    fetchTrendlyneDVM(symbol)
  ]);

  return {
    fundamentals,
    swot,
    checklist,
    dvm
  };
}

export async function fetchTrendlyneSectorRotation() {
  console.log(`[TRENDLYNE] Fetching sector rotation data`);
  const url = `https://trendlyne.com/fundamentals/api/sector-rotation/sector/?format=json&metric=count`;
  try {
    const response = await fetch(url, { headers: HEADERS });
    if (!response.ok) {
      throw new Error(`Status: ${response.status}`);
    }
    return await response.json();
  } catch (error) {
    console.error(`[TRENDLYNE] Sector rotation fetch error:`, error);
    console.log(`[TRENDLYNE] Falling back to mock data...`);
    try {
      const mockDataPath = path.join(__dirname, 'mockSectorRotation.json');
      const mockData = JSON.parse(fs.readFileSync(mockDataPath, 'utf8'));
      return mockData;
    } catch (mockError) {
      console.error(`[TRENDLYNE] Failed to load mock data:`, mockError);
      return null;
    }
  }
}

export async function fetchTrendlyneIndexRotation() {
  console.log(`[TRENDLYNE] Fetching index rotation data`);
  const url = `https://trendlyne.com/fundamentals/api/sector-rotation/indices/?format=json&metric=count`;
  try {
    const response = await fetch(url, { headers: HEADERS });
    if (!response.ok) {
      throw new Error(`Status: ${response.status}`);
    }
    return await response.json();
  } catch (error) {
    console.error(`[TRENDLYNE] Index rotation fetch error:`, error);
    console.log(`[TRENDLYNE] Falling back to mock index rotation data...`);
    try {
      const mockDataPath = path.join(__dirname, 'mockIndexRotation.json');
      const mockData = JSON.parse(fs.readFileSync(mockDataPath, 'utf8'));
      return mockData;
    } catch (mockError) {
      console.error(`[TRENDLYNE] Failed to load mock index rotation data:`, mockError);
      return null;
    }
  }
}

export async function fetchTrendlyneStockOptionChain(symbol: string, expiryDate?: string) {
  const map = getStockMapping(symbol);
  const stockCode = map?.symbol || symbol;

  let expDate = expiryDate;
  if (!expDate) {
    try {
      const expUrl = 'https://webapi.niftytrader.in/webapi/Symbol/symbol-expiry-all?symbol=nifty&exchange=nse';
      const res = await fetch(expUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'application/json'
        }
      });
      if (res.ok) {
        const json = await res.json();
        const nifty = json?.resultData?.find((d: any) => d.symbol_name === 'NIFTY');
        if (nifty?.expiry_date) {
          expDate = nifty.expiry_date.split('T')[0];
        }
      }
    } catch (e) {
      console.error('[TRENDLYNE OPTION CHAIN] Failed to fetch near expiry:', e);
    }

    if (!expDate) {
      expDate = '2026-05-26';
    }
  }

  console.log(`[TRENDLYNE] Fetching option chain for ${stockCode} on expiry ${expDate}`);
  const url = `https://smartoptions.trendlyne.com/phoenix/api/fno/option/chain/?stockCode=${stockCode}&expDate=${expDate}`;
  try {
    const response = await fetch(url, { headers: HEADERS });
    if (!response.ok) return { success: false, error: `API status: ${response.status}` };
    const data = await response.json();
    return { success: true, data };
  } catch (error) {
    console.error(`[TRENDLYNE] Option chain fetch error for ${stockCode}:`, error);
    return { success: false, error: String(error) };
  }
}
