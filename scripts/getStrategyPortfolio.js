const { createTRPCProxyClient, httpBatchLink } = require('@trpc/client');

const strategy = process.argv[2] || 'composite';
const limit = parseInt(process.argv[3] || '20', 10);
const riskModel = process.argv[4] || 'risk_parity';

async function main() {
  const fetchImpl = createTRCPCliFetch();
  const client = createTRPCProxyClient({ links: [httpBatchLink({ url: 'http://localhost:3000/api/trpc', fetch: fetchImpl })] });
  try {
    const res = await client.scoring.getStrategyPortfolio.query({ strategy, limit, riskModel });
    console.log(JSON.stringify(res, null, 2));
  } catch (err) {
    console.error('Error calling getStrategyPortfolio:', err);
    process.exit(1);
  }
}

function createTRCPCliFetch() {
  if (typeof fetch === 'undefined') {
    // Node <18 fallback
    try {
      return require('node-fetch');
    } catch (e) {
      throw new Error('Global fetch not available; please run with Node 18+ or install node-fetch');
    }
  }
  return fetch;
}

// end of file

// actually call main
main();
