import { fetchDeliveryMap } from '../src/server/deliveryFetcher';

function getTradingDaysForLastYear(): string[] {
  const dates: string[] = [];
  const now = new Date();
  // Set start date to exactly 365 days ago
  const start = new Date();
  start.setDate(now.getDate() - 365);

  let current = new Date(start);
  while (current <= now) {
    const day = current.getUTCDay();
    // 0 is Sunday, 6 is Saturday
    if (day !== 0 && day !== 6) {
      const iso = current.toISOString().split('T')[0];
      dates.push(iso);
    }
    current.setDate(current.getDate() + 1);
  }
  return dates;
}

async function runBackfill() {
  const dates = getTradingDaysForLastYear();
  console.log(`[BACKFILL] Found ${dates.length} potential trading days to backfill for the past year.`);

  for (let i = 0; i < dates.length; i++) {
    const date = dates[i];
    console.log(`[BACKFILL] Processing ${date} (${i + 1}/${dates.length})...`);
    try {
      const map = await fetchDeliveryMap(date);
      if (map && map.size > 0) {
        console.log(`[BACKFILL] Successfully backfilled ${map.size} symbols for ${date}.`);
      } else {
        console.log(`[BACKFILL] No data or Holiday on ${date}.`);
      }
    } catch (e: any) {
      console.error(`[BACKFILL] Error fetching ${date}:`, e.message);
    }
    // Pause heavily to avoid getting IP banned by NSE archives
    await new Promise(r => setTimeout(r, 2000));
  }
  
  console.log(`[BACKFILL] Historical Delivery Backfill Complete!`);
}

runBackfill().catch(console.error);
