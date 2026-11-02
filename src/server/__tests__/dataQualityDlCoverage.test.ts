import { describe, expect, it, vi } from 'vitest';

vi.mock('../dbAsync', () => ({
  dbGet: vi.fn(),
  dbAll: vi.fn(),
  dbRun: vi.fn(),
  dbExec: vi.fn(),
}));

const { DATA_QUALITY_CHECKS } = await import('../dataQualityChecks');
const check = DATA_QUALITY_CHECKS.find(c => c.id === 'dl-training-coverage')!;
const evaluate = (notes: string | null) => check.evaluate({ notes, trained_at: '2026-11-01' }, new Date());

describe('dl-training-coverage', () => {
  it('warns on the shortfall that read as success (AF-20260927-20)', () => {
    const result = evaluate(JSON.stringify({
      symbols_requested: 2216, symbols_trained: 200, training_stop_reason: 'train_budget',
    }));
    expect(result.status).toBe('warn');
    expect(result.detail).toContain('200 of 2216');
    expect(result.detail).toContain('9.0%');
    expect(result.detail).toContain('train_budget');
  });

  it('passes a full run, so the warning carries information', () => {
    const result = evaluate(JSON.stringify({
      symbols_requested: 2216, symbols_trained: 2210, training_stop_reason: null,
    }));
    expect(result.status).toBe('pass');
  });

  it('warns rather than passing a row with no coverage recorded', () => {
    expect(evaluate(null).status).toBe('warn');
    expect(evaluate('REJECTED: not json').status).toBe('warn');
  });
});
