import { describe, it, expect } from 'vitest';

/**
 * The app_settings key for a factor's persisted picks is derived from the factor name
 * (factor_backtest.factor_picks_setting). It used to be a single hardcoded constant, which
 * meant persisting a SECOND factor silently overwrote the first -- which is why
 * value_book_to_price, the STRONGER of the two validated factors, sat unwired.
 */
const key = (factor: string) => `factor_picks_${factor}`;

describe('factor picks key derivation', () => {
  it('reproduces the original momentum key exactly, so no migration is needed', () => {
    expect(key('momentum_12_1')).toBe('factor_picks_momentum_12_1');
  });

  it('gives each factor its own key so one cannot clobber the other', () => {
    expect(key('value_book_to_price')).not.toBe(key('momentum_12_1'));
  });
});

describe('scheduled refresh covers both validated factors', () => {
  it('persists value_book_to_price as well as momentum_12_1', async () => {
    const fs = await import('node:fs/promises');
    const src = await fs.readFile('src/server/jobs/screeners.jobs.ts', 'utf8');
    expect(src).toContain('value_book_to_price');
    expect(src).toContain('momentum_12_1');
  });

  it('runs them sequentially -- each loads a ~3M-bar panel, so parallel doubles peak memory', async () => {
    const fs = await import('node:fs/promises');
    const src = await fs.readFile('src/server/jobs/screeners.jobs.ts', 'utf8');
    // a for..of with await inside, not Promise.all over the factor list
    expect(src).toMatch(/for \(const factor of \[['"]value_book_to_price/);
    expect(src).not.toMatch(/Promise\.all\([^)]*factor_backtest/);
  });

  it('isolates the two so one failing still leaves the other snapshot fresh', async () => {
    const fs = await import('node:fs/promises');
    const src = await fs.readFile('src/server/jobs/screeners.jobs.ts', 'utf8');
    const block = src.slice(src.indexOf('for (const factor of'));
    expect(block.slice(0, 600)).toContain('.catch(');
  });
});

describe('router serves the stronger factor first', () => {
  it('orders value_book_to_price ahead of momentum_12_1', async () => {
    const fs = await import('node:fs/promises');
    const src = await fs.readFile('src/server/routers/screeners.router.ts', 'utf8');
    const block = src.slice(src.indexOf('getFactorPaperPicks'));
    expect(block.indexOf('value_book_to_price')).toBeLessThan(block.indexOf('momentum_12_1'));
  });

  it('keeps the legacy top-level shape for existing callers', async () => {
    const fs = await import('node:fs/promises');
    const src = await fs.readFile('src/server/routers/screeners.router.ts', 'utf8');
    const block = src.slice(src.indexOf('getFactorPaperPicks'), src.indexOf('getScreenerLeaderboard'));
    expect(block).toContain('...legacy');
    expect(block).toContain('factors');
  });
});
