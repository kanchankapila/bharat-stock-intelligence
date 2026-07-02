import { getStockMapping } from './stockMapping';
import * as fs from 'fs';
import * as path from 'path';
import { dbGet } from './dbAsync';

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'application/json'
};

const WIDGET_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
  'Referer': 'https://trendlyne.com/'
};

function decodeHtmlEntities(str: string): string {
  return str
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

export interface TrendlyneOverviewData {
  companyProfileData?: {
    companyDescription?: string;
  };
  eventsData?: {
    boardMeetingTableData?: any[];
    dividendTableData?: any[];
    bonusTableData?: any[];
    splitTableData?: any[];
    rightTableData?: any[];
  };
  faq?: { question: string; answer: string }[];
}

async function loadFundamentalsFromDb(symbol: string) {
  try {
    const eps = await dbGet('SELECT eps_ttm, date FROM trendlyne_eps_history WHERE symbol = ? ORDER BY date DESC LIMIT 1', [symbol]) as any;
    const pe = await dbGet('SELECT pe_ttm, date FROM trendlyne_pe_history WHERE symbol = ? ORDER BY date DESC LIMIT 1', [symbol]) as any;
    const pb = await dbGet('SELECT pb_ratio, date FROM trendlyne_pb_history WHERE symbol = ? ORDER BY date DESC LIMIT 1', [symbol]) as any;
    const div = await dbGet('SELECT div_yield_pct, date FROM trendlyne_div_yield_history WHERE symbol = ? ORDER BY date DESC LIMIT 1', [symbol]) as any;
    
    return {
      EPS_TTM: eps ? { eodData: [[new Date(eps.date).getTime(), eps.eps_ttm]] } : null,
      PE_TTM_SHARE_NOW: pe ? { eodData: [[new Date(pe.date).getTime(), pe.pe_ttm]] } : null,
      PBV_A_SHARE_NOW: pb ? { eodData: [[new Date(pb.date).getTime(), pb.pb_ratio]] } : null,
      DIVIDEND_YIELD_TTM_Q: div ? { eodData: [[new Date(div.date).getTime(), div.div_yield_pct]] } : null,
    };
  } catch (err: any) {
    console.error('[TRENDLYNE] Database fallback error:', err.message);
    return {};
  }
}

export async function fetchTrendlyneFundamentals(symbol: string) {
  const map = getStockMapping(symbol);
  let tlid = map?.tlid;

  if (!tlid) {
    try {
      const row = await dbGet('SELECT DISTINCT stock_id FROM trendlyne_screener_stocks WHERE symbol = ?', [symbol]) as { stock_id: string } | undefined;
      if (row?.stock_id) {
        tlid = row.stock_id;
      }
    } catch (dbErr) {
      // ignore
    }
  }

  if (!tlid) {
    console.log(`[TRENDLYNE] No tlid found for fundamentals: ${symbol}`);
    return {};
  }

  console.log(`[TRENDLYNE] Fetching Fundamentals live for ${symbol} using tlid: ${tlid}`);
  const params = ['EPS_TTM', 'PE_TTM_SHARE_NOW', 'PBV_A_SHARE_NOW', 'DIVIDEND_YIELD_TTM_Q'];
  const result: Record<string, any> = {};

  try {
    const fetches = params.map(async (param) => {
      const url = `https://trendlyne.com/mapp/v1/stock/chart-data/${tlid}/${param}/?format=json`;
      try {
        const response = await fetch(url, { headers: HEADERS });
        if (response.ok) {
          const json = await response.json();
          if (json.body) {
            result[param] = json.body;
          }
        }
      } catch (err: any) {
        console.warn(`[TRENDLYNE] Failed to fetch fundamentals param ${param} for ${symbol}:`, err.message);
      }
    });
    await Promise.all(fetches);

    if (Object.keys(result).length === 0) {
      console.log(`[TRENDLYNE] Live fetch empty for ${symbol}, trying database fallback...`);
      return await loadFundamentalsFromDb(symbol);
    }

    return result;
  } catch (error: any) {
    console.error(`[TRENDLYNE] Error fetching fundamentals for ${symbol}:`, error.message);
    return await loadFundamentalsFromDb(symbol);
  }
}

export async function fetchTrendlyneSwot(symbol: string) {
  const map = getStockMapping(symbol);
  if (!map) return null;

  console.log(`[TRENDLYNE] Fetching SWOT HTML for ${symbol} using tlid: ${map.tlid}`);
  const url = `https://trendlyne.com/web-widget/swot-widget/${map.tlid}/${symbol.toUpperCase()}/`;
  try {
    const response = await fetch(url, { headers: WIDGET_HEADERS });
    if (!response.ok) {
      console.warn(`[TRENDLYNE] SWOT HTML fetch failed with status: ${response.status}`);
      return null;
    }
    const html = await response.text();

    const bulletsRegex = /<ul[^>]+class=["']text_bullets[^"']*["'][^>]*>([\s\S]*?)<\/ul>/g;
    const liRegex = /<li>([\s\S]*?)<\/li>/g;

    const uls: string[] = [];
    let match;
    while ((match = bulletsRegex.exec(html)) !== null) {
      uls.push(match[1]);
    }

    const categories = ['strengths', 'weaknesses', 'opportunities', 'threats'];
    const swot: Record<string, string[]> = {
      strengths: [],
      weaknesses: [],
      opportunities: [],
      threats: []
    };

    for (let i = 0; i < uls.length && i < categories.length; i++) {
      const category = categories[i];
      const ulContent = uls[i];
      
      // Reset regex index for safety
      liRegex.lastIndex = 0;
      
      let liMatch;
      while ((liMatch = liRegex.exec(ulContent)) !== null) {
        const cleanText = liMatch[1].replace(/<[^>]*>/g, '').trim();
        if (cleanText) {
          swot[category].push(cleanText);
        }
      }
    }

    return swot;
  } catch (err: any) {
    console.error(`[TRENDLYNE] SWOT HTML parse error for ${symbol}:`, err.message);
    return null;
  }
}

export async function fetchTrendlyneChecklist(symbol: string) {
  const map = getStockMapping(symbol);
  if (!map) return null;

  console.log(`[TRENDLYNE] Fetching checklist HTML for ${symbol} using tlid: ${map.tlid}`);
  const url = `https://trendlyne.com/web-widget/checklist-widget/${map.tlid}/${symbol.toUpperCase()}/`;
  try {
    const response = await fetch(url, { headers: WIDGET_HEADERS });
    if (!response.ok) {
      console.warn(`[TRENDLYNE] Checklist HTML fetch failed with status: ${response.status}`);
      return null;
    }
    const htmlText = await response.text();

    const divRegex = /data-checklist-data\s*=\s*["']([\s\S]*?)["']/;
    const countRegex = /data-total-count\s*=\s*["']([\s\S]*?)["']/;

    const dataMatch = htmlText.match(divRegex);
    const countMatch = htmlText.match(countRegex);

    let checklistP = 0;
    let yesCount = 0;
    let noCount = 0;
    let total = 0;
    let insight = '';
    let checklistData = {};

    if (countMatch) {
      try {
        const countJson = JSON.parse(decodeHtmlEntities(countMatch[1]));
        yesCount = countJson.Yes || 0;
        noCount = countJson.No || 0;
        total = countJson.total || 0;
        checklistP = countJson.checklistP || 0;
        insight = countJson.insight || '';
      } catch (e) {
        console.warn('[TRENDLYNE] Error parsing checklist count metadata:', e);
      }
    }

    if (dataMatch) {
      try {
        const rawJson = decodeHtmlEntities(dataMatch[1]);
        const decoded = JSON.parse(rawJson);
        checklistData = decoded.trendlyneChecklist || {};
      } catch (e) {
        console.warn('[TRENDLYNE] Error parsing checklist data payload:', e);
      }
    }

    return {
      score: checklistP,
      yesCount,
      noCount,
      total,
      insight,
      checklistData
    };
  } catch (err: any) {
    console.error(`[TRENDLYNE] Checklist HTML parse error for ${symbol}:`, err.message);
    return null;
  }
}

export async function fetchTrendlyneDVM(symbol: string) {
  const map = getStockMapping(symbol);
  if (!map) return null;

  console.log(`[TRENDLYNE] Fetching DVM HTML for ${symbol} using tlid: ${map.tlid}`);
  const url = `https://trendlyne.com/web-widget/qvt-widget/${map.tlid}/${symbol.toUpperCase()}/`;
  try {
    const response = await fetch(url, { headers: WIDGET_HEADERS });
    if (!response.ok) {
      console.warn(`[TRENDLYNE] DVM HTML fetch failed with status: ${response.status}`);
      return null;
    }
    const html = await response.text();

    const wrapperRegex = /class=["'][^"']*param-wrapper[^"']*["'][\s\S]*?<\/div>\s*<\/div>/g;
    const nameRegex = /class=["']name_text["'][^>]*>([\s\S]*?)<\/span>/;
    const scoreRegex = /class=["']percent_number["'][^>]*>([\s\S]*?)<\/span>/;
    const insightRegex = /class=["']insight_text["'][^>]*>([\s\S]*?)<\/span>/;

    const dvm: Record<string, { score: number, insight: string }> = {};

    let match;
    while ((match = wrapperRegex.exec(html)) !== null) {
      const wrapperContent = match[0];
      const nameMatch = wrapperContent.match(nameRegex);
      const scoreMatch = wrapperContent.match(scoreRegex);
      const insightMatch = wrapperContent.match(insightRegex);

      if (nameMatch && scoreMatch) {
        const rawName = nameMatch[1].replace(/<[^>]*>/g, '').trim().toLowerCase();
        const score = parseInt(scoreMatch[1].replace(/<[^>]*>/g, '').trim(), 10) || 0;
        const insight = insightMatch ? insightMatch[1].replace(/<[^>]*>/g, '').trim() : '';

        if (rawName === 'quality') {
          dvm['quality'] = { score, insight };
          dvm['durability'] = { score, insight };
        } else if (rawName === 'technicals') {
          dvm['technicals'] = { score, insight };
          dvm['momentum'] = { score, insight };
        } else if (rawName === 'valuation') {
          dvm['valuation'] = { score, insight };
        } else {
          dvm[rawName] = { score, insight };
        }
      }
    }

    return dvm;
  } catch (err: any) {
    console.error(`[TRENDLYNE] DVM HTML parse error for ${symbol}:`, err.message);
    return null;
  }
}

export async function fetchTrendlyneStockMetrics(symbol: string) {
  const map = getStockMapping(symbol);
  let tlid = map?.tlid;

  if (!tlid) {
    try {
      const row = await dbGet('SELECT DISTINCT stock_id FROM trendlyne_screener_stocks WHERE symbol = ?', [symbol]) as { stock_id: string } | undefined;
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
setInterval(() => {
  const cutoff = Date.now() - 10 * 60_000;
  for (const [k, v] of taCache) {
    if (v.timestamp < cutoff) taCache.delete(k);
  }
}, 5 * 60_000); // sweep every 5 min

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
      const row = await dbGet('SELECT DISTINCT stock_id FROM trendlyne_screener_stocks WHERE symbol = ?', [symbol]) as { stock_id: string } | undefined;
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
  const url = `https://trendlyne.com/equity/api/stock/adv-technical-analysis/${tlid}/${dur}/?format=json`;
  try {
    const response = await fetch(url, { headers: { ...HEADERS, 'Referer': 'https://trendlyne.com/' } });
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
    console.error(`Error fetching Adv Technical Analysis for ${symbol}:`, error);
    return [];
  }
}

export async function fetchCompanyOverview(symbol: string): Promise<TrendlyneOverviewData | null> {
  const map = getStockMapping(symbol);
  let tlid = map?.tlid;

  if (!tlid) {
    console.log(`[TRENDLYNE] No tlid found for overview: ${symbol}`);
    return null;
  }

  console.log(`[TRENDLYNE] Fetching Company Overview for ${symbol} using tlid: ${tlid}`);
  const url = `https://trendlyne.com/equity/overview-second-part/${tlid}/`;

  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/json, text/plain, */*',
        'Referer': 'https://trendlyne.com/'
      },
      signal: AbortSignal.timeout(10000)
    });

    if (!response.ok) {
      console.warn(`[TRENDLYNE] Overview fetch failed for ${symbol}: ${response.status}`);
      return null;
    }

    const json = await response.json();
    return json.body as TrendlyneOverviewData;
  } catch (error) {
    console.error(`[TRENDLYNE] Error fetching overview for ${symbol}:`, error);
    return null;
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
  const url = `https://trendlyne.com/fundamentals/api/sector-rotation/sector/?format=json&metric=count&period=1M`;
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
  const url = `https://trendlyne.com/fundamentals/api/sector-rotation/indices/?format=json&metric=count&period=1M`;
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
