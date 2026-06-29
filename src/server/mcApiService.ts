import { getStockMapping } from './stockMapping';
import { Semaphore } from './semaphore';
import { findMcScreenersByStock } from './moneycontrolScreener';
import { findScreenersByStock } from './trendlyneScreener';
import { findEtScreenersByStock } from './etnow';

const mcSemaphore = new Semaphore(10); // Increased concurrency


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
  checklist?: {
    financials: { question: string; answer: boolean }[];
    industry: { question: string; answer: boolean }[];
    ownership: { question: string; answer: boolean }[];
    others: { question: string; answer: boolean }[];
  };
  passPercent?: number;
  passText?: string;
  passYes?: number;
  passNo?: number;
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

export interface McGraphDataPoint {
  _time: string;
  _value: string;
  _volume: string;
  _chg: string;
  _pchg: string;
  _dir: string;
}

export interface McGraphResponse {
  graph: {
    name: string;
    date_time: string;
    current_close: string;
    prev_close: string;
    direction: string;
    values: McGraphDataPoint[];
  };
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

setInterval(() => {
  const now = Date.now();
  for (const key of Object.keys(fundamentalCache)) {
    if (now - fundamentalCache[key].timestamp > CACHE_DURATION) {
      delete fundamentalCache[key];
    }
  }
}, 30 * 60_000); // sweep every 30 min

function getCachedFundamental(scId: string, key: string) {
  const cacheKey = `${scId}:${key}`;
  const entry = fundamentalCache[cacheKey];
  if (entry && (Date.now() - entry.timestamp < CACHE_DURATION)) {
    return entry.data;
  }
  if (entry) delete fundamentalCache[cacheKey]; // evict stale entry
  return null;
}

function setCachedFundamental(scId: string, key: string, data: any) {
  const cacheKey = `${scId}:${key}`;
  fundamentalCache[cacheKey] = { data, timestamp: Date.now() };
}

export interface ScreenerInfo {
  id: string;
  name: string;
  sentiment: 'bullish' | 'bearish' | 'neutral';
  screenpk: string;
  source: string;
  description: string;
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
  historicalRating: any | null;
  technicalV2: any | null;
  technicalAnalysisV2?: any | null;
  technicalRating: any | null;
  ratios?: any;
  shareholdingPattern?: any;
  chartPatterns?: any;
  screeners?: {
    moneycontrol: ScreenerInfo[];
    trendlyne: ScreenerInfo[];
    etnow: ScreenerInfo[];
  };
}

export async function mcFetchJson<T = any>(url: string, retries: number = 3, symbol?: string, priority: boolean = false): Promise<T | null> {
  const runner = priority ? mcSemaphore.runPriority.bind(mcSemaphore) : mcSemaphore.run.bind(mcSemaphore);
  return runner(async () => {

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
  const [res, res2, checklistRes] = await Promise.all([
    mcFetchJson<McApiResponse<any>>(
      `https://api.moneycontrol.com/mcapi/v1/extdata/mc-essentials?scId=${scId}&type=ed`,
      3, symbol
    ),
    mcFetchJson<McApiResponse<any>>(
      `https://api.moneycontrol.com/mcapi/extdata/v2/mc-essentials?scId=${scId}&type=ed&deviceType=W`,
      3, symbol
    ),
    mcFetchJson<McApiResponse<any>>(
      `https://api.moneycontrol.com/mcapi/v1/extdata/mc-essentials?scId=${scId}&type=all`,
      3, symbol
    ),
  ]);

  const data = (res?.success === 1 && res.data) ? res.data :
               (res2?.success === 1 && res2.data) ? res2.data : null;
  if (!data) return null;

  const ed = data.essentialsData || data;

  const toItems = (arr: any[]) =>
    (arr || []).map((i: any) => ({ question: i.question, answer: i.answer === 'true' || i.answer === true }));

  let checklist: McEssentialsData['checklist'] | undefined;
  let passPercent: number | undefined;
  let passText: string | undefined;
  let passYes: number | undefined;
  let passNo: number | undefined;

  if (checklistRes?.success === 1 && checklistRes.data?.essentialsData) {
    const cl = checklistRes.data.essentialsData;
    checklist = {
      financials: toItems(cl.financials),
      industry: toItems(cl.industry),
      ownership: toItems(cl.ownership),
      others: toItems(cl.others),
    };
    const pc = checklistRes.data.perCount;
    passPercent = pc?.passper;
    passText = pc?.passpertext;
    passYes = pc?.Yes;
    passNo = pc?.No;
  }

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
    low52: parseFloat(ed.low52) || 0,
    checklist,
    passPercent,
    passText,
    passYes,
    passNo,
  };
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

export async function fetchMcTechnicalAnalysisV2(scId: string, dur: 'D' | 'W' | 'M'): Promise<any | null> {
  const res = await mcFetchJson<any>(
    `https://api.moneycontrol.com/mcapi/technicals/v2/analysis?scId=${scId}&dur=${dur}&fields=all&deviceType=W&appVersion=189`
  );
  return res;
}

export async function fetchMcTechnicalRating(scId: string, period: 'D' | 'W' | 'M'): Promise<any | null> {
  const res = await mcFetchJson<any>(
    `https://www.moneycontrol.com/mc/widget/pricechart_technicals/technical_rating_summary?sc_did=${scId}&page=mc_technicals&classic=true&period=${period}`
  );
  return res;
}

export async function fetchMcMovingAverages(scId: string, period: 'D' | 'W' | 'M'): Promise<any | null> {
  const res = await mcFetchJson<any>(
    `https://www.moneycontrol.com/mc/widget/pricechart_technicals/moving_average?sc_did=${scId}&page=mc_technicals&classic=true&period=${period}`
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
    `https://www.moneycontrol.com/mc/widget/pricechart_technicals/moving_average_crossovers?sc_did=${scId}&page=mc_technicals&classic=true&period=${period}`
  );
  return res;
}

export async function fetchMcTechnicalIndicators(scId: string, period: 'D' | 'W' | 'M'): Promise<any | null> {
  const res = await mcFetchJson<any>(
    `https://www.moneycontrol.com/mc/widget/pricechart_technicals/technical_indicator?sc_did=${scId}&page=mc_technicals&classic=true&period=${period}`
  );
  return res;
}

export async function fetchMcRatios(scId: string, symbol?: string): Promise<any | null> {
  const url = `https://www.moneycontrol.com/mc/widget/mcfinancials/getFinancialData?classic=true&referenceId=ratios&requestType=S&scId=${scId}&frequency=3`;
  return mcFetchJson(url, 3, symbol);
}

export async function fetchMcShareholdingPattern(scId: string, symbol?: string): Promise<any | null> {
  // Try v1 first
  const res = await mcFetchJson<any>(
    `https://api.moneycontrol.com/mcapi/v1/shareholding/pattern?scId=${scId}`,
    3,
    symbol
  );
  if (res?.success === 1 && res.data) return res.data;
  
  // Fallback to widget if API fails
  const widgetUrl = `https://www.moneycontrol.com/mc/widget/mcshareholding/getShareholdingPattern?classic=true&scId=${scId}`;
  return mcFetchJson(widgetUrl, 3, symbol);
}

export async function fetchMcChartPatterns(scId: string, symbol?: string): Promise<any | null> {
  const url = `https://api.moneycontrol.com/mcapi/technicalpicks/chart-patterns?deviceType=W&version=174&start=0&limit=12&pattern_type=all&sc_id=${scId}`;
  const res = await mcFetchJson<any>(url, 3, symbol);
  if (res?.status === 'success' && res.list) return res.list;
  return null;
}

/**
 * Main consolidated fetch - gets ALL MC data for a stock.
 * Optimised: Refreshes Price/Technical data every time, but caches Fundamentals for 1 hour.
 */
export async function getMcConsolidatedData(scId: string, symbol: string, timeframe: 'D' | 'W' | 'M' = 'D'): Promise<McConsolidatedData> {
  const mapping = getStockMapping(symbol);
  const effectiveScId = mapping?.mcsymbol || scId;

  // 1. Local Screeners (Instant)
  const mcScreeners = await findMcScreenersByStock(symbol);
  const tlScreeners = await findScreenersByStock(symbol);
  const etScreeners = await findEtScreenersByStock(symbol);

  // 2. Fetch all data points in parallel
  const fetchWithCache = async (key: string, fetcher: () => Promise<any>) => {
    const cached = getCachedFundamental(effectiveScId, key);
    if (cached) return cached;
    const fresh = await fetcher();
    if (fresh) setCachedFundamental(effectiveScId, key, fresh);
    return fresh;
  };

  const [
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
    financialOverview,
    historicalRating,
    technicalV2,
    technicalAnalysisV2,
    technicalRating,
    ratios,
    shareholdingPattern,
    chartPatterns
  ] = await Promise.all([
    fetchMcTechnicalData(effectiveScId, timeframe, symbol),
    fetchMcEquityCash(effectiveScId, symbol),
    fetchMcStockPrice(effectiveScId, symbol),
    fetchWithCache('swot', () => fetchMcSwot(effectiveScId, symbol)),
    fetchWithCache('essentials', () => fetchMcEssentials(effectiveScId, symbol)),
    fetchWithCache('insights', () => fetchMcInsights(effectiveScId, symbol)),
    fetchWithCache('detailed_insights', () => fetchMcDetailedInsights(effectiveScId, symbol)),
    fetchWithCache('price_volume', () => fetchMcPriceVolume(effectiveScId, symbol)),
    fetchWithCache('analyst_rating', () => fetchMcAnalystRating(effectiveScId, symbol)),
    fetchWithCache('earnings_forecast', () => fetchMcEarningsForecast(effectiveScId, symbol)),
    fetchWithCache('price_forecast', () => fetchMcPriceForecast(effectiveScId, symbol)),
    fetchWithCache('consensus', () => fetchMcConsensus(effectiveScId, symbol)),
    fetchWithCache('hits_misses', () => fetchMcHitsMisses(effectiveScId, symbol)),
    fetchWithCache('valuation', () => fetchMcValuation(effectiveScId, symbol)),
    fetchWithCache('financial_overview', () => fetchMcFinancialOverview(effectiveScId, symbol)),
    fetchWithCache(`historical_rating_${timeframe}`, () => fetchMcHistoricalRating(effectiveScId, timeframe)),
    fetchWithCache(`technical_v2_${timeframe}`, () => fetchMcTechnicalV2(effectiveScId, timeframe)),
    fetchWithCache(`technical_analysis_v2_${timeframe}`, () => fetchMcTechnicalAnalysisV2(effectiveScId, timeframe)),
    fetchWithCache(`technical_rating_${timeframe}`, () => fetchMcTechnicalRating(effectiveScId, timeframe)),
    fetchWithCache('ratios', () => fetchMcRatios(effectiveScId, symbol)),
    fetchWithCache('shareholding_pattern', () => fetchMcShareholdingPattern(effectiveScId, symbol)),
    fetchWithCache('chart_patterns', () => fetchMcChartPatterns(effectiveScId, symbol)),
  ]);

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
    financialOverview,
    historicalRating,
    technicalV2,
    technicalAnalysisV2,
    technicalRating,
    ratios,
    shareholdingPattern: shareholdingPattern || extractShareholdingFromInsights(detailedInsights),
    chartPatterns,
    screeners: {
      moneycontrol: mcScreeners,
      trendlyne: tlScreeners,
      etnow: etScreeners
    }
  };
}

/**
 * Fallback: Extracts shareholding percentages from textual insights if the structured API fails.
 */
function extractShareholdingFromInsights(insights: McDetailedInsights | null): any {
  if (!insights?.shareholding) return null;
  
  const list: any[] = [];
  let promoterPledging = "0.00";

  const extractPercent = (text: string) => {
    const match = text.match(/(\d+\.?\d*)%/);
    return match ? match[1] : null;
  };

  insights.shareholding.forEach(item => {
    const val = extractPercent(item.longtext);
    if (!val) return;

    if (item.shorttext.includes('Promoter')) {
      list.push({ name: 'Promoter', value: val });
    } else if (item.shorttext.includes('Pledge')) {
      promoterPledging = val;
    } else if (item.shorttext.includes('FII')) {
      list.push({ name: 'FII', value: val });
    } else if (item.shorttext.includes('DII')) {
      list.push({ name: 'DII', value: val });
    } else if (item.shorttext.includes('Public')) {
      list.push({ name: 'Public', value: val });
    }
  });

  return list.length > 0 ? { list, promoterPledging } : null;
  }

// ─── VWAP Chart ───────────────────────────────────────────────────────────────

export async function fetchMcVwapChart(scId: string): Promise<{ BSE: any[]; NSE: any[] } | null> {
  const res = await mcFetchJson<{ BSE: any[]; NSE: any[] }>(
    `https://www.moneycontrol.com/stocks/company_info/get_vwap_chart_data.php?classic=true&sc_did=${scId}`
  );
  if (res?.NSE || res?.BSE) return res;
  return null;
}

// ─── Kayal TrendLyne screener ─────────────────────────────────────────────────

export async function fetchKayalScreener(
  screenpk: string | number,
  perPageCount = 50
): Promise<{ head: any; body: { tableHeaders: any[]; tableData: any[][] } } | null> {
  const res = await mcFetchJson<any>(
    `https://kayal.trendlyne.com/broker-webview/kayal/all-in-one-screener-data-get/?perPageCount=${perPageCount}&pageNumber=0&screenpk=${screenpk}&groupType=all&groupName=`
  );
  if (res?.head && res?.body) return res;
  return null;
}