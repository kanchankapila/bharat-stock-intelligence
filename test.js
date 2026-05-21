const endpoints = [
  'getMarketOverview',
  'getOptionsIntelligence',
  'getGlobalMarketData',
  'getAllIndices',
  'getInstitutionalFlows',
  'getTechnicalTrends?input=' + encodeURIComponent(JSON.stringify({"type":"bullish"})),
  'getTrendlyneFnoScanners?input=' + encodeURIComponent(JSON.stringify({"mtype":"futures","screenType":"most-active-contract","instType":"index"}))
];

async function checkEndpoints() {
  const results = {};
  for (const ep of endpoints) {
    try {
      const url = `http://127.0.0.1:3000/api/trpc/${ep}`;
      const r = await fetch(url);
      if (!r.ok) {
        results[ep] = `HTTP ${r.status}`;
        continue;
      }
      const data = await r.json();
      if (data.error) {
        results[ep] = `Error: ${data.error.message || JSON.stringify(data.error)}`;
      } else if (data.result?.data?.json) {
        const payload = data.result.data.json;
        const size = JSON.stringify(payload).length;
        results[ep] = `Success (${size} bytes of data)`;
      } else {
        results[ep] = `Success (No data returned)`;
      }
    } catch (e) {
      results[ep] = `Failed: ${e.message}`;
    }
  }
  console.log(JSON.stringify(results, null, 2));
}

checkEndpoints();
