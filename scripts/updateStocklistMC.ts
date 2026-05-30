import * as fs from 'fs';
import * as path from 'path';
import db from '../src/server/db';
import stockData from '../src/data/stocklist';

async function updateStocklist() {
  const stocklistPath = path.resolve(import.meta.dirname, '../src/data/stocklist.ts');
  
  const rows = db.prepare('SELECT DISTINCT symbol, mcsymbol FROM moneycontrol_screener_stocks WHERE symbol IS NOT NULL AND mcsymbol IS NOT NULL').all() as {symbol: string, mcsymbol: string}[];
  
  const mcMap = new Map<string, string>();
  for (const r of rows) {
    if (r.symbol && r.mcsymbol) {
      mcMap.set(r.symbol.toUpperCase(), r.mcsymbol);
    }
  }

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

updateStocklist().catch(console.error);
