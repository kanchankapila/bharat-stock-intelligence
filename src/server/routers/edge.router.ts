import { z } from 'zod';
import { dbAll, dbGet } from '../dbAsync';
import { router, publicProcedure } from '../trpc';
import { LATEST_COMPLETE_TS_DATE_SQL } from '../technicalSignalsDate';
import { calendarBlockedUntil, MIN_DATES_RELIABLE, type ForwardTestReport } from '../../lib/callState';

// Read-only honesty surfaces (spec 2026-10-08 section 2.D). Nothing here writes or scores.

const BUY = new Set(['Buy', 'Strong Buy']);

// forward_test_report.py writes json.dumps(..., default=str), which emits bare NaN/Infinity.
// ponytail: a token replace; a string value containing the word NaN would be nulled too.
function parsePyJson<T = any>(text: string | null | undefined): T | null {
  if (!text) return null;
  try { return JSON.parse(text.replace(/-?\bNaN\b|-?\bInfinity\b/g, 'null')) as T; } catch { return null; }
}

type SnapRow = { symbol: string; classification: string | null; unified_score: number | null; valid_until: string | Date | null };

export function diffSnapshots(prev: SnapRow[], latest: SnapRow[], now: Date = new Date()) {
  const p = new Map(prev.map(r => [r.symbol, r]));
  const l = new Map(latest.map(r => [r.symbol, r]));
  const isBuy = (r?: SnapRow) => !!r && BUY.has(r.classification ?? '');
  const row = (r: SnapRow, from: string | null, to: string | null) => ({ symbol: r.symbol, from, to, score: r.unified_score });
  const newBuys = latest.filter(r => isBuy(r) && !isBuy(p.get(r.symbol))).map(r => row(r, p.get(r.symbol)?.classification ?? null, r.classification));
  const dropped = prev.filter(r => isBuy(r) && !isBuy(l.get(r.symbol))).map(r => row(r, r.classification, l.get(r.symbol)?.classification ?? null));
  const flips = latest.filter(r => { const o = p.get(r.symbol); return o && o.classification !== r.classification; })
    .map(r => row(r, p.get(r.symbol)!.classification, r.classification));
  const expiredPlans = prev.filter(r => isBuy(r) && r.valid_until != null && new Date(r.valid_until).getTime() <= now.getTime())
    .map(r => ({ symbol: r.symbol, valid_until: r.valid_until, score: r.unified_score }));
  const byScore = <T extends { score: number | null }>(a: T[]) => a.sort((x, y) => (y.score ?? -1) - (x.score ?? -1));
  return { newBuys: byScore(newBuys), dropped: byScore(dropped), flips: byScore(flips), expiredPlans: byScore(expiredPlans) };
}

type Bar = { date: string; high: number | null; low: number | null };
type PlanLevels = { computed_at: string; valid_until: string | Date | null; stop_loss: number | null; target_1: number | null };

// Which level the price touched first after the plan day. A bar touching both counts as the stop
// (we cannot see the intraday order). Assumes the plan was filled; it is not a graded trade.
export function planFirstTouch(plan: PlanLevels, bars: Bar[], now: Date = new Date()):
  { result: 'T1' | 'SL' | 'EXPIRED' | 'OPEN' | 'NO_LEVELS'; date: string | null } {
  if (plan.stop_loss == null || plan.target_1 == null) return { result: 'NO_LEVELS', date: null };
  const start = plan.computed_at.slice(0, 10);
  const end = plan.valid_until ? new Date(plan.valid_until).toISOString().slice(0, 10) : null;
  for (const b of [...bars].sort((a, c) => a.date.localeCompare(c.date))) {
    if (b.date <= start || (end && b.date > end)) continue;
    if (b.low != null && b.low <= plan.stop_loss) return { result: 'SL', date: b.date };
    if (b.high != null && b.high >= plan.target_1) return { result: 'T1', date: b.date };
  }
  const expired = plan.valid_until != null && new Date(plan.valid_until).getTime() <= now.getTime();
  return { result: expired ? 'EXPIRED' : 'OPEN', date: null };
}

// Objective regime: index close vs its own 200-session mean. Not the HMM.
export function objectiveRegime(closesNewestFirst: number[]) {
  if (closesNewestFirst.length < 200) return null;
  const last = closesNewestFirst[0];
  const mean = closesNewestFirst.slice(0, 200).reduce((s, x) => s + x, 0) / 200;
  const distPct = (last / mean - 1) * 100;
  return { label: distPct >= 0 ? 'ABOVE 200D MEAN' as const : 'BELOW 200D MEAN' as const, close: last, mean200: mean, distPct };
}

export const edgeRouter = router({
  getEdgeStatus: publicProcedure.query(async () => {
    const rows = await dbAll<{ key: string; value: string | null; asof: string | null }>(
      `SELECT key, value, CAST("updatedAt" AS TEXT) AS asof FROM app_settings
       WHERE key IN ('forward_test_report', 'accuracy_scorecard')`);
    const get = (k: string) => rows.find(r => r.key === k);
    const forwardTest = parsePyJson<ForwardTestReport>(get('forward_test_report')?.value);
    const since = forwardTest?.blocks?.forward?.since ?? null;
    return {
      forwardTest,
      forwardTestAsOf: get('forward_test_report')?.asof ?? null,
      scorecard: parsePyJson<Record<string, unknown>>(get('accuracy_scorecard')?.value),
      scorecardAsOf: get('accuracy_scorecard')?.asof ?? null,
      minIndependentWindows: MIN_DATES_RELIABLE,
      calendarBlockedUntil: Object.fromEntries([5, 10, 21].map(h => [String(h), calendarBlockedUntil(since, h)])) as Record<string, string | null>,
    };
  }),

  getWhatChanged: publicProcedure.query(async () => {
    const latestRow = await dbGet<{ d: string | null }>('SELECT CAST(MAX(computed_at) AS TEXT) AS d FROM unified_recommendations');
    const latest = latestRow?.d ?? null;
    const prevRow = latest
      ? await dbGet<{ d: string | null }>('SELECT CAST(MAX(computed_at) AS TEXT) AS d FROM unified_recommendations WHERE computed_at < ?', [latest])
      : null;
    const previous = prevRow?.d ?? null;
    const empty = { latest, previous, newBuys: [], dropped: [], flips: [], expiredPlans: [], counts: { latestBuys: 0, previousBuys: 0 } };
    if (!latest || !previous) return empty;
    const rows = await dbAll<SnapRow & { d: string }>(
      `SELECT symbol, classification, unified_score, valid_until, CAST(computed_at AS TEXT) AS d
       FROM unified_recommendations WHERE computed_at IN (?, ?)`, [latest, previous]);
    const prev = rows.filter(r => r.d === previous);
    const cur = rows.filter(r => r.d === latest);
    return {
      latest, previous, ...diffSnapshots(prev, cur),
      counts: { latestBuys: cur.filter(r => BUY.has(r.classification ?? '')).length, previousBuys: prev.filter(r => BUY.has(r.classification ?? '')).length },
    };
  }),

  getReliabilityCurve: publicProcedure.query(async () => {
    // technical signals, 5-session horizon, last 365 days, suspect rows out.
    const base = `
      FROM signal_outcomes so
      JOIN technical_signals ts ON ts.symbol = so.symbol AND ts.date = so.signal_date
      WHERE so.signal_source = 'technical' AND so.horizon_days = 5
        AND COALESCE(so.is_suspect, 0) = 0
        AND ts.calibrated_win_probability IS NOT NULL
        AND so.signal_date >= CURRENT_DATE - 365`;
    const decisive = `${base} AND so.outcome IN ('WIN', 'LOSS', 'STOP_LOSS')`;
    const y = `CASE WHEN so.outcome = 'WIN' THEN 1.0 ELSE 0.0 END`;
    const [bins, tot, deciles] = await Promise.all([
      dbAll<any>(`
        SELECT LEAST(GREATEST(width_bucket(ts.calibrated_win_probability, 0, 1, 10), 1), 10)::int AS bin,
               COUNT(*)::int AS n, COUNT(DISTINCT so.signal_date)::int AS dates,
               AVG(ts.calibrated_win_probability)::float8 AS predicted, AVG(${y})::float8 AS realised
        ${decisive} GROUP BY 1 ORDER BY 1`),
      dbGet<any>(`
        SELECT COUNT(*)::int AS n, COUNT(DISTINCT so.signal_date)::int AS dates, AVG(${y})::float8 AS base_rate,
               AVG(POWER(ts.calibrated_win_probability - ${y}, 2))::float8 AS brier,
               CAST(MAX(so.signal_date) AS TEXT) AS asof
        ${decisive}`),
      dbAll<any>(`
        SELECT decile::int AS decile, COUNT(*)::int AS n, COUNT(DISTINCT signal_date)::int AS dates,
               AVG(p)::float8 AS predicted, AVG(return_pct)::float8 AS mean_return_pct
        FROM (SELECT NTILE(10) OVER (ORDER BY ts.calibrated_win_probability) AS decile,
                     ts.calibrated_win_probability AS p, so.return_pct, so.signal_date
              ${base} AND so.outcome IS NOT NULL AND so.outcome <> 'PENDING' AND so.return_pct IS NOT NULL) q
        GROUP BY 1 ORDER BY 1`),
    ]);
    return {
      bins: bins.map((b: any) => ({ ...b, lo: (b.bin - 1) / 10, hi: b.bin / 10 })),
      deciles,
      n: tot?.n ?? 0,
      dates: tot?.dates ?? 0,
      baseRate: tot?.base_rate ?? null,
      brier: tot?.brier ?? null,
      asOf: tot?.asof ?? null,
      source: "signal_outcomes (technical, 5-session horizon, last 365 days) joined to technical_signals.calibrated_win_probability",
      roundTripCostPct: 0.5,
    };
  }),

  getPlanTimeline: publicProcedure
    .input(z.object({ symbol: z.string().min(1).max(40), limit: z.number().min(1).max(30).default(10) }))
    .query(async ({ input }) => {
      const plans = await dbAll<any>(`
        SELECT CAST(computed_at AS TEXT) AS computed_at, CAST(generated_at AS TEXT) AS generated_at,
               CAST(valid_until AS TEXT) AS valid_until, classification, timeframe, unified_score,
               entry_zone_low, entry_zone_high, stop_loss, target_1, target_2
        FROM unified_recommendations WHERE symbol = ?
        ORDER BY computed_at DESC LIMIT ?`, [input.symbol, input.limit]);
      if (plans.length === 0) return { symbol: input.symbol, plans: [], lastBar: null };
      const from = plans[plans.length - 1].computed_at.slice(0, 10);
      const [bars, outcomes] = await Promise.all([
        dbAll<Bar & { close: number | null }>(`
          SELECT CAST(date AS TEXT) AS date, high, low, close FROM stock_ohlcv
          WHERE symbol = ? AND date > CAST(? AS DATE) ORDER BY date`, [input.symbol, from]),
        dbAll<any>(`
          SELECT CAST(signal_date AS TEXT) AS signal_date, signal_source, horizon_days::int AS horizon_days,
                 outcome, exit_reason, return_pct, CAST(check_date AS TEXT) AS check_date
          FROM unified_signal_outcomes
          WHERE symbol = ? AND signal_date >= CAST(? AS DATE)
          ORDER BY signal_date DESC, horizon_days`, [input.symbol, from]),
      ]);
      return {
        symbol: input.symbol,
        lastBar: bars.length ? bars[bars.length - 1] : null,
        plans: plans.map(p => ({
          ...p,
          firstTouch: planFirstTouch(p, bars),
          signalOutcomes: outcomes.filter(o => o.signal_date === p.computed_at.slice(0, 10)),
        })),
      };
    }),

  getMarketPulse: publicProcedure.query(async () => {
    const dates = await dbAll<{ d: string }>(`
      SELECT DISTINCT CAST(date AS TEXT) AS d FROM stock_ohlcv
      WHERE date >= CURRENT_DATE - 14 ORDER BY d DESC LIMIT 2`);
    const [latest, prev] = [dates[0]?.d ?? null, dates[1]?.d ?? null];
    const [breadth, vix, fii, nifty] = await Promise.all([
      latest && prev ? dbGet<any>(`
        SELECT SUM(CASE WHEN a.close > b.close THEN 1 ELSE 0 END)::int AS advances,
               SUM(CASE WHEN a.close < b.close THEN 1 ELSE 0 END)::int AS declines,
               SUM(CASE WHEN a.close = b.close THEN 1 ELSE 0 END)::int AS unchanged
        FROM stock_ohlcv a
        JOIN stock_ohlcv b ON b.symbol = a.symbol AND b.date = CAST(? AS DATE)
        WHERE a.date = CAST(? AS DATE)
          AND EXISTS (SELECT 1 FROM nse_stocks n WHERE n.symbol = a.symbol)`, [prev, latest]) : null,
      dbGet<any>(`SELECT vix::float8 AS value, computed_at AS asof FROM intraday_regime_history
                  WHERE vix IS NOT NULL ORDER BY computed_at DESC LIMIT 1`),
      dbGet<any>(`SELECT CAST(date AS TEXT) AS date, fii_net::float8 AS fii_net, dii_net::float8 AS dii_net, source
                  FROM fii_dii_flow ORDER BY date DESC LIMIT 1`),
      dbAll<{ date: string; close: number }>(`
        SELECT CAST(date AS TEXT) AS date, close::float8 AS close FROM stock_ohlcv
        WHERE symbol = 'NIFTY50' AND date >= CURRENT_DATE - 420 AND close IS NOT NULL
        ORDER BY date DESC LIMIT 200`),
    ]);
    return {
      breadth: breadth ? { ...breadth, asOf: latest, vsDate: prev, source: 'stock_ohlcv close vs previous session, NSE-listed equities' } : null,
      vix: vix ? { value: vix.value, asOf: vix.asof, source: 'intraday_regime_history' } : null,
      fiiDii: fii ? { ...fii, unit: 'Rs Cr (cash segment, net)' } : null,
      regime: objectiveRegime(nifty.map(r => r.close)),
      regimeAsOf: nifty[0]?.date ?? null,
      regimeSessions: nifty.length,
    };
  }),

  // Event-risk flags for the Alpha cards (getCommandCenter does not carry them). Latest COMPLETE
  // technical_signals day, never the partial MAX(date).
  getEarningsFlags: publicProcedure
    .input(z.object({ symbols: z.array(z.string()).max(100) }))
    .query(async ({ input }) => {
      if (input.symbols.length === 0) return { asOf: null, rows: [] };
      const rows = await dbAll<any>(`
        SELECT symbol, CAST(date AS TEXT) AS date, days_to_next_results, eps_surprise_q1, eps_beat_streak
        FROM technical_signals
        WHERE date = ${LATEST_COMPLETE_TS_DATE_SQL}
          AND symbol IN (${input.symbols.map(() => '?').join(', ')})`, input.symbols);
      return { asOf: rows[0]?.date ?? null, rows };
    }),
});
