export function isSuccessfulWeeklyJob(returnValue, heartbeatStatus, historyStatus) {
  const failedSteps = Array.isArray(returnValue?.failedSteps)
    ? returnValue.failedSteps
    : [];
  return returnValue?.success !== false
    && failedSteps.length === 0
    && heartbeatStatus !== 'failed'
    && historyStatus !== 'failed';
}
