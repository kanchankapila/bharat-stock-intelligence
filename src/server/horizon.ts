export type CanonicalHorizon = 'INTRADAY' | 'SWING' | 'POSITIONAL';

/** Canonical vocabulary stored in unified_recommendations. */
const HORIZON_ALIASES: Readonly<Record<string, CanonicalHorizon>> = {
  INTRADAY: 'INTRADAY',
  SWING: 'SWING',
  SHORT: 'SWING',
  SHORT_TERM: 'SWING',
  'SWING (3-7D)': 'SWING',
  POSITIONAL: 'POSITIONAL',
  LONG_TERM: 'POSITIONAL',
  'POSITIONAL (2-4W)': 'POSITIONAL',
  'POSITIONAL (1-3M)': 'POSITIONAL',
};

export function canonicalHorizon(raw: string | null | undefined): CanonicalHorizon | null {
  const value = (raw ?? '').trim().toUpperCase();
  return HORIZON_ALIASES[value] ?? HORIZON_ALIASES[value.replace(/[\s-]+/g, '_')] ?? null;
}

/** Conservative display default for historical rows that did not record a horizon. */
export function normaliseHorizon(raw: string | null | undefined): CanonicalHorizon {
  return canonicalHorizon(raw) ?? 'POSITIONAL';
}
