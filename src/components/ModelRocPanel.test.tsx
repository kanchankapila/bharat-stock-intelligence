import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ModelRocPanel } from './ModelRocPanel';

const { query } = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('../lib/trpc', () => ({
  trpc: {
    getModelRocDiagnostics: {
      useQuery: query,
    },
  },
}));

describe('ModelRocPanel', () => {
  beforeEach(() => query.mockReturnValue({ data: undefined, isLoading: false, isError: true, refetch: vi.fn() }));
  it('renders a fetch failure distinctly from an empty resolved-signal set', () => {
    const html = renderToStaticMarkup(<ModelRocPanel />);
    expect(html).toContain('Could not load deployment ROC');
    expect(html).not.toContain('No resolved WIN/LOSS signals');
  });

  it('identifies pooled historical discrimination without claiming an out-of-sample calibration result', () => {
    query.mockReturnValue({ isLoading: false, isError: false, refetch: vi.fn(), data: {
      regimes: [{ regime: 'OVERALL', n: 200, positives: 100, negatives: 100, auc: 0.55,
        baseRate: 0.5, roc: [{ fpr: 0, tpr: 0 }, { fpr: 1, tpr: 1 }] }],
      scoredTotal: 200, totalResolved: 200, trainingAuc: 0.75, trainingModelVersion: 'test',
      evaluationContract: 'Historical mixed-horizon outcome discrimination; not probability calibration or a profitability test',
    } });
    const html = renderToStaticMarkup(<ModelRocPanel />);
    expect(html).toContain('Mixed horizons');
    expect(html).toContain('Not comparable');
    expect(html).not.toContain('Out-of-sample');
    expect(html).not.toContain('discrimination gap');
  });
});
