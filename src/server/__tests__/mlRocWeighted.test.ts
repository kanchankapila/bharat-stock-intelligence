import { describe, expect, it } from 'vitest';
import { computeWeightedRoc } from '../routers/ml.router';

describe('computeWeightedRoc', () => {
  it('computes tie-aware AUC and ROC without expanding one row per resolved signal', () => {
    const result = computeWeightedRoc('OVERALL', [
      { p: 0.9, wins: 2, losses: 0 },
      { p: 0.7, wins: 1, losses: 1 },
      { p: 0.2, wins: 0, losses: 2 },
    ], 1, 20);

    expect(result).not.toBeNull();
    expect(result!.n).toBe(6);
    expect(result!.positives).toBe(3);
    expect(result!.negatives).toBe(3);
    expect(result!.auc).toBe(0.944);
    expect(result!.roc.at(-1)).toEqual({ fpr: 1, tpr: 1 });
  });
});
