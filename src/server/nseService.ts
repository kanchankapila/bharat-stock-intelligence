import { dbGet, dbAll, dbRun, dbTransaction } from './dbAsync';
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

// Backfills nse_stocks.market_cap/pe_ratio/dividend_yield from stock_fundamentals (added
// 2026-08-07, dead-column sweep). These 3 columns had NO writer anywhere in the codebase --
// live-verified 0/2,366 ACTIVE rows populated -- but every reader (getStockList/getStocks/
// searchNSEStocks/etc. in this file) already does COALESCE(stock_fundamentals.x, nse_stocks.x),
// so this was a genuinely dead last-resort fallback rather than a live bug: stock_fundamentals
// covers ~94% of the universe already. This backfill makes the fallback real for the remaining
// ~6% stock_fundamentals doesn't cover, instead of leaving it structurally unreachable.
// COALESCE-on-the-target-side (never downgrade): only fills a currently-NULL nse_stocks value,
// never overwrites one that's already set (matches the sector-backfill convention directly
// above in this file's syncNSEStocksToDatabase()).
export async function backfillNseStocksFundamentalsFallback(): Promise<{ updated: number }> {
  // Correlated subqueries rather than `UPDATE ... FROM` -- this codebase's SQLite dev-fallback
  // path (sqlTranslate.ts) has no established precedent handling Postgres's FROM-joined UPDATE
  // syntax, so this form (proven to work identically on both dialects) avoids that risk entirely.
  const result = await dbRun(`
    UPDATE nse_stocks
    SET market_cap    = COALESCE(market_cap,    (SELECT sf.market_cap    FROM stock_fundamentals sf WHERE sf.symbol = nse_stocks.symbol)),
        pe_ratio       = COALESCE(pe_ratio,      (SELECT sf.trailing_pe  FROM stock_fundamentals sf WHERE sf.symbol = nse_stocks.symbol)),
        dividend_yield = COALESCE(dividend_yield,(SELECT sf.dividend_yield FROM stock_fundamentals sf WHERE sf.symbol = nse_stocks.symbol))
    WHERE symbol IN (SELECT symbol FROM stock_fundamentals)
      AND (market_cap IS NULL OR pe_ratio IS NULL OR dividend_yield IS NULL)
  `);
  return { updated: result?.changes ?? 0 };
}

let _nseSyncInProgress = false;

// Initialize NSE stocks in database (run once or periodically)
export function syncNSEStocksToDatabase(): { success: boolean; message: string; inserted: number; updated: number } {
  if (_nseSyncInProgress) {
    return { success: true, message: 'NSE stocks sync already in progress', inserted: 0, updated: 0 };
  }
  try {
    const stocks = getAllNSEStocks();
    _nseSyncInProgress = true;

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

        const BATCH_SIZE = 100;
        const ROW_PH = `(?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)`;
        const COLS = `symbol,name,sector,industry,isin,listing_date,exchange,status,last_updated`;
        // sector/industry: the static src/data/nseStocks.ts seed file hardcodes 'Unknown' for
        // ~95% of symbols (real classification is backfilled separately by
        // backfill_sector_mc.py/backfill_sector_industry.py, chained right after this sync --
        // see processNSESync in jobs/sync.jobs.ts). This job runs weekly; a blind
        // `sector=excluded.sector` would silently wipe every backfilled real value back to
        // 'Unknown' on the very next run. Only take the incoming value when it's a genuine
        // classification, or when the existing row has nothing at all (first-ever sync) --
        // never let a placeholder downgrade a real one, matching the "gap-fill only, never
        // clobber" convention the backfill scripts themselves already follow.
        const CONFLICT = `name=excluded.name,`
          + `sector=CASE WHEN excluded.sector IS NOT NULL AND excluded.sector NOT IN ('','Unknown') THEN excluded.sector `
          +   `WHEN nse_stocks.sector IS NULL THEN excluded.sector ELSE nse_stocks.sector END,`
          + `industry=CASE WHEN excluded.industry IS NOT NULL AND excluded.industry NOT IN ('','Unknown') THEN excluded.industry `
          +   `WHEN nse_stocks.industry IS NULL THEN excluded.industry ELSE nse_stocks.industry END,`
          + `isin=excluded.isin,listing_date=excluded.listing_date,last_updated=CURRENT_TIMESTAMP`;

        let inserted = 0;
        let updated = 0;
        await dbTransaction(async (tx) => {
          for (let i = 0; i < stocks.length; i += BATCH_SIZE) {
            const chunk = stocks.slice(i, i + BATCH_SIZE);
            const sql = `INSERT INTO nse_stocks (${COLS}) VALUES ${chunk.map(() => ROW_PH).join(',')}
              ON CONFLICT(symbol) DO UPDATE SET ${CONFLICT}`;
            const params = chunk.flatMap(s => [
              s.symbol, s.name, s.sector, s.industry, s.isin,
              s.listing_date || null, 'NSE', 'ACTIVE',
            ]);
            const result = await tx.run(sql, params);
            inserted += result.changes ?? 0;
          }
          updated = stocks.length - inserted;
        });

        console.log(`✅ NSE Stocks Sync: Inserted ${inserted}, Updated ${updated} from ${stocks.length} stocks`);
      } catch (error) {
        console.error('❌ Error in background NSE stocks sync:', error);
      } finally {
        _nseSyncInProgress = false;
      }
    }, 0);

    return { success: true, message: `Syncing ${stocks.length} NSE stocks in background...`, inserted: 0, updated: 0 };
  } catch (error) {
    _nseSyncInProgress = false;
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
    // LIKE is case-sensitive on Postgres (unlike SQLite's implicit ASCII-only
    // case-insensitivity) -- wrap both sides in LOWER() so "bel" matches the
    // uppercase-stored "BEL" on both dialects, matching the LOWER()-bridging
    // convention already used elsewhere in this codebase for cross-dialect matches.
    const q = `%${query.toLowerCase()}%`;
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
        LOWER(n.symbol) LIKE ? OR
        LOWER(n.name) LIKE ? OR
        LOWER(n.sector) LIKE ? OR
        LOWER(n.industry) LIKE ?
      )
      ORDER BY
        CASE WHEN LOWER(n.symbol) = LOWER(?) THEN 0 ELSE 1 END,
        n.symbol ASC
      LIMIT 100
    `, [q, q, q, q, query]);
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
