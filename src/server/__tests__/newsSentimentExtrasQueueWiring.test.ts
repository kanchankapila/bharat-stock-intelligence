import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Wiring test for the 2026-08-13 NSE RSS + MC earnings/deals news additions.
 *
 * Source-scans queues.ts rather than booting the real queue (which needs a live Redis
 * connection) -- same approach as corporateActionsIngestWiring.test.ts /
 * nseSyncSectorBackfillWiring.test.ts. Checks each of the 6 new job registrations (4 base +
 * 2 results-season hot passes) actually reaches its handler, not just that the addJobWithCatchup
 * call exists -- a job registered but never matched in the Worker's job.name dispatch chain
 * would silently fall through to the default runNewsSentimentCycle() branch and never run its
 * own logic, with no error anywhere.
 */
const SOURCE = readFileSync(join(__dirname, '..', 'queues.ts'), 'utf8');

const BASE_JOBS = [
  { jobName: 'nse-announcements-refresh', handler: 'runNseAnnouncementsCycle', everyMs: 15 * 60 * 1000 },
  { jobName: 'nse-financial-results-refresh', handler: 'runNseFinancialResultsCycle', everyMs: 60 * 60 * 1000 },
  { jobName: 'mc-earnings-news-refresh', handler: 'runMcEarningsNewsCycle', everyMs: 60 * 60 * 1000 },
  { jobName: 'mc-deals-news-refresh', handler: 'runMcDealsNewsCycle', everyMs: 15 * 60 * 1000 },
];

const HOT_JOBS = [
  { jobName: 'nse-financial-results-refresh-hot', handler: 'runNseFinancialResultsCycle' },
  { jobName: 'mc-earnings-news-refresh-hot', handler: 'runMcEarningsNewsCycle' },
];

describe('news-sentiment extras (NSE RSS + MC earnings/deals) queue wiring', () => {
  for (const { jobName, handler, everyMs } of BASE_JOBS) {
    it(`${jobName} is registered on newsSentimentQueue and reaches ${handler}()`, () => {
      expect(SOURCE).toMatch(new RegExp(`addJobWithCatchup\\(\\s*newsSentimentQueue,\\s*\\n\\s*'${jobName}'`));
      const dispatchMatch = SOURCE.match(
        new RegExp(`job\\.name === '${jobName}'\\) \\{\\s*\\n\\s*await svc\\.${handler}\\(\\);`)
      );
      expect(dispatchMatch, `${jobName} must dispatch to svc.${handler}()`).not.toBeNull();
    });

    it(`${jobName}'s repeat.every matches its documented cadence`, () => {
      const regMatch = SOURCE.match(new RegExp(`'${jobName}'[\\s\\S]{0,200}?every: ([\\d\\s*]+)[,}]`));
      expect(regMatch).not.toBeNull();
      // eslint-disable-next-line no-eval
      const actualEveryMs = eval(regMatch![1].trim());
      expect(actualEveryMs).toBe(everyMs);
    });
  }

  for (const { jobName, handler } of HOT_JOBS) {
    it(`${jobName} gates on isResultsSeasonActive() before calling ${handler}()`, () => {
      const idx = SOURCE.indexOf(`job.name === '${jobName}'`);
      expect(idx, `${jobName} dispatch branch must exist`).toBeGreaterThan(-1);
      const block = SOURCE.slice(idx, idx + 400);
      expect(block).toMatch(/isResultsSeasonActive\(\)/);
      expect(block).toMatch(new RegExp(`svc\\.${handler}\\(\\)`));
      // The gate must return/skip BEFORE the handler call, not after.
      expect(block.indexOf('isResultsSeasonActive()')).toBeLessThan(block.indexOf(`svc.${handler}()`));
    });

    it(`${jobName} is offset 30 min from its base hourly job (effective ~30-min cadence together, same as BSE's hot pass)`, () => {
      const regMatch = SOURCE.match(new RegExp(`'${jobName}'[\\s\\S]{0,200}?offset: ([\\d\\s*]+)[,\\s}]`));
      expect(regMatch).not.toBeNull();
      // eslint-disable-next-line no-eval
      const offsetMs = eval(regMatch![1].trim());
      expect(offsetMs).toBe(30 * 60 * 1000);
    });
  }

  it('no two of the 6 new repeatable jobIds collide with each other or with bse-announcements-hot', () => {
    const ids = [...SOURCE.matchAll(/jobId: '([a-z0-9-]+)'/g)].map(m => m[1]);
    const newIds = ids.filter(id =>
      id.startsWith('nse-announcements') || id.startsWith('nse-financial-results')
      || id.startsWith('mc-earnings-news') || id.startsWith('mc-deals-news'));
    expect(newIds.length).toBe(6); // 4 base + 2 hot
    expect(new Set(newIds).size).toBe(newIds.length); // all unique
  });
});
