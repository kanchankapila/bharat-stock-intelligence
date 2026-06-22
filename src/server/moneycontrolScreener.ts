import { dbGet, dbAll, dbRun, dbTransaction } from './dbAsync';
import { getStockMapping, getSymbolFromMcsymbol } from './stockMapping';
import { mcFetchJson } from './mcApiService';
import fs from 'fs';
import path from 'path';
import { isIntradayScreener } from './trendlyneScreener';

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

export async function syncMoneyControlScreeners(timeframeFilter?: 'intraday' | 'long_term') {
  console.log(`🔄 Starting MoneyControl screener synchronization (${MC_SCREENERS.length} screeners, filter: ${timeframeFilter || 'all'})...`);
  
  const mappingsToUpdate = new Map<string, string>();

  for (const config of MC_SCREENERS) {
    // Determine screener name from DB or use fallback to check timeframe
    const row = await dbGet<{ screener_name: string }>('SELECT screener_name FROM moneycontrol_screeners WHERE scan_id = ?', [config.scanId]);
    const name = row?.screener_name || `MC Screener ${config.scanId}`;
    const isIntraday = isIntradayScreener(name);
    
    if (timeframeFilter === 'intraday' && !isIntraday) continue;
    if (timeframeFilter === 'long_term' && isIntraday) continue;

    const baseUrl = config.type === 'pro' 
      ? 'https://api.moneycontrol.com/mcapi/v1/proscanner/scanner-detail'
      : 'https://api.moneycontrol.com/mcapi/v1/techscanner/scanner-detail';
    
    const url = `${baseUrl}?catId=${config.catId}&scanId=${config.scanId}`;
    const response = await mcFetchJson(url);

    if (response?.success === 1 && response.data) {
      const screenerName = response.data.list?.scannerName || response.data.scanName || response.data.scanname || `MC Screener ${config.scanId}`;

      // Upsert screener
      await dbRun(`
        INSERT INTO moneycontrol_screeners (scan_id, cat_id, screener_name, type, is_positive)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(scan_id) DO UPDATE SET
          screener_name = excluded.screener_name,
          last_updated = CURRENT_TIMESTAMP
      `, [config.scanId, config.catId, screenerName, config.type, config.is_positive ? 1 : 0]);

      const stocks = response.data.list?.scannerDetails || response.data.stock || response.data.stocks || [];
      console.log(`✅ Fetched ${stocks.length} stocks for MC: ${screenerName}`);

      // Snapshot previous active symbols BEFORE delete
      const prevSymbols = new Set<string>(
        (await dbAll<{ symbol: string }>(`SELECT symbol FROM screener_appearances WHERE screener_id = ? AND exited_date IS NULL`,
          [config.scanId]))
          .map(r => r.symbol).filter(Boolean)
      );

      const upsertStockSql = `
        INSERT INTO moneycontrol_screener_stocks (scan_id, mcsymbol, stock_name, symbol, first_seen, last_seen)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(scan_id, mcsymbol) DO UPDATE SET
          stock_name = excluded.stock_name,
          symbol     = excluded.symbol,
          last_seen  = excluded.last_seen
      `;
      const currentSymbols = new Set<string>();
      const today = new Date().toISOString().slice(0, 10);
      const incomingMcSymbols = new Set<string>();

      for (const stock of stocks) {
        const mcsymbol = stock.stkId || stock.sc_id;
        const stkname = stock.stkname || stock.stock_name || stock.shortName;
        if (mcsymbol) {
          const nseSymbol = getSymbolFromMcsymbol(mcsymbol);
          await dbRun(upsertStockSql, [config.scanId, mcsymbol, stkname, nseSymbol, today, today]);
          incomingMcSymbols.add(mcsymbol);
          if (nseSymbol) currentSymbols.add(nseSymbol);
          if (stkname) mappingsToUpdate.set(stkname.toUpperCase().trim(), mcsymbol);
        }
      }

      // Remove stocks no longer in screener
      const existingRows = await dbAll<{ mcsymbol: string }>(`SELECT mcsymbol FROM moneycontrol_screener_stocks WHERE scan_id = ?`,
        [config.scanId]);
      const toDelete = existingRows.filter(r => !incomingMcSymbols.has(r.mcsymbol));
      if (toDelete.length) {
        const delSql = `DELETE FROM moneycontrol_screener_stocks WHERE scan_id = ? AND mcsymbol = ?`;
        await dbTransaction(async (tx) => { for (const r of toDelete) await tx.run(delSql, [config.scanId, r.mcsymbol]); });
      }

      // Update screener_master sync time
      await dbRun(`UPDATE screener_master SET last_updated = ?, stocks_synced_at = ? WHERE scan_id = ?`,
        [today, today, config.scanId]);

      // Diff patch
      const entered = Array.from(currentSymbols).filter(s => !prevSymbols.has(s));
      const exited  = Array.from(prevSymbols).filter(s => !currentSymbols.has(s));

      if (entered.length > 0) {
        const insertAppSql = `INSERT OR IGNORE INTO screener_appearances (screener_id, source, symbol, appeared_date) VALUES (?, 'moneycontrol', ?, ?)`;
        const insertLogSql = `INSERT OR IGNORE INTO screener_history_log (symbol, screener_id, entry_date, source) VALUES (?, ?, ?, 'moneycontrol')`;
        await dbTransaction(async (tx) => {
          for (const s of entered) {
            await tx.run(insertAppSql, [config.scanId, s, today]);
            await tx.run(insertLogSql, [s, config.scanId, today]);
          }
        });
      }
      if (exited.length > 0) {
        await dbRun(`UPDATE screener_appearances SET exited_date = ? WHERE screener_id = ? AND symbol IN (${exited.map(() => '?').join(',')}) AND exited_date IS NULL`,
          [today, config.scanId, ...exited]);
        
        await dbTransaction(async (tx) => {
          for (const s of exited) {
            await tx.run(`UPDATE screener_history_log SET exit_date = ? WHERE symbol = ? AND screener_id = ? AND exit_date IS NULL`, [today, s, config.scanId]);
          }
        });
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

/**
 * Find all MoneyControl screeners that contain a specific stock
 * @param symbol - The NSE symbol to search for
 * @returns Array of screeners containing the stock with sentiment info
 */
export async function findMcScreenersByStock(symbol: string): Promise<Array<{
  id: string;
  name: string;
  sentiment: 'bullish' | 'bearish' | 'neutral';
  screenpk: string;
  source: string;
  description: string;
}>> {
  try {
    if (!symbol) return [];

    const matches = await dbAll<{
      scan_id: string;
      screener_name: string;
      inferred_sentiment: string | null;
      is_positive: number;
      type: string;
    }>(`
      SELECT s.scan_id, s.screener_name, m.inferred_sentiment, s.is_positive, s.type
      FROM moneycontrol_screeners s
      JOIN moneycontrol_screener_stocks ss ON s.scan_id = ss.scan_id
      LEFT JOIN screener_master m ON s.scan_id = m.scan_id
      WHERE ss.symbol = ?
    `, [symbol]);

    return matches.map(m => ({
      id: m.scan_id,
      name: m.screener_name,
      sentiment: (m.inferred_sentiment || (m.is_positive === 1 ? 'bullish' : 'bearish')) as 'bullish' | 'bearish' | 'neutral',
      screenpk: 'MC_' + m.scan_id,
      source: 'moneycontrol',
      description: 'Moneycontrol ' + (m.type === 'pro' ? 'Fundamental' : 'Technical') + ' Screener'
    }));
  } catch (error) {
    console.error(`❌ Error finding MC screeners for stock ${symbol}:`, error);
    return [];
  }
}

