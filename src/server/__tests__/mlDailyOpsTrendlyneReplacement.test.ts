import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// AF-20261120-01: trendlyne_fno_activity_fetcher.py and trendlyne_market_insight_fetcher.py were refused with
// HTTP 405 every night from 2026-11-18 and failed ml-daily-ops, for two tables nothing reads. The exchange's own
// screens replace them: nse_fo_activity_fetcher.py and nse_corporate_announcements_fetcher.py.
const src = readFileSync(join(__dirname, '..', 'queues.ts'), 'utf8').replace(/\r\n/g, '\n');

describe('ml-daily-ops: Trendlyne F&O activity / market insight replaced by NSE', () => {
  it('no longer runs the two refused Trendlyne steps', () => {
    expect(src).not.toMatch(/runPython\('trendlyne_fno_activity_fetcher\.py'/);
    expect(src).not.toMatch(/runPython\('trendlyne_market_insight_fetcher\.py'/);
  });

  it('runs both NSE replacements with an explicit budget', () => {
    for (const script of ['nse_fo_activity_fetcher.py', 'nse_corporate_announcements_fetcher.py']) {
      const call = src.match(new RegExp(`runPython\\('${script.replace('.', '\\.')}',\\s*\\[[^\\]]*\\],\\s*([^)]+)\\)`));
      expect(call, `${script} is not scheduled with a timeout`).not.toBeNull();
    }
  });
});
