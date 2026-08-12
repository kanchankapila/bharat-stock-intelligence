// BUILD_STAGE_0_2_SPEC.md Task 1.3 / GREENFIELD_BUILD_SPEC.md B4. 'skipped' and
// 'degraded' are deliberately distinct from 'succeeded' -- a heartbeat writer
// that accepts either as success is the exact bug class documented in
// recurring-bugs.md's "skip path stamped as success" (5 recurrences in the
// predecessor system).
export type JobMetrics = {
  rowsSeen: number;
  rowsAccepted: number;
  rowsRejected: number;
  rowsWritten: number;
  symbolsCovered: number;
  inputWatermark: string | null;
  outputWatermark: string | null;
};

export type JobResult =
  | { status: 'succeeded'; metrics: JobMetrics }
  | { status: 'skipped'; reason: string; metrics: JobMetrics }
  | { status: 'degraded'; reason: string; metrics: JobMetrics }
  | { status: 'failed'; error: Error; metrics: JobMetrics };

export function isSuccess(result: JobResult): result is { status: 'succeeded'; metrics: JobMetrics } {
  return result.status === 'succeeded';
}
