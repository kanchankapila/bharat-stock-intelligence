/**
 * Data-quality checks must filter DATE columns as dates, not through ::text.
 *
 * `date::text >= date('now','-10 days')` cannot use an index, and on a hypertable it defeats
 * chunk exclusion. The suite runs every 15 minutes (jobWatchdog). Measured 2026-09-11 on the
 * live stock_ohlcv freshness check: 1,220ms / 132k buffers / 42 chunks scanned as written,
 * 207ms / 3.6k buffers / 40 chunks excluded as `date >= current_date - 10`.
 * Every column these checks filter is a native DATE (verified against production and
 * db/schema.postgres.sql), so the ISO-string comparison and the date comparison are identical.
 */
import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';

describe('dataQualityChecks.ts date filters', () => {
  it('never casts a column to ::text to compare it against a relative date', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '..', 'dataQualityChecks.ts'), 'utf8');
    const offenders = src.split('\n')
      .map((line, i) => ({ line: line.trim(), n: i + 1 }))
      .filter(({ line }) => /\w+::text\s*>=\s*date\('now'/.test(line));
    expect(offenders).toEqual([]);
  });
});
