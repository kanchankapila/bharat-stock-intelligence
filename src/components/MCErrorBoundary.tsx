import React from 'react';
import { AlertCircle } from 'lucide-react';
import { captureException } from '../lib/sentry';

// Extracted from App.tsx (2026-08-02 perf pass, alongside V1StockDetails which was its only
// consumer) so it can be shared without needing to import from the eagerly-loaded App.tsx.
export class MCErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { hasError: boolean; message: string }
> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { hasError: false, message: '' };
  }
  static getDerivedStateFromError(error: Error) {
    return { hasError: true, message: error.message };
  }
  componentDidCatch(error: Error) {
    captureException(error, { boundary: 'MCErrorBoundary' });
  }
  render() {
    if (this.state.hasError) {
      return (
        <div className="p-8 text-center bg-slate-950/30 border border-slate-800/50 rounded-2xl">
          <AlertCircle className="w-8 h-8 text-rose-500 mx-auto mb-3" />
          <p className="text-sm text-slate-400 font-bold">MC Intelligence failed to render</p>
          <p className="text-[10px] text-slate-400 mt-1">{this.state.message}</p>
        </div>
      );
    }
    return this.props.children;
  }
}

export default MCErrorBoundary;
