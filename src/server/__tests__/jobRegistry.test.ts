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

  it('marks the event-driven job (ai-signals) with no schedule', () => {
    const aiSignals = JOB_REGISTRY.find(j => j.jobName === 'ai-signals');
    expect(aiSignals).toBeDefined();
    expect(aiSignals?.cronPattern).toBeUndefined();
    expect(aiSignals?.everyMs).toBeUndefined();
    // dl-retrain-emergency retired 2026-11-11 (AF-20261111-01).
    expect(JOB_REGISTRY.find(j => j.jobName === 'dl-retrain-emergency')).toBeUndefined();
  });
});
