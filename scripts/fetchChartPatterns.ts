import Database from 'better-sqlite3';
import path from 'path';
import stockData from '../src/data/stocklist';

interface ChartPattern {
  userid: number;
  instrument_type: string;
  instrument: string;
  exchange: string;
  pattern_name: string;
  comment: string;
  time_frame: string;
  sc_id: string;
  is_closed: string;
  is_deleted: number;
  end_date: string;
  meta_data: string;
  p_status: string;
  pattern_id: number;
  analyst_name: string;
  analyst_image: string;
  updated_at: string;
  created_at: string;
  updated_at_epoch: number;
  created_at_epoch: number;
  sc_name: string;
  symbol: string;
  chartType: string;
  displayLock: string;
  scanproflg: number;
}

interface PatternMetadata {
  entry_price?: string;
  target_price?: string;
  stoploss_price?: string;
  target_return_prcnt?: string;
  stoploss_prcnt?: string;
  cmp?: string;
  [key: string]: any;
}

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

const BASE_URL = 'https://api.moneycontrol.com/mcapi/technicalpicks/chart-patterns';

async function fetchChartPatterns(mcsymbol: string, retries = 3): Promise<ChartPattern[]> {
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const url = `${BASE_URL}?deviceType=W&version=174&start=0&limit=50&pattern_type=all&sc_id=${mcsymbol}`;
      console.log(`Fetching patterns for ${mcsymbol}...`);
      
      const response = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        }
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const data = await response.json();
      
      if (data.status === 'success' && data.list?.data) {
        console.log(`  ✓ Found ${data.list.data.length} patterns for ${mcsymbol}`);
        return data.list.data;
      }
      
      return [];
    } catch (error) {
      const err = error as Error;
      console.error(`  ✗ Attempt ${attempt + 1}/${retries} failed for ${mcsymbol}: ${err.message}`);
      
      if (attempt < retries - 1) {
        const waitTime = 1000 * Math.pow(2, attempt); // Exponential backoff: 1s, 2s, 4s
        await delay(waitTime);
      }
    }
  }
  
  return [];
}

function parseMetadata(metadataStr: string): PatternMetadata {
  try {
    return JSON.parse(metadataStr);
  } catch (e) {
    return {};
  }
}

function resolveMcsymbolToNseSymbol(mcsymbol: string): string | undefined {
  const stock = stockData.find(s => s.mcsymbol === mcsymbol);
  return stock?.symbol;
}

async function main() {
  const dbPath = path.resolve(process.cwd(), process.env.DATABASE_URL || 'database.sqlite');
  const db = new Database(dbPath, { timeout: 10000 });

  try {
    console.log('🔄 Initializing database connection...');
    
    // Prepare insert statement
    const insertStmt = db.prepare(`
      INSERT INTO mc_chart_patterns (
        mcsymbol, symbol, pattern_id, pattern_name, comment, time_frame,
        exchange, p_status, is_closed, entry_price, target_price, stoploss_price,
        target_return_pct, stoploss_pct, cmp, metadata_json, end_date,
        analyst_name, analyst_image, fetched_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(mcsymbol, pattern_id) DO UPDATE SET
        pattern_name=excluded.pattern_name,
        comment=excluded.comment,
        time_frame=excluded.time_frame,
        p_status=excluded.p_status,
        is_closed=excluded.is_closed,
        entry_price=excluded.entry_price,
        target_price=excluded.target_price,
        stoploss_price=excluded.stoploss_price,
        target_return_pct=excluded.target_return_pct,
        stoploss_pct=excluded.stoploss_pct,
        cmp=excluded.cmp,
        metadata_json=excluded.metadata_json,
        end_date=excluded.end_date,
        fetched_at=excluded.fetched_at
    `);

    let totalInserted = 0;
    let totalUpdated = 0;
    let successCount = 0;
    let errorCount = 0;

    console.log(`\n📊 Fetching chart patterns for ${stockData.length} stocks...\n`);

    for (const stock of stockData) {
      const patterns = await fetchChartPatterns(stock.mcsymbol);
      
      if (patterns.length > 0) {
        successCount++;
        for (const pattern of patterns) {
          const metadata = parseMetadata(pattern.meta_data);
          const nseSymbol = resolveMcsymbolToNseSymbol(stock.mcsymbol);
          
          const entryPrice = metadata.entry_price ? parseFloat(metadata.entry_price) : null;
          const targetPrice = metadata.target_price ? parseFloat(metadata.target_price) : null;
          const stoplossPrice = metadata.stoploss_price ? parseFloat(metadata.stoploss_price) : null;
          const targetReturnPct = metadata.target_return_prcnt ? parseFloat(metadata.target_return_prcnt) : null;
          const stoploss_pct = metadata.stoploss_prcnt ? parseFloat(metadata.stoploss_prcnt) : null;
          const cmp = metadata.cmp ? parseFloat(metadata.cmp) : null;

          try {
            const result = insertStmt.run(
              stock.mcsymbol,           // mcsymbol
              nseSymbol,                // symbol
              pattern.pattern_id,       // pattern_id
              pattern.pattern_name,     // pattern_name
              pattern.comment,          // comment
              pattern.time_frame,       // time_frame
              pattern.exchange,         // exchange
              pattern.p_status,         // p_status
              pattern.is_closed,        // is_closed
              entryPrice,               // entry_price
              targetPrice,              // target_price
              stoplossPrice,            // stoploss_price
              targetReturnPct,          // target_return_pct
              stoploss_pct,             // stoploss_pct
              cmp,                      // cmp
              pattern.meta_data,        // metadata_json (full stringified data)
              pattern.end_date,         // end_date
              pattern.analyst_name,     // analyst_name
              pattern.analyst_image,    // analyst_image
              new Date().toISOString()  // fetched_at
            );

            if (result.changes > 0) {
              if (result.lastInsertRowid) {
                totalInserted++;
              } else {
                totalUpdated++;
              }
            }
          } catch (error) {
            const err = error as Error;
            console.error(`  ✗ Failed to insert pattern ${pattern.pattern_id} for ${stock.mcsymbol}: ${err.message}`);
            errorCount++;
          }
        }
      }

      // Rate limiting: 100ms between requests
      await delay(100);
    }

    console.log(`\n✅ Chart patterns fetch complete!`);
    console.log(`   Total inserted: ${totalInserted}`);
    console.log(`   Total updated: ${totalUpdated}`);
    console.log(`   Total stored: ${totalInserted + totalUpdated}`);
    console.log(`   Stocks processed: ${successCount}/${stockData.length}`);
    console.log(`   Errors: ${errorCount}`);

    // Print summary stats
    const stats = db.prepare('SELECT COUNT(*) as total, COUNT(DISTINCT mcsymbol) as stocks FROM mc_chart_patterns').get() as any;
    console.log(`\n📈 Database summary:`);
    console.log(`   Total patterns: ${stats.total}`);
    console.log(`   Stocks with patterns: ${stats.stocks}`);

  } catch (error) {
    const err = error as Error;
    console.error('Fatal error:', err.message);
    console.error(err.stack);
    process.exit(1);
  } finally {
    db.close();
  }
}

main().catch(err => {
  console.error('Unhandled error:', err);
  process.exit(1);
});
