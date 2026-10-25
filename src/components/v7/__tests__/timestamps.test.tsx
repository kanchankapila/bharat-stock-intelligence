import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { KpiCard } from '../components/KpiCard';
import { AsOfBanner } from '../components/AsOfBanner';
import { formatIST } from '../../../lib/timeFormat';

describe('v7 production timestamp transport', () => {
  it('renders a PostgreSQL timestamp reconstructed as a Date by SuperJSON', () => {
    const generated = new Date('2026-10-23T17:00:02.140005Z');
    const result = renderToStaticMarkup(<KpiCard title="Canonical score" value={77.9} asOf={generated as any} />);
    expect(result).toContain(formatIST(generated));
    expect(result).not.toContain('Invalid Date');
  });

  it('uses the same IST formatter for Date and ISO-string banner timestamps', () => {
    const generated = new Date('2026-10-23T17:00:02.140005Z');
    expect(renderToStaticMarkup(<AsOfBanner asOf={generated.toISOString()} />)).toContain(formatIST(generated));
  });
});
