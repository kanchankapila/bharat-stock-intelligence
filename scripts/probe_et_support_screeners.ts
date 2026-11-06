import 'dotenv/config';
import { getEtMarketstatsScreenerDefs, fetchEtMarketstatsScreener, getFieldValue } from '../src/server/etMarketstats';
import { closePool } from '../src/server/pgClient';

try {
  const defs = (await getEtMarketstatsScreenerDefs()).filter(d => /^Negative Breakout.*Support$/i.test(d.label));
  for (const def of defs) {
    for (const operationType of [def.operationType, 'Below']) {
      const response = await fetchEtMarketstatsScreener({ ...def, operationType }, 5);
      const rows = response.dataList.map(r => ({
        symbol: r.assetSymbol, price: getFieldValue(r, 'lastTradedPrice'),
        support: getFieldValue(r, def.secondOperand!),
      }));
      console.log(JSON.stringify({ label: def.label, operationType, rows }));
    }
  }
} finally {
  await closePool();
}
