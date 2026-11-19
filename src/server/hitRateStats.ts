/**
 * Uncertainty for the Live Hit Rates rollups (AF-20261119-13).
 *
 * Outcome rows that share a horizon overlap: consecutive daily signals graded over h sessions share
 * h-1 sessions of their window, so `total` overstates the independent evidence by about h. This
 * mirrors forward_test_report.py / factor_edge._effective_dates: independent windows = distinct
 * signal dates / horizon, and a cell below MIN_DATES_RELIABLE independent windows is LOW-DATA.
 * The win-rate interval is a Wilson 95% interval on the decided count deflated by the same factor.
 * Still optimistic: signals on one date are cross-sectionally correlated too.
 */
export const MIN_DATES_RELIABLE = 20; // factor_edge.MIN_DATES_RELIABLE

export interface HitRateUncertainty {
  eff_windows: number | null;
  low_data: boolean;
  win_ci_lo: number | null;
  win_ci_hi: number | null;
}

const num = (v: unknown): number | null => {
  const n = v == null ? NaN : Number(v);
  return Number.isFinite(n) ? n : null;
};

/** Wilson score interval (percent) for `wins` of `n` at z = 1.96. */
export function wilson(wins: number, n: number, z = 1.96): [number, number] | null {
  if (!(n > 0)) return null;
  const p = wins / n;
  const z2 = z * z;
  const centre = (p + z2 / (2 * n)) / (1 + z2 / n);
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / (1 + z2 / n);
  return [Math.max(0, centre - half) * 100, Math.min(1, centre + half) * 100];
}

export function hitRateUncertainty(row: Record<string, unknown>): HitRateUncertainty {
  const dates = num(row.dates);
  const horizon = Math.max(num(row.max_horizon) ?? 1, 1);
  const decided = num(row.decided) ?? 0;
  const wins = num(row.wins) ?? 0;
  if (dates == null || dates <= 0) return { eff_windows: null, low_data: true, win_ci_lo: null, win_ci_hi: null };
  const eff = dates / horizon;
  const shrink = Math.min(1, eff / dates);
  const ci = wilson(wins * shrink, decided * shrink);
  return {
    eff_windows: Math.round(eff * 10) / 10,
    low_data: eff < MIN_DATES_RELIABLE,
    win_ci_lo: ci ? Math.round(ci[0] * 10) / 10 : null,
    win_ci_hi: ci ? Math.round(ci[1] * 10) / 10 : null,
  };
}

export function withUncertainty<T extends Record<string, unknown>>(row: T | undefined | null): (T & HitRateUncertainty) | null {
  return row ? { ...row, ...hitRateUncertainty(row) } : null;
}
