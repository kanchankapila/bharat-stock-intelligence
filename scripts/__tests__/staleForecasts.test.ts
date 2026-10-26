import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { findStaleForecasts } from '../staleForecasts.mjs';

// AF-20261026-47. The date is PINNED: a test that read today's clock would go red on its own some
// future morning with no change, which is a flaky test, not a guard. The live check runs in
// `npm run doc:numbers:check` against the real date.
const TODAY = '2026-10-26';

describe('stale forecasts in rule files', () => {
  it('flags an elapsed ~DATE forecast with no outcome on its line', () => {
    const t = 'Still under the 20-date floor; clears ~2026-09-29/10-06 -- re-run then.';
    expect(findStaleForecasts(t, TODAY)).toEqual([expect.objectContaining({ line: 1, date: '2026-09-29' })]);
  });

  it('accepts the same forecast once its outcome is written back on the line', () => {
    const t = 'clears ~2026-09-29/10-06 (ELAPSED 2026-10-26: not re-graded since 2026-09-11)';
    expect(findStaleForecasts(t, TODAY)).toEqual([]);
  });

  it('does not flag a future forecast, or a month-only forecast before that month ends', () => {
    expect(findStaleForecasts('verdict cannot exist before ~2027-08.', TODAY)).toEqual([]);
    expect(findStaleForecasts('~20 dates are needed, so ~2026-10.', TODAY)).toEqual([]);
    expect(findStaleForecasts('~20 dates are needed, so ~2026-10.', '2026-11-01')).toHaveLength(1);
  });

  it('does not flag a historical date written without the forecast marker', () => {
    expect(findStaleForecasts('the other 35 start around 2026-06-30.', TODAY)).toEqual([]);
    expect(findStaleForecasts('Until 2026-09-10 that table stored scaled values.', TODAY)).toEqual([]);
  });

  it('measurement.md had no unresolved elapsed forecast as of the pinned date', () => {
    // Non-vacuity: the file really does contain ~DATE forecasts, so an empty result is a verdict.
    const md = readFileSync('.claude/rules/measurement.md', 'utf8');
    expect((md.match(/~\*{0,2}20\d\d-\d\d/g) ?? []).length).toBeGreaterThan(3);
    expect(findStaleForecasts(md, TODAY)).toEqual([]);
  });
});
