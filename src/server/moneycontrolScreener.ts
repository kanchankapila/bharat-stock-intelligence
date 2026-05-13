import db from './db';
import { getStockMapping, getSymbolFromMcsymbol } from './stockMapping';
import { mcFetchJson } from './mcApiService';
import fs from 'fs';
import path from 'path';

interface McScreenerConfig {
  catId: string;
  scanId: string;
  type: 'pro' | 'tech';
  is_positive: boolean;
}

const MC_SCREENERS: McScreenerConfig[] = [
  // Fundamental (Proscanner)
  { catId: '1', scanId: '146', type: 'pro', is_positive: true },
  { catId: '1', scanId: '181', type: 'pro', is_positive: true },
  { catId: '1', scanId: '178', type: 'pro', is_positive: true },
  { catId: '1', scanId: '182', type: 'pro', is_positive: true },
  { catId: '1', scanId: '176', type: 'pro', is_positive: true },
  { catId: '1', scanId: '184', type: 'pro', is_positive: true },
  { catId: '1', scanId: '177', type: 'pro', is_positive: true },
  { catId: '1', scanId: '165', type: 'pro', is_positive: true },
  { catId: '1', scanId: '174', type: 'pro', is_positive: true },
  { catId: '1', scanId: '179', type: 'pro', is_positive: true },
  { catId: '1', scanId: '168', type: 'pro', is_positive: true },
  { catId: '1', scanId: '364', type: 'pro', is_positive: true },
  { catId: '1', scanId: '366', type: 'pro', is_positive: true },
  { catId: '1', scanId: '369', type: 'pro', is_positive: true },
  { catId: '1', scanId: '367', type: 'pro', is_positive: true },
  { catId: '1', scanId: '370', type: 'pro', is_positive: true },
  { catId: '1', scanId: '374', type: 'pro', is_positive: true },
  { catId: '1', scanId: '371', type: 'pro', is_positive: true },
  { catId: '1', scanId: '378', type: 'pro', is_positive: true },
  { catId: '1', scanId: '376', type: 'pro', is_positive: true },
  { catId: '1', scanId: '365', type: 'pro', is_positive: true },
  { catId: '1', scanId: '379', type: 'pro', is_positive: true },
  { catId: '1', scanId: '382', type: 'pro', is_positive: true },
  { catId: '1', scanId: '375', type: 'pro', is_positive: true },
  { catId: '1', scanId: '381', type: 'pro', is_positive: true },
  { catId: '1', scanId: '383', type: 'pro', is_positive: true },
  { catId: '1', scanId: '388', type: 'pro', is_positive: true },
  { catId: '1', scanId: '390', type: 'pro', is_positive: true },
  { catId: '1', scanId: '362', type: 'pro', is_positive: true },
  { catId: '1', scanId: '391', type: 'pro', is_positive: true },
  { catId: '1', scanId: '377', type: 'pro', is_positive: true },
  { catId: '1', scanId: '397', type: 'pro', is_positive: true },
  { catId: '1', scanId: '405', type: 'pro', is_positive: true },
  { catId: '1', scanId: '403', type: 'pro', is_positive: true },
  { catId: '1', scanId: '399', type: 'pro', is_positive: true },
  { catId: '1', scanId: '412', type: 'pro', is_positive: true },
  { catId: '1', scanId: '400', type: 'pro', is_positive: true },
  { catId: '1', scanId: '408', type: 'pro', is_positive: true },
  { catId: '1', scanId: '411', type: 'pro', is_positive: true },
  { catId: '1', scanId: '419', type: 'pro', is_positive: true },
  { catId: '1', scanId: '416', type: 'pro', is_positive: true },
  { catId: '1', scanId: '410', type: 'pro', is_positive: true },
  { catId: '1', scanId: '422', type: 'pro', is_positive: true },
  { catId: '1', scanId: '430', type: 'pro', is_positive: true },
  { catId: '1', scanId: '389', type: 'pro', is_positive: true },
  { catId: '1', scanId: '409', type: 'pro', is_positive: true },
  { catId: '1', scanId: '425', type: 'pro', is_positive: true },
  { catId: '1', scanId: '429', type: 'pro', is_positive: true },
  { catId: '1', scanId: '424', type: 'pro', is_positive: true },
  { catId: '1', scanId: '432', type: 'pro', is_positive: true },
  { catId: '1', scanId: '431', type: 'pro', is_positive: true },
  { catId: '1', scanId: '423', type: 'pro', is_positive: true },
  { catId: '1', scanId: '435', type: 'pro', is_positive: true },
  { catId: '1', scanId: '434', type: 'pro', is_positive: true },
  
  // Category 2, 3, 4, 6, 7, 8, 9...
  { catId: '2', scanId: '172', type: 'pro', is_positive: true },
  { catId: '2', scanId: '169', type: 'pro', is_positive: true },
  { catId: '2', scanId: '181', type: 'pro', is_positive: true },
  { catId: '2', scanId: '171', type: 'pro', is_positive: true },
  { catId: '2', scanId: '168', type: 'pro', is_positive: true },
  { catId: '2', scanId: '167', type: 'pro', is_positive: true },
  { catId: '2', scanId: '170', type: 'pro', is_positive: true },
  { catId: '2', scanId: '378', type: 'pro', is_positive: true },
  { catId: '2', scanId: '376', type: 'pro', is_positive: true },
  { catId: '2', scanId: '369', type: 'pro', is_positive: true },
  { catId: '2', scanId: '392', type: 'pro', is_positive: true },
  { catId: '2', scanId: '398', type: 'pro', is_positive: true },
  { catId: '2', scanId: '391', type: 'pro', is_positive: true },
  { catId: '2', scanId: '397', type: 'pro', is_positive: true },
  { catId: '2', scanId: '377', type: 'pro', is_positive: true },
  { catId: '2', scanId: '362', type: 'pro', is_positive: true },
  { catId: '2', scanId: '393', type: 'pro', is_positive: true },
  { catId: '2', scanId: '395', type: 'pro', is_positive: true },
  { catId: '2', scanId: '416', type: 'pro', is_positive: true },
  { catId: '2', scanId: '417', type: 'pro', is_positive: true },
  { catId: '2', scanId: '413', type: 'pro', is_positive: true },
  { catId: '2', scanId: '396', type: 'pro', is_positive: true },
  { catId: '2', scanId: '394', type: 'pro', is_positive: true },

  // Technical (Techscanner)
  { catId: '25', scanId: 'OHLC_D_P_BPBULL', type: 'tech', is_positive: true },
  { catId: '25', scanId: 'OHLC_D_I_DSMARTBULLC', type: 'tech', is_positive: true },
  { catId: '25', scanId: 'OHLC_D_P_BPBEAR', type: 'tech', is_positive: false },
  { catId: '25', scanId: 'OHLC_D_I_DSMARTBEARC', type: 'tech', is_positive: false },
  { catId: '25', scanId: 'OHLC_D_I_RSIPOWBO', type: 'tech', is_positive: true },
  { catId: '25', scanId: 'OHLC_D_I_RSI70607DNBU', type: 'tech', is_positive: true },
  { catId: '25', scanId: 'OHLC_D_I_ADBBPBUY', type: 'tech', is_positive: true },
  { catId: '25', scanId: 'OHLC_D_I_MOMRAVBU', type: 'tech', is_positive: true },
  { catId: '25', scanId: 'OHLC_D_I_ST5133BULL', type: 'tech', is_positive: true },
  { catId: '25', scanId: 'OHLC_D_I_SQZBULLBO', type: 'tech', is_positive: true },
  { catId: '25', scanId: 'OHLC_D_I_10DSTOCHBULL', type: 'tech', is_positive: true },
  { catId: '25', scanId: 'OHLC_20D_P_CLABVPWH', type: 'tech', is_positive: true },
  { catId: '25', scanId: 'OHLC_W_I_RSIMULTIBAG', type: 'tech', is_positive: true },
  { catId: '25', scanId: 'OHLC_D_I_BOLDBULL', type: 'tech', is_positive: true },
  { catId: '25', scanId: 'OHLC_D_I_BTSTOND', type: 'tech', is_positive: true },
  { catId: '25', scanId: 'OHLC_D_I_CLSERIESBULL', type: 'tech', is_positive: true },
  { catId: '25', scanId: 'OHLC_D_I_TRNGLCANDBULL', type: 'tech', is_positive: true },
  { catId: '25', scanId: 'OHLC_D_I_RISE3BULL', type: 'tech', is_positive: true },
  { catId: '25', scanId: 'OHLC_D_I_RSIPOWBD', type: 'tech', is_positive: false },
  { catId: '25', scanId: 'OHLC_D_I_RSI70607DNBE', type: 'tech', is_positive: false },
  { catId: '25', scanId: 'OHLC_D_I_ADBBPSELL', type: 'tech', is_positive: false },
  { catId: '25', scanId: 'OHLC_D_I_MOMRAVBE', type: 'tech', is_positive: false },
  { catId: '25', scanId: 'OHLC_D_I_ST5133BEAR', type: 'tech', is_positive: false },
  { catId: '25', scanId: 'OHLC_D_I_SQZBEARBO', type: 'tech', is_positive: false },
  { catId: '25', scanId: 'OHLC_D_I_10DSTOCHBEAR', type: 'tech', is_positive: false },
  { catId: '25', scanId: 'OHLC_20D_P_CLBLWPWL', type: 'tech', is_positive: false },
  { catId: '25', scanId: 'OHLC_D_I_BOLDBEAR', type: 'tech', is_positive: false },
  { catId: '25', scanId: 'OHLC_D_I_STBTOND', type: 'tech', is_positive: false },
  { catId: '25', scanId: 'OHLC_D_I_CLSERIESBEAR', type: 'tech', is_positive: false },
  { catId: '25', scanId: 'OHLC_D_I_TRNGLCANDBEAR', type: 'tech', is_positive: false },
  { catId: '25', scanId: 'OHLC_D_I_RISE3BEAR', type: 'tech', is_positive: false },
  { catId: '17', scanId: 'OHLC_W_P_52HIGH', type: 'tech', is_positive: true },
  { catId: '17', scanId: 'OHLC_D_P_2YRHIGH', type: 'tech', is_positive: true },
  { catId: '17', scanId: 'OHLC_D_P_3YRHIGH', type: 'tech', is_positive: true },
  { catId: '17', scanId: 'OHLC_D_P_5YRHIGH', type: 'tech', is_positive: true },
  { catId: '17', scanId: 'OHLC_D_P_ALLTIMEH', type: 'tech', is_positive: true },
  { catId: '17', scanId: 'OHLC_D_P_OPENLOW', type: 'tech', is_positive: true },
  { catId: '17', scanId: 'OHLC_W_P_52LOW', type: 'tech', is_positive: false },
  { catId: '17', scanId: 'OHLC_D_P_2YRLOW', type: 'tech', is_positive: false },
  { catId: '17', scanId: 'OHLC_D_P_3YRLOW', type: 'tech', is_positive: false },
  { catId: '17', scanId: 'OHLC_D_P_5YRLOW', type: 'tech', is_positive: false },
  { catId: '17', scanId: 'OHLC_D_P_ALLTIMEL', type: 'tech', is_positive: false }
];


/**
 * Updates stocklist.ts with new mcsymbol mappings
 */
async function updateStockMappingsFile(symbolMap: Map<string, string>) {
  const stocklistPath = path.resolve(process.cwd(), 'src/data/stocklist.ts');
  let content = fs.readFileSync(stocklistPath, 'utf8');

  let updated = false;
  symbolMap.forEach((mcsymbol, nseSymbol) => {
    // Look for exact symbol match and check if mcsymbol is different
    const regex = new RegExp(`(symbol:\\s*'${nseSymbol}',\\s*stockid:.*})`, 'g');
    const match = content.match(regex);
    
    if (match) {
      // Find the mcsymbol property in the same object
      const objRegex = new RegExp(`({name:.*mcsymbol:\\s*')([^']*)('.*symbol:\\s*'${nseSymbol}'.*})`, 's');
      const objMatch = content.match(objRegex);
      
      if (objMatch && objMatch[2] !== mcsymbol) {
        console.log(`[MAPPING] Updating ${nseSymbol}: ${objMatch[2]} -> ${mcsymbol}`);
        content = content.replace(objMatch[0], `${objMatch[1]}${mcsymbol}${objMatch[3]}`);
        updated = true;
      }
    }
  });

  if (updated) {
    fs.writeFileSync(stocklistPath, content);
    console.log('[MAPPING] stocklist.ts updated successfully.');
  }
}

export async function syncMoneyControlScreeners() {
  console.log(`🔄 Starting MoneyControl screener synchronization (${MC_SCREENERS.length} screeners)...`);
  
  const mappingsToUpdate = new Map<string, string>();

  for (const config of MC_SCREENERS) {
    const baseUrl = config.type === 'pro' 
      ? 'https://api.moneycontrol.com/mcapi/v1/proscanner/scanner-detail'
      : 'https://api.moneycontrol.com/mcapi/v1/techscanner/scanner-detail';
    
    const url = `${baseUrl}?catId=${config.catId}&scanId=${config.scanId}`;
    const response = await mcFetchJson(url);

    if (response?.success === 1 && response.data) {
      const screenerName = response.data.scanName || response.data.scanname || `MC Screener ${config.scanId}`;
      
      // Upsert screener
      db.prepare(`
        INSERT INTO moneycontrol_screeners (scan_id, cat_id, screener_name, type, is_positive)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(scan_id) DO UPDATE SET
          screener_name = excluded.screener_name,
          last_updated = CURRENT_TIMESTAMP
      `).run(config.scanId, config.catId, screenerName, config.type, config.is_positive ? 1 : 0);

      // Get stocks
      const stocks = response.data.stock || response.data.stocks || [];
      console.log(`✅ Fetched ${stocks.length} stocks for MC: ${screenerName}`);

      // Clear existing stocks for this screener
      db.prepare('DELETE FROM moneycontrol_screener_stocks WHERE scan_id = ?').run(config.scanId);

      const insertStock = db.prepare(`
        INSERT INTO moneycontrol_screener_stocks (scan_id, mcsymbol, stock_name, symbol)
        VALUES (?, ?, ?, ?)
      `);

      for (const stock of stocks) {
        const mcsymbol = stock.stkId || stock.sc_id;
        const stkname = stock.stkname || stock.stock_name || stock.shortName;
        
        if (mcsymbol) {
          const nseSymbol = getSymbolFromMcsymbol(mcsymbol);
          insertStock.run(config.scanId, mcsymbol, stkname, nseSymbol);

          // Automated mapping update: if stkname matches a known NSE symbol, track it
          if (stkname) {
            const cleanStkName = stkname.toUpperCase().trim();
            mappingsToUpdate.set(cleanStkName, mcsymbol);
          }
        }
      }
    }

    // Small delay to avoid rate limits
    await new Promise(resolve => setTimeout(resolve, 500));
  }

  // Final step: update the stocklist.ts file with discovered mappings
  if (mappingsToUpdate.size > 0) {
    await updateStockMappingsFile(mappingsToUpdate);
  }

  console.log('✅ MoneyControl screener synchronization complete.');
}
