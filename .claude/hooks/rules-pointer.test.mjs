// Unit tests for rules-pointer.mjs
// Verifies that path patterns accurately resolve relevant rule files (including ml-model-bugs.md,
// recurring-bugs.md, data-sources.md, scoring-authority.md, measurement.md, and migration reviews).
import { describe, it, expect } from 'vitest';
import { getRulesForPath } from './rules-pointer.mjs';

describe('rules-pointer', () => {
  it('returns null for non-code files like .md or .json', () => {
    expect(getRulesForPath('README.md')).toBeNull();
    expect(getRulesForPath('package.json')).toBeNull();
  });

  it('matches ml-model-bugs.md and recurring-bugs.md for ML ensemble python files', () => {
    const res = getRulesForPath('src/server/ml_ensemble.py');
    expect(res).not.toBeNull();
    expect(res.rules).toContain('ml-model-bugs.md');
    expect(res.rules).toContain('recurring-bugs.md');
  });

  it('matches ml-model-bugs.md for model promotion and drift scripts', () => {
    const res = getRulesForPath('src/server/model_promotion.py');
    expect(res).not.toBeNull();
    expect(res.rules).toContain('ml-model-bugs.md');
  });

  it('matches data-sources.md and recurring-bugs.md for fetchers', () => {
    const res = getRulesForPath('src/server/mover_screener_fetcher.py');
    expect(res).not.toBeNull();
    expect(res.rules).toContain('data-sources.md');
    expect(res.rules).toContain('recurring-bugs.md');
  });

  it('matches scoring-authority.md for signal and scoring services', () => {
    const res = getRulesForPath('src/server/scoring_engine.py');
    expect(res).not.toBeNull();
    expect(res.rules).toContain('scoring-authority.md');
  });

  it('matches measurement.md for backtester and factor scripts', () => {
    const res = getRulesForPath('src/server/factor_backtest.py');
    expect(res).not.toBeNull();
    expect(res.rules).toContain('measurement.md');
    expect(res.rules).toContain('ml-model-bugs.md');
  });

  it('adds migration safety review extra for SQL migration files', () => {
    const res = getRulesForPath('migrations/20260825_test_migration.sql');
    expect(res).not.toBeNull();
    expect(res.rules).toContain('recurring-bugs.md');
    expect(res.extras).toContain('/migration-safety-review');
    expect(res.hookSpecificOutput.additionalContext).toContain('/migration-safety-review');
  });

  it('handles Windows backslash paths seamlessly', () => {
    const res = getRulesForPath('src\\server\\dl_engine.py');
    expect(res).not.toBeNull();
    expect(res.rules).toContain('ml-model-bugs.md');
    expect(res.rules).toContain('recurring-bugs.md');
  });
});
