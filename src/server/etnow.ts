import db from './db';

// Canonical ETnow screener definitions — mirrors getMarketScanners in router.ts.
// Stored once in etnow_screeners so the Python scoring engine can load them.
const ETNOW_SCREENER_DEFINITIONS = [
  { id: '73',   name: 'Cash Cows' },
  { id: '75',   name: 'Elite Bluechips' },
  { id: '79',   name: 'Zero Debt Quality' },
  { id: '91',   name: 'Buy on Dips' },
  { id: '195',  name: 'Potential Multibaggers' },
  { id: '118',  name: 'Straight Flush' },
  { id: '362',  name: 'RSI Oversold' },
  { id: '518',  name: 'The Tata Empire' },
  { id: '520',  name: 'Adani Universe' },
  { id: '514',  name: 'PSU Gems' },
  { id: '515',  name: 'Monopoly Biz' },
  { id: '1101', name: 'Defence Sector' },
  { id: '1100', name: 'Infra Boost' },
];

/**
 * Populate etnow_screeners with the canonical screener list.
 * Uses INSERT OR IGNORE so existing rows are never overwritten.
 * Safe to call on every server start.
 */
export function initEtnowScreeners(): void {
  const insert = db.prepare(`
    INSERT OR IGNORE INTO etnow_screeners (screener_id, screener_name)
    VALUES (?, ?)
  `);
  const runAll = db.transaction(() => {
    for (const s of ETNOW_SCREENER_DEFINITIONS) {
      insert.run(s.id, s.name);
    }
  });
  runAll();
}

export interface ETnowScreenerResponse {
  searchResult?: {
    searchData?: {
      records?: any[];
      header?: any[];
    }
  };
  status?: string;
}

export async function fetchETnowScreener(screenerId: string, queryCondition: string): Promise<any> {
  const url = "https://screener.indiatimes.com/screener/v2/screenerByScreenerIdForWeb";
  const body = {
    viewId: 6916,
    sort: [],
    pagesize: 20,
    pageno: 1,
    deviceId: "web",
    filterType: "index",
    filterValue: [],
    screenerId: screenerId,
    queryCondition: queryCondition
  };

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "referer": "https://economictimes.indiatimes.com/",
      "accept": "*/*",
    },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch from ETnow: ${response.statusText}`);
  }

  return response.json();
}
