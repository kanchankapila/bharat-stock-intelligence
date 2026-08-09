// Shared Suspense fallback (2026-08-02 perf pass) -- extracted from App.tsx so lazy-loaded
// sub-components (V1StockDetails and its own nested lazy tabs) can use the same fallback
// without importing from the eagerly-loaded App.tsx.
export const PageFallback = () => (
  <div className="flex items-center justify-center h-64 text-muted-foreground text-sm">Loading…</div>
);

export default PageFallback;
