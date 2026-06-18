import { dbGet, dbAll, dbTransaction } from './dbAsync';
import { getAllNSEStocks, getNSEStockBySymbol, searchNSEStocks, NSEStock } from '../data/nseStocks';

export interface NSEStockRow {
  id: number;
  symbol: string;
  name: string;
  sector: string;
  industry: string;
  isin: string;
  listing_date: string | null;
  exchange: string;
  status: string;
  market_cap: number | null;
  pe_ratio: number | null;
  dividend_yield: number | null;
  last_updated: string;
}

// Initialize NSE stocks in database (run once or periodically)
export function syncNSEStocksToDatabase(): { success: boolean; message: string; inserted: number; updated: number } {
  try {
    const stocks = getAllNSEStocks();

    // Run the sync asynchronously to avoid blocking the event loop during request handling
    setTimeout(async () => {
      try {
        const insertSql = `
            INSERT INTO nse_stocks (symbol, name, sector, industry, isin, listing_date, exchange, status, last_updated)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
            ON CONFLICT(symbol) DO UPDATE SET
              name = excluded.name,
              sector = excluded.sector,
              industry = excluded.industry,
              isin = excluded.isin,
              listing_date = excluded.listing_date,
              last_updated = CURRENT_TIMESTAMP
          `;

        const { inserted, updated } = await dbTransaction(async (tx) => {
          let inserted = 0;
          let updated = 0;
          for (const stock of stocks) {
            const result = await tx.run(insertSql, [
              stock.symbol,
              stock.name,
              stock.sector,
              stock.industry,
              stock.isin,
              stock.listing_date || null,
              'NSE',
              'ACTIVE',
            ]);

            // If lastInsertRowid is 0, it was an update
            if (result.changes > 0) {
              if (result.lastInsertRowid && Number(result.lastInsertRowid) > 0) {
                inserted++;
              } else {
                updated++;
              }
            }
          }
          return { inserted, updated };
        });

        console.log(`✅ NSE Stocks Sync: Inserted ${inserted}, Updated ${updated} from ${stocks.length} stocks`);
      } catch (error) {
        console.error('❌ Error in background NSE stocks sync:', error);
      }
    }, 0);

    return { success: true, message: `Syncing ${stocks.length} NSE stocks in background...`, inserted: 0, updated: 0 };
  } catch (error) {
    console.error('❌ Error initiating NSE stocks sync:', error);
    return { success: false, message: `Error initiating NSE stocks sync: ${error}`, inserted: 0, updated: 0 };
  }
}

// Get all NSE stocks from database
export async function getAllNSEStocksFromDB(): Promise<NSEStockRow[]> {
  try {
    const rows = await dbAll<NSEStockRow>(`
      SELECT 
        n.id, 
        n.symbol, 
        n.name, 
        n.sector, 
        n.industry, 
        n.isin, 
        n.listing_date, 
        n.exchange, 
        n.status, 
        COALESCE(f.market_cap, n.market_cap) as market_cap, 
        COALESCE(f.trailing_pe, n.pe_ratio) as pe_ratio, 
        COALESCE(f.dividend_yield, n.dividend_yield) as dividend_yield, 
        n.last_updated
      FROM nse_stocks n
      LEFT JOIN stock_fundamentals f ON n.symbol = f.symbol
      WHERE n.status = 'ACTIVE'
      ORDER BY n.symbol ASC
    `);
    return rows;
  } catch (error) {
    console.error('❌ Error fetching NSE stocks from DB:', error);
    return [];
  }
}

// Get NSE stock by symbol from database
export async function getNSEStockFromDB(symbol: string): Promise<NSEStockRow | undefined> {
  try {
    const row = await dbGet<NSEStockRow>(`
      SELECT 
        n.id, 
        n.symbol, 
        n.name, 
        n.sector, 
        n.industry, 
        n.isin, 
        n.listing_date, 
        n.exchange, 
        n.status, 
        COALESCE(f.market_cap, n.market_cap) as market_cap, 
        COALESCE(f.trailing_pe, n.pe_ratio) as pe_ratio, 
        COALESCE(f.dividend_yield, n.dividend_yield) as dividend_yield, 
        n.last_updated
      FROM nse_stocks n
      LEFT JOIN stock_fundamentals f ON n.symbol = f.symbol
      WHERE n.symbol = ? AND n.status = 'ACTIVE'
    `, [symbol]);
    return row;
  } catch (error) {
    console.error(`❌ Error fetching NSE stock ${symbol} from DB:`, error);
    return undefined;
  }
}

// Search NSE stocks from database
export async function searchNSEStocksFromDB(query: string): Promise<NSEStockRow[]> {
  try {
    const q = `%${query}%`;
    const rows = await dbAll<NSEStockRow>(`
      SELECT 
        n.id, 
        n.symbol, 
        n.name, 
        n.sector, 
        n.industry, 
        n.isin, 
        n.listing_date, 
        n.exchange, 
        n.status, 
        COALESCE(f.market_cap, n.market_cap) as market_cap, 
        COALESCE(f.trailing_pe, n.pe_ratio) as pe_ratio, 
        COALESCE(f.dividend_yield, n.dividend_yield) as dividend_yield, 
        n.last_updated
      FROM nse_stocks n
      LEFT JOIN stock_fundamentals f ON n.symbol = f.symbol
      WHERE n.status = 'ACTIVE' AND (
        n.symbol LIKE ? OR
        n.name LIKE ? OR
        n.sector LIKE ? OR
        n.industry LIKE ?
      )
      ORDER BY n.symbol ASC
      LIMIT 100
    `, [q, q, q, q]);
    return rows;
  } catch (error) {
    console.error(`❌ Error searching NSE stocks:`, error);
    return [];
  }
}

// Get stocks by sector from database
export async function getNSEStocksBySectorFromDB(sector: string): Promise<NSEStockRow[]> {
  try {
    const rows = await dbAll<NSEStockRow>(`
      SELECT 
        n.id, 
        n.symbol, 
        n.name, 
        n.sector, 
        n.industry, 
        n.isin, 
        n.listing_date, 
        n.exchange, 
        n.status, 
        COALESCE(f.market_cap, n.market_cap) as market_cap, 
        COALESCE(f.trailing_pe, n.pe_ratio) as pe_ratio, 
        COALESCE(f.dividend_yield, n.dividend_yield) as dividend_yield, 
        n.last_updated
      FROM nse_stocks n
      LEFT JOIN stock_fundamentals f ON n.symbol = f.symbol
      WHERE n.status = 'ACTIVE' AND n.sector = ?
      ORDER BY market_cap DESC
    `, [sector]);
    return rows;
  } catch (error) {
    console.error(`❌ Error fetching stocks for sector ${sector}:`, error);
    return [];
  }
}

// Get stocks by industry from database
export async function getNSEStocksByIndustryFromDB(industry: string): Promise<NSEStockRow[]> {
  try {
    const rows = await dbAll<NSEStockRow>(`
      SELECT 
        n.id, 
        n.symbol, 
        n.name, 
        n.sector, 
        n.industry, 
        n.isin, 
        n.listing_date, 
        n.exchange, 
        n.status, 
        COALESCE(f.market_cap, n.market_cap) as market_cap, 
        COALESCE(f.trailing_pe, n.pe_ratio) as pe_ratio, 
        COALESCE(f.dividend_yield, n.dividend_yield) as dividend_yield, 
        n.last_updated
      FROM nse_stocks n
      LEFT JOIN stock_fundamentals f ON n.symbol = f.symbol
      WHERE n.status = 'ACTIVE' AND n.industry = ?
      ORDER BY market_cap DESC
    `, [industry]);
    return rows;
  } catch (error) {
    console.error(`❌ Error fetching stocks for industry ${industry}:`, error);
    return [];
  }
}

// Get all sectors
export async function getAllSectorsFromDB(): Promise<string[]> {
  try {
    const rows = await dbAll<{ sector: string }>(`
      SELECT DISTINCT sector FROM nse_stocks
      WHERE status = 'ACTIVE'
      ORDER BY sector ASC
    `);
    return rows.map(r => r.sector);
  } catch (error) {
    console.error('❌ Error fetching sectors:', error);
    return [];
  }
}

// Get all industries
export async function getAllIndustriesFromDB(): Promise<string[]> {
  try {
    const rows = await dbAll<{ industry: string }>(`
      SELECT DISTINCT industry FROM nse_stocks
      WHERE status = 'ACTIVE'
      ORDER BY industry ASC
    `);
    return rows.map(r => r.industry);
  } catch (error) {
    console.error('❌ Error fetching industries:', error);
    return [];
  }
}

// Get stock count
export async function getNSEStockCount(): Promise<number> {
  try {
    const result = await dbGet<{ count: number }>(`
      SELECT COUNT(*) as count FROM nse_stocks WHERE status = 'ACTIVE'
    `) as { count: number };
    return result.count;
  } catch (error) {
    console.error('❌ Error getting stock count:', error);
    return 0;
  }
}
