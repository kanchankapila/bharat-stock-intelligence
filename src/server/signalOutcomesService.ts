import { dbAll } from './dbAsync';

export type OutcomeResult = 'WIN' | 'LOSS' | 'NEUTRAL' | 'PENDING';
export type HorizonDays = 5 | 15;

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

export interface WinRateStats {
  overall: {
    total: number;
    wins: number;
    losses: number;
    winRate: number;
    avgReturn: number;
    avgWin: number;
    avgLoss: number;
  };
  bySignalType: Record<string, { total: number; wins: number; winRate: number; avgReturn: number }>;
  byHorizon: Record<HorizonDays, { total: number; wins: number; winRate: number; avgReturn: number }>;
  byScoreBucket: Record<string, { total: number; wins: number; winRate: number; avgReturn: number }>;
  recentOutcomes: OutcomeRow[];
  /** Which labeling convention every number above was computed under. Surfaced so a consumer
   *  can disclose it: `.claude/rules/measurement.md` records path_barrier and terminal_pct2
   *  producing 88-91% vs 41-44% win rates over the IDENTICAL calendar window, so a win rate
   *  quoted without its label definition is not a comparable number. */
  labelDefinition: 'path_barrier';
}

// The grader that lived here (computeSignalOutcomes) was retired 2026-09-30 (AF-20260930-31):
// it wrote the same signal_outcomes key as outcome_resolver.py under a different rule.

export async function getWinRateStats(): Promise<WinRateStats> {
  // signal_source='technical' (2026-08): confluence-sourced rows use an incompatible fixed
  // +/-2% labeling threshold -- blending both into one win-rate report would mix two different
  // questions, matching every other signal-accuracy consumer's choice in this codebase.
  //
  // label_definition='path_barrier' added 2026-08-15: signal_source alone is NOT a reliable
  // proxy for the labeling convention, which is what actually has to be uniform here. Measured
  // live, signal_source='technical' resolves to THREE groups, not one:
  //     path_barrier   198,723 rows   68.7% win
  //     (NULL)           1,722 rows   99.4% win   <-- unlabeled, 2026-07-21..2026-08-02
  //     confluence/terminal_pct2 is the separate 318,292-row family already excluded above
  // The 1,722 unlabeled rows sit INSIDE path_barrier's own date range (2026-05-16..2026-08-13),
  // so they are not old data safely below the window -- `ORDER BY signal_date DESC LIMIT 2000`
  // had no label filter at all, and the only reason they aren't in today's result is that
  // recent signal volume happens to fill 2,000 rows from 2026-08-13 alone. A few low-volume
  // days and the window reaches past 2026-08-02 and silently mixes a 99.4%-win-rate slice into
  // the headline accuracy number, with nothing failing or looking wrong.
  //
  // Filter on the thing that must be uniform, not on a proxy for it. Same shape as
  // `.claude/rules/recurring-bugs.md`'s "enum-ish column with two spellings defeats an IN list"
  // -- a filter that is correct only by coincidence of the current data distribution.
  const rows = await dbAll(`
    SELECT * FROM signal_outcomes
    WHERE outcome != 'PENDING' AND signal_source = 'technical'
      AND label_definition = 'path_barrier'
    ORDER BY signal_date DESC LIMIT 2000
  `) as OutcomeRow[];

  const empty = { total: 0, wins: 0, winRate: 0, avgReturn: 0 };

  const overall = { total: 0, wins: 0, losses: 0, winRate: 0, avgReturn: 0, avgWin: 0, avgLoss: 0 };
  const bySignalType: Record<string, { total: number; wins: number; winRate: number; avgReturn: number; _sumRet: number }> = {};
  const byHorizon: Record<number, { total: number; wins: number; winRate: number; avgReturn: number; _sumRet: number }> = {};
  const byScoreBucket: Record<string, { total: number; wins: number; winRate: number; avgReturn: number; _sumRet: number }> = {};

  for (const r of rows) {
    const ret = r.return_pct ?? 0;
    overall.total++;
    if (r.outcome === 'WIN') overall.wins++;
    if (r.outcome === 'LOSS') overall.losses++;
    overall.avgReturn += ret;

    // By horizon
    const h = r.horizon_days;
    if (!byHorizon[h]) byHorizon[h] = { ...empty, _sumRet: 0 } as typeof byHorizon[number];
    byHorizon[h].total++;
    if (r.outcome === 'WIN') byHorizon[h].wins++;
    byHorizon[h]._sumRet += ret;

    // By score bucket
    const bucket = (r.signal_score ?? 0) >= 7 ? '7-10' : (r.signal_score ?? 0) >= 4 ? '4-6' : '1-3';
    if (!byScoreBucket[bucket]) byScoreBucket[bucket] = { ...empty, _sumRet: 0 } as typeof byScoreBucket[string];
    byScoreBucket[bucket].total++;
    if (r.outcome === 'WIN') byScoreBucket[bucket].wins++;
    byScoreBucket[bucket]._sumRet += ret;

    // By signal type
    try {
      const sigs = JSON.parse(r.signals_json ?? '[]') as { type: string }[];
      for (const s of sigs) {
        if (!bySignalType[s.type]) bySignalType[s.type] = { ...empty, _sumRet: 0 } as typeof bySignalType[string];
        bySignalType[s.type].total++;
        if (r.outcome === 'WIN') bySignalType[s.type].wins++;
        bySignalType[s.type]._sumRet += ret;
      }
    } catch { /* skip */ }
  }

  // Finalise aggregates
  if (overall.total > 0) {
    overall.winRate   = (overall.wins / overall.total) * 100;
    overall.avgReturn = overall.avgReturn / overall.total;
    const winRows  = rows.filter(r => r.outcome === 'WIN');
    const lossRows = rows.filter(r => r.outcome === 'LOSS');
    overall.avgWin  = winRows.length  > 0 ? winRows.reduce( (a, r) => a + (r.return_pct ?? 0), 0) / winRows.length  : 0;
    overall.avgLoss = lossRows.length > 0 ? lossRows.reduce((a, r) => a + (r.return_pct ?? 0), 0) / lossRows.length : 0;
  }

  for (const v of Object.values(byHorizon)) {
    v.winRate  = v.total > 0 ? (v.wins / v.total) * 100 : 0;
    v.avgReturn = v.total > 0 ? (v as typeof v & { _sumRet: number })._sumRet / v.total : 0;
  }
  for (const v of Object.values(byScoreBucket)) {
    v.winRate  = v.total > 0 ? (v.wins / v.total) * 100 : 0;
    v.avgReturn = v.total > 0 ? (v as typeof v & { _sumRet: number })._sumRet / v.total : 0;
  }
  for (const v of Object.values(bySignalType)) {
    v.winRate  = v.total > 0 ? (v.wins / v.total) * 100 : 0;
    v.avgReturn = v.total > 0 ? (v as typeof v & { _sumRet: number })._sumRet / v.total : 0;
  }

  const recentOutcomes = rows.slice(0, 50);

  return {
    labelDefinition: 'path_barrier',
    overall,
    bySignalType: Object.fromEntries(
      Object.entries(bySignalType).map(([k, v]) => [k, { total: v.total, wins: v.wins, winRate: v.winRate, avgReturn: v.avgReturn }])
    ),
    byHorizon: {
      5:  byHorizon[5]  ? { total: byHorizon[5].total,  wins: byHorizon[5].wins,  winRate: byHorizon[5].winRate,  avgReturn: byHorizon[5].avgReturn }  : { ...empty },
      15: byHorizon[15] ? { total: byHorizon[15].total, wins: byHorizon[15].wins, winRate: byHorizon[15].winRate, avgReturn: byHorizon[15].avgReturn } : { ...empty },
    },
    byScoreBucket: Object.fromEntries(
      Object.entries(byScoreBucket).map(([k, v]) => [k, { total: v.total, wins: v.wins, winRate: v.winRate, avgReturn: v.avgReturn }])
    ),
    recentOutcomes,
  };
}

export async function getOutcomesForSignalDate(signalDate: string): Promise<OutcomeRow[]> {
  return await dbAll(`
    SELECT * FROM signal_outcomes WHERE signal_date = ? AND signal_source = 'technical' ORDER BY return_pct DESC
  `, [signalDate]) as OutcomeRow[];
}
