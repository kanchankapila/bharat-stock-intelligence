/**
 * Documentation claims that are reasoning corrections, not counts (doc:numbers:check cannot see
 * them). Spec section 8 of 2026-10-19-full-data-honest-recommendations-design.md. Each test pins
 * one fact a future edit could silently drop.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'fs';
import path from 'path';

const root = path.resolve(__dirname, '..', '..', '..');
const read = (p: string) => readFileSync(path.join(root, p), 'utf8');

describe('docClaims', () => {
  it('CONTEXT.md states the effective-date range behind the edge claim, not just the LOW-DATA label', () => {
    const ctx = read('CONTEXT.md');
    expect(ctx).toMatch(/effective dates/i);
    expect(ctx).toContain('0.2-8.2');
  });

  it('CONTEXT.md marks which ranker engines carry non-zero weight', () => {
    const ctx = read('CONTEXT.md');
    expect(ctx).toMatch(/weight 0\.0|zero-weight/i);
    for (const live of ['ml', 'confluence', 'technical', 'breakout']) expect(ctx).toContain(live);
    for (const dead of ['screener', 'cs', 'dl', 'smart_money']) expect(ctx).toContain(dead);
  });

  it('scoring-authority.md documents that conviction_level is direction-agnostic', () => {
    expect(read('.claude/rules/scoring-authority.md')).toMatch(/direction-agnostic/i);
  });

  it('scoring-authority.md documents the two signal_type vocabularies and the BUY-only consumer', () => {
    const r = read('.claude/rules/scoring-authority.md');
    expect(r).toContain('Bullish');
    expect(r).toContain('BUY');
    expect(r).toContain('misc.router.ts');
  });

  it('measurement.md records the deep-panel tiers and the winsorisation lesson', () => {
    const m = read('.claude/rules/measurement.md');
    expect(m).toContain('F&O-eligible');
    expect(m).toMatch(/raw t beside the winsorised/i);
    expect(m).toContain('99.5%');
  });

  it('bugs-data-layer.md records the warm-up zero-fill class and its shipped diagnostic', () => {
    const b = read('.claude/rules/bugs-data-layer.md');
    expect(b).toContain('column_zero_shares');
    expect(b).toContain('FAKE_ZERO_COLUMNS');
    expect(b).toMatch(/companion/i);
  });

  it('intraday_ranker.py header states the weights are unmeasured and the gate is the protection', () => {
    const src = read('src/server/intraday_ranker.py');
    expect(src).toMatch(/W_SCREENER = 0/);
    expect(src).toMatch(/emission gate is what currently protects/i);
  });

  it('the phase plan no longer names the renamed leak guard', () => {
    expect(read('docs/superpowers/plans/2026-10-19-phase0-delivery-and-phase1-deep-panel.md'))
      .not.toContain('assert_no_same_day_leak');
  });

  // The file is deliberately untracked, so a clean checkout has nothing to assert on.
  it.skipIf(!existsSync(path.join(root, 'docs/master-build-prompt.md')))('master-build-prompt.md is date-stamped as the original brief, not the measured design', () => {
    expect(read('docs/master-build-prompt.md')).toMatch(/original brief/i);
  });

  it('audit-findings.md carries open rows for the two undocumented contracts and none for withdrawn B8', () => {
    const a = read('docs/audit-findings.md');
    expect(a).toMatch(/\| AF-20261021-01 \|/);
    expect(a).toMatch(/\| AF-20261021-02 \|/);
    expect(a).not.toMatch(/\| AF-20261021-\d+ \|[^\n]*LONG_TERM/);
  });
});
