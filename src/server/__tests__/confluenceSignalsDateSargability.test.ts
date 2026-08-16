import { describe, it, expect } from 'vitest';

const { confluenceJoinOnSignalDate } = await import('../routers/confluence.router');

// Regression coverage for the getConfluenceOutcomes sargability fix: `DATE(cs.computed_at) =
// so.signal_date` wrapped confluence_signals' TimescaleDB partitioning column, defeating both
// idx_csi_computed and chunk-exclusion pruning. confluenceJoinOnSignalDate() must emit a
// half-open range on the BARE computed_at column.
//
// This suite used to have four cases, two of which asserted the SQLite arm of a USE_POSTGRES
// ternary and that the flag was read fresh per call rather than cached at import. Both the arm
// and the flag are gone (SQLITE_DECOMMISSION_PLAN Phase 3) -- there is one dialect now, so
// there is nothing left for those two to protect. The sargability property they were really
// guarding is the surviving assertion below, and it is the one that mattered.
describe('confluenceJoinOnSignalDate', () => {
  it('never wraps computed_at in DATE()/date()', () => {
    expect(confluenceJoinOnSignalDate()).not.toMatch(/date\(cs\.computed_at\)/i);
  });

  it('emits a half-open interval range against so.signal_date', () => {
    expect(confluenceJoinOnSignalDate()).toBe(
      "cs.computed_at >= so.signal_date::timestamptz AND cs.computed_at < so.signal_date::timestamptz + interval '1 day'",
    );
  });
});
