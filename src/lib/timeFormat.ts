// NSE/BSE trade in exactly one timezone (Asia/Kolkata, IST) regardless of where a viewer
// sits. Timestamps rendered via the browser's default toLocaleString() silently reinterpret
// against the VIEWER's local timezone with no indication that's what happened -- for a
// platform used from outside India (or just a machine with its OS clock set to another
// zone) that produces an ambiguous or outright wrong-looking time with no way to tell.
// Every "last updated" / "computed at" display should go through these helpers so the
// timestamp is always unambiguous, and a viewer outside IST also sees their own local time.

const IST_TZ = 'Asia/Kolkata';

let _viewerTz: string | null = null;
export function viewerTimeZone(): string {
  if (_viewerTz) return _viewerTz;
  try {
    _viewerTz = Intl.DateTimeFormat().resolvedOptions().timeZone || IST_TZ;
  } catch {
    _viewerTz = IST_TZ;
  }
  return _viewerTz;
}

export function viewerIsOutsideIST(): boolean {
  return viewerTimeZone() !== IST_TZ;
}

/** e.g. "31 Jul, 3:45 PM IST" -- always IST, always explicitly labeled. */
export function formatIST(input: string | number | Date | null | undefined, opts?: { withSeconds?: boolean }): string {
  if (input == null) return '—';
  const d = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(d.getTime())) return '—';
  const formatted = new Intl.DateTimeFormat('en-IN', {
    timeZone: IST_TZ,
    day: '2-digit',
    month: 'short',
    hour: 'numeric',
    minute: '2-digit',
    second: opts?.withSeconds ? '2-digit' : undefined,
    hour12: true,
  }).format(d);
  return `${formatted} IST`;
}

/** Same as formatIST, but also appends the viewer's own local time when it differs from IST. */
export function formatISTWithLocal(input: string | number | Date | null | undefined): string {
  const ist = formatIST(input);
  if (ist === '—' || !viewerIsOutsideIST()) return ist;
  const d = input instanceof Date ? input : new Date(input as string | number);
  if (Number.isNaN(d.getTime())) return ist;
  try {
    const local = new Intl.DateTimeFormat('en-US', {
      timeZone: viewerTimeZone(),
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
      timeZoneName: 'short',
    }).format(d);
    return `${ist} (${local} your time)`;
  } catch {
    return ist;
  }
}

/** "just now" / "3m ago" / "2h ago" -- for auto-refresh freshness indicators. */
export function relativeFromNow(input: string | number | Date | null | undefined): string {
  if (input == null) return '—';
  const d = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(d.getTime())) return '—';
  const diffMs = Date.now() - d.getTime();
  if (diffMs < 0) return 'just now';
  const s = Math.floor(diffMs / 1000);
  if (s < 45) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const days = Math.floor(h / 24);
  return `${days}d ago`;
}

/** Current wall-clock time in a given IANA timezone, for exchange-local clocks. */
export function currentTimeInZone(tz: string): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(new Date());
}

/** Minutes since local midnight in a given IANA timezone, for session-open/closed checks. */
export function minutesSinceMidnightInZone(tz: string, at: Date = new Date()): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour: 'numeric',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(at);
  const hour = Number(parts.find(p => p.type === 'hour')?.value ?? '0');
  const minute = Number(parts.find(p => p.type === 'minute')?.value ?? '0');
  return hour * 60 + minute;
}

/** Day-of-week (0=Sun..6=Sat) in a given IANA timezone -- for weekend session checks. */
export function dayOfWeekInZone(tz: string, at: Date = new Date()): number {
  const weekday = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short' }).format(at);
  return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(weekday);
}

// NSE cash session: 09:15-15:30 IST, Mon-Fri. Doesn't account for exchange holidays (no
// holiday calendar is wired into the frontend) -- a holiday will read as "open" here, same
// known limitation as AppShell.tsx's own getMarketStatus(). Good enough to distinguish "market
// is genuinely closed" from "market is open but this feed returned no rows" in an empty-state
// message, which is the only thing this is used for.
const NSE_OPEN_MIN = 9 * 60 + 15;
const NSE_CLOSE_MIN = 15 * 60 + 30;

/** True during the NSE cash session (09:15-15:30 IST, Mon-Fri), false otherwise. */
export function isNseMarketOpen(at: Date = new Date()): boolean {
  const day = dayOfWeekInZone(IST_TZ, at);
  if (day < 1 || day > 5) return false;
  const mins = minutesSinceMidnightInZone(IST_TZ, at);
  return mins >= NSE_OPEN_MIN && mins < NSE_CLOSE_MIN;
}

// Country-name substring -> exchange timezone, for the global-markets board. Matched by
// substring (case-insensitive) against whatever country label the upstream vendor sends,
// since the backend (globalMarketService.ts) has no timezone field of its own -- only
// `country`/`symbol` strings. Deliberately conservative: an unmatched country renders no
// clock at all rather than guessing, so we never show a fabricated local time.
const EXCHANGE_TZ_BY_COUNTRY: Array<{ match: string; tz: string }> = [
  { match: 'india', tz: 'Asia/Kolkata' },
  { match: 'united states', tz: 'America/New_York' },
  { match: 'usa', tz: 'America/New_York' },
  { match: 'america', tz: 'America/New_York' },
  { match: 'united kingdom', tz: 'Europe/London' },
  { match: 'uk', tz: 'Europe/London' },
  { match: 'britain', tz: 'Europe/London' },
  { match: 'japan', tz: 'Asia/Tokyo' },
  { match: 'hong kong', tz: 'Asia/Hong_Kong' },
  { match: 'china', tz: 'Asia/Shanghai' },
  { match: 'germany', tz: 'Europe/Berlin' },
  { match: 'france', tz: 'Europe/Paris' },
  { match: 'canada', tz: 'America/Toronto' },
  { match: 'australia', tz: 'Australia/Sydney' },
  { match: 'singapore', tz: 'Asia/Singapore' },
  { match: 'korea', tz: 'Asia/Seoul' },
  { match: 'brazil', tz: 'America/Sao_Paulo' },
  { match: 'russia', tz: 'Europe/Moscow' },
  { match: 'switzerland', tz: 'Europe/Zurich' },
  { match: 'italy', tz: 'Europe/Rome' },
  { match: 'spain', tz: 'Europe/Madrid' },
  { match: 'taiwan', tz: 'Asia/Taipei' },
  { match: 'indonesia', tz: 'Asia/Jakarta' },
  { match: 'netherlands', tz: 'Europe/Amsterdam' },
  // Index/instrument names, for feeds that only label by index rather than country
  // (e.g. getGlobalIndices's "S&P 500" / "Nikkei 225" rather than a country string).
  { match: 's&p', tz: 'America/New_York' },
  { match: 'nasdaq', tz: 'America/New_York' },
  { match: 'dow jones', tz: 'America/New_York' },
  { match: 'russell', tz: 'America/New_York' },
  { match: 'ftse', tz: 'Europe/London' },
  { match: 'dax', tz: 'Europe/Berlin' },
  { match: 'cac', tz: 'Europe/Paris' },
  { match: 'nikkei', tz: 'Asia/Tokyo' },
  { match: 'hang seng', tz: 'Asia/Hong_Kong' },
  { match: 'shanghai', tz: 'Asia/Shanghai' },
  { match: 'nifty', tz: 'Asia/Kolkata' },
  { match: 'sensex', tz: 'Asia/Kolkata' },
  { match: 'kospi', tz: 'Asia/Seoul' },
  { match: 'asx', tz: 'Australia/Sydney' },
  { match: 'straits times', tz: 'Asia/Singapore' },
  { match: 'taiex', tz: 'Asia/Taipei' },
  { match: 'bovespa', tz: 'America/Sao_Paulo' },
];

/** Looks up an exchange timezone from either a country label or an index/instrument name. */
export function lookupExchangeTimeZone(label: string | null | undefined): string | null {
  if (!label) return null;
  const c = label.toLowerCase();
  const hit = EXCHANGE_TZ_BY_COUNTRY.find(e => c.includes(e.match));
  return hit?.tz ?? null;
}
