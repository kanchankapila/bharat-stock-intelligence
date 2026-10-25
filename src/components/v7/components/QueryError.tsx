import React from 'react';
import { EmptyState } from './EmptyState';

/** A failed request is not evidence that the market has no matching data. */
export function QueryError({ onRetry = () => window.location.reload() }: { onRetry?: () => void }) {
  return <div role="alert"><EmptyState variant="alert" title="Data request failed"
    text="Data could not be verified. Retry the request; do not interpret this as an empty result."
    action={<button type="button" className="v7-btn" onClick={onRetry}>Retry</button>} /></div>;
}
