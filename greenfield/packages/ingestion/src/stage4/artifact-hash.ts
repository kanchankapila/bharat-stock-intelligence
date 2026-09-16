// Task 4.5's `model-artifact-hash` check and Task 5.1.2's `model_version` writer
// both need to agree on exactly how a ranker spec hashes -- this is the one
// place that logic lives, imported by stage5/write-recommendations.ts (which
// computes the hash at write time) and by this file's own sibling
// dq-checks.ts (which recomputes it at read time to verify nothing drifted).
//
// jsonb does NOT preserve object key order (Postgres docs: "does not preserve
// the order of object keys"), so a hash computed here and later recomputed
// from a `metrics` column read back out of Postgres would not match unless
// both sides serialize with a canonical (sorted-key) form. Plain
// `JSON.stringify` on an in-memory object preserves insertion order, which is
// enough for a single write but not for a write-then-read-back-then-rehash
// round trip through jsonb -- exactly what the DQ check needs to do.
import { createHash } from 'node:crypto';

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value !== null && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(obj).sort()) sorted[key] = sortKeysDeep(obj[key]);
    return sorted;
  }
  return value;
}

export function canonicalStringify(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value));
}

export interface RankerArtifactPayload {
  variant: string;
  version: string;
  factors: unknown;
}

export function computeRankerArtifactHash(payload: RankerArtifactPayload): string {
  return createHash('sha256').update(canonicalStringify(payload)).digest('hex');
}
