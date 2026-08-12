// "A single declarative job catalog is the only source of schedule truth...
// Do not write a cron string in two places -- a hand-mirrored schedule
// registry has caused six separate drift incidents in the predecessor
// system." (BUILD_STAGE_0_2_SPEC.md Task 1.3 / recurring-bugs.md.) This type
// mirrors the job_definition table exactly; scheduler registration and
// monitoring metadata are both GENERATED from a JobCatalogEntry[], never
// hand-written twice.
export interface JobCatalogEntry {
  jobId: string;
  description: string;
  cron?: string;
  timezone: string;
  calendar?: string;
  dependsOn: string[];
  slaMinutes?: number;
  critical: boolean;
  postconditions: Record<string, unknown>;
  enabled: boolean;
  catalogVersion: string;
}

export interface CatalogValidationError {
  jobId: string;
  reason: string;
}

/** Structural checks a hand-written catalog can still get wrong: duplicate
 * ids, a dependency on an id that doesn't exist, and a dependency cycle. */
export function validateCatalog(entries: readonly JobCatalogEntry[]): CatalogValidationError[] {
  const errors: CatalogValidationError[] = [];
  const seen = new Set<string>();
  const knownIds = new Set(entries.map((e) => e.jobId));

  for (const entry of entries) {
    if (seen.has(entry.jobId)) {
      errors.push({ jobId: entry.jobId, reason: `duplicate job_id '${entry.jobId}'` });
    }
    seen.add(entry.jobId);

    for (const dep of entry.dependsOn) {
      if (!knownIds.has(dep)) {
        errors.push({ jobId: entry.jobId, reason: `depends_on unknown job '${dep}'` });
      }
      if (dep === entry.jobId) {
        errors.push({ jobId: entry.jobId, reason: 'depends_on itself' });
      }
    }
  }

  const byId = new Map(entries.map((e) => [e.jobId, e]));
  for (const entry of entries) {
    const cyclePath = findCycle(entry.jobId, byId, new Set());
    if (cyclePath) {
      errors.push({ jobId: entry.jobId, reason: `dependency cycle: ${cyclePath.join(' -> ')}` });
    }
  }

  return errors;
}

function findCycle(
  jobId: string,
  byId: Map<string, JobCatalogEntry>,
  visiting: Set<string>,
): string[] | null {
  if (visiting.has(jobId)) return [...visiting, jobId];
  const entry = byId.get(jobId);
  if (!entry) return null;
  const nextVisiting = new Set(visiting).add(jobId);
  for (const dep of entry.dependsOn) {
    const found = findCycle(dep, byId, nextVisiting);
    if (found) return found;
  }
  return null;
}
