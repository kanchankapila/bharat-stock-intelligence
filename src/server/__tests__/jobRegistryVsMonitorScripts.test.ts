import { describe, it, expect } from 'vitest';
import { JOB_REGISTRY } from '../jobRegistry';
import { MONITOR_SCRIPTS } from '../routers/monitor.router';

describe('JOB_REGISTRY vs MONITOR_SCRIPTS', () => {
  it('has no job names that collide with a MONITOR_SCRIPTS id (would double-cover the same job)', () => {
    const registryNames = new Set(JOB_REGISTRY.map(j => j.jobName));
    const scriptIds = new Set<string>(MONITOR_SCRIPTS.map(s => s.id));
    const collisions = [...registryNames].filter(n => scriptIds.has(n));
    expect(collisions).toEqual([]);
  });
});
