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

  it('CONTEXT.md marks the current base-weighted and zero-weight ranker engines', () => {
    const ctx = read('CONTEXT.md');
    expect(ctx).toMatch(/weight 0\.0|zero-weight/i);
    expect(ctx).toMatch(/`ml`, `confluence` and\s+`technical` are non-zero/);
    expect(ctx).toMatch(/`breakout`, `screener`, `cs`, `dl` and `smart_money` have weight 0\.0/);
    expect(ctx).toMatch(/runtime edge gate can reduce an engine's actual\s+contribution/);
  });

  it('docs identify the ignored URL corpus as optional in a fresh checkout', () => {
    const docs = ['CLAUDE.md', 'CONTEXT.md', 'AGENTS.md', '.claude/rules/data-sources.md', '.claude/rules/bugs-data-layer.md'];
    const named = docs.flatMap(d => read(d).split('\n').filter(l => /URLs|corpus/.test(l))
      .flatMap(l => [...l.matchAll(/`([\w.-]+\.(?:txt|db))`/g)].map(m => `${d}: ${m[1]}`)));
    expect(named.length).toBeGreaterThan(0);
    expect(read('.gitignore')).toMatch(/^urls_v2\.db$/m);
    for (const doc of ['CLAUDE.md', '.claude/rules/data-sources.md', '.claude/rules/bugs-data-layer.md']) {
      const source = read(doc);
      expect(source).toMatch(/optional local[\s\S]{0,100}`urls_v2\.db`/);
      expect(source).toContain('git show c2ceae0e^:unique_urls.txt');
    }
    expect(named.filter(n => n.split(': ')[1] !== 'urls_v2.db' && !existsSync(path.join(root, n.split(': ')[1])))).toEqual([]);
  });

  it('CLAUDE.md does not describe the retired v7 pages as retained (AF-20261027-08)', () => {
    const claude = read('CLAUDE.md');
    expect(claude).not.toMatch(/approved retaining[\s\S]{0,40}v7/);
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
  it('CONTEXT.md and measurement.md do not claim the withdrawn "41 of 41" row count', () => {
    for (const f of ['CONTEXT.md', '.claude/rules/measurement.md']) expect(read(f)).not.toMatch(/41 of 41|all 41 `factor_edge/);
    expect(read('CONTEXT.md')).toContain('97 rows, 2026-10-17');
  });

  it('measurement.md states the column-exclusion chain without double counting', () => {
    const m = read('.claude/rules/measurement.md');
    expect(m).toContain('53 derived columns -> 6 warm-up-zero-filled');
    expect(m).toContain('-> 47 pinned -> 13 excluded at grading');
    expect(m).toContain('-> 34 scored');
  });

  it('measurement.md records the column-depth feasibility result and the B3 outcome table', () => {
    const m = read('.claude/rules/measurement.md');
    expect(m).toContain('(>=60% populated over 2021, including all six labels)');
    expect(m).toContain('~287 independent windows at h=5');
    expect(m).toContain('40.66% win');
    expect(m).toContain('**59 deep**');
    expect(m).toContain('The buckets overlap by exactly one');
    expect(m).toContain('the three figures sum to 105 while the distinct total is 104');
  });

  it('the 2026-10-08 design doc section G carries the dated deep-panel correction', () => {
    const g = read('docs/superpowers/specs/2026-10-08-accuracy-and-honesty-program-design.md');
    expect(g).toContain('Correction 2026-10-21');
    expect(g).toContain('~287 independent windows');
  });

  it('scoring-authority.md lists every live (signal_source, signal_type) pair', () => {
    const r = read('.claude/rules/scoring-authority.md');
    for (const v of ['SCREENER_SURFACING', 'SCREENER_ENTRY', 'platform', 'EMA_BULL_STACK', 'technical_scan']) expect(r).toContain(v);
  });

  it('audit-findings.md opens rows for the intraday weights, DQ noise, duplicated weights and stale worktrees', () => {
    const a = read('docs/audit-findings.md');
    for (const id of ['04', '05', '06', '07']) expect(a).toMatch(new RegExp(`\| AF-202610${'21'}-${id} \|`));
    expect(a).toContain('`adx` is fabricated as 0 on every row for two consecutive months');
  });
});
