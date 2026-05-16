import { getStockMapping } from './stockMapping';
import * as fs from 'fs';
import * as path from 'path';

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
