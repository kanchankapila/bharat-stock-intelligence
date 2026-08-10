import { describe, it, expect, afterEach } from 'vitest';

// Isolates from the host environment's USE_POSTGRES before importing confluence.router.ts,
// which transitively imports dbAsync.ts/confluenceEngine.ts -- see backtestRunner.test.ts's
// identical guard for why this must be set before any (even transitive) import.
process.env.DATABASE_URL = ':memory:';
process.env.USE_POSTGRES = 'false';
const { confluenceJoinOnSignalDate } = await import('../routers/confluence.router');

// Regression coverage for the getConfluenceOutcomes sargability fix: `DATE(cs.computed_at) =
// so.signal_date` wrapped confluence_signals' TimescaleDB partitioning column, defeating both
// idx_csi_computed and chunk-exclusion pruning. confluenceJoinOnSignalDate() must emit a
// half-open range on the BARE computed_at column on both dialects, and must read USE_POSTGRES
// fresh on every call (not cache it at import time).
describe('confluenceJoinOnSignalDate', () => {
  const originalUsePostgres = process.env.USE_POSTGRES;
  afterEach(() => { process.env.USE_POSTGRES = originalUsePostgres; });

  it('never wraps computed_at in DATE()/date() on either dialect', () => {
    process.env.USE_POSTGRES = 'true';
    expect(confluenceJoinOnSignalDate()).not.toMatch(/date\(cs\.computed_at\)/i);
    process.env.USE_POSTGRES = 'false';
    expect(confluenceJoinOnSignalDate()).not.toMatch(/date\(cs\.computed_at\)/i);
  });

  it('emits Postgres interval arithmetic against so.signal_date when USE_POSTGRES=true', () => {
    process.env.USE_POSTGRES = 'true';
    const cond = confluenceJoinOnSignalDate();
    expect(cond).toBe(
      "cs.computed_at >= so.signal_date::timestamptz AND cs.computed_at < so.signal_date::timestamptz + interval '1 day'",
    );
  });

  it("emits SQLite's date(col, '+1 day') form when USE_POSTGRES=false", () => {
    process.env.USE_POSTGRES = 'false';
    const cond = confluenceJoinOnSignalDate();
    expect(cond).toBe(
      "cs.computed_at >= so.signal_date AND cs.computed_at < date(so.signal_date, '+1 day')",
    );
  });

  it('reads USE_POSTGRES fresh on every call rather than caching it at import time', () => {
    process.env.USE_POSTGRES = 'false';
    const sqliteForm = confluenceJoinOnSignalDate();
    process.env.USE_POSTGRES = 'true';
    const pgForm = confluenceJoinOnSignalDate();
    expect(pgForm).not.toBe(sqliteForm);
    expect(pgForm).toContain('::timestamptz');
  });
});
