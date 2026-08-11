import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import { Server } from 'http';

/**
 * LIVE DATASOURCE TEST — skipped by default, opt in with RUN_LIVE_DATASOURCE_TESTS=1.
 *
 * All 28 cases below boot a local proxy and fetch MoneyControl's real API through it, so the
 * suite's result depends on a third party being healthy. On 2026-08-11 this failed `npm test`
 * and CI because /mcapi/v1/premarket/get-global-marketdata started returning 400/422 upstream
 * — nothing in this repo had changed. A test suite that fails on someone else's outage stops
 * being a signal, and the pressure is then to ignore red CI rather than fix it.
 *
 * Deliberately the SAME env var as the Python side's `@pytest.mark.live_datasource`
 * (src/server/tests/conftest.py) rather than a second TypeScript-only flag: one switch runs
 * every live-datasource check in the repo, in both languages.
 *
 *   RUN_LIVE_DATASOURCE_TESTS=1 npx vitest run src/server/__tests__/mcapiProxy.test.ts
 *
 * This is a gate, not a deletion — the test is the only thing that catches the proxy's path
 * rewrites drifting from MoneyControl's real routes, so run it by hand before touching them.
 */
const RUN_LIVE = process.env.RUN_LIVE_DATASOURCE_TESTS === '1';

describe.runIf(RUN_LIVE)('MoneyControl API Proxy Integration Tests [live]', () => {
  let app: express.Express;
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    app = express();
    app.use(express.json());

    // Register the exact same proxy middleware as in server.ts
    app.all('/mcapi/*', async (req, res) => {
      try {
        let path = req.originalUrl;

        // Normalize common variants of endpoints in the user request
        // 1. Fundamentals/Get Indices Details
        if (path.includes('/indices/fundamentals/get-indices-details')) {
          path = path.replace('/indices/fundamentals/get-indices-details', '/indices/get-indices-details');
        }
        
        // 2. Financial Historical Overview
        if (path.includes('/financial-historical/overview') && !path.includes('/stock/financial-historical/overview')) {
          path = path.replace('/financial-historical/overview', '/stock/financial-historical/overview');
        }

        // 3. Earning / Price / Consensus / Valuation Forecasts
        if (path.includes('/earning-forecast') && !path.includes('/stock/estimates/earning-forecast')) {
          path = path.replace('/earning-forecast', '/stock/estimates/earning-forecast');
        }
        if (path.includes('/price-forecast') && !path.includes('/stock/estimates/price-forecast')) {
          path = path.replace('/price-forecast', '/stock/estimates/price-forecast');
        }
        if (path.includes('/consensus') && !path.includes('/stock/estimates/consensus')) {
          path = path.replace('/consensus', '/stock/estimates/consensus');
        }
        if (path.includes('/valuation') && !path.includes('/stock/estimates/valuation')) {
          path = path.replace('/valuation', '/stock/estimates/valuation');
        }

        // 4. SWOT and essentials/insights
        if (path.includes('/mcapi/v1/mc-insights')) {
          path = path.replace('/mcapi/v1/mc-insights', '/mcapi/v1/extdata/mc-insights');
        }
        if (path.includes('/mcapi/v1/mc-essentials')) {
          path = path.replace('/mcapi/v1/mc-essentials', '/mcapi/v1/extdata/mc-essentials');
        }

        // 5. Normalize v1/stock/extdata/v2/ -> extdata/v2/ (newer, more stable API)
        if (path.includes('/mcapi/v1/stock/extdata/v2/')) {
          path = path.replace('/mcapi/v1/stock/extdata/v2/', '/mcapi/extdata/v2/');
        }

        // 6. Normalize mc-insights 422 error by rewriting /mcapi/v1/extdata/mc-insights with deviceType/appVersion to v2
        // (MoneyControl's v1 insights endpoint returns 422 if deviceType/appVersion query params are present, but v2 supports them)
        if (path.includes('/mcapi/v1/extdata/mc-insights') && (path.includes('deviceType') || path.includes('appVersion'))) {
          path = path.replace('/mcapi/v1/extdata/mc-insights', '/mcapi/extdata/v2/mc-insights');
        }

        const targetUrl = `https://api.moneycontrol.com${path}`;
        
        const response = await fetch(targetUrl, {
          method: req.method,
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': 'application/json, text/plain, */*',
            'Referer': 'https://www.moneycontrol.com/'
          },
          signal: AbortSignal.timeout(15000)
        });

        if (!response.ok) {
          res.status(response.status).send(await response.text());
          return;
        }

        const contentType = response.headers.get('content-type') || '';
        res.setHeader('Content-Type', contentType);
        
        if (contentType.includes('application/json')) {
          const json = await response.json();
          res.json(json);
        } else {
          const text = await response.text();
          res.send(text);
        }
      } catch (error: any) {
        console.error(`Error proxying to MoneyControl API: ${req.originalUrl}`, error);
        res.status(500).json({ error: error?.message || 'Failed to fetch from MoneyControl API' });
      }
    });

    // Start on ephemeral port
    server = await new Promise((resolve) => {
      const s = app.listen(0, () => resolve(s));
    });
    const addr = server.address();
    const port = typeof addr === 'string' ? 0 : addr?.port;
    baseUrl = `http://localhost:${port}`;
  });

  afterAll(() => {
    if (server) {
      server.close();
    }
  });

  const testEndpoint = async (urlPath: string) => {
    const fullUrl = `${baseUrl}${urlPath}`;
    console.log(`Testing: ${urlPath}`);
    const res = await fetch(fullUrl);
    expect(res.status).toBe(200);
    const contentType = res.headers.get('content-type') || '';
    expect(contentType).toContain('application/json');
    const json = await res.json();
    expect(json).toBeDefined();
    return json;
  };

  it('/mcapi/v1/indices/fundamentals/graph/pe works', async () => {
    const data = await testEndpoint('/mcapi/v1/indices/fundamentals/graph/pe?indId=9&duration=1Y');
    expect(data.success === 1 || data.code === '200' || data.graph).toBeDefined();
  });

  it('/mcapi/v1/indices/fundamentals/graph/pb works', async () => {
    const data = await testEndpoint('/mcapi/v1/indices/fundamentals/graph/pb?indId=9&duration=1Y');
    expect(data.success === 1 || data.code === '200' || data.graph).toBeDefined();
  });

  it('/mcapi/v1/indices/fundamentals/overview works', async () => {
    const data = await testEndpoint('/mcapi/v1/indices/fundamentals/overview?indId=9');
    expect(data.success === 1 || data.code === '200' || data.data).toBeDefined();
  });

  it('/mcapi/v1/indices/fundamentals/get-indices-details works (rewritten to /indices/get-indices-details)', async () => {
    const data = await testEndpoint('/mcapi/v1/indices/fundamentals/get-indices-details?indexId=9');
    expect(data.success === 1 || data.code === '200' || data.data).toBeDefined();
  });

  it('/mcapi/v1/sector/performance works', async () => {
    const data = await testEndpoint('/mcapi/v1/sector/performance?dur=1d&type=top&section=sector');
    expect(data.success === 1 || data.code === '200' || data.data).toBeDefined();
  });

  it('/mcapi/v1/premarket/get-global-marketdata works', async () => {
    const data = await testEndpoint('/mcapi/v1/premarket/get-global-marketdata?section=mi');
    expect(data.success === 1 || data.code === '200' || data.data).toBeDefined();
  });

  it('/mcapi/v1/stock/get-stock-price works', async () => {
    const data = await testEndpoint('/mcapi/v1/stock/get-stock-price?scIdList=HDF01&scId=HDF01');
    expect(data.success === 1 || data.code === '200' || data.data).toBeDefined();
  });

  it('/mcapi/v1/financial-historical/overview works (rewritten to /stock/financial-historical/overview)', async () => {
    const data = await testEndpoint('/mcapi/v1/financial-historical/overview?scId=HDF01&ex=N');
    expect(data.success === 1 || data.code === '200' || data.data).toBeDefined();
  });

  it('/mcapi/v1/stock/estimates/analyst-rating works', async () => {
    const data = await testEndpoint('/mcapi/v1/stock/estimates/analyst-rating?deviceType=W&scId=HDF01&ex=N');
    expect(data.success === 1 || data.code === '200' || data.data).toBeDefined();
  });

  it('/mcapi/v1/earning-forecast works (rewritten to /stock/estimates/earning-forecast)', async () => {
    const data = await testEndpoint('/mcapi/v1/earning-forecast?scId=HDF01&ex=N&deviceType=W&frequency=12&financialType=C');
    expect(data.success === 1 || data.code === '200' || data.data).toBeDefined();
  });

  it('/mcapi/v1/price-forecast works (rewritten to /stock/estimates/price-forecast)', async () => {
    const data = await testEndpoint('/mcapi/v1/price-forecast?scId=HDF01&ex=N&deviceType=W');
    expect(data.success === 1 || data.code === '200' || data.data).toBeDefined();
  });

  it('/mcapi/v1/consensus works (rewritten to /stock/estimates/consensus)', async () => {
    const data = await testEndpoint('/mcapi/v1/consensus?scId=HDF01&ex=N&deviceType=W');
    expect(data.success === 1 || data.code === '200' || data.data).toBeDefined();
  });

  it('/mcapi/v1/valuation works (rewritten to /stock/estimates/valuation)', async () => {
    const data = await testEndpoint('/mcapi/v1/valuation?deviceType=W&scId=HDF01&ex=N&financialType=C');
    expect(data.success === 1 || data.code === '200' || data.data).toBeDefined();
  });

  it('/mcapi/v1/stock/extdata/v2/mc-essentials works', async () => {
    const data = await testEndpoint('/mcapi/v1/stock/extdata/v2/mc-essentials?scId=HDF01&type=ed&deviceType=W');
    expect(data.success === 1 || data.code === '200' || data.data).toBeDefined();
  });

  it('/mcapi/v1/mc-insights works (rewritten to /extdata/mc-insights)', async () => {
    const data = await testEndpoint('/mcapi/v1/mc-insights?scId=HDF01&type=c&deviceType=W&appVersion=185');
    expect(data.success === 1 || data.code === '200' || data.data).toBeDefined();
  });

  it('/mcapi/v1/swot/details works', async () => {
    const data = await testEndpoint('/mcapi/v1/swot/details?scId=HDF01&type=all');
    expect(data.success === 1 || data.code === '200' || data.data).toBeDefined();
  });

  it('/mcapi/v1/extdata/mc-essentials works', async () => {
    const data = await testEndpoint('/mcapi/v1/extdata/mc-essentials?scId=HDF01&type=ed');
    expect(data.success === 1 || data.code === '200' || data.data).toBeDefined();
  });

  it('/mcapi/v1/extdata/mc-insights works', async () => {
    const data = await testEndpoint('/mcapi/v1/extdata/mc-insights?scId=HDF01&type=c');
    expect(data.success === 1 || data.code === '200' || data.data).toBeDefined();
  });

  it('/mcapi/v1/ecalendar/corporate-action works', async () => {
    const data = await testEndpoint('/mcapi/v1/ecalendar/corporate-action?indexId=All&page=1&event=All&apiVersion=161&orderBy=asc&deviceType=W&duration=UP');
    expect(data.success === 1 || data.code === '200' || data.data).toBeDefined();
  });

  it('/mcapi/v1/earnings/get-earnings-data works', async () => {
    const data = await testEndpoint('/mcapi/v1/earnings/get-earnings-data?indexId=All&page=1&startDate=2026-06-01&endDate=2026-06-30&sector=&limit=10');
    expect(data.success === 1 || data.code === '200' || data.data).toBeDefined();
  });

  it('/mcapi/v1/deals/list works', async () => {
    const data = await testEndpoint('/mcapi/v1/deals/list?start=0&limit=10&orderBy=deal_date&sortBy=DESC&deviceType=W');
    expect(data.success === 1 || data.code === '200' || data.data).toBeDefined();
  });

  it('/mcapi/v1/deals/insight works', async () => {
    const data = await testEndpoint('/mcapi/v1/deals/insight?start=0&limit=10&value=value&range=1W&action=buy&dealsType=topDeal');
    expect(data.success === 1 || data.code === '200' || data.data).toBeDefined();
  });

  it('/mcapi/v1/fno/futures/getExpDts works', async () => {
    const data = await testEndpoint('/mcapi/v1/fno/futures/getExpDts?id=HDF01');
    expect(data.success === 1 || data.code === '200' || data.data).toBeDefined();
  });

  it('/mcapi/v1/fno/options/getOptionsData works', async () => {
    // Resolve expiry date dynamically from getExpDts
    const datesRes = await testEndpoint('/mcapi/v1/fno/futures/getExpDts?id=HDF01');
    let expiry = '2026-06-30';
    if (datesRes?.success === 1 && datesRes?.data) {
      if (Array.isArray(datesRes.data) && datesRes.data.length > 0) {
        expiry = datesRes.data[0].fno_exp || datesRes.data[0];
      } else if (datesRes.data["0"]) {
        expiry = datesRes.data["0"].fno_exp || datesRes.data["0"];
      }
    }
    
    // Resolve valid strike price dynamically from getStrikePrice
    const strikesRes = await testEndpoint(`/mcapi/v1/fno/options/getStrikePrice?id=HDF01&expirydate=${expiry}&optiontype=CE`);
    let strike = '700.00';
    const strikesList = Array.isArray(strikesRes?.data) ? strikesRes.data : Object.values(strikesRes?.data || {});
    if (strikesList.length > 0) {
      const firstStrike = strikesList[0];
      strike = typeof firstStrike === 'string' ? firstStrike : (firstStrike?.strikeprice || firstStrike?.value || '700.00');
    }

    const data = await testEndpoint(`/mcapi/v1/fno/options/getOptionsData?opt=OPTSTK&id=HDF01&expirydate=${expiry}&optiontype=CE&strikeprice=${strike}`);
    expect(data.success === 1 || data.code === '200' || data.data).toBeDefined();
  });

  it('/mcapi/v1/proscanner/scanner-detail works', async () => {
    const data = await testEndpoint('/mcapi/v1/proscanner/scanner-detail?catId=1&scanId=1');
    expect(data.success === 1 || data.code === '200' || data.data).toBeDefined();
  });

  it('/mcapi/v1/technical-trends works', async () => {
    const data = await testEndpoint('/mcapi/v1/technical-trends/uptrend/bullish?ex=N&index=9&page=1&order=desc&deviceType=W&sort=performance&appVersion=142');
    expect(data.success === 1 || data.code === '200' || data.data).toBeDefined();
  });

  it('/mcapi/v1/techscanner/scanner-detail works', async () => {
    const data = await testEndpoint('/mcapi/v1/techscanner/scanner-detail?catId=1&scanId=1');
    expect(data.success === 1 || data.code === '200' || data.data).toBeDefined();
  });

  it('/mcapi/v1/indices/chart/exchange-advdec works', async () => {
    const data = await testEndpoint('/mcapi/v1/indices/chart/exchange-advdec?ex=N');
    expect(data.success === 1 || data.code === '200' || data.data || data.chartData).toBeDefined();
  });
});
