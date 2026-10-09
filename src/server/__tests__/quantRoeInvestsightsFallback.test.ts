import { beforeEach, describe, expect, it } from 'vitest';

const { dbExec, dbRun } = await import('../dbAsync');
const { loadFundamentals } = await import('../quantScoringService');

// Sub-project B.2: stock_fundamentals.return_on_equity (Yahoo) decayed to ~6% coverage;
// investsights_fundamentals_history.return_on_equity is Pearson 0.96, same fraction scale.
// Behind app_settings 'quant_roe_investsights_fallback' (default OFF) it fills ONLY the gaps.
beforeEach(async () => {
  for (const t of ['stock_fundamentals', 'investsights_fundamentals_history']) await dbExec(`DELETE FROM ${t}`);
  await dbExec(`DELETE FROM app_settings WHERE key = 'quant_roe_investsights_fallback'`);
  await dbRun(`INSERT INTO stock_fundamentals (symbol, return_on_equity) VALUES ('HAS', 0.25), ('GAP', NULL)`);
  await dbRun(`INSERT INTO investsights_fundamentals_history (symbol, fetched_date, return_on_equity) VALUES
    ('HAS', '2026-10-01', 0.99), ('GAP', '2026-09-01', 0.10), ('GAP', '2026-10-01', 0.18),
    ('GAP', '2026-10-05', NULL)`);
});

const roe = async () => {
  const m = await loadFundamentals();
  return { has: m.get('HAS')?.return_on_equity ?? null, gap: m.get('GAP')?.return_on_equity ?? null };
};

describe('loadFundamentals ROE investsights fallback', () => {
  it('flag absent => ROE exactly as stored today', async () => {
    expect(await roe()).toEqual({ has: 0.25, gap: null });
  });

  it('flag off => ROE exactly as stored today', async () => {
    await dbRun(`INSERT INTO app_settings (key, value) VALUES ('quant_roe_investsights_fallback', 'false')`);
    expect(await roe()).toEqual({ has: 0.25, gap: null });
  });

  it('flag on => gap filled with latest non-null, present value never overwritten', async () => {
    await dbRun(`INSERT INTO app_settings (key, value) VALUES ('quant_roe_investsights_fallback', 'true')`);
    const r = await roe();
    expect(r.has).toBe(0.25);
    expect(r.gap).toBeCloseTo(0.18, 5);
  });
});
