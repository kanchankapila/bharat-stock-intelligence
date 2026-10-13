import { describe, expect, it } from 'vitest';

import { isSuccessfulWeeklyJob } from '../../../scripts/weeklyJobVerdict.mjs';

describe('weekly manual runner verdict', () => {
  it('accepts a completed job only when semantic and persisted statuses are healthy', () => {
    expect(isSuccessfulWeeklyJob({ success: true, failedSteps: [] }, 'success', 'success')).toBe(true);
  });

  it.each([
    [{ success: false, failedSteps: ['fetch'] }, 'failed', 'failed'],
    [{ success: true, failedSteps: ['fetch'] }, 'success', 'success'],
    [{ success: true, failedSteps: [] }, 'failed', 'success'],
    [{ success: true, failedSteps: [] }, 'success', 'failed'],
  ])('rejects a BullMQ completion with any failed semantic or persisted verdict',
    (returnValue, heartbeatStatus, historyStatus) => {
      expect(isSuccessfulWeeklyJob(returnValue, heartbeatStatus, historyStatus)).toBe(false);
    });
});
