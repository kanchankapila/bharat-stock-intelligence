// NSE full bhavcopy adapter -- BUILD_STAGE_0_2_SPEC.md §2.1-2.3, Task 2.1.
// URL: https://archives.nseindia.com/products/content/sec_bhavdata_full_{DDMMYYYY}.csv
// VERIFIED live 2026-08-13: real headers are comma-space separated and padded
// (" SERIES", " DATE1", ...); the real file also carries an undocumented
// LAST_PRICE column between LOW_PRICE and CLOSE_PRICE -- parsing by header
// NAME (never position) makes that harmless.
//
// "The parser is the single implementation. Tests must call it." -- this
// file's exported parseBhavcopy is called directly by bhavcopy.test.ts
// against saved real-format fixtures, not reimplemented there.

const SERIES_ALLOWLIST = new Set(['EQ', 'BE', 'BZ', 'SM', 'ST']);
const SYMBOL_PATTERN = /^[A-Z0-9&$-]{1,20}$/;
const SENTINELS = new Set(['', '-', 'NA']);

const MONTHS: Record<string, string> = {
  Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06',
  Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12',
};

/** Pure string parsing -- deliberately NOT new Date(), which is forbidden
 * outside packages/market-calendar (eslint.config.js) and would also invite
 * timezone ambiguity for a plain calendar date. */
export function parseNseDate(raw: string): string | null {
  const m = /^(\d{2})-([A-Za-z]{3})-(\d{4})$/.exec(raw);
  if (!m) return null;
  const [, dd, mon, yyyy] = m;
  const mm = MONTHS[mon as keyof typeof MONTHS];
  if (!mm) return null;
  return `${yyyy}-${mm}-${dd}`;
}

function toNullableNumber(raw: string | undefined): number | null {
  if (raw === undefined || SENTINELS.has(raw)) return null;
  const n = Number(raw);
  // Reject, don't coerce: a genuinely malformed non-sentinel value becomes
  // NULL (unknown), never a fabricated 0.
  return Number.isFinite(n) ? n : null;
}

export interface BhavcopyMarketBarRow {
  symbol: string;
  sessionDate: string;
  prevClose: number | null;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number;
  vwap: number | null;
  volume: number | null;
  trades: number | null;
  /** Rupees, not lakhs -- TURNOVER_LACS x 100000 per §2.3. */
  turnover: number | null;
}

export interface BhavcopyDeliveryRow {
  symbol: string;
  sessionDate: string;
  deliveryQty: number | null;
  deliveryPct: number | null;
}

export interface BhavcopyParsedRow {
  marketBar: BhavcopyMarketBarRow;
  delivery: BhavcopyDeliveryRow;
}

export interface BhavcopyParseResult {
  accepted: BhavcopyParsedRow[];
  rejected: Array<{ raw: string; reason: string }>;
}

const REQUIRED_HEADER_MARKER = 'SYMBOL';

export function parseBhavcopy(csvText: string): BhavcopyParseResult {
  const lines = csvText.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length === 0) {
    return { accepted: [], rejected: [{ raw: '', reason: 'empty payload' }] };
  }

  const headerLine = lines[0]!;
  const headers = headerLine.split(',').map((h) => h.trim());
  if (!headers.includes(REQUIRED_HEADER_MARKER)) {
    // HTTP 200 is not success -- an HTML error page returned with status 200
    // must not be silently walked as though every line were a data row.
    return {
      accepted: [],
      rejected: [{
        raw: csvText.slice(0, 200),
        reason: `header row does not contain '${REQUIRED_HEADER_MARKER}' -- payload is likely an HTML error page, not a CSV`,
      }],
    };
  }

  const accepted: BhavcopyParsedRow[] = [];
  const rejected: Array<{ raw: string; reason: string }> = [];

  for (const line of lines.slice(1)) {
    const values = line.split(',').map((v) => v.trim());
    const record: Record<string, string> = {};
    headers.forEach((h, i) => {
      record[h] = values[i] ?? '';
    });

    const symbol = record.SYMBOL ?? '';
    const series = record.SERIES ?? '';

    if (!symbol || !series) {
      rejected.push({ raw: line, reason: 'empty SYMBOL or SERIES' });
      continue;
    }
    if (!SERIES_ALLOWLIST.has(series)) {
      // Deliberate exclusion (GS/GB/debentures/ETF-adjacent), not a data
      // defect -- but Acceptance Gate 2 requires rowsSeen == rowsAccepted +
      // rowsRejected for EVERY run, so this still needs a place in the
      // count. The 'series-excluded:' prefix lets Task 2.4's
      // bhavcopy-reject-rate check (and the coverage report's reject-reason
      // breakdown) separate deliberate exclusion from genuine defects rather
      // than diluting the real defect signal into one undifferentiated rate
      // (measurement.md's "decompose a % figure by category before
      // believing it," applied to ingestion instead of a factor panel).
      rejected.push({ raw: line, reason: `series-excluded: '${series}' not in equity allowlist` });
      continue;
    }
    if (!SYMBOL_PATTERN.test(symbol)) {
      rejected.push({ raw: line, reason: `symbol '${symbol}' fails ^[A-Z0-9&$-]{1,20}$` });
      continue;
    }

    const sessionDate = parseNseDate(record.DATE1 ?? '');
    if (!sessionDate) {
      rejected.push({ raw: line, reason: `unparseable DATE1 '${record.DATE1}'` });
      continue;
    }

    const close = toNullableNumber(record.CLOSE_PRICE);
    if (close === null || close <= 0) {
      rejected.push({ raw: line, reason: `CLOSE_PRICE missing or <= 0 ('${record.CLOSE_PRICE}')` });
      continue;
    }

    const turnoverLacs = toNullableNumber(record.TURNOVER_LACS);

    accepted.push({
      marketBar: {
        symbol,
        sessionDate,
        prevClose: toNullableNumber(record.PREV_CLOSE),
        open: toNullableNumber(record.OPEN_PRICE),
        high: toNullableNumber(record.HIGH_PRICE),
        low: toNullableNumber(record.LOW_PRICE),
        close,
        vwap: toNullableNumber(record.AVG_PRICE),
        volume: toNullableNumber(record.TTL_TRD_QNTY),
        trades: toNullableNumber(record.NO_OF_TRADES),
        turnover: turnoverLacs === null ? null : turnoverLacs * 100_000,
      },
      delivery: {
        symbol,
        sessionDate,
        deliveryQty: toNullableNumber(record.DELIV_QTY),
        deliveryPct: toNullableNumber(record.DELIV_PER),
      },
    });
  }

  return { accepted, rejected };
}

/** Normalizes a rejected row's free-text reason into a stable category, so
 * per-run reject reasons can be tallied and aggregated across a whole
 * backfill (Task 2.5's coverage report) without storing every raw row. The
 * dynamic parts of each reason (a specific symbol, series, or bad value) are
 * stripped; only the category survives. */
export function categorizeRejectReason(reason: string): string {
  if (reason.startsWith('series-excluded:')) return 'series-excluded';
  if (reason.startsWith('empty SYMBOL')) return 'empty-symbol-or-series';
  if (reason.includes('fails ^[A-Z0-9')) return 'invalid-symbol-format';
  if (reason.startsWith('unparseable DATE1')) return 'unparseable-date';
  if (reason.startsWith('CLOSE_PRICE')) return 'invalid-close-price';
  return 'other';
}
