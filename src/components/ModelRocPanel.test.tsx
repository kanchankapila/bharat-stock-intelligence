import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { ModelRocPanel } from './ModelRocPanel';

vi.mock('../lib/trpc', () => ({
  trpc: {
    getModelRocDiagnostics: {
      useQuery: () => ({ data: undefined, isLoading: false, isError: true, refetch: vi.fn() }),
    },
  },
}));

describe('ModelRocPanel', () => {
  it('renders a fetch failure distinctly from an empty resolved-signal set', () => {
    const html = renderToStaticMarkup(<ModelRocPanel />);
    expect(html).toContain('Could not load deployment ROC');
    expect(html).not.toContain('No resolved WIN/LOSS signals');
  });
});
