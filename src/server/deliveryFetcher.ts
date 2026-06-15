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
    for (let i = 1; i < lines.length; i++) {
      const cols = lines[i].split(',').map(c => c.trim().replace(/^"|"$/g, ''));
      if (cols[seriesIdx] !== 'EQ') continue;
      const sym    = cols[symIdx];
      const traded = parseFloat(cols[trdIdx]);
      const deliv  = parseFloat(cols[delIdx]);
      if (traded > 0 && !isNaN(deliv)) {
        map.set(sym, parseFloat(((deliv / traded) * 100).toFixed(2)));
      }
    }

    deliveryCache = map;
    deliveryCacheDate = scanDate;
    console.log(`[Delivery] Loaded delivery% for ${map.size} symbols from NSE Bhavcopy (${scanDate})`);
    return map;
  } catch (err) {
    console.warn(`[Delivery] Failed to fetch Bhavcopy for ${scanDate}:`, (err as Error).message);
    return new Map();
  }
}
