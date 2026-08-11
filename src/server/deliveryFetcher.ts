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
    // By NAME, like every other column here. This used to be cols[cols.length - 2] with the
    // comment "Usually NO_OF_TRADES is second to last" -- but sec_bhavdata_full ends
    // ... NO_OF_TRADES, DELIV_QTY, DELIV_PER, so second-to-last is DELIV_QTY. The result was
    // that `trades` held delivery quantity in 100% of 664,006 rows (found 2026-08-11).
    // Same blind-positional-index class as the 2026-07-23 URL-as-symbol corruption.
    const tradesIdx = header.indexOf('NO_OF_TRADES');

    if (symIdx < 0 || trdIdx < 0 || delIdx < 0) return new Map();

    const map = new Map<string, number>();
    const rowsToInsert: any[][] = [];

    for (let i = 1; i < lines.length; i++) {
      const cols = lines[i].split(',').map(c => c.trim().replace(/^"|"$/g, ''));
      if (cols[seriesIdx] !== 'EQ') continue;
      const sym    = cols[symIdx];
      const traded = parseFloat(cols[trdIdx]);
      const tradesCount = tradesIdx >= 0 ? parseFloat(cols[tradesIdx]) : NaN;
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
          // NULL, not 0: a missing trade count is unknown, and 0 is a real value that would
          // be indistinguishable from "the column was absent".
          isNaN(tradesCount) ? null : tradesCount
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
