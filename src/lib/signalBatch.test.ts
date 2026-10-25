import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { buildSignalBatch, refreshFailureMessage, QUEUE_UNAVAILABLE_MESSAGE, MAX_SIGNAL_BATCH } from './signalBatch';

const stock = (symbol: string, changePct: number) => ({ symbol, changePct });

describe('buildSignalBatch', () => {
  it('drops entries whose changePct is not a finite number instead of poisoning the sort', () => {
    const out = buildSignalBatch([
      stock('A', 1), stock('NAN', NaN), stock('B', -5), stock('INF', Infinity), stock('C', 3),
      { symbol: 'UNDEF', changePct: undefined as any },
    ]);
    expect(out.map(o => o.symbol)).toEqual(['B', 'C', 'A']);
  });

  it('drops the index rows DashboardPage looks up inside stocks (NIFTY / NIFTY50)', () => {
    const out = buildSignalBatch([stock('NIFTY', 9), stock('NIFTY50', -9), stock('RELIANCE', 2)]);
    expect(out.map(o => o.symbol)).toEqual(['RELIANCE']);
  });

  it('still caps at MAX_SIGNAL_BATCH, biggest movers first', () => {
    const many = Array.from({ length: MAX_SIGNAL_BATCH + 50 }, (_, i) => stock(`S${i}`, i));
    const out = buildSignalBatch(many);
    expect(out).toHaveLength(MAX_SIGNAL_BATCH);
    expect(out[0].symbol).toBe(`S${MAX_SIGNAL_BATCH + 49}`);
  });
});

describe('REFRESH failure surface', () => {
  it('carries the server message through', () => {
    expect(refreshFailureMessage(new Error('Admin access required'))).toContain('Admin access required');
  });
  it('has a fallback for a non-Error throw', () => {
    expect(refreshFailureMessage('boom')).toMatch(/failed/i);
  });
  it('names the unavailable queue', () => {
    expect(QUEUE_UNAVAILABLE_MESSAGE).toMatch(/queue.*unavailable/i);
  });
  it('DashboardPage no longer swallows the error and shows both messages', () => {
    const src = readFileSync('src/components/DashboardPage.tsx', 'utf8');
    const handler = src.slice(src.indexOf('const handleGenerateSignals'), src.indexOf('// Derived market stats'));
    expect(handler).not.toMatch(/catch\s*\{/);
    expect(handler).toMatch(/refreshFailureMessage\(/);
    expect(handler).toMatch(/QUEUE_UNAVAILABLE_MESSAGE/);
    expect(src).toMatch(/role="alert"/);
  });
});
