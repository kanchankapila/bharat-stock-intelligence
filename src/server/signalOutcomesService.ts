import { dbAll } from './dbAsync';

export type OutcomeResult = 'WIN' | 'LOSS' | 'NEUTRAL' | 'PENDING';
export type HorizonDays = 1 | 5 | 15;

/** The horizon the headline (`overall`, `byScoreBucket`, `bySignalType`) is computed at. */
export const HEADLINE_HORIZON: HorizonDays = 5;
/** Trailing window of signal dates, anchored to the newest graded date (not to today). */
export const WINDOW_DAYS = 60;

interface OutcomeRow {
  symbol: string;
  signal_date: string;
  horizon_days: number;
  entry_price: number;
  check_date: string | null;
  exit_price: number | null;
  return_pct: number | null;
  max_return_pct: number | null;
  outcome: OutcomeResult;
  signal_score: number | null;
  signals_json: string | null;
}

type Bucket = { total: number; wins: number; winRate: number; avgReturn: number };

export interface WinRateStats {
  overall: Bucket & { losses: number; avgWin: number; avgLoss: number; signalDates: number };
  /** `overall` is ONE horizon, never a pool of horizons (AF-20261001-35). */
  overallHorizonDays: HorizonDays;
  /** Distinct signal dates behind each number: overlapping h-session windows mean only about
   *  signalDates / h of them are independent (measurement.md). */
  windowDays: number;
  bySignalType: Record<string, Bucket>;
  byHorizon: Record<HorizonDays, Bucket & { signalDates: number }>;
  byScoreBucket: Record<string, Bucket>;
  recentOutcomes: OutcomeRow[];
  /** Which labeling convention every number above was computed under. Surfaced so a consumer
   *  can disclose it: `.claude/rules/measurement.md` records path_barrier and terminal_pct2
   *  producing 88-91% vs 41-44% win rates over the IDENTICAL calendar window, so a win rate
   *  quoted without its label definition is not a comparable number. */
  labelDefinition: 'path_barrier';
}

// The grader that lived here (computeSignalOutcomes) was retired 2026-09-30 (AF-20260930-31):
// it wrote the same signal_outcomes key as outcome_resolver.py under a different rule.

// One population for every number: technical source, path_barrier label (signal_source alone
// is not label-uniform -- 1,722 unlabeled 99.4%-win rows sat inside the path_barrier range,
// 2026-08-15), a real exit price (an expiry-fabricated NEUTRAL 0.0% has none, AF-20261001-30),
// and a trailing window of signal DATES anchored to the newest graded date. return_pct is net
// of round-trip cost (outcome_resolver.net_return_pct).
//
// It used to be the newest 2000 rows pooled across horizons. At ~2,170 technical signals/day
// that was one day of h1 labels (live 2026-10-01: 1,999 h1 rows, all 2026-09-29) presented as
// the headline win rate, while byHorizon[5]/[15] read empty (AF-20261001-35).
const BASE = `
  FROM signal_outcomes so
  WHERE so.signal_source = 'technical' AND so.label_definition = 'path_barrier'
    AND so.outcome IN ('WIN', 'LOSS', 'NEUTRAL', 'STOP_LOSS')
    AND so.exit_price IS NOT NULL AND so.return_pct IS NOT NULL
    AND so.horizon_days = ?
    AND so.signal_date >= (
      SELECT MAX(s2.signal_date) FROM signal_outcomes s2
      WHERE s2.signal_source = 'technical' AND s2.label_definition = 'path_barrier'
        AND s2.horizon_days = ? AND s2.exit_price IS NOT NULL) - ${WINDOW_DAYS}`;

const AGG = `COUNT(*)::int AS total,
  COUNT(*) FILTER (WHERE so.outcome = 'WIN')::int AS wins,
  COUNT(*) FILTER (WHERE so.outcome IN ('LOSS', 'STOP_LOSS'))::int AS losses,
  COALESCE(AVG(so.return_pct), 0) AS avg_return,
  COALESCE(AVG(so.return_pct) FILTER (WHERE so.outcome = 'WIN'), 0) AS avg_win,
  COALESCE(AVG(so.return_pct) FILTER (WHERE so.outcome IN ('LOSS', 'STOP_LOSS')), 0) AS avg_loss,
  COUNT(DISTINCT so.signal_date)::int AS signal_dates`;

const bucket = (r: any): Bucket => {
  const total = Number(r?.total ?? 0);
  const wins = Number(r?.wins ?? 0);
  return { total, wins, winRate: total ? (wins / total) * 100 : 0, avgReturn: Number(r?.avg_return ?? 0) };
};

export async function getWinRateStats(): Promise<WinRateStats> {
  const h = HEADLINE_HORIZON;
  const byHorizon = {} as WinRateStats['byHorizon'];
  let overall: WinRateStats['overall'] = { ...bucket(null), losses: 0, avgWin: 0, avgLoss: 0, signalDates: 0 };
  for (const hz of [1, 5, 15] as HorizonDays[]) {
    const [r] = await dbAll<any>(`SELECT ${AGG} ${BASE}`, [hz, hz]);
    byHorizon[hz] = { ...bucket(r), signalDates: Number(r?.signal_dates ?? 0) };
    if (hz === h) {
      overall = { ...bucket(r), losses: Number(r?.losses ?? 0), avgWin: Number(r?.avg_win ?? 0),
        avgLoss: Number(r?.avg_loss ?? 0), signalDates: Number(r?.signal_dates ?? 0) };
    }
  }

  const scoreRows = await dbAll<any>(`
    SELECT CASE WHEN COALESCE(so.signal_score, 0) >= 7 THEN '7-10'
                WHEN COALESCE(so.signal_score, 0) >= 4 THEN '4-6' ELSE '1-3' END AS k, ${AGG}
    ${BASE} GROUP BY 1`, [h, h]);
  // signals_json is free text: only well-formed arrays of objects are expanded.
  const typeRows = await dbAll<any>(`
    SELECT e->>'type' AS k, ${AGG}
    ${BASE.replace('FROM signal_outcomes so', `FROM signal_outcomes so
      CROSS JOIN LATERAL jsonb_array_elements(COALESCE(CASE WHEN pg_input_is_valid(so.signals_json, 'jsonb')
        THEN CASE WHEN jsonb_typeof(so.signals_json::jsonb) = 'array' THEN so.signals_json::jsonb END END,
        '[]'::jsonb)) e`)}
      AND jsonb_typeof(e) = 'object' AND e->>'type' IS NOT NULL
    GROUP BY 1`, [h, h]);
  const recentOutcomes = await dbAll<OutcomeRow>(
    `SELECT so.* ${BASE} ORDER BY so.signal_date DESC, so.symbol LIMIT 50`, [h, h]);

  return {
    labelDefinition: 'path_barrier',
    overallHorizonDays: h,
    windowDays: WINDOW_DAYS,
    overall,
    bySignalType: Object.fromEntries(typeRows.map(r => [r.k, bucket(r)])),
    byHorizon,
    byScoreBucket: Object.fromEntries(scoreRows.map(r => [r.k, bucket(r)])),
    recentOutcomes,
  };
}

export async function getOutcomesForSignalDate(signalDate: string): Promise<OutcomeRow[]> {
  return await dbAll(`
    SELECT * FROM signal_outcomes WHERE signal_date = ? AND signal_source = 'technical' ORDER BY return_pct DESC
  `, [signalDate]) as OutcomeRow[];
}
