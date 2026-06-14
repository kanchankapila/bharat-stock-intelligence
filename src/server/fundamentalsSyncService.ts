/**
 * Bulk Fundamental Data Sync Service
 *
 * Two-phase sync using Yahoo Finance:
 *   Phase 1 — fast batch (v7/quote, 50 symbols at once):
 *     trailing PE, forward PE, P/B, EPS, market cap, 52w range, SMA200,
 *     avg volume, dividend yield, analyst rating
 *   Phase 2 — deep per-symbol (v10/quoteSummary, throttled):
 *     debt-to-equity, ROE, revenue growth, earnings growth, operating margins,
 *     current ratio, Piotroski F-score
 *
 * Crumb authentication is managed internally with auto-refresh on 401.
 */

import db from './db';
import { nseStocksData } from '../data/nseStocks';
import { getAllStocks } from './stockMapping';

// ─── Constants ───────────────────────────────────────────────────────────────

const YF_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'application/json',
};

// Crumb endpoint returns plain text — needs a different Accept header
const YF_CRUMB_HEADERS = {
  'User-Agent': YF_HEADERS['User-Agent'],
  'Accept': 'text/plain, */*',
};

const PHASE1_BATCH_SIZE   = 50;
const PHASE1_CONCURRENCY  = 6;
const PHASE2_CONCURRENCY  = 4;  // quoteSummary — be polite
const PHASE2_DELAY_MS     = 300; // between batches

// ─── In-process sync state (for progress reporting) ──────────────────────────

export interface SyncProgress {
  isRunning: boolean;
  phase: 1 | 2 | 'idle';
  phase1Total: number;
  phase1Done: number;
  phase2Total: number;
  phase2Done: number;
  phase2Errors: number;
  startedAt: string | null;
  completedAt: string | null;
  lastError: string | null;
}

let syncProgress: SyncProgress = {
  isRunning: false,
  phase: 'idle',
  phase1Total: 0,
  phase1Done: 0,
  phase2Total: 0,
  phase2Done: 0,
  phase2Errors: 0,
  startedAt: null,
  completedAt: null,
  lastError: null,
};

export function getSyncProgress(): SyncProgress {
  return { ...syncProgress };
}

// ─── Crumb management ────────────────────────────────────────────────────────

interface YFAuth {
  cookie: string;
  crumb: string;
  expiresAt: number;
}

let yfAuth: YFAuth | null = null;
let refreshInFlight: Promise<YFAuth> | null = null;

async function refreshYFAuthOnce(): Promise<YFAuth> {
  if (!refreshInFlight) {
    refreshInFlight = getYFAuth().finally(() => { refreshInFlight = null; });
  }
  return refreshInFlight;
}

async function getYFAuth(): Promise<YFAuth> {
  if (yfAuth && Date.now() < yfAuth.expiresAt) return yfAuth;

  const r1 = await fetch('https://fc.yahoo.com', {
    headers: YF_HEADERS,
    signal: AbortSignal.timeout(10000),
  });

  const setCookie = r1.headers.get('set-cookie') || '';
  const cookie = setCookie.split(';')[0];
  if (!cookie) throw new Error('[FUNDSYNC] Failed to get Yahoo Finance session cookie');

  const r2 = await fetch('https://query2.finance.yahoo.com/v1/test/getcrumb', {
    headers: { ...YF_CRUMB_HEADERS, Cookie: cookie },
    signal: AbortSignal.timeout(10000),
  });

  if (!r2.ok) throw new Error(`[FUNDSYNC] Crumb request failed: ${r2.status}`);
  const crumb = await r2.text();
  if (!crumb || crumb.includes('{')) throw new Error('[FUNDSYNC] Invalid crumb response');

  yfAuth = { cookie, crumb, expiresAt: Date.now() + 50 * 60 * 1000 }; // 50 min TTL
  console.log('[FUNDSYNC] Yahoo Finance auth refreshed');
  return yfAuth;
}

async function invalidateCrumb(): Promise<void> {
  yfAuth = null;
}

// ─── Symbol universe ─────────────────────────────────────────────────────────

function getAllSymbols(): string[] {
  const stocklistSymbols = getAllStocks().map(s => s.symbol);
  const nseSymbols = nseStocksData.map(s => s.symbol);
  return [...new Set([...stocklistSymbols, ...nseSymbols])];
}

// ─── DB upserts ──────────────────────────────────────────────────────────────

const upsertPhase1 = db.prepare(`
  INSERT INTO stock_fundamentals (
    symbol, trailing_pe, forward_pe, price_to_book, book_value, earnings_yield,
    eps_ttm, eps_forward, market_cap, shares_outstanding,
    fifty_two_week_high, fifty_two_week_low, fifty_two_week_change_pct,
    sma200, price_vs_sma200_pct, avg_volume_3m, dividend_yield, analyst_rating,
    phase1_synced_at, last_updated
  ) VALUES (
    ?, ?, ?, ?, ?, ?,
    ?, ?, ?, ?,
    ?, ?, ?,
    ?, ?, ?, ?, ?,
    CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
  )
  ON CONFLICT(symbol) DO UPDATE SET
    trailing_pe             = excluded.trailing_pe,
    forward_pe              = excluded.forward_pe,
    price_to_book           = excluded.price_to_book,
    book_value              = excluded.book_value,
    earnings_yield          = excluded.earnings_yield,
    eps_ttm                 = excluded.eps_ttm,
    eps_forward             = excluded.eps_forward,
    market_cap              = excluded.market_cap,
    shares_outstanding      = excluded.shares_outstanding,
    fifty_two_week_high     = excluded.fifty_two_week_high,
    fifty_two_week_low      = excluded.fifty_two_week_low,
    fifty_two_week_change_pct = excluded.fifty_two_week_change_pct,
    sma200                  = excluded.sma200,
    price_vs_sma200_pct     = excluded.price_vs_sma200_pct,
    avg_volume_3m           = excluded.avg_volume_3m,
    dividend_yield          = excluded.dividend_yield,
    analyst_rating          = excluded.analyst_rating,
    phase1_synced_at        = CURRENT_TIMESTAMP,
    last_updated            = CURRENT_TIMESTAMP
`);

const upsertPhase2 = db.prepare(`
  INSERT INTO stock_fundamentals (symbol, debt_to_equity, return_on_equity,
    revenue_growth, earnings_growth, operating_margins, current_ratio,
    piotroski_f_score, phase2_synced_at, last_updated)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  ON CONFLICT(symbol) DO UPDATE SET
    debt_to_equity    = excluded.debt_to_equity,
    return_on_equity  = excluded.return_on_equity,
    revenue_growth    = excluded.revenue_growth,
    earnings_growth   = excluded.earnings_growth,
    operating_margins = excluded.operating_margins,
    current_ratio     = excluded.current_ratio,
    piotroski_f_score = excluded.piotroski_f_score,
    phase2_synced_at  = CURRENT_TIMESTAMP,
    last_updated      = CURRENT_TIMESTAMP
`);

// ─── Piotroski F-Score (9-point) ─────────────────────────────────────────────

function computePiotroski(fd: any): number {
  let score = 0;
  // Profitability (4 points)
  if (fd.returnOnAssets?.raw > 0) score++;
  if (fd.operatingCashflow?.raw > 0) score++;
  if (fd.earningsGrowth?.raw > 0) score++;
  if (fd.operatingCashflow?.raw > fd.netIncome?.raw) score++; // accruals
  // Leverage (3 points)
  if ((fd.debtToEquity?.raw || 0) < 100) score++;            // D/E < 1x (stored as %)
  if ((fd.currentRatio?.raw || 0) > 1) score++;
  if (fd.sharesOutstanding) score++;                          // no dilution proxy
  // Efficiency (2 points)
  if ((fd.grossMargins?.raw || 0) > 0) score++;
  if ((fd.revenueGrowth?.raw || 0) > 0) score++;
  return score;
}

// ─── Phase 1: batch v7/quote ─────────────────────────────────────────────────

async function fetchPhase1Batch(
  symbols: string[],
  auth: YFAuth,
): Promise<void> {
  const yfSymbols = symbols.map(s => `${s}.NS`).join(',');
  const fields = [
    'trailingPE', 'forwardPE', 'priceToBook', 'bookValue',
    'epsTrailingTwelveMonths', 'epsForward',
    'marketCap', 'sharesOutstanding',
    'fiftyTwoWeekHigh', 'fiftyTwoWeekLow', 'fiftyTwoWeekChangePercent',
    'twoHundredDayAverage', 'regularMarketPrice',
    'averageDailyVolume3Month', 'dividendYield', 'averageAnalystRating',
  ].join(',');

  const url = `https://query2.finance.yahoo.com/v7/finance/quote?symbols=${yfSymbols}&fields=${fields}&crumb=${encodeURIComponent(auth.crumb)}`;
  const res = await fetch(url, {
    headers: { ...YF_HEADERS, Cookie: auth.cookie },
    signal: AbortSignal.timeout(15000),
  });

  if (res.status === 401) {
    await invalidateCrumb();
    throw new Error('CRUMB_EXPIRED');
  }
  if (!res.ok) return;

  const data = await res.json();
  const quotes: any[] = data?.quoteResponse?.result || [];

  const insertMany = db.transaction((rows: any[]) => {
    for (const q of rows) {
      const symbol = q.symbol?.replace('.NS', '');
      if (!symbol) continue;
      const price    = q.regularMarketPrice ?? null;
      const sma200   = q.twoHundredDayAverage ?? null;
      const priceVsSma200 = (price && sma200) ? ((price - sma200) / sma200 * 100) : null;
      const trailingPE    = q.trailingPE ?? null;
      const earningsYield = (trailingPE && trailingPE > 0) ? (1 / trailingPE * 100) : null;

      upsertPhase1.run(
        symbol,
        trailingPE,
        q.forwardPE              ?? null,
        q.priceToBook            ?? null,
        q.bookValue              ?? null,
        earningsYield,
        q.epsTrailingTwelveMonths ?? null,
        q.epsForward             ?? null,
        q.marketCap              ?? null,
        q.sharesOutstanding      ?? null,
        q.fiftyTwoWeekHigh       ?? null,
        q.fiftyTwoWeekLow        ?? null,
        q.fiftyTwoWeekChangePercent ?? null,
        sma200,
        priceVsSma200,
        q.averageDailyVolume3Month ?? null,
        q.dividendYield          ?? null,
        q.averageAnalystRating   ?? null,
      );
    }
  });

  insertMany(quotes);
  syncProgress.phase1Done += quotes.length;
}

export async function runPhase1(): Promise<void> {
  const symbols = getAllSymbols();
  syncProgress.phase1Total = symbols.length;
  syncProgress.phase1Done  = 0;
  syncProgress.phase = 1;
  console.log(`[FUNDSYNC] Phase 1 starting — ${symbols.length} symbols in batches of ${PHASE1_BATCH_SIZE}`);

  let auth = await getYFAuth();
  const batches: string[][] = [];
  for (let i = 0; i < symbols.length; i += PHASE1_BATCH_SIZE) {
    batches.push(symbols.slice(i, i + PHASE1_BATCH_SIZE));
  }

  // Process PHASE1_CONCURRENCY batches in parallel, then move to next wave
  for (let i = 0; i < batches.length; i += PHASE1_CONCURRENCY) {
    const wave = batches.slice(i, i + PHASE1_CONCURRENCY);
    await Promise.allSettled(
      wave.map(async batch => {
        try {
          await fetchPhase1Batch(batch, auth);
        } catch (err: any) {
          if (err.message === 'CRUMB_EXPIRED') {
            auth = await getYFAuth();
            await fetchPhase1Batch(batch, auth); // retry once
          }
        }
      }),
    );
  }

  console.log(`[FUNDSYNC] Phase 1 complete — ${syncProgress.phase1Done} symbols stored`);
}

// ─── Phase 2: per-symbol quoteSummary ────────────────────────────────────────

interface Phase2Row {
  symbol: string;
  debtToEquity: number | null;
  returnOnEquity: number | null;
  revenueGrowth: number | null;
  earningsGrowth: number | null;
  operatingMargins: number | null;
  currentRatio: number | null;
  piotroski: number;
}

async function fetchPhase2Data(
  symbol: string,
  auth: YFAuth,
): Promise<Phase2Row | null> {
  const url = `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${symbol}.NS?modules=financialData,defaultKeyStatistics&crumb=${encodeURIComponent(auth.crumb)}`;
  const res = await fetch(url, {
    headers: { ...YF_HEADERS, Cookie: auth.cookie },
    signal: AbortSignal.timeout(12000),
  });

  if (res.status === 401) {
    await invalidateCrumb();
    throw new Error('CRUMB_EXPIRED');
  }
  if (!res.ok) throw new Error(`[FUNDSYNC] HTTP ${res.status} for ${symbol}`);

  const data = await res.json();
  const result = data?.quoteSummary?.result?.[0];
  if (!result) return null;

  const fd = result.financialData  || {};
  const ks = result.defaultKeyStatistics || {};

  return {
    symbol,
    debtToEquity:    fd.debtToEquity?.raw    ?? null,
    returnOnEquity:  fd.returnOnEquity?.raw  ?? null,
    revenueGrowth:   fd.revenueGrowth?.raw   ?? null,
    earningsGrowth:  fd.earningsGrowth?.raw  ?? null,
    operatingMargins: fd.operatingMargins?.raw ?? null,
    currentRatio:    fd.currentRatio?.raw    ?? null,
    piotroski:       computePiotroski({ ...fd, ...ks }),
  };
}

const writePhase2Batch = db.transaction((rows: Phase2Row[]) => {
  for (const row of rows) {
    upsertPhase2.run(
      row.symbol,
      row.debtToEquity,
      row.returnOnEquity,
      row.revenueGrowth,
      row.earningsGrowth,
      row.operatingMargins,
      row.currentRatio,
      row.piotroski,
    );
  }
});

export async function runPhase2(symbolsOverride?: string[]): Promise<void> {
  // Only sync symbols that already have Phase 1 data
  const eligible: string[] = symbolsOverride ?? (() => {
    const rows = db.prepare(
      `SELECT symbol FROM stock_fundamentals WHERE phase1_synced_at IS NOT NULL`
    ).all() as { symbol: string }[];
    return rows.map(r => r.symbol);
  })();

  syncProgress.phase2Total  = eligible.length;
  syncProgress.phase2Done   = 0;
  syncProgress.phase2Errors = 0;
  syncProgress.phase = 2;

  console.log(`[FUNDSYNC] Phase 2 starting — ${eligible.length} symbols (deep sync)`);

  let auth = await getYFAuth();

  for (let i = 0; i < eligible.length; i += PHASE2_CONCURRENCY) {
    const batch = eligible.slice(i, i + PHASE2_CONCURRENCY);

    const results = await Promise.allSettled(
      batch.map(async symbol => {
        try {
          return await fetchPhase2Data(symbol, auth);
        } catch (err: any) {
          if (err.message === 'CRUMB_EXPIRED') {
            auth = await refreshYFAuthOnce();
            return await fetchPhase2Data(symbol, auth);
          }
          throw err;
        }
      }),
    );

    const rows: Phase2Row[] = [];
    for (const r of results) {
      if (r.status === 'fulfilled' && r.value !== null) {
        rows.push(r.value);
        syncProgress.phase2Done++;
      } else if (r.status === 'rejected') {
        syncProgress.phase2Errors++;
      }
    }
    if (rows.length > 0) writePhase2Batch(rows);

    // Polite delay between Phase 2 batches to avoid rate limiting
    if (i + PHASE2_CONCURRENCY < eligible.length) {
      await new Promise(r => setTimeout(r, PHASE2_DELAY_MS));
    }

    if (syncProgress.phase2Done % 100 === 0 && syncProgress.phase2Done > 0) {
      console.log(`[FUNDSYNC] Phase 2 progress: ${syncProgress.phase2Done}/${eligible.length}`);
    }
  }

  console.log(`[FUNDSYNC] Phase 2 complete — ${syncProgress.phase2Done} synced, ${syncProgress.phase2Errors} errors`);
}

// ─── Full sync orchestrator ───────────────────────────────────────────────────

export async function runFullFundamentalsSync(phase2Only = false): Promise<void> {
  if (syncProgress.isRunning) {
    console.warn('[FUNDSYNC] Sync already in progress, skipping');
    return;
  }

  syncProgress = {
    isRunning: true,
    phase: 1,
    phase1Total: 0,
    phase1Done: 0,
    phase2Total: 0,
    phase2Done: 0,
    phase2Errors: 0,
    startedAt: new Date().toISOString(),
    completedAt: null,
    lastError: null,
  };

  try {
    if (!phase2Only) await runPhase1();
    await runPhase2();
    syncProgress.completedAt = new Date().toISOString();
    console.log('[FUNDSYNC] Full sync complete');
  } catch (err: any) {
    syncProgress.lastError = err.message;
    console.error('[FUNDSYNC] Sync failed:', err.message);
  } finally {
    syncProgress.isRunning = false;
    syncProgress.phase     = 'idle';
  }
}

// ─── Single-symbol refresh (for on-demand use in individual stock views) ─────

export async function refreshSymbolFundamentals(symbol: string): Promise<void> {
  let auth = await getYFAuth();
  await fetchPhase1Batch([symbol], auth);
  const row = await fetchPhase2Data(symbol, auth).catch(async (err: any) => {
    if (err.message !== 'CRUMB_EXPIRED') throw err;
    auth = await refreshYFAuthOnce();
    return fetchPhase2Data(symbol, auth);
  });
  if (row) writePhase2Batch([row]);
}

// ─── Query helpers ────────────────────────────────────────────────────────────

export function getStoredFundamentals(symbol: string) {
  return db.prepare('SELECT * FROM stock_fundamentals WHERE symbol = ?').get(symbol) as any | null;
}

export function getFundamentalsCount(): { phase1: number; phase2: number; total: number } {
  const p1 = (db.prepare('SELECT COUNT(*) as n FROM stock_fundamentals WHERE phase1_synced_at IS NOT NULL').get() as any).n;
  const p2 = (db.prepare('SELECT COUNT(*) as n FROM stock_fundamentals WHERE phase2_synced_at IS NOT NULL').get() as any).n;
  const total = (db.prepare('SELECT COUNT(*) as n FROM stock_fundamentals').get() as any).n;
  return { phase1: p1, phase2: p2, total };
}

export async function bootstrapFundamentals(bullmqReady: boolean): Promise<void> {
  const counts = getFundamentalsCount();
  if (counts.phase1 > 0) {
    console.log(`[FUND] ${counts.phase1} Phase-1 rows — skipping bootstrap`);
    return;
  }
  if (bullmqReady) {
    const { fundamentalsSyncQueue } = await import('./queues');
    if (fundamentalsSyncQueue) {
      await fundamentalsSyncQueue.add('sync-fundamentals-first-run', { phase2Only: false }, { removeOnComplete: 3, removeOnFail: 3, attempts: 1, priority: 1 });
      console.log('[FUND] First-run job enqueued via BullMQ');
      return;
    }
  }
  console.log('[FUND] No Redis — starting first-time fundamentals sync directly');
  runFullFundamentalsSync(false).catch(err => console.error('[FUND] First-run error:', err.message));
  setInterval(() => runFullFundamentalsSync(false).catch(console.error), 7 * 24 * 60 * 60 * 1000);
}
