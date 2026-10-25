/** Production-data browser checks: no intercepted responses and no database writes. */
import { chromium } from 'playwright';
const base = process.env.V7_VERIFY_URL ?? 'http://localhost:3000';
const browser = await chromium.launch({ headless: true });
const errors = [];
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
page.on('pageerror', e => errors.push(e.message));
page.on('console', message => { if (message.type() === 'error') errors.push(message.text().slice(0, 400)); });
page.on('response', r => { if (r.url().includes('/api/trpc/') && r.status() >= 400) errors.push(`API ${r.status()}: ${new URL(r.url()).pathname}`); });
async function readApi(name, input) {
  const query = new URLSearchParams({ batch: '1', input: JSON.stringify({ 0: { json: input ?? null } }) });
  const response = await fetch(`${base}/api/trpc/${name}?${query}`, { signal: AbortSignal.timeout(20000) });
  const result = (await response.json())[0];
  if (!response.ok || result.error || !result.result) throw new Error(`${name}: API request failed (${response.status})`);
  return result.result.data.json;
}
const reports = [];
let production = null;
try {
  const [canonical, pulse, candles] = await Promise.all([
    readApi('getUnifiedScoreForSymbol', { symbol: 'TCS' }), readApi('getMarketPulse'),
    readApi('getOHLCData', { symbol: 'TCS', dur: '6M' }),
  ]);
  if (!canonical || canonical.unified_score == null) throw new Error('Production canonical TCS row is missing; cannot validate with empty data');
  if (!canonical.generated_at) errors.push('Canonical reader omits actual generation timestamp');
  production = { symbol: canonical.symbol, score: canonical.unified_score, classification: canonical.classification,
    session: canonical.computed_at, generatedAt: canonical.generated_at ?? null, flows: pulse.fiiDii,
    ohlcBars: candles?.data?.length ?? 0 };
  const targets = [
    ['/v7-dashboard', 'Market Dashboard'], ['/v7-top-picks', 'Top Picks'],
    ['/v7-screener', 'Quant Screener'], ['/v7-signals', 'Signals & Tracking'], ['/v7-stock/TCS', 'TCS'],
  ];
  for (const [path, heading] of targets.filter(([path]) => !process.argv.includes('--stock-only') || path === '/v7-stock/TCS')) {
    await page.goto(base + path, { waitUntil: 'domcontentloaded' });
    await page.getByRole('heading', { level: 1 }).filter({ hasText: heading }).waitFor({ timeout: 30000 });
    if (path === '/v7-stock/TCS') {
      const canonicalCard = page.locator('.v7-kpi-card').filter({ has: page.getByText('Unified Score', { exact: true }) });
      await canonicalCard.getByText(Number(canonical.unified_score).toFixed(1), { exact: true }).waitFor({ timeout: 30000 });
      if (production.ohlcBars > 0) await page.locator('canvas').first().waitFor({ timeout: 10000 });
    }
    reports.push({ path, heading: await page.locator('h1').innerText(), shells: await page.locator('.v7-shell').count() });
    if (reports.at(-1).shells !== 1) errors.push(`${path}: expected exactly one v7 shell`);
    if (path === '/v7-dashboard' && pulse.fiiDii?.fii_net != null) {
      const expected = pulse.fiiDii.fii_net > 0 ? 'FII INFLOW' : pulse.fiiDii.fii_net < 0 ? 'FII OUTFLOW' : 'FII FLAT';
      await page.getByText(expected, { exact: true }).waitFor({ timeout: 30000 });
    }
    if (path === '/v7-top-picks') {
      const sort = page.getByRole('button', { name: 'Symbol', exact: true });
      await sort.waitFor({ timeout: 30000 });
      await sort.focus(); await sort.press('Enter');
      if (await sort.locator('xpath=ancestor::th').getAttribute('aria-sort') !== 'ascending') errors.push('Keyboard sorting did not update aria-sort');
    }
    for (const width of [390, 768, 1400]) {
      await page.setViewportSize({ width, height: 900 });
      if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1)) errors.push(`${path}: document overflow at ${width}px`);
    }
  }
} catch (error) { errors.push(error.message); }
finally { await browser.close(); }
console.log(JSON.stringify({ mode: 'production data, read-only', production, reports, errors }, null, 2));
if (errors.length) process.exitCode = 1;
