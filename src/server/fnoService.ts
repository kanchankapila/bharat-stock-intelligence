import { getStockMapping } from './stockMapping';
import { fetchOptionChain } from './optionChainService';
import { dbAll } from './dbAsync';

export interface FnOSignal {
  type: 'UNUSUAL_VOLUME' | 'OI_SPIKE' | 'BUILDUP' | 'PCR_SIGNAL';
  sentiment: 'bullish' | 'bearish' | 'neutral';
  strike?: number;
  optionType?: 'CALL' | 'PUT';
  value: string;
  description: string;
  confidence: 'high' | 'medium' | 'low';
}

export interface FnOResponse {
  success: boolean;
  signals: FnOSignal[];
  marketSentiment: {
    pcr: number;
    maxPain: number;
    oiTrend: string;
    ivRank: number;
    ivPercentile: number;
  };
  error?: string;
}

export async function getFnOSignals(query: string): Promise<FnOResponse> {
  try {
    const mapping = getStockMapping(query);
    if (!mapping) {
      return { 
        success: false, 
        signals: [], 
        marketSentiment: { pcr: 0, maxPain: 0, oiTrend: '', ivRank: 0, ivPercentile: 0 }, 
        error: 'Stock mapping not found' 
      };
    }

    const ocData = await fetchOptionChain(query);
    if (!ocData.success || !ocData.data) {
      return {
        success: false,
        signals: [],
        marketSentiment: { pcr: 0, maxPain: 0, oiTrend: '', ivRank: 0, ivPercentile: 0 },
        error: 'Failed to fetch real-time option chain'
      };
    }

    const chain = ocData.data.optionChain;
    const pcr = ocData.data.pcr;
    const sentiment = ocData.data.marketSentiment;
    const signals: FnOSignal[] = [];

    const maxPain = ocData.data.marketSentiment.maxPain || 0;
    
    // 1. Analyze Buildups from real data
    const callBuildupCount = { 'Call Writing': 0, 'Call Buying': 0, 'Short Covering': 0, 'Long Unwinding': 0 };
    const putBuildupCount = { 'Put Writing': 0, 'Put Buying': 0, 'Short Covering': 0, 'Long Unwinding': 0 };

    chain.forEach((row: any) => {
      if (row.callBuiltup && row.callBuiltup !== 'No Conclusion') {
        const type = row.callBuiltup === 'Short Buildup' ? 'Call Writing' : 
                     row.callBuiltup === 'Long Buildup' ? 'Call Buying' : row.callBuiltup;
        if ((callBuildupCount as any)[type] !== undefined) {
          (callBuildupCount as any)[type]++;
        }
      }
      if (row.putBuiltup && row.putBuiltup !== 'No Conclusion') {
        const type = row.putBuiltup === 'Short Buildup' ? 'Put Writing' : 
                     row.putBuiltup === 'Long Buildup' ? 'Put Buying' : row.putBuiltup;
        if ((putBuildupCount as any)[type] !== undefined) {
          (putBuildupCount as any)[type]++;
        }
      }
    });

    // Find dominant buildup
    const allCounts = [
      ...Object.entries(callBuildupCount).map(([k, v]) => ({ type: 'CALL', name: k, count: v })),
      ...Object.entries(putBuildupCount).map(([k, v]) => ({ type: 'PUT', name: k, count: v }))
    ].sort((a, b) => b.count - a.count);

    if (allCounts[0].count > 0) {
      const top = allCounts[0];
      const isBullish = top.name === 'Call Buying' || top.name === 'Put Writing' || top.name === 'Short Covering';
      const isBearish = top.name === 'Call Writing' || top.name === 'Put Buying' || top.name === 'Long Unwinding';
      
      const sentimentType = isBullish ? 'bullish' : isBearish ? 'bearish' : 'neutral';
      
      let expertDesc = '';
      if (top.name === 'Call Writing') expertDesc = `Aggressive Call writing detected. Sellers are capping the upside, suggesting a range-bound or bearish bias in the near term.`;
      else if (top.name === 'Put Writing') expertDesc = `Strong Put writing observed. Bullish participants are providing a solid floor, indicating limited downside risk at current levels.`;
      else if (top.name === 'Call Buying') expertDesc = `Momentum-driven Call buying suggests anticipation of a breakout. Longs are being built up aggressively.`;
      else if (top.name === 'Put Buying') expertDesc = `Hedging or bearish bets via Put buying are rising. Traders are preparing for potential volatility or a downward move.`;
      else expertDesc = `Dominant ${top.name} activity in ${top.type} options indicates shifting positioning among major market participants.`;

      signals.push({
        type: 'BUILDUP',
        sentiment: sentimentType as any,
        value: top.name,
        description: expertDesc,
        confidence: 'high'
      });
    }

    // 2. High OI Resistance/Support
    const sortedByCallOi = [...chain].sort((a, b) => b.callOi - a.callOi);
    const sortedByPutOi = [...chain].sort((a, b) => b.putOi - a.putOi);

    if (sortedByCallOi[0]) {
      signals.push({
        type: 'OI_SPIKE',
        sentiment: 'bearish',
        strike: sortedByCallOi[0].strikePrice,
        optionType: 'CALL',
        value: `${(sortedByCallOi[0].callOi / 1000).toFixed(1)}k OI`,
        description: `Call writers are aggressively defending the ₹${sortedByCallOi[0].strikePrice} level, creating a formidable overhead resistance zone. A sustained move above this level could trigger a massive short-covering rally.`,
        confidence: 'high'
      });
    }

    if (sortedByPutOi[0]) {
      signals.push({
        type: 'OI_SPIKE',
        sentiment: 'bullish',
        strike: sortedByPutOi[0].strikePrice,
        optionType: 'PUT',
        value: `${(sortedByPutOi[0].putOi / 1000).toFixed(1)}k OI`,
        description: `Substantial Put writing at ₹${sortedByPutOi[0].strikePrice} suggests a strong structural floor. Market participants seem confident that the stock will hold this base in the current expiry.`,
        confidence: 'high'
      });
    }

    // 3. PCR Signal
    if (pcr > 1.3 || pcr < 0.7) {
      const pcrSentiment = pcr > 1.3 ? 'bullish' : 'bearish';
      const pcrDesc = pcr > 1.3 ? 
        'PCR at extreme highs suggests an over-sold territory in terms of sentiment (contrarian bullish). Historical data indicates a high probability of a mean-reversion rally.' : 
        'Low PCR indicates heavy Call concentration relative to Puts. The market is leaning heavily bearish, often seen at local tops before a correction.';
        
      signals.push({
        type: 'PCR_SIGNAL',
        sentiment: pcrSentiment as any,
        value: `PCR: ${pcr.toFixed(2)}`,
        description: pcrDesc,
        confidence: 'medium'
      });
    }

    // 4. Max Pain Insight
    if (maxPain > 0) {
      signals.push({
        type: 'BUILDUP',
        sentiment: 'neutral',
        value: `Max Pain: ₹${maxPain}`,
        description: `The option 'Max Pain' strike is at ₹${maxPain}. This is the price level where the maximum number of option contracts would expire worthless, often acting as a magnet for price action as expiry approaches.`,
        confidence: 'medium'
      });
    }

    return {
      success: true,
      signals,
      marketSentiment: {
        pcr,
        maxPain,
        oiTrend: allCounts[0]?.name || 'Neutral',
        ivRank: sentiment.ivRank,
        ivPercentile: sentiment.ivPercentile
      }
    };
  } catch (error) {
    console.error('Error fetching F&O signals:', error);
    return {
      success: false,
      signals: [],
      marketSentiment: { pcr: 0, maxPain: 0, oiTrend: '', ivRank: 0, ivPercentile: 0 },
      error: error instanceof Error ? error.message : 'Unknown error'
    };
  }
}

let cachedExpiry: { iso: string; trendlyne: string } | null = null;
let lastExpiryFetch = 0;

async function getNearExpiry() {
  if (cachedExpiry && Date.now() - lastExpiryFetch < 3600000) return cachedExpiry;
  
  try {
    const url = 'https://webapi.niftytrader.in/webapi/Symbol/symbol-expiry-all?symbol=nifty&exchange=nse';
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/json'
      },
      signal: AbortSignal.timeout(10000)
    });
    const json = await response.json();
    if (json.resultData && json.resultData.length > 0) {
      const nifty = json.resultData.find((d: any) => d.symbol_name === 'NIFTY');
      if (nifty) {
        const dateObj = new Date(nifty.expiry_date);
        const day = dateObj.getDate().toString().padStart(2, '0');
        const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
        const month = months[dateObj.getMonth()];
        const year = dateObj.getFullYear();
        
        cachedExpiry = {
          iso: nifty.expiry_date.split('T')[0], // YYYY-MM-DD
          trendlyne: `${day}-${month}-${year}` // DD-MMM-YYYY
        };
        lastExpiryFetch = Date.now();
        return cachedExpiry;
      }
    }
  } catch (e) {
    console.error('[FNO] Failed to fetch near expiry:', e);
  }
  
  // Dynamic next Thursday fallback
  const d = new Date();
  const day = d.getDay();
  const diff = (4 - day + 7) % 7;
  const nextThursday = new Date(d.getTime() + diff * 24 * 60 * 60 * 1000);
  const dd = nextThursday.getDate().toString().padStart(2, '0');
  const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  const month = months[nextThursday.getMonth()];
  const yyyy = nextThursday.getFullYear();
  
  return {
    iso: nextThursday.toISOString().split('T')[0],
    trendlyne: `${dd}-${month}-${yyyy}`
  };
}


export async function getTrendlyneFnoScanners(mtype: 'options' | 'futures', screenType: string, instType?: string) {
  // Deliberately no `expDate` param -- Trendlyne's own filter endpoint auto-resolves it to
  // the live near expiry when omitted (live-verified). getNearExpiry() derives a single date
  // from NIFTY's own weekly-expiry list and previously got reused for every underlying here;
  // BankNifty only trades monthly contracts, so that NIFTY-specific weekly date never matched
  // a BankNifty row and it silently disappeared from every instType=index response (NIFTY's
  // OI Intelligence Summary showed, BankNifty's didn't). Confirmed live: omitting expDate
  // returns the same current monthly cycle for both NIFTY and BANKNIFTY consistently.
  let url = `https://smartoptions.trendlyne.com/phoenix/api/fno/market/filter/?mtype=${mtype}&screenType=${screenType}`;
  if (instType) url += `&instType=${instType}`;

  console.log(`[TRENDLYNE FNO] Fetching: ${url}`);

  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/json',
        'Referer': 'https://smartoptions.trendlyne.com/dashboard/options/',
        'X-Requested-With': 'XMLHttpRequest'
      },
      signal: AbortSignal.timeout(10000)
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error(`[TRENDLYNE FNO] API Error ${response.status}: ${errText.slice(0, 100)}`);
      throw new Error(`Trendlyne API error: ${response.status}`);
    }
    const json = await response.json();
    // API wraps data under body; normalize to flat shape the frontend expects
    const body = json?.body || json;
    const header = body?.tableHeaders || [];
    const tableData = body?.tableData || [];
    // Read the resolved expiry back off the response's own rows rather than the (removed)
    // pre-guessed date -- reflects whatever Trendlyne actually auto-resolved to.
    const expiry = tableData?.[0]?.[0]?.callbackinfo?.expiry;
    console.log(`[TRENDLYNE FNO] Success: ${screenType} | Rows: ${tableData.length}`);
    return { header, tableData, expiry };
  } catch (error) {
    console.error(`[TRENDLYNE FNO] Error fetching ${screenType}:`, error);
    return { header: [], tableData: [], error: String(error) };
  }
}

// ── Per-symbol option-chain PCR/OI summary (works for ANY F&O symbol -- index or stock) ──
// Replaces the old index-only PCR card, which sourced from Trendlyne's "oi-gainers"
// screeners (getTrendlyneFnoScanners above) -- those rank across the WHOLE index-options
// universe and NIFTY's volume fills every slot, so BANKNIFTY/FINNIFTY/etc never appeared
// (0 rows, confirmed live) regardless of expiry. This hits Trendlyne's per-symbol chain
// endpoint instead (same one so_option_chain_fetcher.py already uses for the full F&O
// stock universe), which has no such ranking bias.
//
// Expiry is resolved from nt_fno_expiry (already populated for every index+stock by
// sync_nt_fno_symbols.py) rather than Trendlyne's own numeric per-stock id -- this table
// already solves "what's this symbol's correct current expiry" for the whole platform, so
// there's no need for a second, Trendlyne-id-keyed resolution scheme.
const CHAIN_UNIQUE_NAME_TO_FIELD: Record<string, string> = {
  current_price_call: 'ce_price', open_interest_call: 'ce_oi', implied_volatility_call: 'ce_iv',
  get_built_up_str_call: 'ce_buildup', strike_price: 'strike',
  current_price_put: 'pe_price', open_interest_put: 'pe_oi', implied_volatility_put: 'pe_iv',
  get_built_up_str_put: 'pe_buildup',
};

export interface FnoChainSummary {
  symbol: string;
  expiry: string;
  spot: number | null;
  pcr: number | null;
  pcrVolume: number | null;
  maxPain: number | null;
  atm: number | null;
  callTotalOI: number;
  putTotalOI: number;
  avgCallIV: number | null;
  avgPutIV: number | null;
  ivSkew: number | null;
  top3Calls: { strike: number; oi: number; ltp: number; iv: number | null; buildup: string | null }[];
  top3Puts: { strike: number; oi: number; ltp: number; iv: number | null; buildup: string | null }[];
}

// All upcoming expiries for a symbol (near-week/near-month through far quarter/half-year) --
// each one is a distinct "horizon" a trader reads OI/PCR positioning for differently: the
// nearest expiry reflects immediate positioning, further ones reflect longer-term hedging.
export async function getFnoAvailableExpiries(symbol: string, limit = 6): Promise<string[]> {
  const rows = await dbAll<{ expiry: string }>(
    `SELECT expiry FROM nt_fno_expiry WHERE symbol = ? AND expiry >= ? ORDER BY expiry LIMIT ?`,
    [symbol.toUpperCase(), new Date().toISOString().slice(0, 10), limit]
  ).catch(() => []);
  return rows.map(r => r.expiry.slice(0, 10));
}

async function resolveFnoExpiry(symbol: string): Promise<string> {
  const rows = await dbAll<{ expiry: string }>(
    `SELECT expiry FROM nt_fno_expiry WHERE symbol = ? AND expiry >= ? ORDER BY expiry LIMIT 1`,
    [symbol.toUpperCase(), new Date().toISOString().slice(0, 10)]
  ).catch(() => []);
  if (rows[0]) return rows[0].expiry.slice(0, 10);
  // Fallback: nearest Thursday (NSE weekly expiry), matching so_option_chain_fetcher.py's
  // own _nearest_thursday() -- only reached if nt_fno_expiry hasn't synced this symbol yet.
  const d = new Date();
  d.setDate(d.getDate() + ((4 - d.getDay() + 7) % 7));
  return d.toISOString().slice(0, 10);
}

// Pure parser (no network) so the column-resolution logic is independently testable.
export function parseFnoChainBody(symbol: string, expiry: string, body: any): FnoChainSummary | null {
  const headers: any[] = body?.tableHeaders || [];
  const rows: any[][] = body?.tableData || [];
  const col: Record<string, number> = {};
  for (let i = 0; i < headers.length; i++) {
    const field = CHAIN_UNIQUE_NAME_TO_FIELD[headers[i]?.unique_name];
    if (field) col[field] = i;
  }
  if (col.strike === undefined || col.ce_oi === undefined || col.pe_oi === undefined) return null;

  const calls: { strike: number; oi: number; ltp: number; iv: number | null; buildup: string | null }[] = [];
  const puts: { strike: number; oi: number; ltp: number; iv: number | null; buildup: string | null }[] = [];
  let callTotalOI = 0, putTotalOI = 0;
  for (const r of rows) {
    const strike = r[col.strike];
    if (typeof strike !== 'number') continue;
    const ceOi = typeof r[col.ce_oi] === 'number' ? r[col.ce_oi] : 0;
    const peOi = typeof r[col.pe_oi] === 'number' ? r[col.pe_oi] : 0;
    callTotalOI += ceOi;
    putTotalOI += peOi;
    if (ceOi > 0) calls.push({ strike, oi: ceOi, ltp: r[col.ce_price] ?? 0, iv: r[col.ce_iv] ?? null, buildup: r[col.ce_buildup] ?? null });
    if (peOi > 0) puts.push({ strike, oi: peOi, ltp: r[col.pe_price] ?? 0, iv: r[col.pe_iv] ?? null, buildup: r[col.pe_buildup] ?? null });
  }

  const pcrData = body?.expiryLevelPCRValues || {};
  const avg = (vals: (number | null)[]) => {
    const nums = vals.filter((v): v is number => typeof v === 'number');
    return nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : null;
  };
  const avgCallIV = avg(calls.map(c => c.iv));
  const avgPutIV = avg(puts.map(p => p.iv));

  return {
    symbol, expiry,
    spot: typeof body?.stockLevelData?.stockCurrentPrice === 'number' ? body.stockLevelData.stockCurrentPrice : null,
    pcr: typeof pcrData.pcr_oi === 'number' ? pcrData.pcr_oi : null,
    pcrVolume: typeof pcrData.pcr_volume === 'number' ? pcrData.pcr_volume : null,
    maxPain: typeof body?.maxPain === 'number' ? body.maxPain : null,
    atm: typeof body?.atTheMoney === 'number' ? body.atTheMoney : null,
    callTotalOI, putTotalOI,
    avgCallIV, avgPutIV,
    ivSkew: avgCallIV != null && avgPutIV != null ? avgPutIV - avgCallIV : null,
    top3Calls: [...calls].sort((a, b) => b.oi - a.oi).slice(0, 3),
    top3Puts: [...puts].sort((a, b) => b.oi - a.oi).slice(0, 3),
  };
}

export async function getFnoOptionChainSummary(symbol: string, expiryOverride?: string): Promise<FnoChainSummary | null> {
  const expiry = expiryOverride || await resolveFnoExpiry(symbol);
  const url = `https://smartoptions.trendlyne.com/phoenix/api/fno/option/chain/?stockCode=${encodeURIComponent(symbol.toUpperCase())}&expDate=${expiry}`;
  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/json',
        'Origin': 'https://smartoptions.trendlyne.com',
        'Referer': 'https://smartoptions.trendlyne.com/',
      },
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) return null;
    const json = await response.json();
    return parseFnoChainBody(symbol.toUpperCase(), expiry, json?.body || json);
  } catch (error) {
    console.error(`[FNO CHAIN] Error fetching ${symbol}:`, error);
    return null;
  }
}

export async function getMCFnoOverview(id: string, instType: 'futures' | 'options' = 'futures') {
  const url = `https://appfeeds.moneycontrol.com/jsonapi/fno/overview?format=json&inst_type=${instType}&id=${id}&ExpiryDate=`;
  
  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      },
      signal: AbortSignal.timeout(8000)
    });
    
    if (!response.ok) throw new Error(`MC F&O API error: ${response.status}`);
    const json = await response.json();
    return json;
  } catch (error) {
    console.error(`[MC FNO] Error fetching overview for ${id}:`, error);
    return { success: false, error: String(error) };
  }
}

export async function getTrendlyneFnoHeatmap() {
  const dates = await getNearExpiry();
  const url = `https://trendlyne.com/futures-options/api/heatmap/${dates.trendlyne}-near/all/price/`;

  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/json',
        'Referer': 'https://trendlyne.com/futures-options/heatmap/'
      },
      signal: AbortSignal.timeout(10000)
    });

    if (!response.ok) throw new Error(`Trendlyne API error: ${response.status}`);
    const json = await response.json();
    // API returns stock list at json.all.series
    return { data: json?.all?.series || [] };
  } catch (error) {
    console.error(`[TRENDLYNE FNO] Error fetching heatmap:`, error);
    return { data: [] };
  }
}
