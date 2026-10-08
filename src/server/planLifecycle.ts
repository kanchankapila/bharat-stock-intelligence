export type PlanStatus = 'ACTIVE' | 'EXPIRED' | 'UNKNOWN';

// A ranker plan has no status column (a fifth signal table is forbidden and the grid is rewritten
// nightly); its lifecycle is the window `unified_ranker.valid_until_for` stamped on it.
export function planStatus(validUntil: string | Date | null | undefined, now: Date = new Date()): PlanStatus {
  if (validUntil == null) return 'UNKNOWN';
  const t = new Date(validUntil).getTime();
  if (Number.isNaN(t)) return 'UNKNOWN';
  return t > now.getTime() ? 'ACTIVE' : 'EXPIRED';
}
