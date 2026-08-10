/**
 * Live, holiday-aware NSE market-open check.
 *
 * Primary source is BSE's ET-Community feed, which returns a live status object whose `purpose`
 * field names the reason a session is closed (an actual holiday vs a "Weekly Off") — so it is
 * holiday-aware without needing a hardcoded calendar, and it needs no cookie warm-up. NSE's own
 * marketStatus endpoint is used as a cross-check/secondary. If both live sources are unreachable
 * we reuse the last-known live status (still holiday-aware) before falling back to a pure
 * weekday/time heuristic, so a network blip never silently re-enables market-hours jobs on a holiday.
 */

const MARKET_STATUS_URL = 'https://www.nseindia.com/api/marketStatus';
const NSE_HOME_URL = 'https://www.nseindia.com/';
// Primary live source: BSE via ET Community feeds. Holiday-aware (its `purpose` field names the
// reason, e.g. "Weekly Off" or a named holiday). Shape:
//   {"currentMarketStatus":"Live"|"Closed"(?),"marketStatus":"ON"|"OFF","purpose":"Normal Working Day"|...}
const BSE_STATUS_URL = 'https://json.bselivefeeds.indiatimes.com/ET_Community/holidaylist';
const CACHE_TTL_MS = 60_000; // live sources reflect state changes in real time; no need to poll faster
const FALLBACK_CACHE_TTL_MS = 20_000; // shorter TTL for degraded paths so a live recovery is picked up quickly
const LAST_KNOWN_TTL_MS = 2 * 60 * 60 * 1000; // reuse a last-known live status for up to 2h before the heuristic

const HEADERS: Record<string, string> = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'application/json, text/plain, */*',
  'Referer': 'https://www.nseindia.com/',
  'Origin': 'https://www.nseindia.com',
};

let cachedCookie: string | null = null;
let cache: { isOpen: boolean; expiresAt: number } | null = null;
// Last successful live read (from either source). Holiday-aware, so preferred over the heuristic
// when both live sources are temporarily unreachable.
let lastLiveStatus: { isOpen: boolean; at: number } | null = null;

/** Weekday + 9:15-15:30 IST window — absolute last resort; NOT holiday-aware. */
function fallbackIsMarketOpen(): boolean {
  const now = new Date();
  const istOffset = 5.5 * 60 * 60 * 1000;
  const istTime = new Date(now.getTime() + istOffset);
  const day = istTime.getUTCDay(); // 0=Sun, 6=Sat
  if (day === 0 || day === 6) return false;
  const timeInMinutes = istTime.getUTCHours() * 60 + istTime.getUTCMinutes();
  return timeInMinutes >= 555 && timeInMinutes <= 930; // 9:15-15:30 IST
}

async function warmNSESession(): Promise<void> {
  const res = await fetch(NSE_HOME_URL, { headers: HEADERS, signal: AbortSignal.timeout(10_000) });
  const cookies = res.headers.getSetCookie?.() ?? [];
  cachedCookie = cookies.length ? cookies.map(c => c.split(';')[0]).join('; ') : null;
}

/** Primary holiday-aware live check via BSE's feed — returns null if unreachable/unparseable. */
async function fetchBseMarketStatus(): Promise<boolean | null> {
  try {
    const res = await fetch(BSE_STATUS_URL, { headers: { 'User-Agent': HEADERS['User-Agent'] }, signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return null;
    const data = await res.json();
    const status = data.currentMarketStatus ?? data.marketStatus;
    if (!status) return null;
    const s = String(status).trim().toLowerCase();
    // currentMarketStatus returns "Live" during an active session (not "OPEN" as the
    // shape comment above assumes) — marketStatus separately uses "ON"/"OFF".
    return s === 'open' || s === 'on' || s === 'live';
  } catch {
    return null;
  }
}

/** Secondary live check via NSE's Capital Market segment — returns null if unreachable/unparseable. */
async function fetchNseMarketStatus(): Promise<boolean | null> {
  try {
    if (!cachedCookie) await warmNSESession();
    const res = await fetch(MARKET_STATUS_URL, {
      headers: { ...HEADERS, ...(cachedCookie ? { Cookie: cachedCookie } : {}) },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`marketStatus HTTP ${res.status}`);
    const data = await res.json();
    const capital = (data.marketState || []).find((m: any) => m.market === 'Capital Market');
    if (!capital?.marketStatus) return null;
    return String(capital.marketStatus).trim().toLowerCase() === 'open';
  } catch {
    cachedCookie = null; // force a fresh cookie next attempt
    return null;
  }
}

/** True if the NSE/BSE Capital Market segment is currently open for trading (holiday-aware). */
export async function isMarketOpen(): Promise<boolean> {
  if (cache && Date.now() < cache.expiresAt) return cache.isOpen;

  // BSE holidaylist first (holiday-aware, no cookie dance); NSE as cross-check/secondary.
  let isOpen = await fetchBseMarketStatus();
  if (isOpen === null) isOpen = await fetchNseMarketStatus();

  if (isOpen !== null) {
    lastLiveStatus = { isOpen, at: Date.now() };
    cache = { isOpen, expiresAt: Date.now() + CACHE_TTL_MS };
    return isOpen;
  }

  // Both live sources failed. Prefer the last-known live status (holiday-aware) over the
  // holiday-blind weekday/time heuristic, as long as it's fresh enough to still be valid.
  if (lastLiveStatus && Date.now() - lastLiveStatus.at < LAST_KNOWN_TTL_MS) {
    console.warn('[MARKET STATUS] Live sources unreachable; reusing last-known status.');
    cache = { isOpen: lastLiveStatus.isOpen, expiresAt: Date.now() + FALLBACK_CACHE_TTL_MS };
    return lastLiveStatus.isOpen;
  }

  const heuristic = fallbackIsMarketOpen();
  console.warn('[MARKET STATUS] Live sources unreachable and no fresh last-known status; using weekday/time heuristic (NOT holiday-aware).');
  cache = { isOpen: heuristic, expiresAt: Date.now() + FALLBACK_CACHE_TTL_MS };
  return heuristic;
}

/**
 * True only on a **trading holiday** — a weekday on which the exchange is shut (Republic Day,
 * Diwali, etc.), as opposed to a normal session day or a weekend. Used by the closed-day early
 * dispatcher so batch work runs in the morning instead of waiting for a market close that never
 * comes. Weekends are excluded (their weekly jobs are separately timed early on Sunday).
 *
 * Defaults to false on any uncertainty (BSE unreachable / ambiguous purpose) so the normal
 * schedule is never wrongly suppressed — the worst case is a holiday runs on its usual schedule.
 */
export async function isTradingHolidayToday(): Promise<boolean> {
  // No separate weekend short-circuit: the BSE feed already reports Sat/Sun with
  // purpose "Weekly Off", which the purpose.includes('weekly') check below correctly
  // treats as not-a-holiday. Every real caller's own cron is weekday-only anyway.
  try {
    const res = await fetch(BSE_STATUS_URL, { headers: { 'User-Agent': HEADERS['User-Agent'] }, signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return false;
    const data = await res.json();
    const purpose = String(data.purpose ?? '').toLowerCase();
    const status = String(data.currentMarketStatus ?? data.marketStatus ?? '').toLowerCase();
    // A trading holiday names the reason (e.g. "…holiday", "closed for …"); a normal weekday
    // reports "normal market". "Weekly off" only appears on weekends (already excluded above).
    if (purpose.includes('normal') || purpose.includes('weekly')) return false;
    return purpose.includes('holiday') || purpose.includes('closed') ||
           (status === 'closed' && purpose.length > 0);
  } catch {
    return false;
  }
}

/**
 * True when a routine evening/night job should skip its normal cron-triggered run because
 * today is a trading holiday (2026-08-06). On a mid-week holiday the exchange never opens, so
 * every "regular fetch" job downstream of it (screener syncs, OHLCV refresh, re-scoring) would
 * just re-process yesterday's unchanged data -- pure wasted compute/network, not new signal.
 * closed-day-early-batch (queues.ts's QUEUE_CLOSED_DAY) already runs the critical daily
 * pipeline once, early, on such a day -- dispatched jobs carry job.name === 'closed-day-early'
 * and must NEVER be skipped by this check, or the morning dispatch would itself be a no-op.
 *
 * Deliberately NOT applied to the 15-min intraday chain (already gated by the holiday-aware
 * isMarketOpen() above) or to genuinely weekly/global-market jobs (weekly fetches are fine per
 * the user's own framing; global macro data keeps moving on an NSE holiday even though NSE
 * itself doesn't).
 */
export async function shouldSkipOnTradingHoliday(job?: { name?: string } | null): Promise<boolean> {
  if (job?.name === 'closed-day-early') return false;
  // 2026-08-09: every current caller's own cron is weekday-only ('1-5'), and this check's own
  // isTradingHolidayToday() deliberately treats Sat/Sun as "not a holiday" (see its docstring)
  // on the assumption that a weekday-only cron would never invoke it on a weekend anyway. That
  // assumption breaks for addJobWithCatchup's "was the last scheduled occurrence missed"
  // recovery path, which does NOT respect the day-of-week field -- confirmed live: a server
  // restart fired catchup runs for stock-refresh/technical-scan/etnow-screener-sync/et-
  // marketstats-sync/mc-screener-sync on a Sunday, several of which re-wrote stale/duplicate
  // data (e.g. stock_ohlcv rows dated that Sunday, byte-identical to the prior Friday's bar).
  // Every call site here is verified weekday-only, so a weekend is unconditionally treated as
  // a skip -- this is a property of "should THIS caller's already-weekday-only job run today",
  // not a claim that weekends are holidays in general (isTradingHolidayToday() itself is left
  // unchanged for that reason).
  const istDay = new Date(Date.now() + 5.5 * 3600_000).getUTCDay(); // 0=Sun, 6=Sat
  if (istDay === 0 || istDay === 6) return true;
  return isTradingHolidayToday();
}
