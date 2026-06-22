/**
 * Trendlyne Screener Service
 * Fetches screener data from Trendlyne's All-in-One Screener API
 * Features:
 * - Database-backed screener name to screenpk mapping (fetched once)
 * - Intelligent caching with configurable fetch frequency
 * - Polite fetching with random jitter
 * - Batch processing for large stock lists
 */

import { dbGet, dbAll, dbRun, dbTransaction } from './dbAsync';
import { getStockMapping, getStockMappingByTLId, getStockMappingByName } from './stockMapping';

const TRENDLYNE_BASE_URL = 'https://kayal.trendlyne.com/broker-webview/kayal/all-in-one-screener-data-get/';

// Configuration for fetch behavior (easily parameterized)
export const TRENDLYNE_CONFIG = {
  // Fetch interval in milliseconds (set to 0 to disable auto-refresh)
  FETCH_INTERVAL_MS: process.env.TRENDLYNE_FETCH_INTERVAL_MS ? parseInt(process.env.TRENDLYNE_FETCH_INTERVAL_MS, 10) : 300000, // 5 minutes
  // Screener names fetch interval (runs once per interval)
  SCREENER_NAMES_INTERVAL_MS: process.env.TRENDLYNE_SCREENER_NAMES_INTERVAL_MS ? parseInt(process.env.TRENDLYNE_SCREENER_NAMES_INTERVAL_MS, 10) : 86400000, // 24 hours
  // Base delay before API call (adds jitter on top)
  BASE_DELAY_MS: process.env.TRENDLYNE_BASE_DELAY_MS ? parseInt(process.env.TRENDLYNE_BASE_DELAY_MS, 10) : 500,
  // Maximum jitter percentage (10-20% is polite)
  JITTER_PERCENT: process.env.TRENDLYNE_JITTER_PERCENT ? parseInt(process.env.TRENDLYNE_JITTER_PERCENT, 10) : 15,
  // Request timeout
  REQUEST_TIMEOUT_MS: process.env.TRENDLYNE_REQUEST_TIMEOUT_MS ? parseInt(process.env.TRENDLYNE_REQUEST_TIMEOUT_MS, 10) : 30000
};

// Helper to update fetch intervals
export function updateFetchInterval(intervalMs: number): void {
  TRENDLYNE_CONFIG.FETCH_INTERVAL_MS = intervalMs;
}

export function updateScreenerNamesInterval(intervalMs: number): void {
  TRENDLYNE_CONFIG.SCREENER_NAMES_INTERVAL_MS = intervalMs;
}

export function isIntradayScreener(name: string, description: string = ''): boolean {
  const text = (name + ' ' + (description || '')).toLowerCase();
  // Use word-boundary patterns for 'min' to avoid matching 'upcoming', 'performing' etc.
  const hasTimedMin = /\b\d+[\s-]min\b/.test(text);
  return (
    hasTimedMin ||
    text.includes('intraday') ||
    text.includes('15m') ||
    text.includes('30m') ||
    text.includes('5m') ||
    text.includes('15-min') ||
    text.includes('30-min') ||
    text.includes('5-min') ||
    text.includes('hourly') ||
    text.includes('day trade') ||
    text.includes('btst') ||
    text.includes('stbt')
  );
}

/**
 * Categorize screener based on its name and description
 */
export function categorizeScreener(name: string, description: string = ''): {
  sentiment: 'bullish' | 'bearish' | 'neutral';
  category: 'technical' | 'fundamental' | 'valuation' | 'delivery' | 'intraday' | 'momentum' | 'sector';
  timeframe: 'intraday' | 'long_term';
} {
  const text = (name + ' ' + (description || '')).toLowerCase();
  
  // 1. Determine Sentiment
  let sentiment: 'bullish' | 'bearish' | 'neutral' = 'neutral';
  // Compound bearish patterns checked first to prevent "momentum trap" → bullish
  const compoundBearish = /momentum\s*trap|value\s*trap|wealth\s*destroy|low\s*dvm|dvm\s*low|exercise\s*caution|red\s*flag/.test(text);
  if (compoundBearish || text.includes('bearish') || text.includes('sell') || text.includes('breakdown') ||
      text.includes('falling') || text.includes('death cross') || text.includes('underperform') ||
      text.includes('top loser') || text.includes('declining') || text.includes('downtrend') ||
      text.includes('overbought') || text.includes('caution') || text.includes('avoid')) {
    sentiment = 'bearish';
  } else if (text.includes('bullish') || text.includes('buy') || text.includes('breakout') ||
      text.includes('rising') || text.includes('golden cross') || text.includes('outperform') ||
      text.includes('top gainer') || text.includes('gaining') || text.includes('uptrend') ||
      text.includes('oversold')) {
    sentiment = 'bullish';
  }

  // 2. Determine Timeframe
  const timeframe = isIntradayScreener(name, description) ? 'intraday' : 'long_term';

  // 3. Determine Category
  let category: 'technical' | 'fundamental' | 'valuation' | 'delivery' | 'intraday' | 'momentum' | 'sector' = 'technical';
  if (text.includes('momentum') || text.includes('relative strength') || text.includes('gainer') || text.includes('rally')) {
    category = 'momentum';
  } else if (text.includes('tata') || text.includes('adani') || text.includes('psu') || text.includes('sector') || text.includes('defense') || text.includes('infra')) {
    category = 'sector';
  } else if (text.includes('fundamental') || text.includes('roe') || text.includes('debt') || 
      text.includes('profit') || text.includes('sales') || text.includes('growth') || text.includes('margin') ||
      text.includes('asset') || text.includes('balance sheet') || text.includes('dividend')) {
    category = 'fundamental';
  } else if (text.includes('valuation') || text.includes('pe ratio') || text.includes('undervalued') || 
             text.includes('cheap') || text.includes('p/e') || text.includes('pb ratio') || text.includes('intrinsic')) {
    category = 'valuation';
  } else if (text.includes('delivery') || text.includes('volume') || text.includes('bulk deal') || text.includes('block deal') || text.includes('turnover')) {
    category = 'delivery';
  } else if (timeframe === 'intraday' || text.includes('scalping')) {
    category = 'intraday';
  }

  return { sentiment, category, timeframe };
}

// Database operations for screener mappings
export async function saveScreenerToDB(
  screenerId: string,
  screenerName: string,
  screenpk: string,
  description?: string
): Promise<void> {
  try {
    const { sentiment, category, timeframe } = categorizeScreener(screenerName, description);
    await dbRun(`
      INSERT INTO trendlyne_screeners (
        screener_id, screener_name, screenpk, description,
        sentiment, category, timeframe, last_updated
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(screener_id) DO UPDATE SET
        screener_name = excluded.screener_name,
        screenpk      = excluded.screenpk,
        description   = excluded.description,
        sentiment     = excluded.sentiment,
        category      = excluded.category,
        timeframe     = excluded.timeframe,
        last_updated  = CURRENT_TIMESTAMP
    `, [
      screenerId,
      screenerName,
      screenpk,
      description || `${screenerName} from Trendlyne`,
      sentiment,
      category,
      timeframe,
    ]);
  } catch (error) {
    console.error(`❌ Error saving screener to DB:`, error);
  }
}

export async function saveScreenerStocksToDB(
  screenerId: string,
  stocks: Array<{ stockId: string; name: string }>
): Promise<void> {
  try {
    const upsertSql = `
      INSERT INTO trendlyne_screener_stocks (screener_id, stock_id, symbol, first_seen, last_seen)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(screener_id, stock_id) DO UPDATE SET
        symbol    = excluded.symbol,
        last_seen = excluded.last_seen
    `;

    // Snapshot previous active symbols BEFORE delete
    const prevSymbols = new Set<string>(
      (await dbAll(`SELECT symbol FROM screener_appearances WHERE screener_id = ? AND exited_date IS NULL`, [screenerId]) as Array<{ symbol: string }>)
        .map(r => r.symbol)
        .filter(Boolean)
    );

    const now = new Date().toISOString().slice(0, 10);
    const incomingIds = new Set(stocks.map(s => s.stockId));

    await dbTransaction(async (tx) => {
      // Remove stocks no longer in screener
      const existing = await tx.all(`SELECT stock_id FROM trendlyne_screener_stocks WHERE screener_id = ?`, [screenerId]) as Array<{ stock_id: string }>;
      const removed = existing.filter(r => !incomingIds.has(r.stock_id));
      for (const r of removed) {
        await tx.run(`DELETE FROM trendlyne_screener_stocks WHERE screener_id = ? AND stock_id = ?`, [screenerId, r.stock_id]);
      }
      // Upsert current stocks
      for (const stock of stocks) {
        const mapping = getStockMapping(stock.stockId);
        const symbol = mapping ? mapping.symbol : null;
        await tx.run(upsertSql, [screenerId, stock.stockId, symbol, now, now]);
      }
    });

    // Update screener_master to reflect fresh sync time
    await dbRun(`UPDATE screener_master SET last_updated = ?, stocks_synced_at = ? WHERE scan_id = ?`, [now, now, screenerId]);

    // Diff patch: record entries/exits in screener_appearances
    const today = new Date().toISOString().slice(0, 10);
    const currentSymbols = new Set<string>(
      stocks
        .map(s => getStockMapping(s.stockId)?.symbol)
        .filter((s): s is string => !!s)
    );

    const entered = Array.from(currentSymbols).filter(s => !prevSymbols.has(s));
    const exited  = Array.from(prevSymbols).filter(s => !currentSymbols.has(s));

    if (entered.length > 0) {
      await dbTransaction(async (tx) => {
        for (const sym of entered) {
          await tx.run(`INSERT OR IGNORE INTO screener_appearances (screener_id, source, symbol, appeared_date) VALUES (?, 'trendlyne', ?, ?)`, [screenerId, sym, today]);
          await tx.run(`INSERT OR IGNORE INTO screener_history_log (symbol, screener_id, entry_date, source) VALUES (?, ?, ?, 'trendlyne')`, [sym, screenerId, today]);
        }
      });
    }

    if (exited.length > 0) {
      await dbRun(
        `UPDATE screener_appearances SET exited_date = ? WHERE screener_id = ? AND symbol IN (${exited.map(() => '?').join(',')}) AND exited_date IS NULL`,
        [today, screenerId, ...exited]
      );
      await dbTransaction(async (tx) => {
        for (const sym of exited) {
          await tx.run(`UPDATE screener_history_log SET exit_date = ? WHERE symbol = ? AND screener_id = ? AND exit_date IS NULL`, [today, sym, screenerId]);
        }
      });
    }
  } catch (error) {
    console.error(`❌ Error saving screener stocks to DB:`, error);
  }
}

export async function getScreenerFromDB(screenerId: string): Promise<{ screener_name: string; screenpk: string } | null> {
  try {
    return await dbGet(`
      SELECT screener_name, screenpk FROM trendlyne_screeners WHERE screener_id = ?
    `, [screenerId]) as { screener_name: string; screenpk: string } | null;
  } catch (error) {
    console.error(`❌ Error retrieving screener from DB:`, error);
    return null;
  }
}

export async function getAllScreenersFromDB(): Promise<Array<{
  screener_id: string;
  screener_name: string;
  screenpk: string;
  description: string;
  sentiment: string;
  category: string;
  timeframe: string;
}>> {
  try {
    return await dbAll(`
      SELECT screener_id, screener_name, screenpk, description, sentiment, category, timeframe
      FROM trendlyne_screeners
      ORDER BY screener_name
    `) as any[];
  } catch (error) {
    console.error(`❌ Error retrieving all screeners from DB:`, error);
    return [];
  }
}

export async function clearScreenersDB(): Promise<void> {
  try {
    await dbRun(`DELETE FROM trendlyne_screeners`);
    console.log(`🗑️ Cleared all screeners from database`);
  } catch (error) {
    console.error(`❌ Error clearing screeners from DB:`, error);
  }
}

// Cache for screener data
interface CacheEntry {
  data: TrendlyneScreenerData;
  timestamp: number;
}

interface ScreenerNamesCache {
  names: Set<string>;
  timestamp: number;
}

interface ScreenerStocksCache {
  mapping: Map<string, string[]>; // screenerName -> stockIds
  timestamp: number;
}

const cache = new Map<string, CacheEntry>();
let screenerNamesCache: ScreenerNamesCache | null = null;
let screenerStocksCache: ScreenerStocksCache | null = null;

/**
 * Get random jitter for polite API fetching
 */
function getJitter(baseMs: number, jitterPercent: number): number {
  const jitterAmount = (baseMs * jitterPercent) / 100;
  const randomJitter = Math.random() * jitterAmount * 2 - jitterAmount;
  return Math.max(50, baseMs + randomJitter);
}

/**
 * Validate URL length won't exceed limits (414 error prevention)
 * Keep stock IDs to max 30 per request
 */
function validateStockIdCount(stockIds: string): boolean {
  const count = stockIds.split(',').length;
  if (count > 30) {
    console.warn(`⚠️ WARNING: ${count} stock IDs in single request may exceed URL length limit. Max recommended: 30`);
    return false;
  }
  return true;
}

/**
 * Check if cached data is still fresh
 */
function isCacheFresh(key: string): boolean {
  if (!cache.has(key)) return false;
  
  // If fetch interval is 0, cache is never fresh (always refetch)
  if (TRENDLYNE_CONFIG.FETCH_INTERVAL_MS === 0) return false;
  
  const entry = cache.get(key)!;
  const age = Date.now() - entry.timestamp;
  return age < TRENDLYNE_CONFIG.FETCH_INTERVAL_MS;
}

/**
 * Get cached data if available
 */
function getCachedData(key: string): TrendlyneScreenerData | null {
  if (isCacheFresh(key)) {
    return cache.get(key)?.data || null;
  }
  return null;
}

/**
 * Check if screener names cache is still fresh
 */
function isScreenerNamesCacheFresh(): boolean {
  if (!screenerNamesCache) return false;
  const age = Date.now() - screenerNamesCache.timestamp;
  return age < TRENDLYNE_CONFIG.SCREENER_NAMES_INTERVAL_MS;
}

/**
 * Get cached screener names
 */
function getCachedScreenerNames(): Set<string> | null {
  if (isScreenerNamesCacheFresh()) {
    return screenerNamesCache?.names || null;
  }
  return null;
}

/**
 * Set cached screener names
 */
function setCachedScreenerNames(names: Set<string>): void {
  screenerNamesCache = {
    names,
    timestamp: Date.now()
  };
}

/**
 * Check if screener->stocks mapping cache is fresh
 */
function isScreenerStocksCacheFresh(): boolean {
  if (!screenerStocksCache) return false;
  const age = Date.now() - screenerStocksCache.timestamp;
  return age < TRENDLYNE_CONFIG.SCREENER_NAMES_INTERVAL_MS;
}

/**
 * Get cached screener->stocks mapping
 */
function getCachedScreenerStocks(): Map<string, string[]> | null {
  if (isScreenerStocksCacheFresh()) {
    return screenerStocksCache?.mapping || null;
  }
  return null;
}

/**
 * Set cached screener->stocks mapping
 */
function setCachedScreenerStocks(mapping: Map<string, string[]>): void {
  screenerStocksCache = {
    mapping,
    timestamp: Date.now()
  };
}

export interface TrendlyneStock {
  stockId: string;
  name: string;
  symbol?: string;
  ltp: number;
  change: number;
  changePercent: number;
  screenerName: string;
  screenerType?: string;
  [key: string]: any;
}

export interface TrendlyneScreenerData {
  success: boolean;
  data: TrendlyneStock[];
  screenerName?: string;
  totalResults?: number;
}

/**
 * Debug function to test API response and see actual structure
 */
export async function testTrendlyneApiResponse(
  stockId: string = '19814'
): Promise<{ rawResponse: any; parsedStocks: TrendlyneStock[] }> {
  try {
    const params = new URLSearchParams({
      perPageCount: '10',
      pageNumber: '0',
      screenpk: stockId,
      groupType: 'all',
      groupName: ''
    });

    const url = `${TRENDLYNE_BASE_URL}?${params.toString()}`;
    console.log('🔍 Testing API with URL:', url);

    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/json',
        'Referer': 'https://kayal.trendlyne.com/'
      }
    });

    console.log('📊 Response Status:', response.status);

    const json = await response.json();
    console.log('📋 Raw API Response (head):', JSON.stringify(json.head, null, 2));

    const stocks: TrendlyneStock[] = [];

    // API returns { body: { screenObj: { title, description, ... }, tableData: [...], tableHeaders: [...] }, head: {...} }
    if (json?.head?.status === '0' && json.body) {
      const screenerTitle = json.body.screenObj?.title || 'Trendlyne Screener';
      const tableData = json.body.tableData || [];
      const tableHeaders = json.body.tableHeaders || [];

      console.log(`📋 Screener: ${screenerTitle}`);
      console.log(`📋 Table Headers: ${tableHeaders.map((h: any) => h.unique_name).join(', ')}`);
      console.log(`📋 Data rows: ${tableData.length}`);

      // Find indices of important columns
      const stockIdIndex = tableHeaders.findIndex((h: any) => h.unique_name === 'stock_id');
      const nameIndex = tableHeaders.findIndex((h: any) => h.unique_name === 'get_full_name');
      const priceIndex = tableHeaders.findIndex((h: any) => h.unique_name === 'currentPrice');
      const changeIndex = tableHeaders.findIndex((h: any) => h.unique_name === 'pPriceChange' || h.unique_name === 'priceChange');
      const changePctIndex = tableHeaders.findIndex((h: any) => h.unique_name === 'pPercentChange' || h.unique_name === 'percentChange');

      console.log(`📋 Column indices - stockId: ${stockIdIndex}, name: ${nameIndex}, price: ${priceIndex}, change: ${changeIndex}, changePct: ${changePctIndex}`);

      // Map tableData rows to stock objects
      tableData.forEach((row: any[]) => {
        const tlId = String(row[stockIdIndex] || '');
        const fullName = String(row[nameIndex] || '');
        
        let mapping = getStockMappingByTLId(tlId);
        if (!mapping) {
          mapping = getStockMappingByName(fullName);
        }

        stocks.push({
          stockId: tlId,
          name: fullName,
          symbol: mapping?.symbol,
          ltp: parseFloat(row[priceIndex] || 0),
          change: changeIndex !== -1 ? parseFloat(row[changeIndex] || 0) : 0,
          changePercent: changePctIndex !== -1 ? parseFloat(row[changePctIndex] || 0) : 0,
          screenerName: screenerTitle,
          screenerType: 'all-in-one'
        });
      });
    } else {
      console.log('❌ API returned error:', json?.head?.statusDescription);
    }

    console.log('✅ Parsed Stocks:', stocks.length);
    console.log('📌 First Stock Sample:', stocks.length > 0 ? stocks[0] : 'No stocks found');

    return { rawResponse: json, parsedStocks: stocks };
  } catch (error) {
    console.error('❌ Test Error:', error);
    throw error;
  }
}

const STOCK_IDS = [
  '19814,153269,19746,3057,280337,6211,190803,387668,66655,548705,16996,45884,501877,691112,7154,211854,208805,24645,523595,691113,11502,174452,205167,32574,371832,222864,6159,93730,154274,463821,36308,4897,3059,7205,208109,497177,15045,14567,123150,9818,9823,9824,9819,9835,9836,9840,9837,9831,9896,9834,9838,9843,9895,9832,9821,9826,788358,788354,786325,786299,24700,24702,358896,358898,286949,358885,224614,24713,358886,224616,470230,470223,24714,224617,224581,224618,224584,24715,25865,224587,224628,224590,24716,25866,224632,24717,224634,224601,224612,442237,358905,358904,358903,358902,442244,358901,358900,358894,358892,358891,358890,358889,358888,358887,358883,224641,9844,9588,9589,10663,10118,756398,756399,756400,756397,22717,24728,24729,24730,5388,756409,756410,756411,756412,258543,756528,756495,756496,756501,756502,756503,756504,756525,756526,756527,756494,756541,756542,756543,756544,756549,756550,756551,756552,756424,756446,756440,756439,756438,756437,756432,756431,756422,756423,756445,756430,756429,756421,756489,756490,756491,756402,756401,756403,756404,22719,5389,756405,756406,756407,756408,24733,24732,24731,258545,756532,756483,756484,756497,756498,756499,756500,756529,756530,756531,756482,756545,756546,756547,756548,756553,756554,756555,756556,756420,756450,756451,756452,756457,756444,756443,756442,756418,756419,756449,756441,756436,756435,756434,756433,756417,5906,5892,5899,5891,5888,5898,5897,5905,5885,5889,5902,5890,5887,5893,5896,5903,5900,5884,5895,5894,5886,5904,5901,79711,79710,231024,231325,230994,231302,186840,385663,385658,385659,79728,79724,231110,385690,385668,385670,198018,385676,353470,385673,48091,35316,35319,35321,35325,35326,434325,24866,24867,10554,7589,6160,334854,36288,208625,208626,208614,5779,18792,15697,35336,35337,35338,35341,35343,24871,24872,24870,24876,208631,208613,178571,178573,222865,182100,218262,218265,218473,218470,218266,218481,218482,218476,218489,218479,218492,218484,218488,178572,258192,258198,258206,258205,258174,258175,258180,258176,222872,222869,218511,218498,222874,222870,218513,218510,222877,222875,222859,218517,222879,222876,222861,218535,371821,371829,371831,371835,252766,252940,252942,252969,252997,371842,372090,372098,372099,372101,253069,253053,253026,253025,253024,372130,179161,178590,179144,178574,372137,252158,252169,252170,178588,372170,372171,372172,372174,372175,252751,252750,252749,252748,252747,79712,79709,79708,79707,79706,79704,79690,79703,79729,79723,79722,79718,79717,79716,79715,79713,260220,260221,260300,260322,260327,260380,260382,260397,260430,260460,260219,260235,260275,260320,260325,260364,260381,260383,260401,260452,79796,79795,79794,79793,79792,79791,79790,79739,79738,79737,79811,79810,79808,79806,79803,79802,79801,79800,79799,79797,764,11559,30,32034,36384,36381,36378,36376,36375,36373,25994,24575,17131,18121,287918,22709,8256,633902,697683,630954,15628,150420,9193,15543,10029,636494,11814,9287,560405,16,25797,82586,83417,12094,20014,15075,24,219052,24747,25818,45882,756413,756425,756465,756461,756453,756469,756473,756505,756509,756513,756493,756485,756477,756481,756517,756521,756533,756537,756414,756426,756466,756462,756454,756458,756470,756474,756506,756510,756514,756486,756478,756518,756522,756534,756538,756415,756427,756463,756447,756455,756459,756467,756471,756475,756507,756511,756515,756487,756479,756519,756523,756535,756539,756416,756428,756464,756448,756456,756460,756468,756472,756476,756508,756512,756516,756492,756488,756480,756520,756524,756536,756540,399177,399179,24573,27,5394,5393,497162,28,6157,482896,481430,481431,481432,481434,481435,481436,482900,482899,482898,482895,482894,482913,482912,482911,482910,482909,482908,482906,482905,482904,482903,482902,482901,482924,482923,482922,482921,482920,482919,482918,482917,482916,482914,701756,701758,701757,701755,701754,701753,593017,593007,593000,593015,593002,593009,593018,593027,593024,593022,593036,593021,593031,593026,593023,593034,593033,593485,593486,593487,593038,593037,593044,593043,593042,593041,593040,593484,593045,593489,593504,593488,593503,593502,593501,593499,593497,593494,593493,701764,701770,701768,701763,701762,701760,594821,594819,594811,594816,594824,594815,594807,594809,594835,594842,595302,594829,594855,594849,594844,594845,594847,594848,595615,595617,595618,595304,595303,595310,595309,595308,595306,595305,595614,595613,595662,595661,595672,595670,595667,595671,595666,595664,595663,701782,701785,701783,701780,701773,701772,494720,504450,494750,494749,494748,494747,494740,494718,494715,494721,495958,495960,495971,495972,504476,495955,495953,495954,495951,495950,495946,495947,224859,224858,224856,224855,224854,224853,224851,224849,225503,225502,225500,225498,225496,225493,225491,225489,224875,224874,224872,224870,224869,224866,224865,224864,225524,225526,225522,225520,225517,225515,225509,225507,495937,495935,495117,494777,494773,494768,494767,494764,494763,494761,494758,494757,494756,494754,225408,225381,497806,497805,497804,497803,497802,497798,497797,497796,497793,497791,497790,497789,497786,497784,231999,231960,231955,225569,225558,225540,225538,504449,504448,504444,504442,504441,504438,504435,504433,495992,495990,495989,495988,495986,495984,495979,495975,498225,498224,498223,498221,498220,498219,498217,498215,498214,498212,498211,498209,498205,498203,359218,359217,359216,359214,359213,359212,359200,15320,17343,13086,31717,17344,26001,11385,9544,36377,23,184105,497233,42221,11500,15316,15318,31264,25348,47927,399172,258663,15451,526367,526405,526380,526379,526362,526402,526363,526385,472327,471978,472341,472333,472344,20078,46425,661640,661639,661637,661641,661638,629842,592839,592842,592754,592853,592864,592840,592848,592861,592858,592856,789518,661182,592867,592873,592935,592936,592943,592940,608228,638307,608252,608231,592969,592939,556779,556782,556783,556798,556802,556806,556812,556819,556858,556862,253272,556865,556869,556891,556895,556358,688033,207497,669112,669051,669140,669138,669137,669067,669064,253311,253307,253296,253269,253267,253264,556785,556790,556793,556795,556799,556803,556810,556813,556820,556861,556864,556868,556873,556885,556888,556894,253313,253337,253354,253352,253350,258822,669143,669142,669141,669114,669070,669066,669060,208995,208618,208619,497124,25125,16995,21557,17038,180912,26901,37335,258944,258930,258902,479184,82566,36275,515743,126619,17183,179158,92294,10699,330675,13213,650308,4807,24842,23511,14807,11321,14752,10955,10407,8036,11866,9335,6562,29,11793,11122,18566,9516,17233,8182,7830,8181,14535,10159,8185,7942,7557,26,8008,497215,270925,314013,82568,3056,3051,422031,422030,422010500,82567,82476,422033,314012,314026,83413,314016,314038,83414,314039,95025,478,9362,31,314052,314043,314003,82485,83419,314020,314055,314053,82553,314011,314046,314050,314054,83418,314019,314040,314051,15,82466,422015,422014,422013,422006,1511,4805,18597,18916,497220,314009,82540,12405,422017,691164,691162,691159,677964,678277,1729,138,423,717,2651,1648,226,41,293,292'
];

/**
 * Fetch screener data from Trendlyne API using screenpk and screenerName
 * @param screenpk - A sample stock ID to use as context for the API call
 * @param screenerName - The name of the screener to fetch stocks for
 * @param pageNumber - Page number for pagination (default 0)
 * @param skipCache - Force bypass cache (default false)
 * @returns Screener data with stocks
 */
export async function fetchTrendlyneScreenerData(
  screenpk: string,
  screenerName: string,
  pageNumber: number = 0,
  skipCache: boolean = false
): Promise<TrendlyneScreenerData> {
  try {
    if (!screenpk || !screenerName) {
      console.warn(`⚠️ Missing screenpk or screenerName for screener fetch`);
      return {
        success: false,
        data: [],
        totalResults: 0
      };
    }

    // Create cache key using both screenpk and screenerName
    const cacheKey = `${screenpk}:${screenerName}:${pageNumber}`;

    // Check cache if not skipping
    if (!skipCache) {
      const cached = getCachedData(cacheKey);
      if (cached) {
        console.log(`📦 Using cached data for screener: ${screenerName}`);
        return cached;
      }
    }

    // Apply jitter delay for polite fetching
    const jitterDelay = getJitter(TRENDLYNE_CONFIG.BASE_DELAY_MS, TRENDLYNE_CONFIG.JITTER_PERCENT);
    await new Promise(resolve => setTimeout(resolve, jitterDelay));

    const params = new URLSearchParams({
      perPageCount: '1000',
      pageNumber: pageNumber.toString(),
      screenpk: screenpk,
      groupType: 'all',
      groupName: screenerName  // Use the screener name as groupName to filter
    });

    const url = `${TRENDLYNE_BASE_URL}?${params.toString()}`;
    console.log(`📊 Fetching screener data for: ${screenerName} (sample screenpk: ${screenpk})`);

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), TRENDLYNE_CONFIG.REQUEST_TIMEOUT_MS);

    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/json',
        'Referer': 'https://kayal.trendlyne.com/'
      }
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      console.error(`❌ Trendlyne API error: ${response.status}`);
      return {
        success: false,
        data: [],
        totalResults: 0
      };
    }

    const json = await response.json();

    // Transform the response to our expected format
    // API returns: { body: { screenObj: { title, description, ... }, tableData: [...], tableHeaders: [...] }, head: {...} }
    if (json && json.head?.status === '0' && json.body) {
      const stocks: TrendlyneStock[] = [];
      const screenerTitle = json.body.screenObj?.title || 'Trendlyne Screener';
      const tableData = json.body.tableData || [];
      const tableHeaders = json.body.tableHeaders || [];

      // Find indices of important columns
      const stockIdIndex = tableHeaders.findIndex((h: any) => h.unique_name === 'stock_id');
      const nameIndex = tableHeaders.findIndex((h: any) => h.unique_name === 'get_full_name');
      const priceIndex = tableHeaders.findIndex((h: any) => h.unique_name === 'currentPrice');
      const changeIndex = tableHeaders.findIndex((h: any) => h.unique_name === 'pPriceChange' || h.unique_name === 'priceChange');
      const changePctIndex = tableHeaders.findIndex((h: any) => h.unique_name === 'pPercentChange' || h.unique_name === 'percentChange');
      const return1wIndex = tableHeaders.findIndex((h: any) => h.unique_name === 'pReturn1W' || h.unique_name === 'return1W' || h.unique_name === 'pReturn5D');
      const return1mIndex = tableHeaders.findIndex((h: any) => h.unique_name === 'pReturn1M' || h.unique_name === 'return1M' || h.unique_name === 'pReturn21D');

      // Map tableData rows to stock objects
      tableData.forEach((row: any[]) => {
        const tlId = String(row[stockIdIndex] || '');
        const fullName = String(row[nameIndex] || '');
        
        let mapping = getStockMappingByTLId(tlId);
        if (!mapping) {
          mapping = getStockMappingByName(fullName);
        }

        stocks.push({
          stockId: tlId,
          name: fullName,
          symbol: mapping?.symbol,
          ltp: parseFloat(row[priceIndex] || 0),
          change: changeIndex !== -1 ? parseFloat(row[changeIndex] || 0) : 0,
          changePercent: changePctIndex !== -1 ? parseFloat(row[changePctIndex] || 0) : 0,
          return_1w: return1wIndex !== -1 ? parseFloat(row[return1wIndex] || 0) : undefined,
          return_1m: return1mIndex !== -1 ? parseFloat(row[return1mIndex] || 0) : undefined,
          screenerName: screenerTitle,
          screenerType: 'all-in-one'
        });
      });

      // --- Enrichment & Sorting ---
      const symbols = stocks.map(s => s.symbol).filter(Boolean) as string[];
      if (symbols.length > 0) {
        try {
          // 1. Fetch Quant Scores
          const placeholders = symbols.map(() => '?').join(',');
          const qScores = await dbAll(`
            SELECT symbol, rank_composite, return_1w, return_1m, composite_class
            FROM quant_scores
            WHERE symbol IN (${placeholders})
          `, symbols) as any[];

          const scoreMap = new Map(qScores.map(q => [q.symbol, q]));

          // 2. Fetch Other Screeners
          const otherScrs = await dbAll(`
            SELECT ss.symbol, s.screener_name
            FROM trendlyne_screener_stocks ss
            JOIN trendlyne_screeners s ON s.screener_id = ss.screener_id
            WHERE ss.symbol IN (${placeholders})
          `, symbols) as any[];
          
          const scrMap = new Map<string, string[]>();
          otherScrs.forEach(o => {
            if (!scrMap.has(o.symbol)) scrMap.set(o.symbol, []);
            if (o.screener_name !== screenerTitle) { // Avoid redundancy
              scrMap.get(o.symbol)!.push(o.screener_name);
            }
          });

          // 3. Apply to stocks
          stocks.forEach(s => {
            if (s.symbol) {
              const score = scoreMap.get(s.symbol);
              if (score) {
                s.score = score.rank_composite;
                if (s.return_1w === undefined) s.return_1w = score.return_1w;
                if (s.return_1m === undefined) s.return_1m = score.return_1m;
                s.classification = score.composite_class;
              }
              s.otherScreeners = scrMap.get(s.symbol) || [];
            }
          });

          // 4. Sort by score (High to Low) - Actionable Intelligence
          stocks.sort((a, b) => (b.score || 0) - (a.score || 0));
          
          console.log(`✨ Enriched ${stocks.length} stocks with AlphaQuant Intelligence`);
        } catch (enrichError) {
          console.error('❌ Error enriching screener stocks:', enrichError);
        }
      }

      const result = {
        success: true,
        data: stocks,
        screenerName: screenerTitle,
        totalResults: stocks.length
      };

      // Cache the result
      cache.set(cacheKey, { data: result, timestamp: Date.now() });
      console.log(`✅ Fetched ${stocks.length} stocks for screener: ${screenerTitle}`);
      return result;
    }

    console.warn(`⚠️ Unexpected API response format`);
    return {
      success: false,
      data: [],
      totalResults: 0
    };
  } catch (error) {
    console.error('❌ Error fetching Trendlyne screener data:', error);
    return {
      success: false,
      data: [],
      totalResults: 0
    };
  }
}

/**
 * Fetch all unique screener names from Trendlyne API and save to database
 * Queries ALL NSE stocks in the database to discover ALL screener types comprehensively
 * Stores screener name -> screenpk mapping in database for one-time fetch
 * @returns Set of unique screener names
 */
export async function fetchAllTrendlyneScreenerNames(forceRefresh = false): Promise<Set<string>> {
  try {
    // Return cached screeners unless a forced refresh is requested
    if (!forceRefresh) {
      const existingScreeners = await getAllScreenersFromDB();
      if (existingScreeners.length > 0) {
        console.log(`✅ Using ${existingScreeners.length} screeners from database (previously fetched)`);
        return new Set(existingScreeners.map(s => s.screener_name));
      }
    } else {
      // Clear existing screeners so the full discovery re-runs
      await dbRun('DELETE FROM trendlyne_screeners');
      console.log('🔄 Force-refreshing Trendlyne screeners — cleared existing DB entries');
    }

    // Get stock IDs from the hardcoded list (fallback to existing data)
    // In the future, this can be extended to use NSE stocks from database
    const allStockIds = STOCK_IDS[0].split(',');

    console.log(`🔍 Fetching ALL ${allStockIds.length} stocks to discover comprehensive screener list...`);
    console.log(`⏱️  This is a one-time operation. Please be patient (may take 10-15 minutes)...`);

    const screenerNames = new Set<string>();
    const screenerMappings = new Map<string, string>(); // screener_id -> screenpk

    let successCount = 0;
    let errorCount = 0;
    const startTime = Date.now();

    // Fetch ALL stocks to discover all screeners
    for (let idx = 0; idx < allStockIds.length; idx++) {
      const stockId = allStockIds[idx];

      // Progress update every 50 stocks
      if (idx % 50 === 0) {
        const elapsedSeconds = Math.round((Date.now() - startTime) / 1000);
        const percentComplete = Math.round((idx / allStockIds.length) * 100);
        console.log(`📊 Progress: ${idx}/${allStockIds.length} (${percentComplete}%) | Found ${screenerMappings.size} screeners | Elapsed: ${elapsedSeconds}s`);
      }

      // Apply jitter delay for polite fetching
      const jitterDelay = getJitter(TRENDLYNE_CONFIG.BASE_DELAY_MS, TRENDLYNE_CONFIG.JITTER_PERCENT);
      await new Promise(resolve => setTimeout(resolve, jitterDelay));

      try {
        const params = new URLSearchParams({
          perPageCount: '1000',
          pageNumber: '0',
          screenpk: stockId,
          groupType: 'all',
          groupName: ''
        });

        const url = `${TRENDLYNE_BASE_URL}?${params.toString()}`;

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), TRENDLYNE_CONFIG.REQUEST_TIMEOUT_MS);

        const response = await fetch(url, {
          signal: controller.signal,
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            'Accept': 'application/json',
            'Referer': 'https://kayal.trendlyne.com/'
          }
        });

        clearTimeout(timeoutId);

        if (!response.ok) {
          errorCount++;
          continue;
        }

        const json = await response.json();
        // API returns { body: { screenObj: { title: "..." }, ... }, head: { status: "0" } }
        if (json?.head?.status === '0' && json.body?.screenObj?.title) {
          const screenerName = json.body.screenObj.title;
          screenerNames.add(screenerName);
          successCount++;

          // Create ID in same format as frontend uses
          const screenerNameId = screenerName.toLowerCase().replace(/\s+/g, '-');

          // Store the screenpk (stockId) for this screener
          // Only store the first screenpk found for each screener
          if (!screenerMappings.has(screenerNameId)) {
            screenerMappings.set(screenerNameId, stockId);
            console.log(`  ✅ [${screenerMappings.size}] Stock ${idx + 1}: "${screenerName}" (pk: ${stockId})`);
          }
        }
      } catch (error) {
        errorCount++;
        // Silently continue on individual stock fetch errors
      }
    }

    // Save all screener mappings to database (one-time operation)
    const totalTime = Math.round((Date.now() - startTime) / 1000);
    console.log(`\n💾 Saving ${screenerMappings.size} screener mappings to database...`);
    console.log(`📈 Statistics: ${successCount} successful | ${errorCount} errors | ${totalTime}s total time`);

    const saveTasks: Promise<void>[] = [];
    screenerMappings.forEach((screenpk, screenerNameId) => {
      // Get the full name from screenerNames
      const screenerName = Array.from(screenerNames).find(
        name => name.toLowerCase().replace(/\s+/g, '-') === screenerNameId
      ) || screenerNameId;

      saveTasks.push(saveScreenerToDB(screenerNameId, screenerName, screenpk));
    });
    await Promise.all(saveTasks);

    console.log(`✅ Fetched and saved ${screenerNames.size} unique screeners to database`);
    console.log(`✅ Average time per stock: ${Math.round(totalTime / allStockIds.length * 1000)}ms`);

    return screenerNames;
  } catch (error) {
    console.error('❌ Error fetching screener names:', error);
    return new Set();
  }
}

/**
 * Get list of screener names/categories available
 * Returns screeners from database, enriched with NLP-inferred metadata from screener_master
 */
export async function getTrendlyneScreenerList() {
  // 1. Get raw screeners from their respective source tables
  const trendlyneScreeners = await getAllScreenersFromDB();

  let mcScreeners: any[] = [];
  try {
    mcScreeners = await dbAll(`
      SELECT scan_id, screener_name, type, is_positive
      FROM moneycontrol_screeners
      ORDER BY screener_name
    `) as any[];
  } catch (error) {
    console.error('❌ Error fetching MC screeners for list:', error);
  }

  // 2. Load the "New Analysis" metadata from screener_master
  const masterMeta = new Map<string, any>();
  try {
    const rows = await dbAll(`
      SELECT scan_id, inferred_sentiment, inferred_category, inferred_timeframe, confidence
      FROM screener_master
    `) as any[];
    for (const r of rows) {
      masterMeta.set(r.scan_id, r);
    }
  } catch (err) {
    console.error('❌ Error loading screener_master metadata:', err);
  }

  // If database is empty, trigger background fetch
  if (trendlyneScreeners.length === 0 && mcScreeners.length === 0) {
    console.log(`📊 Database empty, triggering background fetch of screener names from Trendlyne API...`);
    fetchAllTrendlyneScreenerNames().catch(err => console.error('Background fetch error:', err));
    
    return (await getTrendlyneScreenerCategories()).map(c => {
      const { sentiment, category, timeframe } = categorizeScreener(c.name, c.description);
      return {
        id: c.id,
        name: c.name,
        description: c.description,
        screenpk: '19814',
        sentiment,
        category,
        timeframe,
        source: 'trendlyne'
      };
    });
  }

  const result = [];
  
  // 3. Process Trendlyne screeners
  for (const s of trendlyneScreeners) {
    const meta = masterMeta.get(s.screener_id);
    result.push({
      id: s.screener_id,
      name: s.screener_name,
      description: s.description,
      screenpk: s.screenpk,
      // Use NLP analysis if available, otherwise fall back to simple regex
      sentiment: meta?.inferred_sentiment || s.sentiment,
      category:  meta?.inferred_category  || s.category,
      timeframe: meta?.inferred_timeframe || s.timeframe,
      confidence: meta?.confidence || 0.5,
      source: 'trendlyne'
    });
  }
  
  // 4. Process MoneyControl screeners
  for (const mc of mcScreeners) {
    const meta = masterMeta.get(mc.scan_id);
    result.push({
      id: mc.scan_id,
      name: mc.screener_name,
      description: 'Moneycontrol ' + (mc.type === 'pro' ? 'Fundamental' : 'Technical') + ' Screener',
      screenpk: 'MC_' + mc.scan_id,
      sentiment: meta?.inferred_sentiment || (mc.is_positive === 1 ? 'bullish' : 'bearish'),
      category:  meta?.inferred_category  || (mc.type === 'pro' ? 'fundamental' : 'technical'),
      timeframe: meta?.inferred_timeframe || (mc.type === 'pro' ? 'long_term' : 'intraday'),
      confidence: meta?.confidence || 0.7,
      source: 'moneycontrol'
    });
  }

  // 5. Process ETnow screeners
  try {
    const etScreeners = await dbAll(`
      SELECT screener_id, screener_name, query_condition
      FROM etnow_screeners
      ORDER BY screener_name
    `) as any[];

    for (const et of etScreeners) {
      const meta = masterMeta.get(et.screener_id);
      result.push({
        id: et.screener_id,
        name: et.screener_name,
        description: 'ETnow Market Screener',
        screenpk: 'ET_' + et.screener_id,
        sentiment: meta?.inferred_sentiment || 'neutral',
        category:  meta?.inferred_category  || 'fundamental',
        timeframe: meta?.inferred_timeframe || 'long_term',
        confidence: meta?.confidence || 0.6,
        source: 'etnow'
      });
    }
  } catch (error) {
    console.error('❌ Error fetching ETnow screeners for list:', error);
  }

  return result;
}

/**
 * Determine sentiment from screener name
 * Returns: 'bullish' | 'bearish' | 'neutral'
 */
function determineSentiment(screenerName: string): 'bullish' | 'bearish' | 'neutral' {
  const name = screenerName.toLowerCase();

  // Compound bearish patterns first to prevent "momentum trap" → bullish
  if (/momentum\s*trap|value\s*trap|wealth\s*destroy|low\s*dvm|dvm\s*low|exercise\s*caution/.test(name)) {
    return 'bearish';
  }

  // Bearish indicators
  if (name.includes('bearish') || name.includes('sell') || name.includes('breakdown') ||
      name.includes('underperform') || name.includes('falling') || name.includes('declining') ||
      name.includes('negative') || name.includes('below') || name.includes('crossed below') ||
      name.includes('caution') || name.includes('avoid') || name.includes('weak')) {
    return 'bearish';
  }

  // Bullish indicators
  if (name.includes('bullish') || name.includes('buy') || name.includes('breakout') ||
      name.includes('outperform') || name.includes('rising') || name.includes('gaining') ||
      name.includes('high momentum') || name.includes('high growth') || name.includes('top gainers') ||
      name.includes('increasing') || name.includes('above') || name.includes('crossed above')) {
    return 'bullish';
  }

  // Default to neutral
  return 'neutral';
}

/**
 * Find all screeners that contain a specific stock (Synchronous version for API integration)
 * @param stockId - The stock ID to search for
 * @returns Array of screeners containing the stock with sentiment info
 */
export async function findScreenersByStock(stockId: string): Promise<Array<{
  id: string;
  name: string;
  sentiment: 'bullish' | 'bearish' | 'neutral';
  screenpk: string;
  source: string;
  description: string;
}>> {
  try {
    if (!stockId || stockId === '#N/A' || stockId === 'undefined' || stockId === 'null') {
      return [];
    }

    // Attempt to resolve symbol if stockId is passed as a symbol or mapping exists
    const mapping = getStockMapping(stockId);
    const symbol = mapping ? mapping.symbol : stockId;

    // Get matching screeners enriched with NLP metadata
    const matches = await dbAll(`
      SELECT s.screener_id, s.screener_name, s.screenpk, s.description, m.inferred_sentiment, s.sentiment as fallback_sentiment
      FROM trendlyne_screeners s
      JOIN trendlyne_screener_stocks ss ON s.screener_id = ss.screener_id
      LEFT JOIN screener_master m ON s.screener_id = m.scan_id
      WHERE ss.stock_id = ? OR ss.symbol = ?
    `, [stockId, symbol]) as Array<{
      screener_id: string; 
      screener_name: string;
      screenpk: string;
      description: string;
      inferred_sentiment: string | null;
      fallback_sentiment: string;
    }>;

    if (matches.length === 0) {
      return [];
    }

    const result = matches.map(m => ({
      id: m.screener_id,
      name: m.screener_name,
      sentiment: (m.inferred_sentiment || m.fallback_sentiment || determineSentiment(m.screener_name)) as 'bullish' | 'bearish' | 'neutral',
      screenpk: m.screenpk,
      source: 'trendlyne',
      description: m.description || 'Trendlyne Intelligent Screener'
    }));

    return result;
  } catch (error) {
    console.error('❌ Error finding screeners for stock from DB:', error);
    return [];
  }
}


/**
 * Synchronize all screener constituents to the database
 */
export async function syncAllScreenerStocksToDB(timeframeFilter?: 'intraday' | 'long_term') {
  try {
    console.log(`🔄 Starting Trendlyne screener synchronization (filter: ${timeframeFilter || 'all'})...`);
    
    // 1. Ensure we have screeners in the DB
    let screeners = await getAllScreenersFromDB();
    if (screeners.length === 0) {
      await fetchAllTrendlyneScreenerNames();
      screeners = await getAllScreenersFromDB();
    }
    
    if (timeframeFilter) {
      screeners = screeners.filter(s => s.timeframe === timeframeFilter);
    }
    
    console.log(`📊 Found ${screeners.length} screeners to sync`);
    let successCount = 0;
    
    for (const screener of screeners) {
      try {
        console.log(`⏳ Fetching stocks for: ${screener.screener_name}...`);
        
        // Fetch stocks for this screener (skip cache to get fresh mapping)
        const result = await fetchTrendlyneScreenerData(
          screener.screenpk,
          screener.screener_name,
          0,
          true
        );
        
        if (result.success && result.data) {
          const stocksToSave = result.data.map(s => ({
            stockId: s.stockId,
            name: s.name
          }));
          
          await saveScreenerStocksToDB(screener.screener_id, stocksToSave);
          successCount++;
          console.log(`  ✅ Saved ${stocksToSave.length} stocks for ${screener.screener_name}`);
        }
        
        // Polite delay
        await new Promise(resolve => setTimeout(resolve, 500));
      } catch (err) {
        console.error(`  ❌ Error syncing screener ${screener.screener_name}:`, err);
      }
    }
    
    console.log(`✅ Completed synchronization of ${successCount}/${screeners.length} screeners`);
    return { success: true, count: successCount };
  } catch (error) {
    console.error('❌ Error during full screener sync:', error);
    return { success: false, error: String(error) };
  }
}

/**
 * Re-categorize all screeners in the database based on current logic
 */
export async function recategorizeAllScreeners() {
  try {
    const screeners = await getAllScreenersFromDB();
    console.log(`🔄 Re-categorizing ${screeners.length} screeners...`);

    let updatedCount = 0;
    const updateSql = `
      UPDATE trendlyne_screeners
      SET sentiment = ?, category = ?, timeframe = ?
      WHERE screener_id = ?
    `;

    await dbTransaction(async (tx) => {
      for (const s of screeners) {
        const { sentiment, category, timeframe } = categorizeScreener(s.screener_name, s.description);
        if (sentiment !== s.sentiment || category !== s.category || timeframe !== s.timeframe) {
          await tx.run(updateSql, [sentiment, category, timeframe, s.screener_id]);
          updatedCount++;
        }
      }
    });

    console.log(`✅ Re-categorization complete. Updated ${updatedCount} screeners.`);
    return { success: true, updatedCount };
  } catch (error) {
    console.error('❌ Error during re-categorization:', error);
    return { success: false, error: String(error) };
  }
}

/**
 * Get hardcoded fallback categories if API fails
 */
export function getTrendlyneScreenerCategories() {
  return [
    // ── Expert Bullish ────────────────────────────────────────────────────
    { id: '19814', name: 'MFs & FII/DII Increasing QoQ', description: 'Institutions increasing shareholding quarter-on-quarter', sentiment: 'bullish' as const, category: 'fundamental' as const, timeframe: 'long_term' as const, source: 'trendlyne', screenpk: '19814' },
    { id: '153269', name: 'Superstar Investor Buys', description: 'Stocks bought by superstar investors', sentiment: 'bullish' as const, category: 'fundamental' as const, timeframe: 'long_term' as const, source: 'trendlyne', screenpk: '153269' },
    { id: '3057', name: 'High Momentum Score', description: 'Highest Trendlyne Momentum Score stocks', sentiment: 'bullish' as const, category: 'momentum' as const, timeframe: 'long_term' as const, source: 'trendlyne', screenpk: '3057' },
    { id: '6211', name: 'High Piotroski Score', description: 'Companies with strong financials (High F-Score)', sentiment: 'bullish' as const, category: 'fundamental' as const, timeframe: 'long_term' as const, source: 'trendlyne', screenpk: '6211' },
    { id: '190803', name: 'All Stars: High Scorers', description: 'High scorers across all metrics', sentiment: 'bullish' as const, category: 'fundamental' as const, timeframe: 'long_term' as const, source: 'trendlyne', screenpk: '190803' },
    { id: '387668', name: 'High Trendlyne Checklist Score', description: 'Top checklist score stocks', sentiment: 'bullish' as const, category: 'fundamental' as const, timeframe: 'long_term' as const, source: 'trendlyne', screenpk: '387668' },
    { id: '548705', name: 'Low PE vs Historical Avg', description: 'PE TTM lower than 3Y, 5Y, 10Y average PE', sentiment: 'bullish' as const, category: 'valuation' as const, timeframe: 'long_term' as const, source: 'trendlyne', screenpk: '548705' },
    { id: '45884', name: 'Upcoming Bonus/Split', description: 'Stocks with upcoming bonus or stock split', sentiment: 'bullish' as const, category: 'fundamental' as const, timeframe: 'long_term' as const, source: 'trendlyne', screenpk: '45884' },
    { id: '501877', name: 'Consistently Performing Growth Stocks', description: 'Consistent growth with strong performance', sentiment: 'bullish' as const, category: 'fundamental' as const, timeframe: 'long_term' as const, source: 'trendlyne', screenpk: '501877' },
    { id: '691112', name: 'Darvas Scan', description: 'Darvas Box breakout stocks', sentiment: 'bullish' as const, category: 'technical' as const, timeframe: 'long_term' as const, source: 'trendlyne', screenpk: '691112' },
    { id: '7154', name: 'Improving Cash Flow', description: 'Good durability with improving cash flow', sentiment: 'bullish' as const, category: 'fundamental' as const, timeframe: 'long_term' as const, source: 'trendlyne', screenpk: '7154' },
    { id: '24645', name: 'Golden Cross (50 > 200 SMA)', description: 'Golden cross 50 day over 200 day', sentiment: 'bullish' as const, category: 'technical' as const, timeframe: 'long_term' as const, source: 'trendlyne', screenpk: '24645' },
    { id: '691113', name: 'Magic Formula (Joel Greenblatt)', description: 'Magic formula investing stocks', sentiment: 'bullish' as const, category: 'valuation' as const, timeframe: 'long_term' as const, source: 'trendlyne', screenpk: '691113' },
    { id: '174452', name: 'PLI Scheme Beneficiaries', description: 'Companies benefiting from government PLI schemes', sentiment: 'bullish' as const, category: 'fundamental' as const, timeframe: 'long_term' as const, source: 'trendlyne', screenpk: '174452' },
    { id: '32574', name: 'Consistent Performers (5Y)', description: 'Consistent high performing stocks over five years', sentiment: 'bullish' as const, category: 'fundamental' as const, timeframe: 'long_term' as const, source: 'trendlyne', screenpk: '32574' },
    { id: '222864', name: 'PE Less Than Sector PE', description: 'Undervalued relative to sector peers', sentiment: 'bullish' as const, category: 'valuation' as const, timeframe: 'long_term' as const, source: 'trendlyne', screenpk: '222864' },
    { id: '14567', name: "Jim Slater's Zulu Principle", description: 'Discover growth stocks using Zulu Principle', sentiment: 'bullish' as const, category: 'fundamental' as const, timeframe: 'long_term' as const, source: 'trendlyne', screenpk: '14567' },
    { id: '123150', name: 'Richard Dreihaus Momentum', description: 'Momentum driven strategy by Richard Dreihaus', sentiment: 'bullish' as const, category: 'momentum' as const, timeframe: 'long_term' as const, source: 'trendlyne', screenpk: '123150' },
    { id: '6159', name: 'Momentum Score Daily Gainers', description: 'Stocks gaining momentum score daily', sentiment: 'bullish' as const, category: 'momentum' as const, timeframe: 'long_term' as const, source: 'trendlyne', screenpk: '6159' },

    // ── Expert Bearish ────────────────────────────────────────────────────
    { id: '93730', name: 'PE Sell Zone', description: 'Stocks in the PE sell zone', sentiment: 'bearish' as const, category: 'valuation' as const, timeframe: 'long_term' as const, source: 'trendlyne', screenpk: '93730' },
    { id: '154274', name: 'Superstar Investor Sells', description: 'Stocks sold by superstar investors', sentiment: 'bearish' as const, category: 'fundamental' as const, timeframe: 'long_term' as const, source: 'trendlyne', screenpk: '154274' },
    { id: '463821', name: 'Wealth Destroyers (6M)', description: 'Wealth destroyers in the past 6 months', sentiment: 'bearish' as const, category: 'momentum' as const, timeframe: 'long_term' as const, source: 'trendlyne', screenpk: '463821' },
    { id: '36308', name: 'High Debt Companies', description: 'Highly leveraged companies', sentiment: 'bearish' as const, category: 'fundamental' as const, timeframe: 'long_term' as const, source: 'trendlyne', screenpk: '36308' },
    { id: '4897', name: 'About to Cross Below SMA-200', description: 'Stocks in downtrend likely to cross below SMA-200', sentiment: 'bearish' as const, category: 'technical' as const, timeframe: 'long_term' as const, source: 'trendlyne', screenpk: '4897' },
    { id: '3059', name: 'Low Momentum Score (Bearish)', description: 'Stocks with medium to low momentum score', sentiment: 'bearish' as const, category: 'momentum' as const, timeframe: 'long_term' as const, source: 'trendlyne', screenpk: '3059' },
    { id: '7205', name: 'Low DVM Stocks', description: 'Stocks to exercise caution on (Low DVM)', sentiment: 'bearish' as const, category: 'fundamental' as const, timeframe: 'long_term' as const, source: 'trendlyne', screenpk: '7205' },

    // ── High DVM ─────────────────────────────────────────────────────────
    { id: '9818', name: 'Strong Performers (High DVM)', description: 'High DVM strong performer stocks', sentiment: 'bullish' as const, category: 'fundamental' as const, timeframe: 'long_term' as const, source: 'trendlyne', screenpk: '9818' },
    { id: '9823', name: 'Strong Performer, Getting Expensive (DVM)', description: 'High DVM but becoming expensive', sentiment: 'neutral' as const, category: 'fundamental' as const, timeframe: 'long_term' as const, source: 'trendlyne', screenpk: '9823' },
    { id: '9824', name: 'Expensive Stars (DVM)', description: 'High DVM expensive stocks', sentiment: 'neutral' as const, category: 'valuation' as const, timeframe: 'long_term' as const, source: 'trendlyne', screenpk: '9824' },
    { id: '9819', name: 'Under Radar Strong Performers (DVM)', description: 'High DVM under-radar stocks', sentiment: 'bullish' as const, category: 'fundamental' as const, timeframe: 'long_term' as const, source: 'trendlyne', screenpk: '9819' },

    // ── Price/Volume ──────────────────────────────────────────────────────
    { id: '788358', name: 'NSE Stocks at Upper Circuit', description: 'Stocks at upper circuit limit', sentiment: 'bullish' as const, category: 'momentum' as const, timeframe: 'intraday' as const, source: 'trendlyne', screenpk: '788358' },
    { id: '788354', name: 'NSE Stocks at Lower Circuit', description: 'Stocks at lower circuit limit', sentiment: 'bearish' as const, category: 'momentum' as const, timeframe: 'intraday' as const, source: 'trendlyne', screenpk: '788354' },
    { id: '786325', name: 'NSE Stocks Hit Upper Circuit Today', description: 'Stocks that hit upper circuit today', sentiment: 'bullish' as const, category: 'momentum' as const, timeframe: 'intraday' as const, source: 'trendlyne', screenpk: '786325' },
    { id: '786299', name: 'NSE Stocks Hit Lower Circuit Today', description: 'Stocks that hit lower circuit today', sentiment: 'bearish' as const, category: 'momentum' as const, timeframe: 'intraday' as const, source: 'trendlyne', screenpk: '786299' },
    { id: '17110', name: 'New 52 Week High Today', description: 'Stocks making new 52 week highs', sentiment: 'bullish' as const, category: 'momentum' as const, timeframe: 'long_term' as const, source: 'trendlyne', screenpk: '17110' },
    { id: '17109', name: 'New 52 Week Low Today', description: 'Stocks at new 52 week lows', sentiment: 'bearish' as const, category: 'momentum' as const, timeframe: 'long_term' as const, source: 'trendlyne', screenpk: '17109' },
    { id: '470223', name: 'Gap Up Opening', description: 'Gap up opening in price screener', sentiment: 'bullish' as const, category: 'momentum' as const, timeframe: 'intraday' as const, source: 'trendlyne', screenpk: '470223' },
    { id: '470230', name: 'Gap Down Opening', description: 'Gap down opening in price screener', sentiment: 'bearish' as const, category: 'momentum' as const, timeframe: 'intraday' as const, source: 'trendlyne', screenpk: '470230' },
    { id: '17096', name: 'Top Gainers', description: 'Bullish stocks for today on exchanges', sentiment: 'bullish' as const, category: 'momentum' as const, timeframe: 'intraday' as const, source: 'trendlyne', screenpk: '17096' },
    { id: '17098', name: 'Top Losers', description: 'Top losing stocks for today', sentiment: 'bearish' as const, category: 'momentum' as const, timeframe: 'intraday' as const, source: 'trendlyne', screenpk: '17098' },
    { id: '17097', name: 'Volume Shockers', description: 'Stocks with unusual high volume', sentiment: 'neutral' as const, category: 'delivery' as const, timeframe: 'intraday' as const, source: 'trendlyne', screenpk: '17097' },
    { id: '17099', name: 'High Volume High Gain', description: 'Unusual high volume, top gainers', sentiment: 'bullish' as const, category: 'delivery' as const, timeframe: 'intraday' as const, source: 'trendlyne', screenpk: '17099' },
    { id: '17100', name: 'High Volume Top Losers', description: 'Unusual high volume, top losers', sentiment: 'bearish' as const, category: 'delivery' as const, timeframe: 'intraday' as const, source: 'trendlyne', screenpk: '17100' },
    { id: '286949', name: '>30% Below 52W High', description: 'Significant distance from 52 week high', sentiment: 'bearish' as const, category: 'valuation' as const, timeframe: 'long_term' as const, source: 'trendlyne', screenpk: '286949' },

    // ── Delivery ──────────────────────────────────────────────────────────
    { id: '9844', name: 'Rising Delivery % (vs Prev Day)', description: 'Stocks seeing rising delivery percentage', sentiment: 'bullish' as const, category: 'delivery' as const, timeframe: 'intraday' as const, source: 'trendlyne', screenpk: '9844' },
    { id: '9588', name: 'High Delivery Percentage', description: 'Stocks with high delivery percentage', sentiment: 'bullish' as const, category: 'delivery' as const, timeframe: 'intraday' as const, source: 'trendlyne', screenpk: '9588' },
    { id: '48091', name: 'Upcoming Results + Rising Delivery', description: 'Rising delivery volumes before results', sentiment: 'bullish' as const, category: 'delivery' as const, timeframe: 'long_term' as const, source: 'trendlyne', screenpk: '48091' },

    // ── Intraday Positive Technical ───────────────────────────────────────
    { id: '22717', name: 'MACD Crossover Above Signal', description: 'MACD crossover above signal line', sentiment: 'bullish' as const, category: 'intraday' as const, timeframe: 'intraday' as const, source: 'trendlyne', screenpk: '22717' },
    { id: '756398', name: '30min MACD Crossover ↑', description: '30 min MACD crossover above signal line', sentiment: 'bullish' as const, category: 'intraday' as const, timeframe: 'intraday' as const, source: 'trendlyne', screenpk: '756398' },
    { id: '756399', name: '1H MACD Crossover ↑', description: '1H MACD crossover above signal line', sentiment: 'bullish' as const, category: 'intraday' as const, timeframe: 'intraday' as const, source: 'trendlyne', screenpk: '756399' },
    { id: '5388', name: 'RSI Bullish', description: 'RSI bullish signal stocks', sentiment: 'bullish' as const, category: 'intraday' as const, timeframe: 'intraday' as const, source: 'trendlyne', screenpk: '5388' },
    { id: '756409', name: '15min RSI Bullish', description: '15 min RSI bullish stocks', sentiment: 'bullish' as const, category: 'intraday' as const, timeframe: 'intraday' as const, source: 'trendlyne', screenpk: '756409' },
    { id: '24728', name: 'Positive Breakout > R1', description: 'LTP breakout above first resistance', sentiment: 'bullish' as const, category: 'intraday' as const, timeframe: 'intraday' as const, source: 'trendlyne', screenpk: '24728' },
    { id: '24729', name: 'Positive Breakout > R2', description: 'LTP breakout above second resistance', sentiment: 'bullish' as const, category: 'intraday' as const, timeframe: 'intraday' as const, source: 'trendlyne', screenpk: '24729' },
    { id: '258543', name: 'Price Above Pivot', description: 'Stocks with price above pivot point', sentiment: 'bullish' as const, category: 'intraday' as const, timeframe: 'intraday' as const, source: 'trendlyne', screenpk: '258543' },
    { id: '756446', name: '30min Bollinger Band Breakout', description: '30 min Bollinger Band breakout', sentiment: 'bullish' as const, category: 'intraday' as const, timeframe: 'intraday' as const, source: 'trendlyne', screenpk: '756446' },

    // ── Intraday Negative Technical ───────────────────────────────────────
    { id: '22719', name: 'MACD Crossover Below Signal', description: 'MACD crossover below signal line', sentiment: 'bearish' as const, category: 'intraday' as const, timeframe: 'intraday' as const, source: 'trendlyne', screenpk: '22719' },
    { id: '756402', name: '30min MACD Crossover ↓', description: '30 min MACD crossover below signal line', sentiment: 'bearish' as const, category: 'intraday' as const, timeframe: 'intraday' as const, source: 'trendlyne', screenpk: '756402' },
    { id: '5389', name: 'RSI Bearish', description: 'RSI bearish signal stocks', sentiment: 'bearish' as const, category: 'intraday' as const, timeframe: 'intraday' as const, source: 'trendlyne', screenpk: '5389' },
    { id: '24733', name: 'Negative Breakdown < S1', description: 'LTP breakdown below first support', sentiment: 'bearish' as const, category: 'intraday' as const, timeframe: 'intraday' as const, source: 'trendlyne', screenpk: '24733' },
    { id: '258545', name: 'Price Below Pivot', description: 'Stocks with price below pivot point', sentiment: 'bearish' as const, category: 'intraday' as const, timeframe: 'intraday' as const, source: 'trendlyne', screenpk: '258545' },
    { id: '24870', name: 'Death Cross', description: 'Death cross pattern stocks', sentiment: 'bearish' as const, category: 'technical' as const, timeframe: 'long_term' as const, source: 'trendlyne', screenpk: '24870' },
    { id: '756449', name: '15min Bollinger Band Breakdown', description: '15 min Bollinger Band breakdown', sentiment: 'bearish' as const, category: 'intraday' as const, timeframe: 'intraday' as const, source: 'trendlyne', screenpk: '756449' },

    // ── Positive Candlesticks ─────────────────────────────────────────────
    { id: '5906', name: 'Dragonfly Doji (Bullish Reversal)', description: 'Dragonfly Doji bullish reversal pattern', sentiment: 'bullish' as const, category: 'technical' as const, timeframe: 'long_term' as const, source: 'trendlyne', screenpk: '5906' },
    { id: '5892', name: 'Bullish Engulfing', description: 'Bullish engulfing reversal pattern', sentiment: 'bullish' as const, category: 'technical' as const, timeframe: 'long_term' as const, source: 'trendlyne', screenpk: '5892' },
    { id: '5899', name: 'White Marubozu', description: 'White Marubozu bullish candlestick', sentiment: 'bullish' as const, category: 'technical' as const, timeframe: 'long_term' as const, source: 'trendlyne', screenpk: '5899' },
    { id: '5898', name: 'Morning Star (Bullish Reversal)', description: 'Morning Star bullish reversal pattern', sentiment: 'bullish' as const, category: 'technical' as const, timeframe: 'long_term' as const, source: 'trendlyne', screenpk: '5898' },
    { id: '5889', name: 'Hammer (Bullish Reversal)', description: 'Hammer bullish reversal pattern', sentiment: 'bullish' as const, category: 'technical' as const, timeframe: 'long_term' as const, source: 'trendlyne', screenpk: '5889' },
    { id: '5902', name: 'Three White Soldiers', description: 'Three white soldiers bullish reversal', sentiment: 'bullish' as const, category: 'technical' as const, timeframe: 'long_term' as const, source: 'trendlyne', screenpk: '5902' },
    { id: '5885', name: 'Inverted Hammer (Bullish)', description: 'Inverted Hammer bullish reversal', sentiment: 'bullish' as const, category: 'technical' as const, timeframe: 'long_term' as const, source: 'trendlyne', screenpk: '5885' },

    // ── Negative Candlesticks ─────────────────────────────────────────────
    { id: '5893', name: 'Bearish Engulfing', description: 'Bearish engulfing reversal pattern', sentiment: 'bearish' as const, category: 'technical' as const, timeframe: 'long_term' as const, source: 'trendlyne', screenpk: '5893' },
    { id: '5896', name: 'Black Marubozu (Bearish)', description: 'Black Marubozu bearish candlestick', sentiment: 'bearish' as const, category: 'technical' as const, timeframe: 'long_term' as const, source: 'trendlyne', screenpk: '5896' },
    { id: '5904', name: 'Shooting Star (Bearish)', description: 'Shooting Star bearish reversal pattern', sentiment: 'bearish' as const, category: 'technical' as const, timeframe: 'long_term' as const, source: 'trendlyne', screenpk: '5904' },
    { id: '5884', name: 'Identical Three Crows', description: 'Identical Three Crows bearish reversal', sentiment: 'bearish' as const, category: 'technical' as const, timeframe: 'long_term' as const, source: 'trendlyne', screenpk: '5884' },
    { id: '5901', name: 'Hanging Man (Bearish)', description: 'Hanging Man bearish reversal pattern', sentiment: 'bearish' as const, category: 'technical' as const, timeframe: 'long_term' as const, source: 'trendlyne', screenpk: '5901' },
    { id: '5895', name: 'Dark Cloud Cover (Bearish)', description: 'Dark cloud cover bearish reversal', sentiment: 'bearish' as const, category: 'technical' as const, timeframe: 'long_term' as const, source: 'trendlyne', screenpk: '5895' },

    // ── Swing Trading ─────────────────────────────────────────────────────
    { id: '79795', name: 'Outperform Nifty500 – 1 Week', description: 'Relative outperformance vs Nifty500 over week', sentiment: 'bullish' as const, category: 'momentum' as const, timeframe: 'long_term' as const, source: 'trendlyne', screenpk: '79795' },
    { id: '79796', name: 'Outperform Nifty500 – 1 Day', description: 'Relative outperformance vs Nifty500 over day', sentiment: 'bullish' as const, category: 'momentum' as const, timeframe: 'intraday' as const, source: 'trendlyne', screenpk: '79796' },
    { id: '79794', name: 'Outperform Nifty500 – 1 Month', description: 'Relative outperformance vs Nifty500 over month', sentiment: 'bullish' as const, category: 'momentum' as const, timeframe: 'long_term' as const, source: 'trendlyne', screenpk: '79794' },
    { id: '79793', name: 'Outperform Nifty500 – 1 Quarter', description: 'Relative outperformance vs Nifty500 over 1 quarter', sentiment: 'bullish' as const, category: 'momentum' as const, timeframe: 'long_term' as const, source: 'trendlyne', screenpk: '79793' },
    { id: '79792', name: 'Outperform Nifty500 – 6 Months', description: 'Relative outperformance vs Nifty500 over 6 months', sentiment: 'bullish' as const, category: 'momentum' as const, timeframe: 'long_term' as const, source: 'trendlyne', screenpk: '79792' },
    { id: '79791', name: 'Outperform Nifty500 – 1 Year', description: 'Relative outperformance vs Nifty500 over 1 year', sentiment: 'bullish' as const, category: 'momentum' as const, timeframe: 'long_term' as const, source: 'trendlyne', screenpk: '79791' },
    { id: '79790', name: 'Outperform Nifty500 – 2 Years', description: 'Relative outperformance vs Nifty500 over 2 years', sentiment: 'bullish' as const, category: 'momentum' as const, timeframe: 'long_term' as const, source: 'trendlyne', screenpk: '79790' },
    { id: '79811', name: 'Underperform Nifty500 – 1 Day', description: 'Relative underperformance vs Nifty500 over day', sentiment: 'bearish' as const, category: 'momentum' as const, timeframe: 'intraday' as const, source: 'trendlyne', screenpk: '79811' },
    { id: '79810', name: 'Underperform Nifty500 – 1 Week', description: 'Relative underperformance vs Nifty500 over week', sentiment: 'bearish' as const, category: 'momentum' as const, timeframe: 'long_term' as const, source: 'trendlyne', screenpk: '79810' },
    { id: '79808', name: 'Underperform Nifty500 – 1 Month', description: 'Relative underperformance vs Nifty500 over month', sentiment: 'bearish' as const, category: 'momentum' as const, timeframe: 'long_term' as const, source: 'trendlyne', screenpk: '79808' },
    { id: '79711', name: 'Outperform Nifty50 – 1 Week', description: 'Relative outperformance vs Nifty50 over week', sentiment: 'bullish' as const, category: 'momentum' as const, timeframe: 'long_term' as const, source: 'trendlyne', screenpk: '79711' },
    { id: '79710', name: 'Outperform Nifty50 – 1 Month', description: 'Relative outperformance vs Nifty50 over month', sentiment: 'bullish' as const, category: 'momentum' as const, timeframe: 'long_term' as const, source: 'trendlyne', screenpk: '79710' },

    // ── Swing Positive Technical ──────────────────────────────────────────
    { id: '35316', name: 'Price Above 5D EMA', description: 'Current price above 5 day EMA', sentiment: 'bullish' as const, category: 'technical' as const, timeframe: 'intraday' as const, source: 'trendlyne', screenpk: '35316' },
    { id: '35325', name: 'Price Above 50D EMA', description: 'Current price above 50 day EMA', sentiment: 'bullish' as const, category: 'technical' as const, timeframe: 'long_term' as const, source: 'trendlyne', screenpk: '35325' },
    { id: '434325', name: 'Golden Cross Made Today', description: 'Golden cross happened today', sentiment: 'bullish' as const, category: 'technical' as const, timeframe: 'long_term' as const, source: 'trendlyne', screenpk: '434325' },
    { id: '24866', name: 'Positive Breakout – Short Trend', description: 'Short term positive breakout', sentiment: 'bullish' as const, category: 'technical' as const, timeframe: 'long_term' as const, source: 'trendlyne', screenpk: '24866' },
    { id: '208626', name: 'Long Buildup', description: 'Securities seeing a long buildup in FnO', sentiment: 'bullish' as const, category: 'technical' as const, timeframe: 'intraday' as const, source: 'trendlyne', screenpk: '208626' },
    { id: '208625', name: 'Short Covering', description: 'Securities seeing short covering in FnO', sentiment: 'bullish' as const, category: 'technical' as const, timeframe: 'intraday' as const, source: 'trendlyne', screenpk: '208625' },

    // ── Swing Negative Technical ──────────────────────────────────────────
    { id: '35336', name: 'Price Below 5D EMA', description: 'Current price below 5 day EMA', sentiment: 'bearish' as const, category: 'technical' as const, timeframe: 'intraday' as const, source: 'trendlyne', screenpk: '35336' },
    { id: '35343', name: 'Price Below 100D EMA', description: 'Current price below 100 day EMA', sentiment: 'bearish' as const, category: 'technical' as const, timeframe: 'long_term' as const, source: 'trendlyne', screenpk: '35343' },
    { id: '24871', name: 'Negative Breakout – Short Trend', description: 'Short term negative breakout', sentiment: 'bearish' as const, category: 'technical' as const, timeframe: 'long_term' as const, source: 'trendlyne', screenpk: '24871' },
    { id: '208631', name: 'Short Buildup', description: 'Securities seeing a short build-up in FnO', sentiment: 'bearish' as const, category: 'technical' as const, timeframe: 'intraday' as const, source: 'trendlyne', screenpk: '208631' },

    // ── Fundamental Valuation ─────────────────────────────────────────────
    { id: '178571', name: 'PE Higher Than Industry PE', description: 'Potentially overvalued vs industry', sentiment: 'bearish' as const, category: 'valuation' as const, timeframe: 'long_term' as const, source: 'trendlyne', screenpk: '178571' },
    { id: '178573', name: 'PE Less Than Industry PE', description: 'Potentially undervalued vs industry', sentiment: 'bullish' as const, category: 'valuation' as const, timeframe: 'long_term' as const, source: 'trendlyne', screenpk: '178573' },
    { id: '218473', name: 'ROCE Higher Than Industry', description: 'Return on capital employed above industry', sentiment: 'bullish' as const, category: 'fundamental' as const, timeframe: 'long_term' as const, source: 'trendlyne', screenpk: '218473' },
    { id: '218481', name: 'ROE Higher Than Industry', description: 'Return on equity above industry', sentiment: 'bullish' as const, category: 'fundamental' as const, timeframe: 'long_term' as const, source: 'trendlyne', screenpk: '218481' },
    { id: '222872', name: 'Quarterly Profit Growth > Industry', description: 'Quarterly profit growth above industry average', sentiment: 'bullish' as const, category: 'fundamental' as const, timeframe: 'long_term' as const, source: 'trendlyne', screenpk: '222872' },
    { id: '222877', name: 'Quarterly Revenue Growth > Industry', description: 'Quarterly revenue growth above industry', sentiment: 'bullish' as const, category: 'fundamental' as const, timeframe: 'long_term' as const, source: 'trendlyne', screenpk: '222877' },

    // ── Fundamental Analysis ──────────────────────────────────────────────
    { id: '27', name: 'Overbought (RSI + MFI)', description: 'Overbought on both RSI and MFI, possible reversal', sentiment: 'bearish' as const, category: 'technical' as const, timeframe: 'intraday' as const, source: 'trendlyne', screenpk: '27' },
    { id: '28', name: 'Oversold (RSI + MFI)', description: 'Oversold on both RSI and MFI, possible bounce', sentiment: 'bullish' as const, category: 'technical' as const, timeframe: 'intraday' as const, source: 'trendlyne', screenpk: '28' },
    { id: '15', name: 'Hi Revenue & Profit Growth, Hi ROE, Low PE', description: 'Quality growth at value price', sentiment: 'bullish' as const, category: 'fundamental' as const, timeframe: 'long_term' as const, source: 'trendlyne', screenpk: '15' },
    { id: '10', name: 'Rising Revenue Every Quarter (4 Qtrs)', description: 'Increasing revenue for 4 consecutive quarters', sentiment: 'bullish' as const, category: 'fundamental' as const, timeframe: 'long_term' as const, source: 'trendlyne', screenpk: '10' },
    { id: '22', name: 'Promoters Buying Growth Stocks', description: 'Promoters increasing stake in growth stocks', sentiment: 'bullish' as const, category: 'fundamental' as const, timeframe: 'long_term' as const, source: 'trendlyne', screenpk: '22' },
    { id: '24', name: 'Pataka Stocks (Analyst Upgrades + 20% Upside)', description: 'High analyst rating with 20%+ upside potential', sentiment: 'bullish' as const, category: 'fundamental' as const, timeframe: 'long_term' as const, source: 'trendlyne', screenpk: '24' },
    { id: '20014', name: 'Broker Price/Reco Upgrades (1M)', description: 'Stocks with broker upgrades in past one month', sentiment: 'bullish' as const, category: 'fundamental' as const, timeframe: 'long_term' as const, source: 'trendlyne', screenpk: '20014' },
    { id: '42', name: 'High Volume High Growth', description: 'High volume stocks with high growth', sentiment: 'bullish' as const, category: 'delivery' as const, timeframe: 'long_term' as const, source: 'trendlyne', screenpk: '42' },
    { id: '40', name: 'Near Day High/Low + 2x Year Avg Vol', description: 'Near day high or low with 2x yearly average volume', sentiment: 'neutral' as const, category: 'delivery' as const, timeframe: 'intraday' as const, source: 'trendlyne', screenpk: '40' },
    { id: '31', name: 'Small Cap Stars', description: 'High performing small cap stocks', sentiment: 'bullish' as const, category: 'fundamental' as const, timeframe: 'long_term' as const, source: 'trendlyne', screenpk: '31' },
  ];
}


/**
 * Scan all Intraday Trendlyne screeners and automatically generate BUY/SELL signals for high-scoring stock constituents.
 */
export async function runIntradayScreenerScan(): Promise<{
  screenersScanned: number;
  highScoringStocksFound: number;
  newSignalsGenerated: number;
}> {
  console.log('⚡ [INTRADAY SCAN] Starting scan of Intraday Trendlyne Screeners...');
  
  let screenersScanned = 0;
  let highScoringStocksFound = 0;
  let newSignalsGenerated = 0;

  try {
    // 1. Fetch all intraday screeners
    const screeners = await dbAll(`
      SELECT DISTINCT s.screener_id, s.screener_name, s.screenpk, s.sentiment, m.inferred_sentiment
      FROM trendlyne_screeners s
      LEFT JOIN screener_master m ON s.screener_id = m.scan_id
      WHERE s.timeframe = 'intraday' OR m.inferred_timeframe = 'intraday'
    `) as any[];

    console.log(`⚡ [INTRADAY SCAN] Found ${screeners.length} intraday screeners to process.`);

    for (const screener of screeners) {
      screenersScanned++;
      const name = screener.screener_name;
      const screenpk = screener.screenpk;
      const sentiment = screener.inferred_sentiment || screener.sentiment || 'neutral';

      console.log(`🔍 [INTRADAY SCAN] Scanning screener: ${name} (PK: ${screenpk}, Sentiment: ${sentiment})...`);

      // 2. Fetch stock constituents bypassing cache
      const result = await fetchTrendlyneScreenerData(screenpk, name, 0, true);
      if (!result.success || !result.data || result.data.length === 0) {
        console.log(`⚠️ [INTRADAY SCAN] No stocks found or scan failed for: ${name}`);
        continue;
      }

      console.log(`📊 [INTRADAY SCAN] Processing ${result.data.length} stocks for screener: ${name}`);

      for (const stock of result.data) {
        // Resolve stock symbol if not directly present
        let symbol = stock.symbol;
        if (!symbol) {
          const mapping = getStockMappingByTLId(stock.stockId) || getStockMappingByName(stock.name);
          symbol = mapping?.symbol;
        }

        if (!symbol) {
          continue; // Skip stocks that cannot be mapped to a clean NSE symbol
        }

        // 3. Lookup stock score from quant_scores or stock_scores fallback
        let score: number | null = null;
        try {
          const qScore = await dbGet('SELECT rank_composite FROM quant_scores WHERE symbol = ?', [symbol]) as any;
          if (qScore?.rank_composite !== undefined && qScore?.rank_composite !== null) {
            score = qScore.rank_composite;
          } else {
            const sScore = await dbGet("SELECT score FROM stock_scores WHERE symbol = ? AND timeframe = 'long_term'", [symbol]) as any;
            if (sScore?.score !== undefined && sScore?.score !== null) {
              score = sScore.score;
            }
          }
        } catch (err) {
          console.error(`❌ [INTRADAY SCAN] Error checking score for ${symbol}:`, err);
        }

        if (score === null || score < 80) {
          continue; // Only proceed if stock has a High Score (>= 80)
        }

        highScoringStocksFound++;

        // 4. Deduplicate active signals
        let existingActive = 0;
        try {
          const check = await dbGet("SELECT COUNT(*) as count FROM unified_signals WHERE symbol = ? AND status = 'ACTIVE' AND signal_source = 'screener'", [symbol]) as any;
          existingActive = check?.count || 0;
        } catch (err) {
          console.error(`❌ [INTRADAY SCAN] Error checking active signals for ${symbol}:`, err);
        }

        if (existingActive > 0) {
          console.log(`⏭️ [INTRADAY SCAN] Symbol ${symbol} has score ${score.toFixed(1)}% but already has an ACTIVE signal. Skipping.`);
          continue;
        }

        // 5. Generate and save trading signal
        const type = sentiment === 'bearish' ? 'SELL' : 'BUY';
        const entry = stock.ltp || 0;
        const target = type === 'BUY' ? parseFloat((entry * 1.05).toFixed(2)) : parseFloat((entry * 0.95).toFixed(2));
        const stopLoss = type === 'BUY' ? parseFloat((entry * 0.97).toFixed(2)) : parseFloat((entry * 1.03).toFixed(2));
        const confidence = Math.round(score);
        const reasoning = `Strong quantitative score of ${score.toFixed(1)}% and active intraday breakout spotted in Trendlyne screener '${name}'.`;

        try {
          const { upsertUnifiedSignal } = await import('./signals');
          await upsertUnifiedSignal('screener', {
            symbol,
            signalDate: new Date().toISOString().split('T')[0],
            signalType: type,
            entryPrice: entry,
            targetPrice: target,
            stopLoss,
            confidenceScore: confidence / 100,
            reasoning,
          });

          newSignalsGenerated++;
          console.log(`🎯 [INTRADAY SCAN] GENERATED ${type} SIGNAL FOR ${symbol}! Score: ${score.toFixed(1)}% | Entry: ₹${entry} | Target: ₹${target} | SL: ₹${stopLoss}`);
        } catch (err) {
          console.error(`❌ [INTRADAY SCAN] Failed to save signal for ${symbol}:`, err);
        }
      }
    }

    console.log(`✅ [INTRADAY SCAN] Scan completed. Scanned: ${screenersScanned} | High-Scoring Stocks: ${highScoringStocksFound} | New Signals: ${newSignalsGenerated}`);
  } catch (error) {
    console.error('❌ [INTRADAY SCAN] Fatal error during intraday screener scan:', error);
  }

  return { screenersScanned, highScoringStocksFound, newSignalsGenerated };
}

