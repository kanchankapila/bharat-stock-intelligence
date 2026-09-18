// Display helpers preserve missing values; model returns/probabilities are fractions.
export function percent(value: unknown, digits = 1): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
  return `${(value * 100).toFixed(digits)}%`;
}

// For DB fields ALREADY stored in percent units (e.g. actual_ret_*d written by
// outcome_resolver.py as `(exit-entry)/entry*100`): render as-is, never ×100 again.
export function percentPoint(value: unknown, digits = 2): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
  return `${value.toFixed(digits)}%`;
}


export function istDate(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

export function safeNewsUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) ? url.href : undefined;
  } catch { return undefined; }
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  hellip: '…', mdash: '—', ndash: '–', rsquo: '’', lsquo: '‘',
  ldquo: '“', rdquo: '”', deg: '°', plusmn: '±', times: '×',
};

// Upstream news summaries are sometimes full HTML snippets (e.g. Google News RSS
// "<a href=…>…</a> <font>Source</font>"). Extract display text only: strip tags,
// decode entities, collapse whitespace. Output is rendered as React text (escaped).
export function stripHtmlToText(value: string): string {
  if (!value) return '';
  if (!/[<&]/.test(value)) return value;
  return decodeHtmlEntities(value.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

// Decode common HTML entities in upstream plain-text fields (titles/summaries).
// Output is rendered as React text (escaped), so a decoded `<` can never inject markup.
export function decodeHtmlEntities(value: string): string {
  if (!value || !value.includes('&')) return value;
  return value.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (match, body: string) => {
    if (body.startsWith('#')) {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code >= 0x20 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    return NAMED_ENTITIES[body] ?? match;
  });
}

