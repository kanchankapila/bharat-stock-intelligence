import { describe, it, expect } from 'vitest';
import { parseLiveEdgeProven } from '../routers/monitor.router';

// 2026-08-07: getLiveScreenerIntradaySignals used to render live_screener_ml_scores.
// win_probability unconditionally, with no check on whether the deployed model has ever
// demonstrated real live discrimination -- live-confirmed the deployed model's real AUC is
// 0.4615 over 671,257 resolved rows (essentially no edge) despite a respectable held-out
// test_auc of 0.641, and its own app_settings status row never even carried this signal until
// live_screener_ml_ranker.py's _persist_live_edge_status fix (a sibling commit) started
// refreshing it on every --train run, not just a promoting one. parseLiveEdgeProven is the
// extracted, pure parsing/gating core of the router-side fix.
describe('parseLiveEdgeProven', () => {
  it('returns true when the model has a demonstrated live edge', () => {
    expect(parseLiveEdgeProven(JSON.stringify({ live_edge_proven: true }))).toBe(true);
  });

  it('returns false when the model has been live-graded with NO edge (the real bug case)', () => {
    expect(parseLiveEdgeProven(JSON.stringify({
      live_auc: 0.4615, live_auc_rows: 671257, live_edge_proven: false,
    }))).toBe(false);
  });

  it('returns null (not false) when the row is entirely absent -- no evidence either way', () => {
    expect(parseLiveEdgeProven(undefined)).toBeNull();
    expect(parseLiveEdgeProven(null)).toBeNull();
    expect(parseLiveEdgeProven('')).toBeNull();
  });

  it('returns null when the field is missing from an otherwise-valid row', () => {
    // A model that simply hasn't accumulated LIVE_AUC_MIN_ROWS yet -- must not be treated the
    // same as an explicit false (which would wrongly suppress a model with no evidence against
    // it at all, not just no evidence for it).
    expect(parseLiveEdgeProven(JSON.stringify({ test_auc: 0.64, cv_auc: 0.62 }))).toBeNull();
  });

  it('returns null on malformed JSON rather than throwing', () => {
    expect(parseLiveEdgeProven('{not valid json')).toBeNull();
  });

  it('returns null when live_edge_proven is present but not a real boolean', () => {
    expect(parseLiveEdgeProven(JSON.stringify({ live_edge_proven: null }))).toBeNull();
    expect(parseLiveEdgeProven(JSON.stringify({ live_edge_proven: 'false' }))).toBeNull();
  });
});
