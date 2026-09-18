import React from 'react';

export function QueryError({ retry }: { retry: () => void }) {
  return <div role="alert" className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-rose-500/30 bg-rose-500/5 p-4 text-sm text-rose-300">
    <span>Unable to load data. Previously loaded data may be outdated.</span>
    <button type="button" onClick={retry} className="underline underline-offset-4">Try again</button>
  </div>;
}
