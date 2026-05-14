/**
 * Trendlyne Screener Service
 * Fetches screener data from Trendlyne's All-in-One Screener API
 * Features:
 * - Database-backed screener name to screenpk mapping (fetched once)
 * - Intelligent caching with configurable fetch frequency
 * - Polite fetching with random jitter
 * - Batch processing for large stock lists
 */

import db from './db';
import { getStockMapping } from './stockMapping';

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

// Database operations for screener mappings
export function saveScreenerToDB(
  screenerId: string,
  screenerName: string,
  screenpk: string,
  description?: string
): void {
  try {
    const stmt = db.prepare(`
      INSERT OR REPLACE INTO trendlyne_screeners (screener_id, screener_name, screenpk, description, last_updated)
      VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
    `);
    stmt.run(screenerId, screenerName, screenpk, description || `${screenerName} from Trendlyne`);
  } catch (error) {
    console.error(`❌ Error saving screener to DB:`, error);
  }
}

export function saveScreenerStocksToDB(
  screenerId: string,
  stocks: Array<{ stockId: string; name: string }>
): void {
  try {
    const deleteStmt = db.prepare(`DELETE FROM trendlyne_screener_stocks WHERE screener_id = ?`);
    const insertStmt = db.prepare(`
      INSERT INTO trendlyne_screener_stocks (screener_id, stock_id, symbol)
      VALUES (?, ?, ?)
    `);

    db.transaction(() => {
      deleteStmt.run(screenerId);
      for (const stock of stocks) {
        // Attempt to find symbol for the stockId
        const mapping = getStockMapping(stock.stockId);
        const symbol = mapping ? mapping.symbol : null;
        insertStmt.run(screenerId, stock.stockId, symbol);
      }
    })();
  } catch (error) {
    console.error(`❌ Error saving screener stocks to DB:`, error);
  }
}

export function getScreenerFromDB(screenerId: string): { screener_name: string; screenpk: string } | null {
  try {
    const stmt = db.prepare(`
      SELECT screener_name, screenpk FROM trendlyne_screeners WHERE screener_id = ?
    `);
    return stmt.get(screenerId) as { screener_name: string; screenpk: string } | null;
  } catch (error) {
    console.error(`❌ Error retrieving screener from DB:`, error);
    return null;
  }
}

export function getAllScreenersFromDB(): Array<{ screener_id: string; screener_name: string; screenpk: string; description: string }> {
  try {
    const stmt = db.prepare(`
      SELECT screener_id, screener_name, screenpk, description FROM trendlyne_screeners ORDER BY screener_name
    `);
    return stmt.all() as Array<{ screener_id: string; screener_name: string; screenpk: string; description: string }>;
  } catch (error) {
    console.error(`❌ Error retrieving all screeners from DB:`, error);
    return [];
  }
}

export function clearScreenersDB(): void {
  try {
    const stmt = db.prepare(`DELETE FROM trendlyne_screeners`);
    stmt.run();
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

      console.log(`📋 Column indices - stockId: ${stockIdIndex}, name: ${nameIndex}, price: ${priceIndex}`);

      // Map tableData rows to stock objects
      tableData.forEach((row: any[]) => {
        stocks.push({
          stockId: String(row[stockIdIndex] || ''),
          name: String(row[nameIndex] || ''),
          ltp: parseFloat(row[priceIndex] || 0),
          change: 0,
          changePercent: 0,
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
      perPageCount: '200',
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

      // Map tableData rows to stock objects
      tableData.forEach((row: any[]) => {
        stocks.push({
          stockId: String(row[stockIdIndex] || ''),
          name: String(row[nameIndex] || ''),
          ltp: parseFloat(row[priceIndex] || 0),
          change: 0,
          changePercent: 0,
          screenerName: screenerTitle,
          screenerType: 'all-in-one'
        });
      });

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
export async function fetchAllTrendlyneScreenerNames(): Promise<Set<string>> {
  try {
    // Check if screeners are already in database
    const existingScreeners = getAllScreenersFromDB();
    if (existingScreeners.length > 0) {
      console.log(`✅ Using ${existingScreeners.length} screeners from database (previously fetched)`);
      return new Set(existingScreeners.map(s => s.screener_name));
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
          perPageCount: '200',
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

    screenerMappings.forEach((screenpk, screenerNameId) => {
      // Get the full name from screenerNames
      const screenerName = Array.from(screenerNames).find(
        name => name.toLowerCase().replace(/\s+/g, '-') === screenerNameId
      ) || screenerNameId;

      saveScreenerToDB(screenerNameId, screenerName, screenpk);
    });

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
 * Returns screeners from database (fetched once on first call)
 * Also includes screenpk for direct API calls
 */
export async function getTrendlyneScreenerList() {
  // Try to get from database first
  let screeners = getAllScreenersFromDB();

  // If database is empty, return hardcoded categories immediately and trigger fetch in background
  if (screeners.length === 0) {
    console.log(`📊 Database empty, triggering background fetch of screener names from Trendlyne API...`);
    // Trigger in background, don't await
    fetchAllTrendlyneScreenerNames().catch(err => console.error('Background fetch error:', err));
    
    // Return hardcoded ones as fallback for now
    return getTrendlyneScreenerCategories().map(c => ({
      id: c.id,
      name: c.name,
      description: c.description,
      screenpk: '19814' // Default sample pk
    }));
  }

  return screeners.map(s => ({
    id: s.screener_id,
    name: s.screener_name,
    description: s.description,
    screenpk: s.screenpk  // Include screenpk for API calls
  }));
}

/**
 * Determine sentiment from screener name
 * Returns: 'bullish' | 'bearish' | 'neutral'
 */
function determineSentiment(screenerName: string): 'bullish' | 'bearish' | 'neutral' {
  const name = screenerName.toLowerCase();

  // Bullish indicators
  if (name.includes('bullish') || name.includes('buy') || name.includes('breakout') ||
      name.includes('outperform') || name.includes('rising') || name.includes('gaining') ||
      name.includes('high momentum') || name.includes('high growth') || name.includes('top gainers') ||
      name.includes('increasing') || name.includes('above') || name.includes('crossed above')) {
    return 'bullish';
  }

  // Bearish indicators
  if (name.includes('bearish') || name.includes('sell') || name.includes('breakdown') ||
      name.includes('underperform') || name.includes('falling') || name.includes('declining') ||
      name.includes('negative') || name.includes('below') || name.includes('crossed below')) {
    return 'bearish';
  }

  // Default to neutral
  return 'neutral';
}

/**
 * Find all screeners that contain a specific stock (Synchronous version for API integration)
 * @param stockId - The stock ID to search for
 * @returns Array of screeners containing the stock with sentiment info
 */
export function findScreenersByStock(stockId: string): Array<{
  id: string;
  name: string;
  sentiment: 'bullish' | 'bearish' | 'neutral';
}> {
  try {
    if (!stockId || stockId === '#N/A' || stockId === 'undefined' || stockId === 'null') {
      return [];
    }

    // Get matching screeners from database using the stock_id mapping
    const stmt = db.prepare(`
      SELECT s.screener_id, s.screener_name
      FROM trendlyne_screeners s
      JOIN trendlyne_screener_stocks ss ON s.screener_id = ss.screener_id
      WHERE ss.stock_id = ? OR ss.symbol = ?
    `);
    
    // Attempt to resolve symbol if stockId is passed as a symbol or mapping exists
    const mapping = getStockMapping(stockId);
    const symbol = mapping ? mapping.symbol : stockId;
    
    const matches = stmt.all(stockId, symbol) as Array<{ screener_id: string; screener_name: string }>;

    if (matches.length === 0) {
      return [];
    }

    const result = matches.map(m => ({
      id: m.screener_id,
      name: m.screener_name,
      sentiment: determineSentiment(m.screener_name)
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
export async function syncAllScreenerStocksToDB() {
  try {
    console.log('🔄 Starting full Trendlyne screener synchronization...');
    
    // 1. Ensure we have screeners in the DB
    let screeners = getAllScreenersFromDB();
    if (screeners.length === 0) {
      await fetchAllTrendlyneScreenerNames();
      screeners = getAllScreenersFromDB();
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
          
          saveScreenerStocksToDB(screener.screener_id, stocksToSave);
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
 * Get hardcoded fallback categories if API fails
 */
export function getTrendlyneScreenerCategories() {
  return [
    { id: 'all', name: 'All Screeners', description: 'All available Trendlyne screeners' },
    { id: 'bullish', name: 'Bullish Signals', description: 'Stocks showing bullish signals' },
    { id: 'bearish', name: 'Bearish Signals', description: 'Stocks showing bearish signals' },
    { id: 'breakout', name: 'Breakouts', description: 'Stocks breaking out of resistance' },
    { id: 'trending', name: 'Trending', description: 'Stocks in strong trends' },
    { id: 'momentum', name: 'Momentum', description: 'High momentum stocks' },
    { id: 'reversal', name: 'Reversals', description: 'Potential reversal signals' },
    { id: 'volume', name: 'Volume Leaders', description: 'High volume stocks' }
  ];
}
