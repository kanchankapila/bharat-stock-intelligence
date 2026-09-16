import { describe, it, expect } from 'vitest';
import { appRouter } from '../router';

describe('sectorsRouter', () => {
  it('should export getSectorsOverview and return structured sector data', async () => {
    const caller = appRouter.createCaller({} as any);
    const result = await caller.getSectorsOverview();

    expect(result).toBeDefined();
    expect(result).toHaveProperty('sectors');
    expect(Array.isArray(result.sectors)).toBe(true);
    expect(result.sectors.length).toBeGreaterThan(0);

    const firstSector = result.sectors[0];
    expect(firstSector).toHaveProperty('id');
    expect(firstSector).toHaveProperty('name');
    expect(firstSector).toHaveProperty('breadth');
    expect(firstSector).toHaveProperty('screener');
    expect(firstSector).toHaveProperty('derivatives');
    expect(firstSector).toHaveProperty('rrg');
    expect(firstSector).toHaveProperty('analyst');
    expect(['LEADING', 'WEAKENING', 'LAGGING', 'IMPROVING']).toContain(firstSector.rrg.quadrant);
  });

  it('should return deep-dive details for nifty-bank', async () => {
    const caller = appRouter.createCaller({} as any);
    const result = await caller.getSectorDeepDive({ sectorId: 'nifty-bank' });

    expect(result).toBeDefined();
    expect(result.sectorDef.id).toBe('nifty-bank');
    expect(result).toHaveProperty('constituents');
    expect(Array.isArray(result.constituents)).toBe(true);
  });

  it('should return derivatives desk metrics', async () => {
    const caller = appRouter.createCaller({} as any);
    const result = await caller.getSectorDerivativesDesk();

    expect(result).toBeDefined();
    expect(Array.isArray(result)).toBe(true);
  });
});
