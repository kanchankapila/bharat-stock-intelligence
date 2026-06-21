let deliveryCache: Map<string, number> | null = null;
let deliveryCacheDate: string | null = null;

export async function fetchDeliveryMap(scanDate: string): Promise<Map<string, number>> {
  if (deliveryCache && deliveryCacheDate === scanDate) return deliveryCache;

  const [year, month, day] = scanDate.split('-');
  const ddmmyyyy = `${day}${month}${year}`;
  const url = `https://archives.nseindia.com/products/content/sec_bhavdata_full_${ddmmyyyy}.csv`;

  try {
    const res = await fetch(url, {
      headers: { 'Accept': 'text/csv', 'User-Agent': 'Mozilla/5.0' },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return new Map();

    const text = await res.text();
    const lines = text.trim().split('\n');
    const header = lines[0].split(',').map(h => h.trim().replace(/^"|"$/g, ''));
    const symIdx    = header.indexOf('SYMBOL');
    const seriesIdx = header.indexOf('SERIES');
    const trdIdx    = header.indexOf('TTL_TRD_QNTY');
    const delIdx    = header.indexOf('DELIV_QTY');

    if (symIdx < 0 || trdIdx < 0 || delIdx < 0) return new Map();

    const map = new Map<string, number>();
    const rowsToInsert: any[][] = [];

    for (let i = 1; i < lines.length; i++) {
      const cols = lines[i].split(',').map(c => c.trim().replace(/^"|"$/g, ''));
      if (cols[seriesIdx] !== 'EQ') continue;
      const sym    = cols[symIdx];
      const traded = parseFloat(cols[trdIdx]);
      const tradesCount = parseFloat(cols[cols.length - 2]); // Usually NO_OF_TRADES is second to last
      const deliv  = parseFloat(cols[delIdx]);
      
      if (traded > 0 && !isNaN(deliv)) {
        const pct = parseFloat(((deliv / traded) * 100).toFixed(2));
        map.set(sym, pct);
        rowsToInsert.push([
          sym,
          scanDate,
          pct,
          deliv,
          traded,
          isNaN(tradesCount) ? 0 : tradesCount
        ]);
      }
    }

    if (rowsToInsert.length > 0) {
      try {
        const { dbRun } = await import('./dbAsync');
        const { bulkUpsert, rowGroups } = await import('./dbBulk');
        
        // Use a dummy object wrapping dbRun to satisfy DbTx interface since we don't need get/all here
        const tx = { run: dbRun, get: async () => undefined, all: async () => [] };
        
        await bulkUpsert(tx, rowsToInsert, 6, (rowCount) => `
          INSERT INTO stock_delivery_data (symbol, date, delivery_pct, delivery_qty, traded_qty, trades)
          VALUES ${rowGroups(rowCount, 6)}
          ON CONFLICT(symbol, date) DO UPDATE SET
            delivery_pct = excluded.delivery_pct,
            delivery_qty = excluded.delivery_qty,
            traded_qty = excluded.traded_qty,
            trades = excluded.trades,
            updated_at = CURRENT_TIMESTAMP
        `);
      } catch (dbErr) {
        console.error(`[Delivery] Failed to persist delivery data:`, dbErr);
      }
    }

    deliveryCache = map;
    deliveryCacheDate = scanDate;
    console.log(`[Delivery] Loaded & persisted delivery% for ${map.size} symbols from NSE Bhavcopy (${scanDate})`);
    return map;
  } catch (err) {
    console.warn(`[Delivery] Failed to fetch Bhavcopy for ${scanDate}:`, (err as Error).message);
    return new Map();
  }
}
