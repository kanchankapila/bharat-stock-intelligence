export function isSuccessfulWeeklyJob(
  returnValue: { success?: boolean; failedSteps?: unknown[] } | null | undefined,
  heartbeatStatus: string | undefined,
  historyStatus: string | undefined,
): boolean;
