/**
 * Live NSE market-open check, backed by NSE's own marketStatus endpoint instead of a
 * hardcoded weekday/time window — this also accounts for market holidays and special
 * sessions that a pure weekday+time check can't know about. Falls back to the old
 * weekday/time heuristic if NSE is unreachable, so a network blip never silently
 * disables every market-hours-gated job.
 */

const MARKET_STATUS_URL = 'https://www.nseindia.com/api/marketStatus';
const NSE_HOME_URL = 'https://www.nseindia.com/';
// Secondary live source (BSE via ET Community feeds) — used only if NSE is unreachable.
// Also holiday-aware (its `purpose` field names the reason, e.g. "Weekly Off" or an actual
// holiday), unlike the pure weekday/time heuristic below.
const BSE_STATUS_URL = 'https://json.bselivefeeds.indiatimes.com/ET_Community/holidaylist';
const CACHE_TTL_MS = 60_000; // NSE reflects state changes in real time; no need to poll faster than this
const FALLBACK_CACHE_TTL_MS = 20_000; // shorter TTL for the heuristic fallback so a live recovery is picked up quickly

const HEADERS: Record<string, string> = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'application/json, text/plain, */*',
  'Referer': 'https://www.nseindia.com/',
  'Origin': 'https://www.nseindia.com',
};

let cachedCookie: string | null = null;
let cache: { isOpen: boolean; expiresAt: number } | null = null;

/** Weekday + 9:15-15:30 IST window — used only when the live NSE check is unavailable. */
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

/** Secondary live check via BSE's feed — returns null if unreachable/unparseable. */
async function fetchBseMarketStatus(): Promise<boolean | null> {
  try {
    const res = await fetch(BSE_STATUS_URL, { headers: { 'User-Agent': HEADERS['User-Agent'] }, signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return null;
    const data = await res.json();
    const status = data.currentMarketStatus ?? data.marketStatus;
    if (!status) return null;
    return String(status).trim().toLowerCase() === 'open';
  } catch {
    return null;
  }
}

/** True if NSE's Capital Market segment is currently open for trading. */
export async function isMarketOpen(): Promise<boolean> {
  if (cache && Date.now() < cache.expiresAt) return cache.isOpen;

  try {
    if (!cachedCookie) await warmNSESession();
    const res = await fetch(MARKET_STATUS_URL, {
      headers: { ...HEADERS, ...(cachedCookie ? { Cookie: cachedCookie } : {}) },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`marketStatus HTTP ${res.status}`);
    const data = await res.json();
    const capital = (data.marketState || []).find((m: any) => m.market === 'Capital Market');
    if (!capital?.marketStatus) throw new Error('Capital Market segment missing from marketStatus response');

    const isOpen = String(capital.marketStatus).trim().toLowerCase() === 'open';
    cache = { isOpen, expiresAt: Date.now() + CACHE_TTL_MS };
    return isOpen;
  } catch (err) {
    console.warn('[MARKET STATUS] NSE live check failed, trying BSE secondary source:', (err as Error).message);
    cachedCookie = null; // force a fresh cookie next attempt

    const bseIsOpen = await fetchBseMarketStatus();
    const isOpen = bseIsOpen ?? fallbackIsMarketOpen();
    if (bseIsOpen === null) {
      console.warn('[MARKET STATUS] BSE secondary source also failed, falling back to weekday/time heuristic.');
    }
    // Cache the fallback result too (short TTL) — otherwise every caller re-triggers fresh live
    // checks (up to 20s of network work) on every single invocation for as long as NSE stays
    // unreachable, which is exactly when hammering it is least useful.
    cache = { isOpen, expiresAt: Date.now() + FALLBACK_CACHE_TTL_MS };
    return isOpen;
  }
}
