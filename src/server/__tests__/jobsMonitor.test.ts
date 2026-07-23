import { describe, it, expect, vi } from 'vitest';

// triggerBullMQJob is adminProcedure — stub token verification so the caller below
// authenticates as an admin without a real Firebase round-trip.
vi.mock('../firebaseAdmin', () => ({
  verifyIdToken: vi.fn().mockResolvedValue('test-admin-uid'),
  AuthTokenError: class AuthTokenError extends Error {},
}));
process.env.ADMIN_UIDS = 'test-admin-uid';

// Mock the queues module so we don't attempt real Redis connection in tests
vi.mock('../queues', () => {
  const dummyQueue = {
    getActiveCount: vi.fn().mockResolvedValue(2),
    getWaitingCount: vi.fn().mockResolvedValue(5),
    getCompletedCount: vi.fn().mockResolvedValue(100),
    getFailedCount: vi.fn().mockResolvedValue(1),
    getDelayedCount: vi.fn().mockResolvedValue(0),
    getRepeatableJobs: vi.fn().mockResolvedValue([
      { key: 'test-key', name: 'test-job', cron: '0 0 * * *', next: 1774348800000 }
    ]),
    getJobs: vi.fn().mockResolvedValue([
      { id: '1', name: 'manual-test-job', progress: 50, timestamp: Date.now() }
    ]),
    add: vi.fn().mockResolvedValue({ id: 'mock-job-id' }),
  };

  return {
    stockRefreshQueue: dummyQueue,
    aiSignalsQueue: dummyQueue,
    stockScoringQueue: dummyQueue,
    mcScreenerSyncQueue: dummyQueue,
    etnowScreenerSyncQueue: dummyQueue,
    nseScreenerSyncQueue: dummyQueue,
    fundamentalsSyncQueue: dummyQueue,
    quantScoringQueue: dummyQueue,
    technicalSignalsQueue: dummyQueue,
    signalOutcomesQueue: dummyQueue,
    newsSentimentQueue: dummyQueue,
    trendlyneIntradayQueue: dummyQueue,
    outcomeResolverQueue: dummyQueue,
    mlDailyOpsQueue: dummyQueue,
    mlWeeklyRetrainQueue: dummyQueue,
    intradayFetcherQueue: dummyQueue,
    liveScreenerCollectQueue: dummyQueue,
    researchPremarketQueue: dummyQueue,
    researchPostcloseQueue: dummyQueue,
    dlMacroFetchQueue: dummyQueue,
    dlFeatureRefreshQueue: dummyQueue,
    dlInferenceQueue: dummyQueue,
    dlRegimeUpdateQueue: dummyQueue,
    dlRetrainWeeklyQueue: dummyQueue,
    ohlcvBackfillQueue: dummyQueue,
    confluenceComputeQueue: dummyQueue,
    confluenceOutcomesQueue: dummyQueue,
    screenerPerfQueue: dummyQueue,
    agentDataScientistQueue: dummyQueue,
    agentStrategistQueue: dummyQueue,
    agentAuditorQueue: dummyQueue,
    agentOptimizerQueue: dummyQueue,
    unifiedRankerQueue: dummyQueue,
  };
});

const { createCallerFactory } = await import('../trpc');
const { appRouter } = await import('../router');
const createCaller = createCallerFactory(appRouter);
const caller = createCaller({ req: { headers: { authorization: 'Bearer test' } } } as any);

describe('BullMQ Monitor Router Procedures', () => {
  
  it('getBullMQJobsStatus returns all 33 queues with categories and states', async () => {
    const status = await caller.getBullMQJobsStatus();
    
    expect(Array.isArray(status)).toBe(true);
    expect(status.length).toBe(33);

    // Verify all return properties
    const stockRefresh = status.find(q => q.id === 'stock-refresh');
    expect(stockRefresh).toBeDefined();
    expect(stockRefresh?.label).toBe('Stock Price Refresh');
    expect(stockRefresh?.category).toBe('data-sync');
    expect(stockRefresh?.connected).toBe(true);
    expect(stockRefresh?.activeCount).toBe(2);
    expect(stockRefresh?.waitingCount).toBe(5);
    expect(stockRefresh?.completedCount).toBe(100);
    expect(stockRefresh?.failedCount).toBe(1);
    expect(stockRefresh?.repeatable.length).toBe(1);
    expect(stockRefresh?.repeatable[0].name).toBe('test-job');
    expect(stockRefresh?.repeatable[0].cron).toBe('0 0 * * *');
  });

  it('triggerBullMQJob successfully queues a manual job', async () => {
    const res = await caller.triggerBullMQJob({ queueId: 'stock-refresh' });
    expect(res.success).toBe(true);
    expect(res.jobId).toBe('mock-job-id');
    expect(res.message).toContain('Successfully queued manual job');
  });

  it('triggerBullMQJob throws error for unknown queue', async () => {
    await expect(
      caller.triggerBullMQJob({ queueId: 'invalid-queue-id' })
    ).rejects.toThrow('Unknown queue: invalid-queue-id');
  });
});
