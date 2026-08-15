/**
 * Shared number/money formatting for the frontend.
 *
 * Measured 2026-08-15 before this existed: 537 raw `.toFixed()` calls, 112 ad-hoc "Cr" suffixes
 * and 91 hand-written `toLocaleString('en-IN')` calls (plus one stray 'en-US') across 155 .tsx
 * files, with no shared helper anywhere -- i.e. every component re-derived rupee formatting, and
 * they do not all agree. That is the single most visible "doesn't feel like a real product"
 * signal on a financial terminal.
 *
 * THE IMPORTANT PART IS THE NULL HANDLING, not the digits. Every function here renders
 * null/undefined/NaN/Infinity as `DASH`, never as 0. This platform's dominant bug class is
 * "missing data rendered as a real value" -- getInstitutionalFlows coercing a NULL dii_net to
 * "0.00" so MoneyFlowPulseWidget drew `+₹0 Cr` on a day it had no data (2026-08-14
 * data-honesty-review), and `float(x or 0)` fabricating a zero score out of a NaN
 * (.claude/rules/recurring-bugs.md). On a stock-analysis surface, "0" is a claim and "—" is an
 * admission; these must not look alike.
 *
 * Adoption is incremental by design: this file is the destination, not a completed migration.
 * Rewriting 537 call sites in one sweep would be a large untested diff across every dashboard,
 * and several of those sites format things that are not money at all.
 */

export const DASH = '—';

/** Null/NaN/Infinity guard shared by every formatter here. Returns null when unrenderable. */
function finite(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Indian digit grouping (1,23,456 — not 123,456). `en-IN` does this natively; spelled out here
 * so no call site has to remember the locale string, and so the one 'en-US' site that existed
 * has somewhere correct to go.
 */
export function formatNumber(value: number | string | null | undefined, decimals = 2): string {
  const n = finite(value);
  if (n === null) return DASH;
  return n.toLocaleString('en-IN', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

/** Rupee amount with the ₹ symbol, Indian grouping. Whole rupees by default — sub-rupee
 *  precision is noise on every screen in this app except an option premium. */
export function formatINR(value: number | string | null | undefined, decimals = 0): string {
  const n = finite(value);
  if (n === null) return DASH;
  return `₹${Math.abs(n).toLocaleString('en-IN', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}`;
}

/**
 * Signed rupee amount — always carries an explicit + or −, for P&L and net-flow figures where
 * the direction is the whole point and an unsigned number is ambiguous.
 */
export function formatINRSigned(value: number | string | null | undefined, decimals = 0): string {
  const n = finite(value);
  if (n === null) return DASH;
  return `${n < 0 ? '−' : '+'}${formatINR(n, decimals)}`;
}

/**
 * Compact Indian magnitude: crore (1e7) and lakh (1e5), matching how NSE/BSE figures are
 * actually quoted here. Falls back to plain grouping below a lakh rather than inventing a unit.
 */
export function formatCr(value: number | string | null | undefined, decimals = 2): string {
  const n = finite(value);
  if (n === null) return DASH;
  const abs = Math.abs(n);
  const sign = n < 0 ? '−' : '';
  if (abs >= 1e7) return `${sign}₹${(abs / 1e7).toFixed(decimals)} Cr`;
  if (abs >= 1e5) return `${sign}₹${(abs / 1e5).toFixed(decimals)} L`;
  return `${sign}${formatINR(abs, 0)}`;
}

/** Percentage. `signed` for change/return figures where direction matters. */
export function formatPct(
  value: number | string | null | undefined,
  decimals = 2,
  signed = false,
): string {
  const n = finite(value);
  if (n === null) return DASH;
  const sign = signed ? (n < 0 ? '−' : '+') : (n < 0 ? '−' : '');
  return `${sign}${Math.abs(n).toFixed(decimals)}%`;
}
