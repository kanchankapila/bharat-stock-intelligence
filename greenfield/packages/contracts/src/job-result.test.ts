import { expect, test } from 'vitest';
import { isSuccess, type JobResult } from './job-result.js';

const metrics = {
  rowsSeen: 0, rowsAccepted: 0, rowsRejected: 0, rowsWritten: 0,
  symbolsCovered: 0, inputWatermark: null, outputWatermark: null,
};

test('isSuccess accepts only status=succeeded', () => {
  const succeeded: JobResult = { status: 'succeeded', metrics };
  const skipped: JobResult = { status: 'skipped', reason: 'holiday', metrics };
  const degraded: JobResult = { status: 'degraded', reason: 'partial', metrics };
  const failed: JobResult = { status: 'failed', error: new Error('boom'), metrics };

  expect(isSuccess(succeeded)).toBe(true);
  expect(isSuccess(skipped)).toBe(false);
  expect(isSuccess(degraded)).toBe(false);
  expect(isSuccess(failed)).toBe(false);
});
