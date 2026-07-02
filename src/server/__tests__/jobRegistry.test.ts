import { describe, it, expect } from 'vitest';
import { JOB_REGISTRY } from '../jobRegistry';
import { CronExpressionParser } from 'cron-parser';

describe('JOB_REGISTRY', () => {
  it('has no duplicate job names', () => {
    const names = JOB_REGISTRY.map(j => j.jobName);
    expect(new Set(names).size).toBe(names.length);
  });

  it('every scheduled (non-event-driven) entry has a parseable cron or everyMs', () => {
    for (const j of JOB_REGISTRY) {
      if (j.cronPattern === undefined && j.everyMs === undefined) continue; // event-driven, allowed
      if (j.cronPattern) {
        expect(() => CronExpressionParser.parse(j.cronPattern!, { tz: 'Etc/UTC' })).not.toThrow();
      } else {
        expect(j.everyMs).toBeGreaterThan(0);
      }
      expect(j.graceMinutes).toBeGreaterThan(0);
    }
  });

  it('marks event-driven jobs (ai-signals, dl-retrain-emergency) with no schedule', () => {
    const aiSignals = JOB_REGISTRY.find(j => j.jobName === 'ai-signals');
    const dlEmergency = JOB_REGISTRY.find(j => j.jobName === 'dl-retrain-emergency');
    expect(aiSignals?.cronPattern).toBeUndefined();
    expect(aiSignals?.everyMs).toBeUndefined();
    expect(dlEmergency?.cronPattern).toBeUndefined();
    expect(dlEmergency?.everyMs).toBeUndefined();
  });
});
