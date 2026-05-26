import fs from 'fs';
import path from 'path';
import db from './db';

// Fallback list of 13 canonical ETnow screeners used when et_screeners.json is absent.
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
 * Populate etnow_screeners.
 * Priority:
 *   1. Skip if DB already has > 20 rows (already fully imported).
 *   2. Auto-import from et_screeners.json if the file exists (438 screeners).
 *   3. Fall back to the hardcoded 13-screener list.
 * Safe to call on every server start.
 */
export function initEtnowScreeners(): void {
  const count = db.prepare('SELECT count(*) as count FROM etnow_screeners').get() as { count: number };
  if (count.count > 20) {
    console.log(`ℹ️ etnow_screeners already populated with ${count.count} items. Skipping seed.`);
    return;
  }

  // Try bulk import from captured JSON
  const jsonPath = path.join(process.cwd(), 'et_screeners.json');
  if (fs.existsSync(jsonPath)) {
    try {
      const data = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
      const requests: any[] = data.requests || [];
      if (requests.length > 0) {
        const insert = db.prepare(
          `INSERT OR IGNORE INTO etnow_screeners (screener_id, screener_name, query_condition) VALUES (?, ?, ?)`
        );
        db.transaction(() => {
          for (const req of requests) {
            const id: string = req.screenerId;
            const name: string = req.label;
            const postData = req.request?.postData;
            const query = typeof postData === 'string' ? postData : JSON.stringify(postData || {});
            if (id && name) insert.run(id, name, query);
          }
        })();
        console.log(`✅ Auto-imported ${requests.length} ETnow screeners from et_screeners.json`);
        return;
      }
    } catch (e) {
      console.warn('⚠️ Could not parse et_screeners.json, falling back to defaults:', e);
    }
  }

  // Hardcoded fallback
  const insert = db.prepare(`INSERT OR IGNORE INTO etnow_screeners (screener_id, screener_name) VALUES (?, ?)`);
  db.transaction(() => {
    for (const s of ETNOW_SCREENER_DEFINITIONS) insert.run(s.id, s.name);
  })();
  console.log(`ℹ️ Seeded ${ETNOW_SCREENER_DEFINITIONS.length} default ETnow screeners.`);
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
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      "Origin": "https://economictimes.indiatimes.com",
      "Accept-Language": "en-US,en;q=0.9"
    },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch from ETnow: ${response.statusText}`);
  }

  return response.json();
}
export function findEtScreenersByStock(symbol: string): Array<{
  id: string;
  name: string;
  sentiment: 'bullish' | 'bearish' | 'neutral';
  screenpk: string;
  source: string;
  description: string;
}> {
  try {
    if (!symbol) return [];

    const stmt = db.prepare(`
      SELECT s.screener_id, s.screener_name, m.inferred_sentiment
      FROM etnow_screeners s
      JOIN etnow_screener_stocks ss ON s.screener_id = ss.screener_id
      LEFT JOIN screener_master m ON s.screener_id = m.scan_id
      WHERE ss.symbol = ?
    `);

    const matches = stmt.all(symbol) as Array<{
      screener_id: string;
      screener_name: string;
      inferred_sentiment: string | null;
    }>;

    return matches.map(m => ({
      id: m.screener_id,
      name: m.screener_name,
      sentiment: (m.inferred_sentiment as 'bullish' | 'bearish' | 'neutral') || 'neutral',
      screenpk: 'ET_' + m.screener_id,
      source: 'etnow',
      description: 'ETnow Market Screener'
    }));
  } catch (error) {
    console.error(`❌ Error finding ETnow screeners for stock ${symbol}:`, error);
    return [];
  }
}
