// Task 3.5 / spec §2.5: ET Stats quarterly/annual fundamentals. Envelope key
// name depends on the `events` param -- confirmed live against companyId=9195
// (HDFCBANK) for all four before writing this parser:
//   events=Ratio     -> resultRatiosStatement.list
//   events=Balance    -> resultBalanceSheet.list
//   events=CashFlow   -> resultCashFlowStatement.list
//   events=Quarterly  -> resultQuarterlyResult.list
export const ET_STATS_URL = 'https://etmarketsapis.indiatimes.com/ET_Stats/mobile';

export type EtStatsEvent = 'Balance' | 'CashFlow' | 'Quarterly' | 'Ratio';

const ENVELOPE_KEY: Record<EtStatsEvent, string> = {
  Ratio: 'resultRatiosStatement',
  Balance: 'resultBalanceSheet',
  CashFlow: 'resultCashFlowStatement',
  Quarterly: 'resultQuarterlyResult',
};

const PERIOD_TYPE: Record<EtStatsEvent, 'Q' | 'FY'> = {
  Ratio: 'FY', Balance: 'FY', CashFlow: 'FY', Quarterly: 'Q',
};

export function etStatsUrl(companyId: string, events: EtStatsEvent, last: number): string {
  return `${ET_STATS_URL}?companyId=${companyId}&events=${events}&last=${last}&bType=all`;
}

// Fields that describe the row itself, not a fundamental metric.
const META_FIELDS = new Set(['_id', 'id', 'companyname', 'months', 'yearEnding', 'yearEndingLong', 'bType', 'cType', 'type']);

export interface EtStatsFact {
  metric: string;
  periodEnd: string;
  periodType: 'Q' | 'FY';
  value: number;
  bType: string | null;
}

export interface EtStatsParseResult {
  accepted: EtStatsFact[];
  rejectedRows: number;
  rejectReason?: string;
}

function isIsoDate(s: unknown): s is string {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
}

export function parseEtStatsResponse(body: string, event: EtStatsEvent): EtStatsParseResult {
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    return { accepted: [], rejectedRows: 0, rejectReason: 'response body is not valid JSON' };
  }

  const envelopeKey = ENVELOPE_KEY[event];
  const envelope = (json as Record<string, unknown>)[envelopeKey] as { list?: unknown } | undefined;
  const list = envelope?.list;
  if (!Array.isArray(list)) {
    return { accepted: [], rejectedRows: 0, rejectReason: `missing ${envelopeKey}.list array` };
  }

  const accepted: EtStatsFact[] = [];
  let rejectedRows = 0;
  const periodType = PERIOD_TYPE[event];

  for (const row of list) {
    const r = row as Record<string, unknown>;
    if (!isIsoDate(r.yearEnding)) {
      rejectedRows++;
      continue;
    }
    // bType ('standalone'/'consolidated') folded into the metric name -- a
    // company can report both for the same yearEnding, and fundamental_fact's
    // PK has no separate reporting-basis column, so two legitimately
    // different values under the same metric name would silently collide via
    // ON CONFLICT DO NOTHING.
    const bType = typeof r.bType === 'string' ? r.bType : 'unknown';
    for (const [key, raw] of Object.entries(r)) {
      if (META_FIELDS.has(key)) continue;
      if (raw === null || raw === undefined || raw === '') continue;
      const value = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw.replace(/,/g, '')) : NaN;
      if (!Number.isFinite(value)) continue;
      accepted.push({ metric: `et_${event.toLowerCase()}_${bType}_${key}`, periodEnd: r.yearEnding, periodType, value, bType });
    }
  }

  return { accepted, rejectedRows };
}
