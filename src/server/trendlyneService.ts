import { getStockMapping } from './stockMapping';
import { cacheGet, cacheSet } from './cacheService';
import { fetchTrendlyneWithAuth } from './trendlyneAuthService';
import { dbGet } from './dbAsync';
import { parseChecklistHtml, type TrendlyneChecklistResult } from './trendlyneChecklistParser';

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'application/json'
};

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
  console.warn(`[TRENDLYNE] SWOT has no JSON API on Trendlyne (only HTML widget scraping); returning null for ${symbol}`);
  return null;
}

export async function fetchTrendlyneChecklist(tlid: string): Promise<TrendlyneChecklistResult | null> {
  try {
    const res = await fetch(`https://kayal.trendlyne.com/clientapi/kayal/content/checklist-bypk/${tlid}`, {
      headers: {
        ...HEADERS,
        'Referer': 'https://trendlyne.com/',
      },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return null;
    const html = await res.text();
    return parseChecklistHtml(html);
  } catch (err: any) {
    console.warn(`[TRENDLYNE] Checklist fetch failed for tlid=${tlid}:`, err.message);
    return null;
  }
}

/**
 * Reads checklist data written by the background cycle job (see Task 6) from
 * trendlyne_checklist. Never live-fetches — on-demand callers (the router
 * procedure and getTrendlyneOverview below) must go through this, not
 * fetchTrendlyneChecklist, so checklist traffic stays confined to the paced
 * cycle job.
 */
export async function getCachedTrendlyneChecklist(symbol: string): Promise<TrendlyneChecklistResult | null> {
  try {
    const row = await dbGet<{
      score: number; total: number; yes_count: number;
      insight: string | null; checklist_data: string;
    }>(
      'SELECT score, total, yes_count, insight, checklist_data FROM trendlyne_checklist WHERE symbol = ?',
      [symbol],
    );
    if (!row) return null;
    return {
      score: row.score,
      total: row.total,
      yesCount: row.yes_count,
      insight: row.insight ?? undefined,
      checklistData: JSON.parse(row.checklist_data),
    };
  } catch (err: any) {
    console.warn(`[TRENDLYNE] Cached checklist read failed for ${symbol}:`, err.message);
    return null;
  }
}

export async function fetchTrendlyneDVM(symbol: string) {
  console.warn(`[TRENDLYNE] DVM has no JSON API on Trendlyne (only HTML widget scraping); returning null for ${symbol}`);
  return null;
}

export interface TrendlyneDvmLeg {
  score: number;
  color: string | null;
  insight?: string;  // Optional compat prop for V2StockDetails
}

export interface TrendlyneDvmScores {
  durability: TrendlyneDvmLeg | null;
  valuation: TrendlyneDvmLeg | null;
  momentum: TrendlyneDvmLeg | null;
  // Optional compat props for existing components (MCStockInfoPanel, V2StockDetails)
  quality?: TrendlyneDvmLeg | null;
  technicals?: TrendlyneDvmLeg | null;
}

/**
 * DVM has no surviving live Trendlyne JSON API (see fetchTrendlyneDVM above), but the
 * scores are already fetched weekly as a byproduct of the EPS_TTM chart-data call in
 * trendlyne_fundamentals_fetcher.py and stored in trendlyne_dvm_scores. Read from there
 * instead of live-scraping.
 */
export async function getTrendlyneDVMFromDb(symbol: string): Promise<TrendlyneDvmScores | null> {
  const row = await dbGet(
    `SELECT d_score, v_score, m_score, d_color, v_color, m_color
     FROM trendlyne_dvm_scores
     WHERE symbol = ?
     ORDER BY date DESC LIMIT 1`,
    [symbol.toUpperCase()],
  ) as
    | { d_score: number | null; v_score: number | null; m_score: number | null; d_color: string | null; v_color: string | null; m_color: string | null }
    | undefined;

  if (!row) return null;
  if (row.d_score == null && row.v_score == null && row.m_score == null) return null;

  return {
    durability: row.d_score != null ? { score: row.d_score, color: row.d_color } : null,
    valuation: row.v_score != null ? { score: row.v_score, color: row.v_color } : null,
    momentum: row.m_score != null ? { score: row.m_score, color: row.m_color } : null,
  };
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
    console.log(`[TRENDLYNE] No metrics tlid found for ${symbol}.`);
    return null;
  }

  console.log(`[TRENDLYNE] Fetching Stock Metrics for ${symbol} using tlid: ${tlid}`);
  const cacheKey = `trendlyne:stock-metrics:${symbol}`;
  const cached = await cacheGet<any>(cacheKey);
  if (cached) {
    return cached;
  }

  const url = `https://trendlyne.com/equity/getStockMetricParameterList/${tlid}/`;
  try {
    const response = await fetchTrendlyneWithAuth(url, { headers: HEADERS });
    if (!response.ok) {
      console.warn(`[TRENDLYNE] Metrics API failed with status ${response.status} for ${symbol}.`);
      return null;
    }

    const data = await response.json();
    if (data.body && data.error !== true && !data.triggerloginmodal && data.head?.status !== '100') {
      await cacheSet(cacheKey, data, 12 * 60 * 60);
      return data;
    }

    console.warn(`[TRENDLYNE] Metrics API returned gated/invalid payload for ${symbol}.`);
    return null;
  } catch (error) {
    console.warn(`[TRENDLYNE] Error fetching stock metrics for ${symbol}:`, error);
    return null;
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
    console.log(`[TRENDLYNE] No TA tlid found for ${symbol}.`);
    return null;
  }

  const durationMap = { 'D': '24', 'W': '25', 'M': '26' };
  const dur = durationMap[timeframe] || '24';

  console.log(`[TRENDLYNE] Fetching Adv Technical Analysis (${timeframe}) for ${symbol} using tlid: ${tlid}`);
  const url = `https://trendlyne.com/equity/api/stock/adv-technical-analysis/${tlid}/${dur}/?format=json`;
  try {
    const response = await fetchTrendlyneWithAuth(url, { headers: { ...HEADERS, 'Referer': 'https://trendlyne.com/' } });
    if (!response.ok) {
      console.warn(`[TRENDLYNE] TA API failed with status ${response.status} for ${symbol}.`);
      return null;
    }
    const data = await response.json();
    if (data.html || !data.body) {
      console.warn(`[TRENDLYNE] TA API returned gated/invalid payload for ${symbol}.`);
      return null;
    }
    return data;
  } catch (error) {
    console.error(`Error fetching Adv Technical Analysis for ${symbol}:`, error);
    return null;
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
    getCachedTrendlyneChecklist(symbol),
    getTrendlyneDVMFromDb(symbol)
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
    // Routed through the auth service (like the other Trendlyne endpoints in this file) so this
    // keeps working — instead of silently degrading forever with no fallback — if Trendlyne ever
    // extends login-gating to this endpoint the way it already has for stock metrics/TA.
    const response = await fetchTrendlyneWithAuth(url, { headers: HEADERS });
    if (!response.ok) {
      throw new Error(`Status: ${response.status}`);
    }
    return await response.json();
  } catch (error) {
    console.error(`[TRENDLYNE] Sector rotation fetch error:`, error);
    return null;
  }
}

export async function fetchTrendlyneIndexRotation() {
  console.log(`[TRENDLYNE] Fetching index rotation data`);
  const url = `https://trendlyne.com/fundamentals/api/sector-rotation/indices/?format=json&metric=count&period=1M`;
  try {
    const response = await fetchTrendlyneWithAuth(url, { headers: HEADERS });
    if (!response.ok) {
      throw new Error(`Status: ${response.status}`);
    }
    return await response.json();
  } catch (error) {
    console.error(`[TRENDLYNE] Index rotation fetch error:`, error);
    return null;
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
