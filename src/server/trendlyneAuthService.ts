const LOGIN_URL = process.env.TRENDLYNE_LOGIN_URL || 'https://trendlyne.com/accounts/login/';
const USERNAME = process.env.TRENDLYNE_USERNAME;
const PASSWORD = process.env.TRENDLYNE_PASSWORD;
const LOGIN_USERNAME_FIELD = process.env.TRENDLYNE_LOGIN_USERNAME_FIELD || 'login';
const LOGIN_PASSWORD_FIELD = process.env.TRENDLYNE_LOGIN_PASSWORD_FIELD || 'password';
const LOGIN_CSRF_FIELD = process.env.TRENDLYNE_LOGIN_CSRF_FIELD || 'csrfmiddlewaretoken';
const SESSION_TTL_MS = Number(process.env.TRENDLYNE_SESSION_TTL_MS ?? 10 * 60 * 60 * 1000);
const MAX_REFRESH_ATTEMPTS = 2;

interface TrendlyneSession {
  cookieHeader: string;
  expiresAt: number;
}

let trendlyneSession: TrendlyneSession | null = null;
let sessionRefreshInFlight: Promise<boolean> | null = null;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function decodeHtmlEntities(str: string): string {
  return str
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

function extractCsrfToken(html: string): string | null {
  const tokenMatch = html.match(/name=["'](?:csrfmiddlewaretoken|csrf_token|csrf)["']\s+value=["']([^"']+)["']/i);
  if (tokenMatch) return decodeHtmlEntities(tokenMatch[1]);
  return null;
}

function extractCookiePairs(headers: Headers): Map<string, string> {
  const pairs = new Map<string, string>();
  for (const setCookie of headers.getSetCookie()) {
    const nameValue = setCookie.split(';')[0].trim();
    const eqIndex = nameValue.indexOf('=');
    if (eqIndex > 0) {
      pairs.set(nameValue.slice(0, eqIndex), nameValue.slice(eqIndex + 1));
    }
  }
  return pairs;
}

function mergeCookiePairs(...maps: Map<string, string>[]): string {
  const merged = new Map<string, string>();
  for (const map of maps) {
    for (const [name, value] of map) {
      merged.set(name, value);
    }
  }
  return [...merged.entries()].map(([name, value]) => `${name}=${value}`).join('; ');
}

async function fetchWithTimeout(url: string, init: RequestInit = {}): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function loginTrendlyne(): Promise<boolean> {
  if (!USERNAME || !PASSWORD) {
    console.warn('[TRENDLYNE AUTH] Missing TRENDLYNE_USERNAME or TRENDLYNE_PASSWORD');
    return false;
  }

  const pageResponse = await fetchWithTimeout(LOGIN_URL, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
      'Referer': 'https://trendlyne.com/',
    },
  });

  if (!pageResponse.ok) {
    console.warn(`[TRENDLYNE AUTH] Login page fetch failed with status ${pageResponse.status}`);
    return false;
  }

  const html = await pageResponse.text();
  const csrfToken = extractCsrfToken(html);
  const initCookiePairs = extractCookiePairs(pageResponse.headers);
  const initCookie = mergeCookiePairs(initCookiePairs);

  const form = new URLSearchParams();
  if (csrfToken) {
    form.append(LOGIN_CSRF_FIELD, csrfToken);
  }
  form.append(LOGIN_USERNAME_FIELD, USERNAME);
  form.append(LOGIN_PASSWORD_FIELD, PASSWORD);
  form.append('next', '/');

  const loginResponse = await fetchWithTimeout(LOGIN_URL, {
    method: 'POST',
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
      'Content-Type': 'application/x-www-form-urlencoded',
      'Referer': LOGIN_URL,
      ...(initCookie ? { Cookie: initCookie } : {}),
    },
    body: form.toString(),
    redirect: 'manual',
  });

  const loginCookiePairs = extractCookiePairs(loginResponse.headers);
  const cookieHeader = mergeCookiePairs(initCookiePairs, loginCookiePairs);

  if (!cookieHeader) {
    console.warn('[TRENDLYNE AUTH] Login attempt did not return any session cookies');
    return false;
  }

  trendlyneSession = {
    cookieHeader,
    expiresAt: Date.now() + SESSION_TTL_MS,
  };
  console.log('[TRENDLYNE AUTH] Logged in successfully and cached session cookie');
  return true;
}

export async function ensureTrendlyneSession(): Promise<boolean> {
  if (trendlyneSession && Date.now() < trendlyneSession.expiresAt) {
    return true;
  }
  if (sessionRefreshInFlight) {
    return sessionRefreshInFlight;
  }

  sessionRefreshInFlight = (async () => {
    for (let attempt = 1; attempt <= MAX_REFRESH_ATTEMPTS; attempt += 1) {
      const success = await loginTrendlyne();
      if (success) {
        sessionRefreshInFlight = null;
        return true;
      }
      await sleep(1000 * attempt);
    }
    sessionRefreshInFlight = null;
    return false;
  })();

  return sessionRefreshInFlight;
}

export async function invalidateTrendlyneSession(): Promise<void> {
  trendlyneSession = null;
}

export async function getTrendlyneAuthHeaders(): Promise<Record<string, string>> {
  const haveSession = await ensureTrendlyneSession();
  if (!haveSession || !trendlyneSession) return {};
  return {
    Cookie: trendlyneSession.cookieHeader,
    Referer: 'https://trendlyne.com/',
  };
}

export async function fetchTrendlyneWithAuth(url: string, init: RequestInit = {}): Promise<Response> {
  const headers = {
    ...(init.headers as Record<string, string> | undefined),
    ...await getTrendlyneAuthHeaders(),
  };

  let response = await fetchWithTimeout(url, { ...init, headers });
  if (response.status === 401 || response.status === 403) {
    await invalidateTrendlyneSession();
    if (await ensureTrendlyneSession()) {
      const retryHeaders = {
        ...(init.headers as Record<string, string> | undefined),
        ...await getTrendlyneAuthHeaders(),
      };
      response = await fetchWithTimeout(url, { ...init, headers: retryHeaders });
    }
  }

  return response;
}

export async function getTrendlyneWidgetHeaders(): Promise<Record<string, string>> {
  const auth = await getTrendlyneAuthHeaders();
  return {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
    'Referer': 'https://trendlyne.com/',
    ...auth,
  };
}

export function randomizeTrendlyneFetchDelay(windowHours = 12): number {
  const maxDelayMs = Math.max(0, Math.min(windowHours, 24)) * 60 * 60 * 1000;
  return Math.floor(Math.random() * maxDelayMs);
}
