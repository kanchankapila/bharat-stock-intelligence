export function n(v: unknown, d = 0): number {
  const x = Number(v);
  return Number.isFinite(x) ? x : d;
}

export function numOrNull(v: unknown): number | null {
  const x = Number(v);
  return Number.isFinite(x) ? x : null;
}

export function s(v: unknown, d = ''): string {
  return typeof v === 'string' ? v : d;
}

export function asINR(v: number): string {
  return v.toLocaleString('en-IN', { maximumFractionDigits: 2 });
}

export function fmtFixed(v: unknown, digits = 2): string {
  const x = numOrNull(v);
  return x == null ? '—' : x.toFixed(digits);
}

export function fmtPct(v: unknown, digits = 2, scale = 1): string {
  const x = numOrNull(v);
  return x == null ? '—' : `${(x * scale).toFixed(digits)}%`;
}

export function fmtINR(v: unknown, digits = 2): string {
  const x = numOrNull(v);
  if (x == null) return '—';
  return x.toLocaleString('en-IN', { maximumFractionDigits: digits, minimumFractionDigits: digits });
}

export function pctClass(v: number): string {
  if (v > 0) return 'text-teal-700';
  if (v < 0) return 'text-rose-700';
  return 'text-slate-600';
}

export function tone(v: number): 'pos' | 'neg' | 'flat' {
  if (v > 0) return 'pos';
  if (v < 0) return 'neg';
  return 'flat';
}
