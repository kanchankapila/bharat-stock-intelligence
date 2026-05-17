import { runQuantScoring, getQuantScoreSummary } from '../src/server/quantScoringService';

console.log('[QUANT] Starting first-time scoring...');
const t = Date.now();
await runQuantScoring();
console.log('[QUANT] Done in', ((Date.now() - t) / 1000).toFixed(1) + 's');
console.log(JSON.stringify(getQuantScoreSummary(), null, 2));
