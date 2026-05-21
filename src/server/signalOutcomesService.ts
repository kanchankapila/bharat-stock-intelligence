import db from './db';

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

export function computeSignalOutcomes(horizonDays: HorizonDays = 5): {
  processed: number;
  resolved: number;
} {
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - horizonDays);
  const cutoff = cutoffDate.toISOString().slice(0, 10);

  // Find signals from `horizonDays` ago that haven't been resolved yet
  const pending = db.prepare(`
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
      )
    ORDER BY ts.date DESC
    LIMIT 500
  `).all(cutoff, horizonDays) as {
    symbol: string; signal_date: string; entry_price: number;
    signal_score: number; signals_json: string; stop_loss: number | null;
  }[];

  if (pending.length === 0) return { processed: 0, resolved: 0 };

  const upsert = db.prepare(`
    INSERT INTO signal_outcomes (
      symbol, signal_date, horizon_days, entry_price,
      check_date, exit_price, return_pct, outcome,
      signal_score, signals_json, computed_at
    ) VALUES (
      @symbol, @signal_date, @horizon_days, @entry_price,
      @check_date, @exit_price, @return_pct, @outcome,
      @signal_score, @signals_json, CURRENT_TIMESTAMP
    )
    ON CONFLICT(symbol, signal_date, horizon_days) DO UPDATE SET
      check_date=excluded.check_date, exit_price=excluded.exit_price,
      return_pct=excluded.return_pct, outcome=excluded.outcome,
      computed_at=excluded.computed_at
  `);

  let resolved = 0;

  db.transaction(() => {
    for (const row of pending) {
      // Find the closest trading day at or after the target exit date
      const targetDate = new Date(row.signal_date);
      targetDate.setDate(targetDate.getDate() + horizonDays);
      const targetStr = targetDate.toISOString().slice(0, 10);

      // Check for stop-loss hit before target exit date
      const stopLossRow = db.prepare(`
        SELECT date FROM stock_ohlcv
        WHERE symbol = ? AND date > ? AND date <= ?
          AND low <= ?
        ORDER BY date ASC LIMIT 1
      `).get(row.symbol, row.signal_date, targetStr, row.stop_loss) as { date: string } | undefined;

      if (stopLossRow) {
        const stopReturnPct = ((row.stop_loss! - row.entry_price) / row.entry_price) * 100;
        upsert.run({
          symbol: row.symbol, signal_date: row.signal_date,
          horizon_days: horizonDays, entry_price: row.entry_price,
          check_date: stopLossRow.date, exit_price: row.stop_loss,
          return_pct: stopReturnPct, outcome: 'LOSS',
          signal_score: row.signal_score, signals_json: row.signals_json,
        });
        resolved++;
        continue;
      }

      const exitRow = db.prepare(`
        SELECT date, close FROM stock_ohlcv
        WHERE symbol = ? AND date >= ?
        ORDER BY date ASC LIMIT 1
      `).get(row.symbol, targetStr) as { date: string; close: number } | undefined;

      if (!exitRow) {
        // No exit data yet — record as PENDING
        upsert.run({
          symbol: row.symbol, signal_date: row.signal_date,
          horizon_days: horizonDays, entry_price: row.entry_price,
          check_date: null, exit_price: null, return_pct: null,
          outcome: 'PENDING', signal_score: row.signal_score,
          signals_json: row.signals_json,
        });
        continue;
      }

      const returnPct = ((exitRow.close - row.entry_price) / row.entry_price) * 100;
      const outcome: OutcomeResult =
        returnPct > 1.0  ? 'WIN'  :
        returnPct < -1.0 ? 'LOSS' : 'NEUTRAL';

      upsert.run({
        symbol: row.symbol, signal_date: row.signal_date,
        horizon_days: horizonDays, entry_price: row.entry_price,
        check_date: exitRow.date, exit_price: exitRow.close,
        return_pct: returnPct, outcome,
        signal_score: row.signal_score, signals_json: row.signals_json,
      });
      resolved++;
    }
  })();

  console.log(`[OUTCOMES] horizon=${horizonDays}d: checked ${pending.length}, resolved ${resolved}`);
  return { processed: pending.length, resolved };
}

export function getWinRateStats(): WinRateStats {
  const rows = db.prepare(`
    SELECT * FROM signal_outcomes WHERE outcome != 'PENDING'
    ORDER BY signal_date DESC LIMIT 2000
  `).all() as OutcomeRow[];

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

export function getOutcomesForSignalDate(signalDate: string): OutcomeRow[] {
  return db.prepare(`
    SELECT * FROM signal_outcomes WHERE signal_date = ? ORDER BY return_pct DESC
  `).all(signalDate) as OutcomeRow[];
}
