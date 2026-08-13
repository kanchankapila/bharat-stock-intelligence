import { Semaphore } from './semaphore';
import { findMcScreenersByStock } from './moneycontrolScreener';
import { findScreenersByStock } from './trendlyneScreener';
import { findEtScreenersByStock } from './etnow';
import { dbRun } from './dbAsync';

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
        try { return JSON.parse(text); } catch { console.warn('[mcApiService] JSON parse failed:', text.slice(0, 200)); return null; }
      } catch (e) {
        lastError = e instanceof Error ? e : new Error(String(e));
        if (attempt < retries) {
          const delay = Math.min(1000 * Math.pow(2, attempt - 1), 10000) + Math.random() * 1000;
          console.warn(`MoneyControl API error for ${symbol || url}: ${lastError.message}. Retrying in ${Math.round(delay)}ms (attempt ${attempt}/${retries})...`);
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      }
    }

    if (lastError) {
      console.error(`MoneyControl API failed for ${symbol || url} after retries:`, lastError.message);
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

// The `sc_id` query param is silently ignored by this endpoint -- verified live: 11 different
// scIds all returned identical currentCount/closedCount and the same unfiltered market-wide
// list, so `res.list.data` for EVERY stock used to be the same ~50-row global feed rather than
// that stock's own patterns. The real per-row stock key lives inside meta_data.price_key
// (`stk_{scId}_N` for equities, `futstk_{scId}_<expiry>` for F&O) -- filter on that instead.
function matchesScId(row: any, scId: string): boolean {
  try {
    const meta = JSON.parse(row?.meta_data || '{}');
    const key: string = meta?.price_key || '';
    const m = key.match(/^(?:stk|futstk)_([A-Z0-9]+)_/i);
    return !!m && m[1].toUpperCase() === scId.toUpperCase();
  } catch {
    return false;
  }
}

export async function fetchMcChartPatterns(scId: string, symbol?: string): Promise<any | null> {
  const url = `https://api.moneycontrol.com/mcapi/technicalpicks/chart-patterns?deviceType=W&version=174&start=0&limit=200&pattern_type=all`;
  const res = await mcFetchJson<any>(url, 3, symbol);
  if (res?.status !== 'success' || !res.list) return null;
  const data = (res.list.data || []).filter((row: any) => matchesScId(row, scId));
  if (data.length === 0) return null;
  return { ...res.list, data };
}

// A handful of MoneyControl's own proprietary scores are fetched and rendered by
// MCStockInfoPanel on every panel open but were never written anywhere — meaning nobody could
// ever check (the way factor_edge.py already did for Trendlyne's m_score, and found it has zero
// forward edge) whether MC's own analyst consensus/price-target/composite score actually predicts
// anything. Piggybacks on the already-fetched response from this request-time call rather than a
// new scheduled fetcher; `fetched_at` is day-grain (not a full timestamp) so repeated panel opens
// within the same day upsert the same row instead of accumulating duplicates, while a new day
// still gets its own row -- giving a real daily time series for a future factor_edge.py pass.
//
// Deliberately does NOT persist chart patterns: mc_chart_patterns_fetcher.py already does,
// on its own schedule, into mc_chart_patterns/mc_pattern_signals (with a proper (mcsymbol,
// pattern_id) key and downstream technical_signals.mc_cp_* columns already feeding the ML
// pipeline) -- a second writer here would just duplicate an existing, more complete pipeline.
//
// Best-effort: never throws (all errors are caught and logged), so the caller below
// deliberately does NOT `await` this -- it stays fire-and-forget in production. Returns its
// Promise anyway (rather than `void`) purely so a test can await it deterministically.
export async function persistMcConsolidatedMetrics(symbol: string, data: {
  mcInsights?: { classification?: { stockScore?: number } } | null;
  analystRating?: { finalRating?: string; analystCount?: string } | null;
  priceForecast?: { high?: string; mean?: string; low?: string } | null;
  hitsMisses?: { beats?: { total?: string }; misses?: { total?: string }; inline?: { total?: string } } | null;
  swot?: { strengths?: string[]; weaknesses?: string[]; opportunities?: string[]; threats?: string[] } | null;
  // MC's `data` here is `any` at the type level (see McHistoricalRating) because the response
  // shape is only ever consumed positionally (`data[0]`) by the panel itself -- MC's own trend
  // history beyond today is Pro-locked (see MCStockInfoPanel's displayLock check), so `data[0]`
  // really is the whole usable payload, not an arbitrary slice of a larger series.
  historicalRating?: { data?: Array<{ currSentiment?: string; closePrice?: number | string; currdate?: string }> } | null;
}): Promise<void> {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const rows: [string, string, number | null, string | null, string][] = [];
    const push = (group: string, name: string, num: number | null, text: string | null = null) => {
      if (num == null && text == null) return;
      rows.push([group, name, num, text, today]);
    };
    const stockScore = data.mcInsights?.classification?.stockScore;
    if (typeof stockScore === 'number') push('score', 'mc_stock_score', stockScore);
    if (data.analystRating?.finalRating) push('analyst', 'final_rating', null, data.analystRating.finalRating);
    const analystCount = Number(data.analystRating?.analystCount);
    if (Number.isFinite(analystCount) && analystCount > 0) push('analyst', 'analyst_count', analystCount);
    const high = Number(data.priceForecast?.high), mean = Number(data.priceForecast?.mean), low = Number(data.priceForecast?.low);
    if (Number.isFinite(high)) push('price_forecast', 'target_high', high);
    if (Number.isFinite(mean)) push('price_forecast', 'target_mean', mean);
    if (Number.isFinite(low)) push('price_forecast', 'target_low', low);
    const beats = Number(data.hitsMisses?.beats?.total) || 0;
    const misses = Number(data.hitsMisses?.misses?.total) || 0;
    const inline = Number(data.hitsMisses?.inline?.total) || 0;
    const totalCalls = beats + misses + inline;
    if (totalCalls > 0) push('estimates', 'beat_ratio', beats / totalCalls);

    // SWOT text is qualitative and free-form -- not itself a clean numeric factor -- but the
    // counts are, and net_score gives factor_edge.py a single directional number to test
    // ("does a rising strength/opportunity count vs. weakness/threat count predict forward
    // returns") without needing to parse text. The full items themselves go to mc_swot_history
    // below, not into this numeric-metrics table.
    const swotRowsText: { category: string; item: string }[] = [];
    if (data.swot) {
      const s = data.swot.strengths?.length ?? 0;
      const w = data.swot.weaknesses?.length ?? 0;
      const o = data.swot.opportunities?.length ?? 0;
      const t = data.swot.threats?.length ?? 0;
      if (s + w + o + t > 0) {
        push('swot', 'strengths_count', s);
        push('swot', 'weaknesses_count', w);
        push('swot', 'opportunities_count', o);
        push('swot', 'threats_count', t);
        push('swot', 'net_score', (s + o) - (w + t));
      }
      for (const item of data.swot.strengths ?? []) swotRowsText.push({ category: 'strength', item });
      for (const item of data.swot.weaknesses ?? []) swotRowsText.push({ category: 'weakness', item });
      for (const item of data.swot.opportunities ?? []) swotRowsText.push({ category: 'opportunity', item });
      for (const item of data.swot.threats ?? []) swotRowsText.push({ category: 'threat', item });
    }

    // Only data[0] is ever public (see the type comment above) -- MCStockInfoPanel already
    // reads it the same way. bull_flag turns the free-text sentiment into a signed number a
    // future factor_edge.py pass can test directly, same rationale as swot's net_score.
    const hrRow = data.historicalRating?.data?.[0];
    if (hrRow?.currSentiment) {
      push('historical_rating', 'sentiment_text', null, hrRow.currSentiment);
      const isBull = /bullish/i.test(hrRow.currSentiment);
      const isBear = /bearish/i.test(hrRow.currSentiment);
      push('historical_rating', 'bull_flag', isBull ? 1 : isBear ? -1 : 0);
      const closePrice = Number(hrRow.closePrice);
      if (Number.isFinite(closePrice)) push('historical_rating', 'close_price_at_sentiment', closePrice);
    }

    const writes: Promise<unknown>[] = rows.map(([metric_group, metric_name, metric_value_num, metric_value_text, fetched_at]) =>
      dbRun(
        `INSERT INTO mc_general_metrics (symbol, source_api, metric_group, metric_name, metric_value_num, metric_value_text, fetched_at)
         VALUES (?, 'mc_consolidated', ?, ?, ?, ?, ?)
         ON CONFLICT(symbol, source_api, metric_group, metric_name, fetched_at) DO UPDATE SET
           metric_value_num = excluded.metric_value_num, metric_value_text = excluded.metric_value_text`,
        [symbol.toUpperCase(), metric_group, metric_name, metric_value_num, metric_value_text, fetched_at]
      )
    );
    for (const { category, item } of swotRowsText) {
      writes.push(dbRun(
        `INSERT INTO mc_swot_history (symbol, category, item_text, fetched_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(symbol, category, item_text, fetched_at) DO NOTHING`,
        [symbol.toUpperCase(), category, item, today]
      ));
    }

    if (writes.length === 0) return;
    await Promise.all(writes);
  } catch (e) {
    console.warn('[mcApiService] persistMcConsolidatedMetrics failed (non-fatal):', (e as Error)?.message);
  }
}

/**
 * Main consolidated fetch - gets ALL MC data for a stock.
 * Optimised: Refreshes Price/Technical data every time, but caches Fundamentals for 1 hour.
 */
export async function getMcConsolidatedData(scId: string, symbol: string, timeframe: 'D' | 'W' | 'M' = 'D'): Promise<McConsolidatedData> {
  // scId is expected to already be resolved by the caller via resolveMoneycontrolSymbol
  // (stockMapping.ts) -- do not re-derive it here. A prior version of this function did
  // `getStockMapping(symbol)?.mcsymbol || scId`, which silently reintroduced the same
  // empty-mcsymbol-falls-back-to-raw-ticker bug this codebase fixed at every call site
  // (2026-08-02) if this function's own fallback ever diverged from the caller's.
  const effectiveScId = scId;

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

  persistMcConsolidatedMetrics(symbol, { mcInsights, analystRating, priceForecast, hitsMisses, swot, historicalRating });

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

// ─── MoneyControl Stock News ──────────────────────────────────────────────────

export interface McStockNewsItem {
  heading: string;
  posturl: string;
  creation_date_epoch: string;
  update_date_epoch: string;
  display_date: string;
  post_type: string;
  post_image: string;
  summary: string;
  formatted_date?: string;
}

export interface McNewsLink {
  name: string;
  link: string;
}

/**
 * `no_news` means MoneyControl has nothing for this sc_id (it answers with
 * `news: null`); `fetch_failed` means we never got a usable response. Callers
 * must not collapse the two — an outage rendered as "no news" is how a broken
 * feed goes unnoticed.
 */
export type McNewsStatus = 'ok' | 'no_news' | 'fetch_failed';

export interface McStockNewsResponse {
  scId: string;
  status: McNewsStatus;
  count: number;
  news: McStockNewsItem[];
  additional_links: McNewsLink[];
  more_link?: McNewsLink;
}

/**
 * MoneyControl serves some headlines with the backslash stripped from JSON
 * `\uXXXX` escapes, so an en-dash arrives as the literal text "u2013".
 * Only rewrite sequences that carry a digit and decode above ASCII, so ordinary
 * words that happen to be hex-shaped are left alone.
 */
export function decodeMangledEscapes(text: string): string {
  if (!text) return text;
  return text.replace(/(^|[^A-Za-z0-9])u([0-9a-fA-F]{4})/g, (match, prefix: string, hex: string) => {
    if (!/\d/.test(hex)) return match;
    const code = parseInt(hex, 16);
    if (code < 0x80) return match;
    return prefix + String.fromCharCode(code);
  });
}

export function formatHumanTimestamp(epochStr?: string, displayDate?: string): string {
  if (epochStr && !isNaN(Number(epochStr))) {
    const epochSec = Number(epochStr);
    const date = new Date(epochSec * 1000);
    if (!isNaN(date.getTime())) {
      const now = new Date();
      const diffMs = now.getTime() - date.getTime();
      const diffHours = diffMs / (1000 * 60 * 60);

      if (diffMs >= 0 && diffHours < 24) {
        if (diffHours < 1) {
          const mins = Math.max(1, Math.floor(diffMs / (1000 * 60)));
          return `${mins} ${mins === 1 ? 'min' : 'mins'} ago`;
        }
        const hrs = Math.floor(diffHours);
        return `${hrs} ${hrs === 1 ? 'hour' : 'hours'} ago`;
      }

      if (diffMs >= 0 && diffHours < 168) {
        const days = Math.floor(diffHours / 24);
        return `${days} ${days === 1 ? 'day' : 'days'} ago`;
      }

      const day = date.getDate().toString().padStart(2, '0');
      const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
      const month = months[date.getMonth()];
      const year = date.getFullYear();
      let hours = date.getHours();
      const minutes = date.getMinutes().toString().padStart(2, '0');
      const ampm = hours >= 12 ? 'PM' : 'AM';
      hours = hours % 12;
      hours = hours ? hours : 12;
      const timeStr = `${hours.toString().padStart(2, '0')}:${minutes} ${ampm}`;

      return `${day} ${month} ${year}, ${timeStr}`;
    }
  }
  return displayDate || '—';
}

export function parseMcStockNews(scId: string, res: any): McStockNewsResponse {
  if (!res || typeof res !== 'object' || !res.body) {
    return { scId, status: 'fetch_failed', count: 0, news: [], additional_links: [] };
  }

  const block = res.body.news;
  if (!block || !Array.isArray(block.data)) {
    return { scId, status: 'no_news', count: 0, news: [], additional_links: [] };
  }

  const news: McStockNewsItem[] = block.data.map((item: any) => ({
    heading: decodeMangledEscapes(item.heading || ''),
    posturl: item.posturl || '',
    creation_date_epoch: item.creation_date_epoch || '',
    update_date_epoch: item.update_date_epoch || '',
    display_date: item.display_date || '',
    post_type: item.post_type || 'news',
    post_image: item.post_image || '',
    summary: decodeMangledEscapes(item.summary || ''),
    formatted_date: formatHumanTimestamp(item.creation_date_epoch || item.update_date_epoch, item.display_date),
  }));

  return {
    scId,
    status: news.length > 0 ? 'ok' : 'no_news',
    // The upstream `count` is the page size, not a total — report what we return.
    count: news.length,
    news,
    additional_links: Array.isArray(block.additional_links) ? block.additional_links : [],
    more_link: block.more_link,
  };
}

export async function fetchMcStockNews(scId: string, symbol?: string): Promise<McStockNewsResponse> {
  const url = `https://www.moneycontrol.com/techmvc/mc_apis/mc_pricechart_homepage/news?sc_did=${encodeURIComponent(scId)}`;
  const res = await mcFetchJson<any>(url, 3, symbol);
  return parseMcStockNews(scId, res);
}

// ── MC per-stock EARNINGS news (mc_news.php, related_scid + earnings category) ───────────
// Distinct from fetchMcStockNews above: that hits mc_apis/mc_pricechart_homepage/news (general
// per-stock headlines); this hits MC's own article-search API filtered to the earnings
// sub-category for one scId -- live-verified 2026-08-13 to return the real reported quarterly
// numbers (net sales/profit/EBITDA/EPS), not just a "shares jump X%" reaction wrapper.

export interface McRelatedNewsItem {
  id: string;
  headline: string;
  intro: string;
  posturl: string;
  creation_date_epoch: string;
  update_date_epoch: string;
}

export interface McRelatedNewsResponse {
  scId: string;
  status: McNewsStatus;
  news: McRelatedNewsItem[];
}

/** query object -> the numbered-object response ({"0": {...}, "1": {...}}) `mc_news.php`
 *  actually returns, not an array -- Object.values() normalizes it. */
export function parseMcRelatedNews(scId: string, res: any): McRelatedNewsResponse {
  if (!res || typeof res !== 'object') return { scId, status: 'fetch_failed', news: [] };
  const items = Object.values(res).filter((v): v is any => v && typeof v === 'object' && 'id' in v);
  if (items.length === 0) return { scId, status: 'no_news', news: [] };
  const news: McRelatedNewsItem[] = items.map((item) => ({
    id: String(item.id ?? ''),
    headline: decodeMangledEscapes(item.headline || ''),
    intro: decodeMangledEscapes(item.intro || ''),
    posturl: item.posturl || item.canonical_url || '',
    creation_date_epoch: String(item.creation_date_epoch ?? ''),
    update_date_epoch: String(item.update_date_epoch ?? ''),
  }));
  return { scId, status: 'ok', news };
}

export async function fetchMcEarningsNews(scId: string, symbol?: string, limit = 8): Promise<McRelatedNewsResponse> {
  const url = `https://www.moneycontrol.com/newsapi/mc_news.php?query=categories_slug:"business"+AND+`
    + `sub_category_slug:"earnings"+AND+related_scid:"${encodeURIComponent(scId)}"&start=0&limit=${limit}`;
  const res = await mcFetchJson<any>(url, 3, symbol);
  return parseMcRelatedNews(scId, res);
}

// ── MC market-wide stock-move blurbs (deals/get-stock-news) ──────────────────────────────
// One call, no per-stock loop -- each item already carries its own `scid`, so this is cheap
// and (unlike the top-N-by-market-cap per-stock cycles above) reaches whatever stock MC itself
// chose to write a move-blurb for, including names outside our tracked top-100/150 universe --
// live-verified 2026-08-13 this is exactly the population (smaller/loser-side names) our
// existing per-stock cycles under-cover.

export interface McDealsNewsItem {
  id: string;
  heading: string;
  posturl: string;
  scid: string;
  cmp: string;
  changePct: string;
  updateDateEpoch: string;
}

export function parseMcDealsNews(res: any): McDealsNewsItem[] {
  if (!res || res.success !== 1 || !Array.isArray(res.data)) return [];
  return res.data.map((item: any) => ({
    id: String(item.id ?? ''),
    heading: decodeMangledEscapes(item.heading || ''),
    posturl: item.posturl || '',
    scid: item.scid || '',
    cmp: item.cmp || '',
    changePct: item.perChange || '',
    updateDateEpoch: String(item.update_date_epoch ?? ''),
  }));
}

export async function fetchMcDealsNews(): Promise<McDealsNewsItem[]> {
  const res = await mcFetchJson<any>('https://api.moneycontrol.com/mcapi/v1/deals/get-stock-news', 3);
  return parseMcDealsNews(res);
}
