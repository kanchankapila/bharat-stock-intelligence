import { describe, expect, test } from 'vitest';
import { JOB_REGISTRY } from '../jobRegistry';
import { MONITOR_SCRIPTS } from '../monitorScripts';
import { buildJobReadinessRegistry } from '../jobReadinessRegistry';

describe('job readiness registry', () => {
  test('covers both scheduling registries exactly once', () => {
    const entries = buildJobReadinessRegistry();
    const expectedNames = new Set([
      ...JOB_REGISTRY.map(j => j.jobName),
      ...MONITOR_SCRIPTS.map(j => j.id),
    ]);

    expect(new Set(entries.map(j => j.jobName))).toEqual(expectedNames);
    expect(entries).toHaveLength(expectedNames.size);
    expect(entries.filter(j => j.jobName === 'company-profiles-sync')).toHaveLength(1);
    expect(entries.find(j => j.jobName === 'company-profiles-sync')).toMatchObject({
      scheduled: true,
      cronPatterns: ['30 15 * * *'],
    });
  });
});
