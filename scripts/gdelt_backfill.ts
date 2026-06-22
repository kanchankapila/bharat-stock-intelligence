/**
 * Backfill GDELT daily tone into gdelt_sentiment.
 * RUN FROM YOUR OWN MACHINE — GDELT blocks cloud/shared IPs.
 *   npx tsx scripts/gdelt_backfill.ts [monthsBack=6] [limit=150]
 * Rate-limited to 1 req / 5s, so ~150 companies ≈ 13 min.
 */
import { runGdeltBackfill } from '../src/server/gdeltService';

const monthsBack = Number(process.argv[2] ?? 6);
const limit = Number(process.argv[3] ?? 150);
const end = new Date();
const start = new Date(end.getTime() - monthsBack * 30 * 864e5);

(async () => {
  console.log(`GDELT backfill: top ${limit} cos, ${start.toISOString().slice(0,10)} -> ${end.toISOString().slice(0,10)}`);
  const r = await runGdeltBackfill(start, end, limit);
  console.log('DONE:', JSON.stringify(r));
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
