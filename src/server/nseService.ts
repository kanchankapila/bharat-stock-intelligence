import db from './db';
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
    setTimeout(() => {
      try {
        const insertMany = db.transaction((stocksList) => {
          let inserted = 0;
          let updated = 0;

          const insertStmt = db.prepare(`
            INSERT INTO nse_stocks (symbol, name, sector, industry, isin, listing_date, exchange, status, last_updated)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
            ON CONFLICT(symbol) DO UPDATE SET
              name = excluded.name,
              sector = excluded.sector,
              industry = excluded.industry,
              isin = excluded.isin,
              listing_date = excluded.listing_date,
              last_updated = CURRENT_TIMESTAMP
          `);

          for (const stock of stocksList) {
            const result = insertStmt.run(
              stock.symbol,
              stock.name,
              stock.sector,
              stock.industry,
              stock.isin,
              stock.listing_date || null,
              'NSE',
              'ACTIVE'
            );

            // If lastInsertRowid is 0, it was an update
            if ((result as any).changes > 0) {
              if ((result as any).lastInsertRowid && (result as any).lastInsertRowid > 0) {
                inserted++;
              } else {
                updated++;
              }
            }
          }
          return { inserted, updated };
        });

        const { inserted, updated } = insertMany(stocks);
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
export function getAllNSEStocksFromDB(): NSEStockRow[] {
  try {
    const rows = db.prepare(`
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
    `).all() as NSEStockRow[];
    return rows;
  } catch (error) {
    console.error('❌ Error fetching NSE stocks from DB:', error);
    return [];
  }
}

// Get NSE stock by symbol from database
export function getNSEStockFromDB(symbol: string): NSEStockRow | undefined {
  try {
    const row = db.prepare(`
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
    `).get(symbol) as NSEStockRow | undefined;
    return row;
  } catch (error) {
    console.error(`❌ Error fetching NSE stock ${symbol} from DB:`, error);
    return undefined;
  }
}

// Search NSE stocks from database
export function searchNSEStocksFromDB(query: string): NSEStockRow[] {
  try {
    const q = `%${query}%`;
    const rows = db.prepare(`
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
    `).all(q, q, q, q) as NSEStockRow[];
    return rows;
  } catch (error) {
    console.error(`❌ Error searching NSE stocks:`, error);
    return [];
  }
}

// Get stocks by sector from database
export function getNSEStocksBySectorFromDB(sector: string): NSEStockRow[] {
  try {
    const rows = db.prepare(`
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
    `).all(sector) as NSEStockRow[];
    return rows;
  } catch (error) {
    console.error(`❌ Error fetching stocks for sector ${sector}:`, error);
    return [];
  }
}

// Get stocks by industry from database
export function getNSEStocksByIndustryFromDB(industry: string): NSEStockRow[] {
  try {
    const rows = db.prepare(`
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
    `).all(industry) as NSEStockRow[];
    return rows;
  } catch (error) {
    console.error(`❌ Error fetching stocks for industry ${industry}:`, error);
    return [];
  }
}

// Get all sectors
export function getAllSectorsFromDB(): string[] {
  try {
    const rows = db.prepare(`
      SELECT DISTINCT sector FROM nse_stocks
      WHERE status = 'ACTIVE'
      ORDER BY sector ASC
    `).all() as { sector: string }[];
    return rows.map(r => r.sector);
  } catch (error) {
    console.error('❌ Error fetching sectors:', error);
    return [];
  }
}

// Get all industries
export function getAllIndustriesFromDB(): string[] {
  try {
    const rows = db.prepare(`
      SELECT DISTINCT industry FROM nse_stocks
      WHERE status = 'ACTIVE'
      ORDER BY industry ASC
    `).all() as { industry: string }[];
    return rows.map(r => r.industry);
  } catch (error) {
    console.error('❌ Error fetching industries:', error);
    return [];
  }
}

// Get stock count
export function getNSEStockCount(): number {
  try {
    const result = db.prepare(`
      SELECT COUNT(*) as count FROM nse_stocks WHERE status = 'ACTIVE'
    `).get() as { count: number };
    return result.count;
  } catch (error) {
    console.error('❌ Error getting stock count:', error);
    return 0;
  }
}
