import {
  DASH,
  formatNumber,
  formatINR,
  formatINRSigned,
  formatCr,
  formatPct,
  mlRankLabel,
} from '../../../lib/format';
import { cn } from '../../../lib/utils';

export { DASH, formatNumber, formatINR, formatINRSigned, formatCr, formatPct, mlRankLabel, cn };

/**
 * Directional tone for a change value: 'up' | 'down' | 'neutral'.
 * Null/NaN -> neutral (no claim made about direction when there is no data).
 */
export function toneOf(value: number | null | undefined): 'up' | 'down' | 'neutral' {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return 'neutral';
  if (n > 0) return 'up';
  if (n < 0) return 'down';
  return 'neutral';
}

/**
 * Change chip text with explicit sign + color class, honest about missing data.
 */
export function changeText(value: number | string | null | undefined, decimals = 2): { text: string; cls: string } {
  // Guard null BEFORE coercion: Number(null) is 0, which would render missing data as "+0.00"
  // — the exact fabrication class format.ts's header documents ("0" is a claim, "—" is an
  // admission). Same rule as format.ts's finite(): no value, no claim.
  const n = value === null || value === undefined || value === '' ? NaN : Number(value);
  if (!Number.isFinite(n)) return { text: DASH, cls: 'v7-kpi-change neutral text-[11px]' };
  const sign = n >= 0 ? '+' : '−';
  const base = 'v7-kpi-change text-[11px] font-mono';
  return n > 0
    ? { text: `${sign}${n.toFixed(decimals)}`, cls: `${base} up` }
    : n < 0
    ? { text: `${sign}${Math.abs(n).toFixed(decimals)}`, cls: `${base} down` }
    : { text: `${sign}${n.toFixed(decimals)}`, cls: `${base} neutral` };
}

/** Conviction level -> badge variant. Unranked/null reads neutral, never fabricated. */
export function convictionBadge(level: string | null | undefined) {
  switch (level?.toLowerCase()) {
    case 'high': return { variant: 'elite' as const, label: 'HIGH' };
    case 'medium': return { variant: 'high' as const, label: 'MEDIUM' };
    case 'low': return { variant: 'medium' as const, label: 'LOW' };
    default: return { variant: 'neutral' as const, label: level ?? '—' };
  }
}
