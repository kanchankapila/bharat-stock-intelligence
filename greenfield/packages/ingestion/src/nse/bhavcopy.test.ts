// Task 2.1 Verify: "contract tests against saved fixture payloads covering --
// a normal trading day; a padded-header file; a file containing GS/GB series
// that must be excluded; a row with '-' in a numeric column; a row with
// CLOSE_PRICE of 0; an HTML error page returned with status 200." All
// fixtures under __fixtures__/ are in the REAL live-verified column format
// (captured 2026-08-13 against the actual archive).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { expect, test } from 'vitest';
import { categorizeRejectReason, parseBhavcopy, parseNseDate } from './bhavcopy.js';

const FIXTURES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '__fixtures__');
function fixture(name: string): string {
  return readFileSync(path.join(FIXTURES_DIR, name), 'utf8');
}

test('parseNseDate parses the real %d-%b-%Y format without using Date()', () => {
  expect(parseNseDate('12-Aug-2026')).toBe('2026-08-12');
  expect(parseNseDate('01-Jan-2021')).toBe('2021-01-01');
});

test('parseNseDate rejects a malformed date as null, not an exception', () => {
  expect(parseNseDate('not-a-date')).toBeNull();
  expect(parseNseDate('')).toBeNull();
});

test('normal trading day: real EQ/BE/BZ/SM/ST rows accepted, GS/GB rejected as series-excluded (not silently dropped)', () => {
  const result = parseBhavcopy(fixture('normal-day.csv'));
  // 9 data rows total: GS + GB are out-of-scope series -- rejected with a
  // 'series-excluded:' reason, not a defect, but still counted (Acceptance
  // Gate 2 requires rowsSeen == rowsAccepted + rowsRejected for every run).
  expect(result.accepted).toHaveLength(7);
  expect(result.rejected).toHaveLength(2);
  expect(result.rejected.every((r) => r.reason.startsWith('series-excluded:'))).toBe(true);
  const symbols = result.accepted.map((r) => r.marketBar.symbol).sort();
  expect(symbols).not.toContain('1018GS2026'); // GS
  expect(symbols).not.toContain('NIFTY50GS'); // GB
  expect(symbols).toContain('RELIANCE'); // BE
  expect(symbols).toContain('IDEA'); // BZ
});

test('padded headers (" SERIES", " DATE1", ...) are stripped -- same fixture proves it, since real NSE files are always padded', () => {
  const result = parseBhavcopy(fixture('normal-day.csv'));
  const reliance = result.accepted.find((r) => r.marketBar.symbol === 'RELIANCE');
  expect(reliance?.marketBar.sessionDate).toBe('2026-08-12');
  expect(reliance?.marketBar.close).toBe(2995);
});

test('TURNOVER_LACS is converted to rupees (x100000), not left as lakhs', () => {
  const result = parseBhavcopy(fixture('normal-day.csv'));
  const twentyMicrons = result.accepted.find((r) => r.marketBar.symbol === '20MICRONS');
  expect(twentyMicrons?.marketBar.turnover).toBe(197.84 * 100_000);
});

test('a row with "-" sentinel values maps them to null, never to 0', () => {
  const result = parseBhavcopy(fixture('dash-value.csv'));
  expect(result.accepted).toHaveLength(1);
  const row = result.accepted[0]!;
  expect(row.marketBar.open).toBeNull();
  expect(row.marketBar.high).toBeNull();
  expect(row.marketBar.vwap).toBeNull();
  expect(row.delivery.deliveryQty).toBeNull();
  expect(row.delivery.deliveryPct).toBeNull();
  // CLOSE_PRICE was a real 50.00, not a sentinel -- still accepted.
  expect(row.marketBar.close).toBe(50);
});

test('CLOSE_PRICE of exactly 0 is rejected, with a reason -- never coerced', () => {
  const result = parseBhavcopy(fixture('zero-close.csv'));
  expect(result.accepted).toHaveLength(0);
  expect(result.rejected).toHaveLength(1);
  expect(result.rejected[0]!.reason).toMatch(/CLOSE_PRICE/);
});

test('an HTML error page returned with status 200 is rejected as one malformed payload, not walked as 200 data rows', () => {
  const result = parseBhavcopy(fixture('html-error-200.html'));
  expect(result.accepted).toHaveLength(0);
  expect(result.rejected).toHaveLength(1);
  expect(result.rejected[0]!.reason).toMatch(/HTML error page/);
});

test('rowsSeen == rowsAccepted + rowsRejected holds over ALL data lines, including series-excluded ones', () => {
  const result = parseBhavcopy(fixture('normal-day.csv'));
  const totalDataLines = 9; // every non-header line in the fixture
  expect(result.accepted.length + result.rejected.length).toBe(totalDataLines);
});

test('categorizeRejectReason maps each real reason string to a stable category', () => {
  expect(categorizeRejectReason("series-excluded: 'GS' not in equity allowlist")).toBe('series-excluded');
  expect(categorizeRejectReason('empty SYMBOL or SERIES')).toBe('empty-symbol-or-series');
  expect(categorizeRejectReason("symbol 'bad!' fails ^[A-Z0-9&$-]{1,20}$")).toBe('invalid-symbol-format');
  expect(categorizeRejectReason("unparseable DATE1 'garbage'")).toBe('unparseable-date');
  expect(categorizeRejectReason("CLOSE_PRICE missing or <= 0 ('0')")).toBe('invalid-close-price');
  expect(categorizeRejectReason('something entirely unexpected')).toBe('other');
});
