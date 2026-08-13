// Task 3.2 / spec §2.1: InvestSights corporate-actions feed. Symbols are
// real NSE tickers already (no translation needed) but must still be
// validated against `security` before insert (data-sources.md resolution
// order). `category` is a pipe-joined multi-label string, not an enum --
// this is a general corporate-EVENTS feed (board meetings, results,
// dividends all mixed together), which is why it targets event_fact and not
// the narrower action_type-keyed corporate_action table.
export interface InvestSightsAction {
  symbol: string;
  companyName: string | null;
  dividendPerShare: number | null;
  recordDate: string | null;
  exDate: string | null;
  filingDate: string | null;
  headline: string | null;
  category: string | null;
  sourceUrl: string;
  upcoming: boolean;
}

export interface InvestSightsParseResult {
  accepted: InvestSightsAction[];
  rejected: Array<{ raw: unknown; reason: string }>;
}

export function investSightsUrl(daysBack: number, daysAhead: number): string {
  return `https://investsights.in/api/v2/market/corporate-actions?days_back=${daysBack}&days_ahead=${daysAhead}`;
}

export const INVESTSIGHTS_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  Accept: 'application/json',
};

export function parseInvestSightsResponse(body: string): InvestSightsParseResult {
  const accepted: InvestSightsAction[] = [];
  const rejected: Array<{ raw: unknown; reason: string }> = [];

  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    return { accepted, rejected: [{ raw: body.slice(0, 500), reason: 'response body is not valid JSON' }] };
  }

  const envelope = json as { success?: unknown; actions?: unknown };
  if (envelope.success !== true || !Array.isArray(envelope.actions)) {
    return { accepted, rejected: [{ raw: json, reason: 'envelope missing success=true or actions[] array' }] };
  }

  for (const raw of envelope.actions) {
    const a = raw as Record<string, unknown>;
    const symbol = typeof a.symbol === 'string' ? a.symbol.trim().toUpperCase() : '';
    const sourceUrl = typeof a.source_url === 'string' ? a.source_url : '';
    if (!symbol) {
      rejected.push({ raw, reason: 'missing or non-string symbol' });
      continue;
    }
    if (!sourceUrl) {
      rejected.push({ raw, reason: 'missing source_url (natural dedup key)' });
      continue;
    }
    accepted.push({
      symbol,
      companyName: typeof a.company_name === 'string' ? a.company_name : null,
      dividendPerShare: typeof a.dividend_per_share === 'number' ? a.dividend_per_share : null,
      // ex_date is frequently NULL even when record_date is populated -- normal
      // state (NSE discloses record date before ex-date is fixed), not a reject.
      recordDate: typeof a.record_date === 'string' ? a.record_date : null,
      exDate: typeof a.ex_date === 'string' ? a.ex_date : null,
      filingDate: typeof a.filing_date === 'string' ? a.filing_date : null,
      headline: typeof a.headline === 'string' ? a.headline : null,
      category: typeof a.category === 'string' ? a.category : null,
      sourceUrl,
      upcoming: a.upcoming === true,
    });
  }

  return { accepted, rejected };
}

const KIND_KEYWORDS: Array<[string, string]> = [
  ['board_meeting', 'board_meeting'],
  ['results', 'earnings'],
  ['earnings', 'earnings'],
  ['agm', 'agm'],
  ['credit_rating', 'credit_rating'],
  ['surveillance', 'surveillance'],
  ['insider_trade', 'insider_trade'],
  ['bulk_deal', 'bulk_deal'],
  ['block_deal', 'block_deal'],
  ['ipo', 'ipo'],
];

/** event_type enum has no 'dividend'/'split'/'fundraise' literal -- this feed
 * mixes governance events with price-adjusting actions in one pipe-joined
 * category string. Best-effort classify by keyword for filtering; the raw
 * category string is always preserved in payload so nothing is lost. */
export function deriveEventKind(category: string | null): string {
  if (!category) return 'announcement';
  const lower = category.toLowerCase();
  for (const [keyword, kind] of KIND_KEYWORDS) {
    if (lower.includes(keyword)) return kind;
  }
  return 'announcement';
}
