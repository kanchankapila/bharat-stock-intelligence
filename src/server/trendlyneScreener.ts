/**
 * Trendlyne Screener Service
 * Fetches screener data from Trendlyne's All-in-One Screener API
 * Features:
 * - Intelligent caching with configurable fetch frequency
 * - Polite fetching with random jitter
 * - Batch processing for large stock lists
 */

const TRENDLYNE_BASE_URL = 'https://kayal.trendlyne.com/broker-webview/kayal/all-in-one-screener-data-get/';

// Configuration for fetch behavior (easily parameterized)
export const TRENDLYNE_CONFIG = {
  // Fetch interval in milliseconds (set to 0 to disable auto-refresh)
  FETCH_INTERVAL_MS: 300000, // 5 minutes
  // Screener names fetch interval (runs once per interval)
  SCREENER_NAMES_INTERVAL_MS: 86400000, // 24 hours
  // Base delay before API call (adds jitter on top)
  BASE_DELAY_MS: 500,
  // Maximum jitter percentage (10-20% is polite)
  JITTER_PERCENT: 15,
  // Request timeout
  REQUEST_TIMEOUT_MS: 30000
};

// Helper to update fetch intervals
export function updateFetchInterval(intervalMs: number): void {
  TRENDLYNE_CONFIG.FETCH_INTERVAL_MS = intervalMs;
}

export function updateScreenerNamesInterval(intervalMs: number): void {
  TRENDLYNE_CONFIG.SCREENER_NAMES_INTERVAL_MS = intervalMs;
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

const cache = new Map<string, CacheEntry>();
let screenerNamesCache: ScreenerNamesCache | null = null;

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
    console.log('📋 Raw API Response:', JSON.stringify(json, null, 2));

    const stocks: TrendlyneStock[] = (json.result || []).map((item: any) => ({
      stockId: item.stock_id || item.id,
      name: item.stock_name || item.name || '',
      ltp: parseFloat(item.ltp || item.price || 0),
      change: parseFloat(item.change || 0),
      changePercent: parseFloat(item.change_percent || item.changePercent || 0),
      screenerName: item.screener_name || 'Trendlyne Screener',
      screenerType: item.screener_type || 'all-in-one',
      ...item
    }));

    console.log('✅ Parsed Stocks:', stocks);
    console.log('📌 Available Fields in First Stock:', Object.keys(json.result?.[0] || {}));

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
 * Fetch screener data from Trendlyne API
 * @param stockId - The stock ID to fetch screener data for (or comma-separated IDs, max 30 per request to avoid 414 error)
 * @param pageNumber - Page number for pagination (default 0)
 * @param groupName - Group name filter (optional)
 * @param skipCache - Force bypass cache (default false)
 * @returns Screener data with stocks and names
 */
export async function fetchTrendlyneScreenerData(
  stockId: string = STOCK_IDS[0],
  pageNumber: number = 0,
  groupName: string = '',
  skipCache: boolean = false
): Promise<TrendlyneScreenerData> {
  try {
    const ids = stockId.split(',');

    // If too many IDs, batch them
    if (ids.length > 30) {
      console.warn(`⚠️ WARNING: ${ids.length} stock IDs provided. Batching into requests of 30 to avoid URL length limit...`);
      const batchSize = 30;
      const allStocks: TrendlyneStock[] = [];

      for (let i = 0; i < ids.length; i += batchSize) {
        const batch = ids.slice(i, i + batchSize).join(',');
        const result = await fetchTrendlyneScreenerData(batch, pageNumber, groupName, skipCache);
        if (result.success) {
          allStocks.push(...result.data);
        }
      }

      return {
        success: true,
        data: allStocks,
        screenerName: 'Trendlyne All-in-One Screener',
        totalResults: allStocks.length
      };
    }

    // Validate stock ID count to prevent 414 URI Too Long errors
    validateStockIdCount(stockId);

    // Create cache key
    const cacheKey = `${stockId}:${pageNumber}:${groupName}`;

    // Check cache if not skipping
    if (!skipCache) {
      const cached = getCachedData(cacheKey);
      if (cached) {
        return cached;
      }
    }

    // Apply jitter delay for polite fetching
    const jitterDelay = getJitter(TRENDLYNE_CONFIG.BASE_DELAY_MS, TRENDLYNE_CONFIG.JITTER_PERCENT);
    await new Promise(resolve => setTimeout(resolve, jitterDelay));

    const params = new URLSearchParams({
      perPageCount: '200',
      pageNumber: pageNumber.toString(),
      screenpk: stockId,
      groupType: 'all',
      groupName: groupName || ''
    });

    const url = `${TRENDLYNE_BASE_URL}?${params.toString()}`;

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
      console.error(`Trendlyne API error: ${response.status}`);
      return {
        success: false,
        data: [],
        totalResults: 0
      };
    }

    const json = await response.json();

    // Transform the response to our expected format
    if (json && json.result) {
      const stocks: TrendlyneStock[] = (json.result || []).map((item: any) => ({
        stockId: item.stock_id || item.id,
        name: item.stock_name || item.name || '',
        ltp: parseFloat(item.ltp || item.price || 0),
        change: parseFloat(item.change || 0),
        changePercent: parseFloat(item.change_percent || item.changePercent || 0),
        screenerName: item.screener_name || 'Trendlyne Screener',
        screenerType: item.screener_type || 'all-in-one',
        ...item // Include all other fields
      }));

      const result = {
        success: true,
        data: stocks,
        screenerName: 'Trendlyne All-in-One Screener',
        totalResults: stocks.length
      };

      // Cache the result
      cache.set(cacheKey, { data: result, timestamp: Date.now() });
      return result;
    }

    return {
      success: false,
      data: [],
      totalResults: 0
    };
  } catch (error) {
    console.error('Error fetching Trendlyne screener data:', error);
    return {
      success: false,
      data: [],
      totalResults: 0
    };
  }
}

/**
 * Fetch all unique screener names from Trendlyne in one efficient call
 * Uses batching to handle large stock lists with polite fetching
 * @returns Set of unique screener names
 */
export async function fetchAllTrendlyneScreenerNames(): Promise<Set<string>> {
  try {
    // Check cache first
    const cached = getCachedScreenerNames();
    if (cached) {
      return cached;
    }

    const screenerNames = new Set<string>();
    const allStockIds = STOCK_IDS[0].split(',');
    const batchSize = 30; // Reduced from 100 to prevent URI length exceeded (414) error

    console.log(`Fetching screener names from ${allStockIds.length} stocks in batches of ${batchSize}...`);

    for (let i = 0; i < allStockIds.length; i += batchSize) {
      const batch = allStockIds.slice(i, i + batchSize).join(',');

      // Apply jitter delay for polite fetching
      const jitterDelay = getJitter(TRENDLYNE_CONFIG.BASE_DELAY_MS, TRENDLYNE_CONFIG.JITTER_PERCENT);
      await new Promise(resolve => setTimeout(resolve, jitterDelay));

      try {
        const params = new URLSearchParams({
          perPageCount: '200',
          pageNumber: '0',
          screenpk: batch,
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
          console.warn(`Batch fetch error: ${response.status}`);
          continue;
        }

        const json = await response.json();
        if (json && json.result) {
          (json.result || []).forEach((item: any) => {
            const screenerName = item.screener_name || item.category || 'Trendlyne Screener';
            screenerNames.add(screenerName);
          });
        }

        console.log(`Batch ${Math.floor(i / batchSize) + 1}: Extracted ${screenerNames.size} unique screeners`);
      } catch (error) {
        console.error(`Error fetching batch starting at index ${i}:`, error);
      }
    }

    // Cache the results
    setCachedScreenerNames(screenerNames);
    console.log(`Total unique screener names cached: ${screenerNames.size}`);

    return screenerNames;
  } catch (error) {
    console.error('Error fetching screener names:', error);
    return new Set();
  }
}

/**
 * Get list of screener names/categories available
 * Fetches once and caches based on configured interval
 */
export async function getTrendlyneScreenerList() {
  const screenerNames = await fetchAllTrendlyneScreenerNames();
  return Array.from(screenerNames).map(name => ({
    id: name.toLowerCase().replace(/\s+/g, '-'),
    name: name,
    description: `${name} from Trendlyne`
  }));
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
