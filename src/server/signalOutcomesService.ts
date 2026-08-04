import { dbAll, dbTransaction } from './dbAsync';

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
}

// signal_source='technical' (2026-08): this grades technical_signals rows -- the same source
// bucket as outcome_resolver.py's resolve_outcomes(), which runs on its own independent
// schedule against the same (symbol, signal_date, horizon_days=5|15). Before signal_source
// existed, both writers' dedup guards matched on ANY row for that key regardless of writer, so
// whichever ran first silently blocked the other. Stamping 'technical' here lets ON CONFLICT
// correctly update-in-place when either writer re-touches the same key, instead of colliding
// with the unrelated confluence_outcome_tracker.py writer that also shares this table.
const UPSERT_OUTCOME_SQL = `
  INSERT INTO signal_outcomes (
    symbol, signal_date, horizon_days, entry_price,
    check_date, exit_price, return_pct, max_return_pct, outcome,
    signal_score, signals_json, computed_at, signal_source
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, 'technical')
  ON CONFLICT(symbol, signal_date, horizon_days, signal_source) DO UPDATE SET
    check_date=excluded.check_date, exit_price=excluded.exit_price,
    return_pct=excluded.return_pct, max_return_pct=excluded.max_return_pct,
    outcome=excluded.outcome, computed_at=excluded.computed_at
`;

export async function computeSignalOutcomes(horizonDays: HorizonDays = 5): Promise<{
  processed: number;
  resolved: number;
}> {
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - horizonDays);
  const cutoff = cutoffDate.toISOString().slice(0, 10);

  // Find signals from `horizonDays` ago that haven't been resolved yet
  const pending = await dbAll(`
    SELECT ts.symbol, ts.date as signal_date, ts.cmp as entry_price,
           ts.signal_score, ts.signals_json, ts.stop_loss
    FROM technical_signals ts
    WHERE ts.date <= ?
      AND NOT EXISTS (
        SELECT 1 FROM signal_outcomes so
        WHERE so.symbol = ts.symbol
          AND so.signal_date = ts.date
          AND so.horizon_days = ?
          AND so.outcome != 'PENDING'
          AND so.signal_source = 'technical'
      )
    ORDER BY ts.date DESC
    LIMIT 500
  `, [cutoff, horizonDays]) as {
    symbol: string; signal_date: string; entry_price: number;
    signal_score: number; signals_json: string; stop_loss: number | null;
  }[];

  if (pending.length === 0) return { processed: 0, resolved: 0 };

  // Pre-load stock_ohlcv for every symbol in this batch once, instead of up to 3
  // sequential per-row queries x 500 rows. Window starts at the earliest signal_date
  // in the batch (open-ended upper bound, same as the original unbounded exit-row scan).
  const symbols = [...new Set(pending.map(r => r.symbol))];
  const minSignalDate = pending.reduce(
    (min, r) => (r.signal_date < min ? r.signal_date : min),
    pending[0].signal_date,
  );
  const placeholders = symbols.map(() => '?').join(',');
  const ohlcvRows = await dbAll(
    `SELECT symbol, date, low, high, close FROM stock_ohlcv
     WHERE symbol IN (${placeholders}) AND date > ?
     ORDER BY symbol, date`,
    [...symbols, minSignalDate],
  ) as { symbol: string; date: unknown; low: number; high: number; close: number }[];

  // Postgres returns DATE columns as JS Date objects (local midnight) — toISOString()
  // converts to UTC and can shift the calendar day (e.g. IST midnight -> prior-day UTC).
  // Local getFullYear/getMonth/getDate reconstruct the exact DB value instead.
  const toDateStr = (d: unknown): string => {
    if (d instanceof Date) {
      const y = d.getFullYear();
      const m = String(d.getMonth() + 1).padStart(2, '0');
      const day = String(d.getDate()).padStart(2, '0');
      return `${y}-${m}-${day}`;
    }
    return String(d).slice(0, 10);
  };

  const bySymbol = new Map<string, { date: string; low: number; high: number; close: number }[]>();
  for (const bar of ohlcvRows) {
    let arr = bySymbol.get(bar.symbol);
    if (!arr) { arr = []; bySymbol.set(bar.symbol, arr); }
    arr.push({ date: toDateStr(bar.date), low: bar.low, high: bar.high, close: bar.close });
  }
  // Already ORDER BY symbol, date — each per-symbol array is ascending by date.

  let resolved = 0;

  await dbTransaction(async (tx) => {
    for (const row of pending) {
      // Find the closest trading day at or after the target exit date
      const targetDate = new Date(row.signal_date);
      targetDate.setDate(targetDate.getDate() + horizonDays);
      const targetStr = targetDate.toISOString().slice(0, 10);

      const series = bySymbol.get(row.symbol) ?? [];

      // Check for stop-loss hit before target exit date
      let stopLossRow: { date: string } | undefined;
      if (row.stop_loss != null) {
        for (const bar of series) {
          if (bar.date <= row.signal_date) continue;
          if (bar.date > targetStr) break;
          if (bar.low <= row.stop_loss) { stopLossRow = { date: bar.date }; break; }
        }
      }

      if (stopLossRow) {
        const stopReturnPct = ((row.stop_loss! - row.entry_price) / row.entry_price) * 100;
        await tx.run(UPSERT_OUTCOME_SQL, [
          row.symbol, row.signal_date, horizonDays, row.entry_price,
          stopLossRow.date, row.stop_loss, stopReturnPct, null, 'LOSS',
          row.signal_score, row.signals_json,
        ]);
        resolved++;
        continue;
      }

      // Check MAX(high) over the full horizon for WIN detection
      let maxHigh: number | null = null;
      for (const bar of series) {
        if (bar.date <= row.signal_date) continue;
        if (bar.date > targetStr) break;
        if (maxHigh == null || bar.high > maxHigh) maxHigh = bar.high;
      }
      const maxReturnPct = maxHigh != null
        ? ((maxHigh - row.entry_price) / row.entry_price) * 100
        : null;

      if (maxReturnPct != null && maxReturnPct > 2.0) {
        // Hit target intraday at some point during the horizon — WIN
        await tx.run(UPSERT_OUTCOME_SQL, [
          row.symbol, row.signal_date, horizonDays, row.entry_price,
          targetStr, maxHigh, maxReturnPct, maxReturnPct, 'WIN',
          row.signal_score, row.signals_json,
        ]);
        resolved++;
        continue;
      }

      // No WIN from max high — fall back to terminal close for LOSS/NEUTRAL
      let exitRow: { date: string; close: number } | undefined;
      for (const bar of series) {
        if (bar.date >= targetStr) { exitRow = { date: bar.date, close: bar.close }; break; }
      }

      if (!exitRow) {
        // No exit data yet — record as PENDING
        await tx.run(UPSERT_OUTCOME_SQL, [
          row.symbol, row.signal_date, horizonDays, row.entry_price,
          null, null, null, maxReturnPct, 'PENDING',
          row.signal_score, row.signals_json,
        ]);
        continue;
      }

      const returnPct = ((exitRow.close - row.entry_price) / row.entry_price) * 100;
      const outcome: OutcomeResult = returnPct < -1.0 ? 'LOSS' : 'NEUTRAL';

      await tx.run(UPSERT_OUTCOME_SQL, [
        row.symbol, row.signal_date, horizonDays, row.entry_price,
        exitRow.date, exitRow.close, returnPct, maxReturnPct, outcome,
        row.signal_score, row.signals_json,
      ]);
      resolved++;
    }
  });

  console.log(`[OUTCOMES] horizon=${horizonDays}d: checked ${pending.length}, resolved ${resolved}`);
  return { processed: pending.length, resolved };
}

export async function getWinRateStats(): Promise<WinRateStats> {
  // signal_source='technical' (2026-08): confluence-sourced rows use an incompatible fixed
  // +/-2% labeling threshold -- blending both into one win-rate report would mix two different
  // questions, matching every other signal-accuracy consumer's choice in this codebase.
  const rows = await dbAll(`
    SELECT * FROM signal_outcomes WHERE outcome != 'PENDING' AND signal_source = 'technical'
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
