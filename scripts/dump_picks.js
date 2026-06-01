const { createTRPCProxyClient, httpBatchLink } = require('@trpc/client');
const fs = require('fs');

const strategy = process.argv[2] || 'composite';
const limit = parseInt(process.argv[3] || '20', 10);
const riskModel = process.argv[4] || 'risk_parity';
const out = process.argv[5] || 'picks.json';

async function main() {
  // Try HTTP endpoint first
  const url = 'http://localhost:3000/api/export-picks';
  try {
    const resp = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ strategy, limit, riskModel }) });
    if (resp.ok) {
      const j = await resp.json();
      if (j.success) {
        fs.writeFileSync(out, JSON.stringify(j.picks, null, 2));
        console.log('Wrote', out);
        return;
      }
      console.error('Server returned error:', j.error);
    } else {
      console.warn('HTTP export endpoint not available (status ' + resp.status + ')');
    }
  } catch (e) {
    console.warn('HTTP export failed, falling back to direct TRPC client');
  }

  // Fallback: call tRPC directly
  try {
    const fetchImpl = (typeof fetch === 'undefined') ? require('node-fetch') : fetch;
    const client = createTRPCProxyClient({ links: [httpBatchLink({ url: 'http://localhost:3000/api/trpc', fetch: fetchImpl })] });
    const j = await client.scoring.getStrategyPortfolio.query({ strategy, limit, riskModel });
    fs.writeFileSync(out, JSON.stringify(j, null, 2));
    console.log('Wrote', out);
    return;
  } catch (e) {
    console.error('TRPC client fallback failed:', e.message || e);
  }

  console.error('Failed to obtain picks. Ensure server is running or call the script from the server host.');
  process.exit(1);
}

main();
