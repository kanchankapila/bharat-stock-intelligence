// Read-only preview of the NEW signal-accuracy digest format against live DB.
import 'dotenv/config';
const { buildAccuracyDigest, formatAccuracyDigest } = await import('../src/server/signalAccuracyDigest.ts');
const d = await buildAccuracyDigest();
if (!d) { console.log('no digest rows'); process.exit(0); }
console.log('=== data ===');
console.log(JSON.stringify({ flyers: d.flyers, divers: d.divers, flyerCalls: d.flyerCalls, diverCalls: d.diverCalls, confirmed: d.confirmedCalls.length, worst: d.worstCalls.length,
  wrongBearish: d.wrongBearish, wrongBullish: d.wrongBullish, recallAny: d.recallAny, date: d.date }, null, 1));
console.log('\n=== rendered (NOT sent to Telegram) ===');
console.log(formatAccuracyDigest(d));