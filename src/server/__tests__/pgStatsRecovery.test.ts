import { describe, it, expect, vi, beforeEach } from 'vitest';

const state = vi.hoisted(() => ({
  queries: [] as string[],
  big: 107,
  unanalyzed: 104,
  postmasterStart: '2026-11-09T04:50:48.253Z',
  checkpointerStart: '2026-11-09T04:50:49.000Z' as string | null,
  releaseAnalyze: null as null | (() => void),
  holdAnalyze: false,
}));

vi.mock('../pgClient', () => ({
  withClient: async (fn: (c: unknown) => Promise<unknown>) => fn({
    query: async (text: string) => {
      state.queries.push(text);
      if (text.includes('pg_postmaster_start_time')) {
        const started = text.includes('checkpointer') ? (state.checkpointerStart ?? state.postmasterStart) : state.postmasterStart;
        return { rows: [{ started }] };
      }
      if (text.includes('pg_stat_user_tables')) return { rows: [{ big: state.big, unanalyzed: state.unanalyzed, sample: 'x' }] };
      if (/^\s*ANALYZE\s*$/i.test(text) && state.holdAnalyze) {
        await new Promise<void>(resolve => { state.releaseAnalyze = resolve; });
      }
      return { rows: [] };
    },
  }),
}));
vi.mock('../logger', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { recoverPgStatsIfReset, resetPgStatsRecoveryState, PG_TABLES_ANALYZED_SQL } from '../pgStatsRecovery';

const analyzeCount = () => state.queries.filter(q => /^\s*ANALYZE\s*$/i.test(q)).length;

describe('recoverPgStatsIfReset (AF-20261028-22: stats reset after an unclean Postgres stop)', () => {
  beforeEach(() => {
    resetPgStatsRecoveryState();
    state.queries = [];
    state.big = 107;
    state.unanalyzed = 104;
    state.postmasterStart = '2026-11-09T04:50:48.253Z';
    state.checkpointerStart = '2026-11-09T04:50:49.000Z';
    state.holdAnalyze = false;
    state.releaseAnalyze = null;
  });

  it('runs one database-wide ANALYZE, outside a transaction, under a server-side timeout that is reset afterwards', async () => {
    expect(await recoverPgStatsIfReset()).toBe('analyzed');
    expect(analyzeCount()).toBe(1);
    const i = state.queries.findIndex(q => /^\s*ANALYZE\s*$/i.test(q));
    expect(state.queries.slice(0, i).some(q => /SET statement_timeout/i.test(q))).toBe(true);
    expect(state.queries.slice(i + 1).some(q => /RESET statement_timeout/i.test(q))).toBe(true);
    expect(state.queries.some(q => /^\s*BEGIN/i.test(q))).toBe(false);
  });

  it('does nothing when the large tables carry analyze times', async () => {
    state.unanalyzed = 0;
    expect(await recoverPgStatsIfReset()).toBe('healthy');
    expect(analyzeCount()).toBe(0);
  });

  it('does nothing below the check\'s fail threshold (a few unanalyzed tables is a warn, not a reset)', async () => {
    state.unanalyzed = 10;
    expect(await recoverPgStatsIfReset()).toBe('healthy');
    expect(analyzeCount()).toBe(0);
  });

  it('attempts at most once per Postgres start, and again after the next restart', async () => {
    await recoverPgStatsIfReset();
    expect(await recoverPgStatsIfReset()).toBe('already-attempted');
    expect(analyzeCount()).toBe(1);
    state.postmasterStart = '2026-11-10T03:00:00.000Z';
    state.checkpointerStart = '2026-11-10T03:00:01.000Z';
    expect(await recoverPgStatsIfReset()).toBe('analyzed');
    expect(analyzeCount()).toBe(2);
  });

  it('treats a crash-recovery reinitialisation as a new start although the postmaster start time is unchanged', async () => {
    // 2026-11-20 09:39 IST: a backend was OOM-killed, Postgres reinitialised (stats reset) and
    // pg_postmaster_start_time() still read the 11-15 start; only the auxiliary processes restarted.
    await recoverPgStatsIfReset();
    state.checkpointerStart = '2026-11-20T04:09:15.618Z';
    expect(await recoverPgStatsIfReset()).toBe('analyzed');
    expect(analyzeCount()).toBe(2);
  });

  it('falls back to the postmaster start when the checkpointer row is not visible', async () => {
    state.checkpointerStart = null;
    expect(await recoverPgStatsIfReset()).toBe('analyzed');
    expect(await recoverPgStatsIfReset()).toBe('already-attempted');
  });

  it('does not start a second ANALYZE while one is running', async () => {
    state.holdAnalyze = true;
    const first = recoverPgStatsIfReset();
    await vi.waitFor(() => expect(state.releaseAnalyze).not.toBeNull());
    expect(await recoverPgStatsIfReset()).toBe('in-progress');
    state.releaseAnalyze!();
    expect(await first).toBe('analyzed');
    expect(analyzeCount()).toBe(1);
  });

  it('shares its detection SQL with the pg-tables-analyzed data-quality check', async () => {
    const { DATA_QUALITY_CHECKS } = await import('../dataQualityChecks');
    const check = DATA_QUALITY_CHECKS.find(c => c.id === 'pg-tables-analyzed') as { sql?: string } | undefined;
    expect(check?.sql).toBe(PG_TABLES_ANALYZED_SQL);
  });
});
