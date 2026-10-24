import { describe, expect, it } from 'vitest';
import { dbAll, dbRun } from '../dbAsync';
import { MODEL_ROC_DIAGNOSTICS_SQL } from '../routers/ml.router';

describe('deployment ROC query contract', () => {
  it('retains the exact weighted counts across horizons, sources, NULL scores and cutoff', async () => {
    for (const [symbol, probability] of [['ROC_REAL', 0.7], ['ROC_NULL', null]] as const) {
      await dbRun(`INSERT INTO technical_signals (symbol, date, nifty_regime, win_probability)
        VALUES (?, '2026-10-01', 'BEAR', ?)`, [symbol, probability]);
    }
    for (const [symbol, horizon, source, outcome] of [
      ['ROC_REAL', 5, 'technical', 'WIN'], ['ROC_REAL', 15, 'technical', 'LOSS'],
      ['ROC_REAL', 1, 'technical', 'WIN'], ['ROC_REAL', 5, 'AI', 'LOSS'],
      ['ROC_NULL', 5, 'technical', 'WIN'],
    ] as const) {
      await dbRun(`INSERT INTO signal_outcomes
        (symbol, signal_date, horizon_days, entry_price, signal_source, outcome)
        VALUES (?, '2026-10-01', ?, 100, ?, ?)`, [symbol, horizon, source, outcome]);
    }
    const rows = await dbAll<any>(MODEL_ROC_DIAGNOSTICS_SQL, ['2026-10-01', '2026-10-01']);
    expect(rows).toHaveLength(1);
    expect(rows[0].regime).toBe('BEAR');
    expect(Number(rows[0].wins)).toBe(2);
    expect(Number(rows[0].losses)).toBe(1);
    expect(await dbAll(MODEL_ROC_DIAGNOSTICS_SQL, ['2026-10-02', '2026-10-02'])).toEqual([]);
  });
});
