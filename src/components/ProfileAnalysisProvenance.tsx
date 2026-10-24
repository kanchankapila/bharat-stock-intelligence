import React from 'react';

export function ProfileAnalysisProvenance({ updatedAt }: { updatedAt?: string | Date | null }) {
  const date = updatedAt instanceof Date ? updatedAt : updatedAt ? new Date(updatedAt) : null;
  const stamp = date && Number.isFinite(date.getTime())
    ? date.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' })
    : 'unknown';
  return <p className="text-xs text-slate-400 mb-3" role="note">
    Last generated: {stamp}. Qualitative AI opinion; trading accuracy has not been validated.
  </p>;
}
