/**
 * Formatting primitives for the TALA desk.
 *
 * Every price/pct on this surface flows through here rather than through ad-hoc
 * `.toFixed()` calls at the call site, for two reasons that matter on a trading
 * screen: (1) a missing value must render as an em dash and never as "0.00" —
 * "PCR 0" and "no PCR data" are completely different facts to a trader and
 * conflating them is how people size wrong; (2) Indian numbering (lakh/crore) is
 * what the audience actually reads, so the big-number formatters use it.
 */

export const DASH = '—';

/** Coerce anything (including Postgres numeric strings and NaN) to a finite number, or null. */
export function num(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : parseFloat(String(v).replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

/** Format a price with Indian digit grouping and 2dp. Null-safe. */
export function price(v: unknown, dp = 2): string {
  const n = num(v);
  if (n === null) return DASH;
  return n.toLocaleString('en-IN', { minimumFractionDigits: dp, maximumFractionDigits: dp });
}

/** Format a signed percentage from a value already expressed in percent units (3.25 -> "+3.25%"). */
export function pct(v: unknown, dp = 2): string {
  const n = num(v);
  if (n === null) return DASH;
  return `${n > 0 ? '+' : ''}${n.toFixed(dp)}%`;
}

/** Format a ratio/fraction as a percent (0.5269 -> "52.7%"). For fields stored 0..1. */
export function frac(v: unknown, dp = 1): string {
  const n = num(v);
  if (n === null) return DASH;
  return `${(n * 100).toFixed(dp)}%`;
}

/** Plain number, Indian grouping, no sign. */
export function n0(v: unknown, dp = 0): string {
  const n = num(v);
  if (n === null) return DASH;
  return n.toLocaleString('en-IN', { minimumFractionDigits: dp, maximumFractionDigits: dp });
}

/** Compact Indian money in crore: 1,65,912 Cr -> "₹1.66L Cr". */
export function crore(v: unknown): string {
  const n = num(v);
  if (n === null) return DASH;
  const abs = Math.abs(n);
  const sign = n < 0 ? '-' : '';
  if (abs >= 1_00_000) return `${sign}₹${(abs / 1_00_000).toFixed(2)}L Cr`;
  if (abs >= 1_000) return `${sign}₹${(abs / 1_000).toFixed(1)}K Cr`;
  return `${sign}₹${abs.toFixed(0)} Cr`;
}

/** Rupee amounts in absolute terms, compacted the same way. */
export function rupees(v: unknown): string {
  const n = num(v);
  if (n === null) return DASH;
  const abs = Math.abs(n);
  const sign = n < 0 ? '-' : '';
  if (abs >= 1_00_00_000) return `${sign}₹${(abs / 1_00_00_000).toFixed(2)} Cr`;
  if (abs >= 1_00_000) return `${sign}₹${(abs / 1_00_000).toFixed(2)} L`;
  if (abs >= 1_000) return `${sign}₹${(abs / 1_000).toFixed(1)}K`;
  return `${sign}₹${abs.toFixed(0)}`;
}

/** 0..1 probability -> "57.2%" */
export function prob(v: unknown, dp = 1): string {
  return frac(v, dp);
}

/** Score 0..100 rendered as an integer, em dash for unscored rows. */
export function score(v: unknown): string {
  const n = num(v);
  if (n === null) return DASH;
  return n.toFixed(0);
}


// ── Time ────────────────────────────────────────────────────────────────────

const IST = 'Asia/Kolkata';

/** IST clock, HH:MM:SS. The desk is for an Indian market — IST is the only clock. */
export function clockIST(d: unknown, withSeconds = true): string {
  const t = toDate(d);
  if (!t) return DASH;
  return t.toLocaleTimeString('en-IN', {
    hour: '2-digit',
    minute: '2-digit',
    ...(withSeconds ? { second: '2-digit' } : {}),
    hour12: false,
    timeZone: IST,
  });
}

export function dateIST(d: unknown): string {
  const t = toDate(d);
  if (!t) return DASH;
  return t.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', timeZone: IST });
}

export function dateTimeIST(d: unknown): string {
  const t = toDate(d);
  if (!t) return DASH;
  return `${dateIST(t)} · ${clockIST(t, false)} IST`;
}

/** "4m ago" / "2h ago" / "3d ago" — freshness is decision-critical here (this repo's
 *  own agent contract escalates at "data freshness > 4h"), so every surface that
 *  shows a timestamp also shows its age. */
export function ago(d: unknown): string {
  const t = toDate(d);
  if (!t) return DASH;
  const s = Math.max(0, (Date.now() - t.getTime()) / 1000);
  if (s < 60) return `${Math.floor(s)}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

/** Accepts Date, epoch seconds (the OHLC endpoint returns these), epoch ms, or an ISO string. */
export function toDate(v: unknown): Date | null {
  if (v === null || v === undefined || v === '') return null;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v;
  if (typeof v === 'number') {
    // Anything below ~1e11 is seconds, above is milliseconds — unambiguous in
    // practice (1e11 s is the year 5138; 1e11 ms is 1973).
    const ms = v < 1e11 ? v * 1000 : v;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const d = new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d;
}

// ── Direction helpers ───────────────────────────────────────────────────────

export type Dir = 'up' | 'down' | 'flat';

export function dir(v: unknown): Dir {
  const n = num(v);
  if (n === null || Math.abs(n) < 1e-9) return 'flat';
  return n > 0 ? 'up' : 'down';
}

/** Tailwind class for a signed value, with a real flat state so a 0.00% row
 *  isn't coloured as though it were a genuine move. */
export function dirText(v: unknown): string {
  const d = dir(v);
  return d === 'up' ? 'text-up' : d === 'down' ? 'text-down' : 'text-mark-3';
}

export function dirBg(v: unknown): string {
  const d = dir(v);
  return d === 'up' ? 'bg-up/10' : d === 'down' ? 'bg-down/10' : 'bg-white/[0.04]';
}

/** Parse a JSON column that may be text, may be malformed, and may legitimately be
 *  null. The *_json columns here are all TEXT written by several different
 *  fetchers, so a throw would blank a whole panel — this returns `fallback` instead. */
export function parseJson<T>(raw: unknown, fallback: T): T {
  if (raw === null || raw === undefined) return fallback;
  if (typeof raw !== 'string') return raw as T;
  try {
    const v = JSON.parse(raw);
    return (v ?? fallback) as T;
  } catch {
    return fallback;
  }
}

/** Truncate for dense table cells without breaking the mono grid. */
export function clip(s: unknown, max = 68): string {
  const str = String(s ?? '').trim();
  if (!str) return '';
  return str.length > max ? `${str.slice(0, max - 1)}…` : str;
}
