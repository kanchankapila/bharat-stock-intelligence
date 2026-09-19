import { describe, expect, it } from 'vitest';
import { heatColor, layout, parseMktcap, type MapCell } from './MarketMapPage';

// Pure-function regression tests for the market-map treemap (#15): the layout must tile the
// box exactly (area conservation), the heat scale must stay diverging around zero, and the
// vendor's comma-grouped market-cap strings must parse to numbers.
type Rect = { cell: MapCell; x: number; y: number; w: number; h: number };

const cell = (key: string, mktcap: number): MapCell => ({ key, name: key, mktcap, changePct: 0 });

describe('parseMktcap', () => {
  it('passes numbers through untouched', () => {
    expect(parseMktcap(4991143.72)).toBe(4991143.72);
    expect(parseMktcap(0)).toBe(0);
  });
  it('parses the vendor comma-grouped string form', () => {
    expect(parseMktcap('4,991,143.72')).toBe(4991143.72);
    expect(parseMktcap('123')).toBe(123);
  });
  it('returns 0 for anything non-numeric rather than NaN', () => {
    expect(parseMktcap('N/A')).toBe(0);
    expect(parseMktcap(null)).toBe(0);
    expect(parseMktcap(undefined)).toBe(0);
    expect(parseMktcap({})).toBe(0);
  });
});

describe('heatColor', () => {
  const alpha = (s: string) => parseFloat(s.split(',')[3]);
  it('is neutral (green channel floor, lowest alpha) at exactly 0', () => {
    expect(heatColor(0)).toBe('rgba(16, 70, 129, 0.220)');
  });
  it('reaches the emerald extreme at +2 and the rose extreme at -2', () => {
    expect(heatColor(2)).toBe('rgba(16, 185, 129, 0.770)');
    expect(heatColor(-2)).toBe('rgba(244, 63, 94, 0.770)');
  });
  it('clamps moves beyond the ±2% scale instead of overflowing it', () => {
    expect(heatColor(5)).toBe(heatColor(2));
    expect(heatColor(-5)).toBe(heatColor(-2));
  });
  it('deepens opacity monotonically as the move grows', () => {
    expect(alpha(heatColor(0.5))).toBeLessThan(alpha(heatColor(1)));
    expect(alpha(heatColor(1))).toBeLessThan(alpha(heatColor(1.5)));
  });
});

describe('layout', () => {
  it('places a single cell over the entire box', () => {
    const out: Rect[] = [];
    layout([cell('A', 100)], 0, 0, 100, 100, out);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ x: 0, y: 0, w: 100, h: 100 });
  });
  it('splits two cells at their market-cap ratio along the wider axis', () => {
    const out: Rect[] = [];
    layout([cell('A', 75), cell('B', 25)], 0, 0, 100, 100, out);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ x: 0, y: 0, w: 75, h: 100 });
    expect(out[1]).toMatchObject({ x: 75, y: 0, w: 25, h: 100 });
  });
  it('tiles the box exactly: total area conserved and nothing out of bounds', () => {
    const out: Rect[] = [];
    const cells = [cell('A', 50), cell('B', 30), cell('C', 12), cell('D', 5), cell('E', 3)];
    layout(cells, 0, 0, 100, 100, out);
    expect(out).toHaveLength(cells.length);
    const totalArea = out.reduce((s, r) => s + r.w * r.h, 0);
    expect(totalArea).toBeCloseTo(10000, 6);
    for (const r of out) {
      expect(r.x).toBeGreaterThanOrEqual(-1e-9);
      expect(r.y).toBeGreaterThanOrEqual(-1e-9);
      expect(r.x + r.w).toBeLessThanOrEqual(100 + 1e-9);
      expect(r.y + r.h).toBeLessThanOrEqual(100 + 1e-9);
    }
  });
  it('is deterministic for the same input', () => {
    const cells = [cell('A', 40), cell('B', 35), cell('C', 25)];
    const a: Rect[] = [];
    const b: Rect[] = [];
    layout(cells, 0, 0, 100, 100, a);
    layout(cells, 0, 0, 100, 100, b);
    expect(a).toEqual(b);
  });
  it('produces nothing for an empty or all-zero-cap input', () => {
    const empty: Rect[] = [];
    layout([], 0, 0, 100, 100, empty);
    expect(empty).toHaveLength(0);
    const zeroed: Rect[] = [];
    layout([cell('A', 0), cell('B', 0)], 0, 0, 100, 100, zeroed);
    expect(zeroed).toHaveLength(0);
  });
});
