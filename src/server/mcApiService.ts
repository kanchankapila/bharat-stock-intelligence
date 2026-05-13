import { getStockMapping } from './stockMapping';
import { Semaphore } from './semaphore';

const mcSemaphore = new Semaphore(3);

interface McApiResponse<T = any> {
  success: number;
  data?: T;
  code?: string;
  message?: string;
}

export interface McTechData {
  open: number;
  high: number;
  low: number;
  close: number;
  pclose: number;
  volume: number;
  pivotLevels: McPivotGroup[];
  sma: McAverage[];
  ema: McAverage[];
  crossover: McCrossover[];
  indicators: McIndicator[];
  sentiments: McSentiments;
}

interface McPivotGroup {
  key: string;
  pivotLevel: {
    pivotPoint: string;
    r1: string;
    r2: string;
    r3: string;
    s1: string;
    s2: string;
    s3: string;
  };
}

interface McAverage {
  key: string;
  value: string;
  indication: string;
}

interface McCrossover {
  key: string;
  displayValue: string;
  indication: string;
  period: string;
}

interface McIndicator {
  id: string;
  displayName: string;
  value: string | any[];
  indication: string;
}

interface McSentiments {
  movingAverageSentiment: { bearishCount: number; bullishCount: number; neutralCount: number; indication: string };
  movingAverageCrossOverSentiment: { bearishCount: number; bullishCount: number; neutralCount: number; indication: string };
  indicatorsSentiment: { bearishCount: number; bullishCount: number; neutralCount: number; indication: string };
  totalBearish: number;
  totalBullish: number;
  totalNeutral: number;
  indication: string;
}

export interface McSwotData {
  strengths: string[];
  weaknesses: string[];
  opportunities: string[];
  threats: string[];
}

export interface McEssentialsData {
  pe: number;
  sectorPe: number;
  pb: number;
  dividendYield: number;
  marketCap: string;
  faceValue: number;
  industry: string;
  mcapText: string;
  high52: number;
  low52: number;
}

export interface McInsightsData {
  classification: {
    name: string;
    color: string;
    longDesc: string;
    stockScore: number;
    shortDesc: string;
  };
}

export interface McDetailedInsights {
  price: { color: string; shortDesc: string; linktext?: string; linkurl?: string }[];
  financials: {
    piotroskiData: { title: string; shortDesc: string; color: string; score: string; tooltip: string };
    cagr: { Revenue: string; NetProfit: string; OperatingProfit: string };
  };
  shareholding: { shorttext: string; longtext: string; color: string }[];
  industryComparison: { title: string; shortDesc: string; longDesc: string; color: string; value: number }[];
  creditRating: { datetime: string; title: string; description: string; pdfUrl: string }[];
  earningTranscripts: { datetime: string; title: string; description: string; pdfUrl: string }[];
}

export interface McPriceVolume {
  price: Record<string, number>;
  volume: Record<string, { 
    delivery: number; 
    cvol: number; 
    cvol_display_text: string; 
    delivery_display_text: string;
    cvol_tooltip_text?: string;
    delivery_tooltip_text?: string;
  }>;
}

export interface McAnalystRating {
  ratings: { name: string; value: string }[];
  finalRating: string;
  analystCount: string;
}

export interface McEarningsForecast {
  eps: { date: string; high: string; low: string; avg: string; actual: string }[];
  netProfit: { date: string; high: string; low: string; avg: string; actual: string }[];
  revenue: { date: string; high: string; low: string; avg: string; actual: string }[];
  displayLock: string;
}

export interface McPriceForecast {
  graphData: number[][];
  high: string;
  mean: string;
  low: string;
  displayLock: string;
}

export interface McConsensusData {
  graphData: { name: string; data: number[] }[];
  categories: string[];
}

export interface McHitsMisses {
  beats: { total: string; selected: string; unselected: string };
  misses: { total: string; selected: string; unselected: string };
  inline: { total: string; selected: string; unselected: string };
  list: { quarter: string; actual: string; estimates: string; surprise: string; type: string }[];
  displayLock: string;
}

export interface McValuation {
  list: { heading: string; data: { eps: string; pe: string; bvps: string; pb: string; analyst: string } }[];
  displayLock: string;
}

export interface McEquityCash {
  company: string;
  symbol: string;
  LP: string;
  OPN: string;
  pricecurrent: string;
  pricepercentchange: string;
  pricechange: string;
  VOL: string;
  DELV: string;
  MKTCAP: string;
  PE: string;
  PB: string;
  BV: string;
  DY: string;
  FV: string;
  high52: string;
  low52: string;
  CEPS: string;
  IND_PE: string;
  main_sector: string;
  newSubsector: string;
  lastupd: string;
  '52H': string;
  '52L': string;
  market_state: string;
}

export interface McStockPrice {
  companyName: string;
  lastPrice: string;
  perChange: string;
  marketCap: string;
  scTtm: string;
  perform1yr: string;
  priceBook: string;
}

export interface McHistoricalRating {
  data: any;
  success: number;
}

// --- Simple In-Memory Cache for Fundamentals (1 hour) ---
const fundamentalCache: Record<string, { data: any, timestamp: number }> = {};
const CACHE_DURATION = 60 * 60 * 1000; // 1 hour

function getCachedFundamental(scId: string, key: string) {
  const cacheKey = `${scId}:${key}`;
  const entry = fundamentalCache[cacheKey];
  if (entry && (Date.now() - entry.timestamp < CACHE_DURATION)) {
    return entry.data;
  }
  return null;
}

function setCachedFundamental(scId: string, key: string, data: any) {
  const cacheKey = `${scId}:${key}`;
  fundamentalCache[cacheKey] = { data, timestamp: Date.now() };
}

export interface McConsolidatedData {
  scId: string;
  timeframe: 'D' | 'W' | 'M';
  technical: McTechData | null;
  equityCash: McEquityCash | null;
  stockPrice: McStockPrice | null;
  swot: McSwotData | null;
  essentials: McEssentialsData | null;
  mcInsights: McInsightsData | null;
  detailedInsights: McDetailedInsights | null;
  priceVolume: McPriceVolume | null;
  analystRating: McAnalystRating | null;
  earningsForecast: McEarningsForecast | null;
  priceForecast: McPriceForecast | null;
  consensus: McConsensusData | null;
  hitsMisses: McHitsMisses | null;
  valuation: McValuation | null;
  financialOverview: { ttmEpsText: string; ttmPeText: string; pbText: string } | null;
}

export async function mcFetchJson<T = any>(url: string, retries: number = 3, symbol?: string): Promise<T | null> {
  return mcSemaphore.run(async () => {
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        const res = await fetch(url, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': 'application/json, text/plain, */*',
            'Referer': 'https://www.moneycontrol.com/'
          },
          signal: AbortSignal.timeout(10000)
        });

        if (!res.ok) {
          // Retry on 503 Service Unavailable
          if (res.status === 503 && attempt < retries) {
            const delay = Math.min(1000 * Math.pow(2, attempt - 1), 10000) + Math.random() * 1000;
            const logSymbol = symbol ? `${symbol} (${url.split('/').pop()?.split('?')[0]})` : url;
            console.warn(`MoneyControl API ${logSymbol} returned 503. Retrying in ${Math.round(delay)}ms (attempt ${attempt}/${retries})...`);
            await new Promise(resolve => setTimeout(resolve, delay));
            continue;
          }
          return null;
        }

        const contentType = res.headers.get('content-type') || '';
        if (contentType.includes('application/json')) {
          return await res.json();
        }
        const text = await res.text();
        try { return JSON.parse(text); } catch { return null; }
      } catch (e) {
        lastError = e instanceof Error ? e : new Error(String(e));
        if (attempt < retries) {
          const delay = Math.min(1000 * Math.pow(2, attempt - 1), 10000) + Math.random() * 1000;
          console.warn(`MoneyControl API error. Retrying in ${Math.round(delay)}ms (attempt ${attempt}/${retries})...`);
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      }
    }

    if (lastError) {
      console.error('MoneyControl API failed after retries:', lastError.message);
    }
    return null;
  });
}

export async function fetchMcTechnicalData(scId: string, dur: 'D' | 'W' | 'M', symbol?: string): Promise<McTechData | null> {
  const res = await mcFetchJson<{ code: string; data: McTechData }>(
    `https://priceapi.moneycontrol.com/pricefeed/techindicator/${dur}/${scId}?fields=sentiments,pivotLevels,sma,ema,crossover,indicators`,
    3,
    symbol
  );
  if (res?.code === '200' && res.data) {
    return res.data;
  }
  return null;
}

export async function fetchMcEquityCash(scId: string, symbol?: string): Promise<McEquityCash | null> {
  const res = await mcFetchJson<{ code: string; data: McEquityCash }>(
    `https://priceapi.moneycontrol.com/pricefeed/nse/equitycash/${scId}`,
    3,
    symbol
  );
  if (res?.code === '200' && res.data) return res.data;
  return null;
}

export async function fetchMcSwot(scId: string, symbol?: string): Promise<McSwotData | null> {
  const res = await mcFetchJson<McApiResponse<{ strengths: { info: string[] }; weaknesses: { info: string[] }; opportunities: { info: string[] }; threats: { info: string[] } }>>(
    `https://api.moneycontrol.com/mcapi/v1/swot/details?scId=${scId}&type=all`,
    3,
    symbol
  );
  if (res?.success === 1 && res.data) {
    return {
      strengths: res.data.strengths?.info || [],
      weaknesses: res.data.weaknesses?.info || [],
      opportunities: res.data.opportunities?.info || [],
      threats: res.data.threats?.info || []
    };
  }
  return null;
}

export async function fetchMcEssentials(scId: string, symbol?: string): Promise<McEssentialsData | null> {
  const res = await mcFetchJson<McApiResponse<any>>(
    `https://api.moneycontrol.com/mcapi/v1/extdata/mc-essentials?scId=${scId}&type=ed`,
    3,
    symbol
  );
  
  // Also try v2 endpoint
  const res2 = await mcFetchJson<McApiResponse<any>>(
    `https://api.moneycontrol.com/mcapi/extdata/v2/mc-essentials?scId=${scId}&type=ed&deviceType=W`,
    3,
    symbol
  );

  const data = (res?.success === 1 && res.data) ? res.data : 
               (res2?.success === 1 && res2.data) ? res2.data : null;
  if (data) {
    const ed = data.essentialsData || data;
    return {
      pe: parseFloat(ed.pe) || 0,
      sectorPe: parseFloat(ed.sectorPe) || 0,
      pb: parseFloat(ed.pb) || 0,
      dividendYield: parseFloat(ed.dividendYield) || 0,
      marketCap: ed.marketCap || "N/A",
      faceValue: parseFloat(ed.faceValue) || 0,
      industry: ed.industry || ed.newSubsector || "",
      mcapText: ed.marketCapText || "",
      high52: parseFloat(ed.high52) || 0,
      low52: parseFloat(ed.low52) || 0
    };
  }
  return null;
}

export async function fetchMcInsights(scId: string, symbol?: string): Promise<McInsightsData | null> {
  const res = await mcFetchJson<McApiResponse<McInsightsData['classification'] & { classification: McInsightsData['classification'] }>>(
    `https://api.moneycontrol.com/mcapi/v1/extdata/mc-insights?scId=${scId}&type=c`,
    3,
    symbol
  );
  const res2 = await mcFetchJson<McApiResponse<{ classification: McInsightsData['classification'] }>>(
    `https://api.moneycontrol.com/mcapi/extdata/v2/mc-insights?scId=${scId}&type=c&deviceType=W&appVersion=185`,
    3,
    symbol
  );
  
  if (res2?.success === 1 && res2.data?.classification) {
    return { classification: res2.data.classification };
  }
  if (res?.success === 1 && (res as any).data?.classification) {
    return { classification: (res as any).data.classification };
  }
  if (res?.success === 1 && (res as any).data?.name !== undefined) {
    return { classification: (res as any).data };
  }
  return null;
}

export async function fetchMcDetailedInsights(scId: string, symbol?: string): Promise<McDetailedInsights | null> {
  const res = await mcFetchJson<McApiResponse<{ insightData: McDetailedInsights }>>(
    `https://api.moneycontrol.com/mcapi/v1/extdata/mc-insights?scId=${scId}&type=d`,
    3,
    symbol
  );
  if (res?.success === 1 && res.data?.insightData) {
    return res.data.insightData;
  }
  // Try v2
  const res2 = await mcFetchJson<McApiResponse<{ insightData: McDetailedInsights }>>(
    `https://api.moneycontrol.com/mcapi/extdata/v2/mc-insights?scId=${scId}&type=d&deviceType=W&appVersion=185`,
    3,
    symbol
  );
  if (res2?.success === 1 && res2.data?.insightData) {
    return res2.data.insightData;
  }
  return null;
}

export async function fetchMcPriceVolume(scId: string, symbol?: string): Promise<McPriceVolume | null> {
  const res = await mcFetchJson<McApiResponse<{ stock_price_volume_data: McPriceVolume }>>(
    `https://api.moneycontrol.com/mcapi/v1/stock/price-volume?scId=${scId}&ex=&appVersion=175`,
    3,
    symbol
  );
  if (res?.success === 1 && res.data?.stock_price_volume_data) {
    return res.data.stock_price_volume_data;
  }
  return null;
}

export async function fetchMcAnalystRating(scId: string, symbol?: string): Promise<McAnalystRating | null> {
  const res = await mcFetchJson<McApiResponse<McAnalystRating>>(
    `https://api.moneycontrol.com/mcapi/v1/stock/estimates/analyst-rating?deviceType=W&scId=${scId}&ex=N`,
    3,
    symbol
  );
  if (res?.success === 1 && res.data) return res.data;
  return null;
}

export async function fetchMcEarningsForecast(scId: string, symbol?: string): Promise<McEarningsForecast | null> {
  const res = await mcFetchJson<McApiResponse<McEarningsForecast>>(
    `https://api.moneycontrol.com/mcapi/v1/stock/estimates/earning-forecast?scId=${scId}&ex=N&deviceType=W&frequency=12&financialType=C`,
    3,
    symbol
  );
  if (res?.success === 1 && res.data) return res.data;
  return null;
}

export async function fetchMcPriceForecast(scId: string, symbol?: string): Promise<McPriceForecast | null> {
  const res = await mcFetchJson<McApiResponse<McPriceForecast>>(
    `https://api.moneycontrol.com/mcapi/v1/stock/estimates/price-forecast?scId=${scId}&ex=N&deviceType=W`,
    3,
    symbol
  );
  if (res?.success === 1 && res.data) return res.data;
  return null;
}

export async function fetchMcConsensus(scId: string, symbol?: string): Promise<McConsensusData | null> {
  const res = await mcFetchJson<McApiResponse<McConsensusData>>(
    `https://api.moneycontrol.com/mcapi/v1/stock/estimates/consensus?scId=${scId}&ex=N&deviceType=W`,
    3,
    symbol
  );
  if (res?.success === 1 && res.data) return res.data;
  return null;
}

export async function fetchMcHitsMisses(scId: string, symbol?: string): Promise<McHitsMisses | null> {
  const res = await mcFetchJson<McApiResponse<McHitsMisses>>(
    `https://api.moneycontrol.com/mcapi/v1/stock/estimates/hits-misses?deviceType=W&scId=${scId}&ex=N&type=eps&financialType=C`,
    3,
    symbol
  );
  if (res?.success === 1 && res.data) return res.data;
  return null;
}

export async function fetchMcValuation(scId: string, symbol?: string): Promise<McValuation | null> {
  const res = await mcFetchJson<McApiResponse<McValuation>>(
    `https://api.moneycontrol.com/mcapi/v1/stock/estimates/valuation?deviceType=W&scId=${scId}&ex=N&financialType=C`,
    3,
    symbol
  );
  if (res?.success === 1 && res.data) return res.data;
  return null;
}

export async function fetchMcFinancialOverview(scId: string, symbol?: string): Promise<{ ttmEpsText: string; ttmPeText: string; pbText: string } | null> {
  const res = await mcFetchJson<McApiResponse<{ ttmEpsText: string; ttmPeText: string; pbText: string }>>(
    `https://api.moneycontrol.com/mcapi/v1/stock/financial-historical/overview?scId=${scId}&ex=N`,
    3,
    symbol
  );
  if (res?.success === 1 && res.data) return res.data;
  return null;
}

export async function fetchMcStockPrice(scId: string, symbol?: string): Promise<McStockPrice | null> {
  const res = await mcFetchJson<McApiResponse<McStockPrice[]>>(
    `https://api.moneycontrol.com/mcapi/v1/stock/get-stock-price?scIdList=${scId}&scId=${scId}`,
    3,
    symbol
  );
  if (res?.success === 1 && res.data && res.data.length > 0) {
    return res.data[0];
  }
  return null;
}

export async function fetchMcHistoricalRating(scId: string, period: 'D' | 'W' | 'M'): Promise<any | null> {
  const res = await mcFetchJson<any>(
    `https://www.moneycontrol.com/mc/widget/historicalrating/ratingPro?classic=true&type=gson&sc_did=${scId}&period=${period}&dur=6m`
  );
  return res;
}

export async function fetchMcTechnicalV2(scId: string, dur: 'D' | 'W' | 'M'): Promise<any | null> {
  const res = await mcFetchJson<any>(
    `https://api.moneycontrol.com/mcapi/technicals/v2/details?scId=${scId}&dur=${dur}&deviceType=W`
  );
  return res;
}

export async function fetchMcTechnicalRating(scId: string, period: 'D' | 'W' | 'M'): Promise<any | null> {
  const res = await mcFetchJson<any>(
    `https://www.moneycontrol.com/mc/widget/pricechart_technicals/technical_rating_summary?sc_did=${scId}&page=mc_technicals&period=D&classic=true&period=${period}`
  );
  return res;
}

export async function fetchMcMovingAverages(scId: string, period: 'D' | 'W' | 'M'): Promise<any | null> {
  const res = await mcFetchJson<any>(
    `https://www.moneycontrol.com/mc/widget/pricechart_technicals/moving_average?sc_did=${scId}&page=mc_technicals&period=D&classic=true&period=${period}`
  );
  return res;
}

export async function fetchMcPivotLevels(scId: string, period: 'D' | 'W' | 'M'): Promise<any | null> {
  const res = await mcFetchJson<any>(
    `https://www.moneycontrol.com/mc/widget/pricechart_technicals/pivot_level?sc_did=${scId}&page=mc_technicals&classic=true&period=${period}`
  );
  return res;
}

export async function fetchMcCrossovers(scId: string, period: 'D' | 'W' | 'M'): Promise<any | null> {
  const res = await mcFetchJson<any>(
    `https://www.moneycontrol.com/mc/widget/pricechart_technicals/moving_average_crossovers?sc_did=${scId}&page=mc_technicals&period=D&classic=true&period=${period}`
  );
  return res;
}

export async function fetchMcTechnicalIndicators(scId: string, period: 'D' | 'W' | 'M'): Promise<any | null> {
  const res = await mcFetchJson<any>(
    `https://www.moneycontrol.com/mc/widget/pricechart_technicals/technical_indicator?sc_did=${scId}&page=mc_technicals&period=D&classic=true&period=${period}`
  );
  return res;
}

/**
 * Main consolidated fetch - gets ALL MC data for a stock.
 * Optimised: Refreshes Price/Technical data every time, but caches Fundamentals for 1 hour.
 */
export async function getMcConsolidatedData(scId: string, symbol: string, timeframe: 'D' | 'W' | 'M' = 'D'): Promise<McConsolidatedData> {
  const mapping = getStockMapping(symbol);
  const effectiveScId = mapping?.mcsymbol || scId;

  // 1. Always fetch Price/Technical Data (The "Live" parts)
  const technical = await fetchMcTechnicalData(effectiveScId, timeframe, symbol);
  const equityCash = await fetchMcEquityCash(effectiveScId, symbol);
  const stockPrice = await fetchMcStockPrice(effectiveScId, symbol);

  // 2. Fetch or Use Cache for Fundamentals
  const fetchWithCache = async (key: string, fetcher: () => Promise<any>) => {
    const cached = getCachedFundamental(effectiveScId, key);
    if (cached) return cached;
    const fresh = await fetcher();
    if (fresh) setCachedFundamental(effectiveScId, key, fresh);
    return fresh;
  };

  const swot = await fetchWithCache('swot', () => fetchMcSwot(effectiveScId, symbol));
  const essentials = await fetchWithCache('essentials', () => fetchMcEssentials(effectiveScId, symbol));
  const mcInsights = await fetchWithCache('insights', () => fetchMcInsights(effectiveScId, symbol));
  const detailedInsights = await fetchWithCache('detailed_insights', () => fetchMcDetailedInsights(effectiveScId, symbol));
  const priceVolume = await fetchWithCache('price_volume', () => fetchMcPriceVolume(effectiveScId, symbol));
  const analystRating = await fetchWithCache('analyst_rating', () => fetchMcAnalystRating(effectiveScId, symbol));
  const earningsForecast = await fetchWithCache('earnings_forecast', () => fetchMcEarningsForecast(effectiveScId, symbol));
  const priceForecast = await fetchWithCache('price_forecast', () => fetchMcPriceForecast(effectiveScId, symbol));
  const consensus = await fetchWithCache('consensus', () => fetchMcConsensus(effectiveScId, symbol));
  const hitsMisses = await fetchWithCache('hits_misses', () => fetchMcHitsMisses(effectiveScId, symbol));
  const valuation = await fetchWithCache('valuation', () => fetchMcValuation(effectiveScId, symbol));
  const financialOverview = await fetchWithCache('financial_overview', () => fetchMcFinancialOverview(effectiveScId, symbol));

  return {
    scId: effectiveScId,
    timeframe,
    technical,
    equityCash,
    stockPrice,
    swot,
    essentials,
    mcInsights,
    detailedInsights,
    priceVolume,
    analystRating,
    earningsForecast,
    priceForecast,
    consensus,
    hitsMisses,
    valuation,
    financialOverview
  };
}