import * as fs from 'fs';
import * as path from 'path';
import Database from 'better-sqlite3';
import stockData from '../src/data/stocklist';

async function run() {
  const stocklistPath = path.resolve(import.meta.dirname, '../src/data/stocklist.ts');
  const db = new Database('mc_tl_explore.db');
  
  console.log('Fetching responses from database...');
  const rows = db.prepare("SELECT raw_json FROM api_responses WHERE domain='moneycontrol'").all() as {raw_json: string}[];
  
  const mcMap = new Map<string, string>();
  
  function traverse(obj: any) {
    if (!obj || typeof obj !== 'object') return;
    if (Array.isArray(obj)) {
      for (const item of obj) traverse(item);
      return;
    }
    
    let symbol = obj.symbol || obj.nseId || obj.nseid || obj.NSE || obj.stk_exchng_id;
    let mcsymbol = obj.sc_id || obj.sc_did || obj.scid || obj.scId;
    
    if (symbol && mcsymbol && typeof symbol === 'string' && typeof mcsymbol === 'string') {
      symbol = symbol.trim().toUpperCase();
      if (symbol && mcsymbol) {
         mcMap.set(symbol, mcsymbol);
      }
    }
    
    for (const key of Object.keys(obj)) {
      traverse(obj[key]);
    }
  }

  console.log('Parsing responses to extract mappings...');
  for (const row of rows) {
    if (!row.raw_json) continue;
    try {
      const parsed = JSON.parse(row.raw_json);
      traverse(parsed);
    } catch (e) {
      // ignore
    }
  }
  
  console.log(`Extracted ${mcMap.size} unique mappings from mc_tl_explore.db`);

  let updatedCount = 0;
  for (const item of stockData) {
    if (!item.mcsymbol) {
       const mapped = mcMap.get(item.symbol.toUpperCase());
       if (mapped) {
          item.mcsymbol = mapped;
          updatedCount++;
       }
    }
  }

  const fileContent = `export interface StockMapping {
  name: string;
  mcsymbol: string;
  tlid: string;
  tlname: string;
  isin: string;
  symbol: string;
  stockid: string;
  companyid: string;
}

const stockData: StockMapping[] = ${JSON.stringify(stockData, null, 2)};

export default stockData;
`;

  fs.writeFileSync(stocklistPath, fileContent, 'utf8');
  console.log(`Successfully updated ${updatedCount} stocks with Moneycontrol symbols in stocklist.ts.`);
}

run().catch(console.error);
