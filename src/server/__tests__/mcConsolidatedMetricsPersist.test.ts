import { beforeEach, describe, expect, it } from 'vitest';

process.env.DATABASE_URL = ':memory:';
// Isolates this test from the host environment's USE_POSTGRES -- see backtestRunner.test.ts
// for the full explanation of why this must be set before any dbAsync.ts import.
process.env.USE_POSTGRES = 'false';
const { default: db } = await import('../db');
const { dbAll } = await import('../dbAsync');

const { persistMcConsolidatedMetrics } = await import('../mcApiService');

// mc_general_metrics is a real db.ts table (shared with etMarketstatsSync.ts's writer) --
// no ad-hoc CREATE TABLE needed here, unlike the Python-fetcher-owned tables in
// corporateActionsRouter.test.ts.
beforeEach(() => {
  db.exec(`DELETE FROM mc_general_metrics WHERE source_api = 'mc_consolidated'`);
});

describe('persistMcConsolidatedMetrics', () => {
  it('writes the stock score, analyst rating/count, price-forecast targets and beat ratio', async () => {
    await persistMcConsolidatedMetrics('reliance', {
      mcInsights: { classification: { stockScore: 78 } },
      analystRating: { finalRating: 'Buy', analystCount: '32' },
      priceForecast: { high: '3200', mean: '2950.5', low: '2700' },
      hitsMisses: { beats: { total: '6' }, misses: { total: '2' }, inline: { total: '2' } },
    });

    const rows = await dbAll<any>(
      `SELECT metric_group, metric_name, metric_value_num, metric_value_text FROM mc_general_metrics
       WHERE symbol = 'RELIANCE' AND source_api = 'mc_consolidated' ORDER BY metric_group, metric_name`
    );
    const byName = Object.fromEntries(rows.map(r => [`${r.metric_group}.${r.metric_name}`, r]));

    expect(byName['score.mc_stock_score'].metric_value_num).toBe(78);
    expect(byName['analyst.final_rating'].metric_value_text).toBe('Buy');
    expect(byName['analyst.analyst_count'].metric_value_num).toBe(32);
    expect(byName['price_forecast.target_high'].metric_value_num).toBe(3200);
    expect(byName['price_forecast.target_mean'].metric_value_num).toBe(2950.5);
    expect(byName['price_forecast.target_low'].metric_value_num).toBe(2700);
    expect(byName['estimates.beat_ratio'].metric_value_num).toBeCloseTo(0.6); // 6/(6+2+2)
  });

  it('upserts in place on a same-day re-run instead of accumulating duplicate rows', async () => {
    await persistMcConsolidatedMetrics('TCS', { mcInsights: { classification: { stockScore: 60 } } });
    await persistMcConsolidatedMetrics('TCS', { mcInsights: { classification: { stockScore: 65 } } });

    const rows = await dbAll<any>(
      `SELECT metric_value_num FROM mc_general_metrics
       WHERE symbol = 'TCS' AND source_api = 'mc_consolidated' AND metric_name = 'mc_stock_score'`
    );
    expect(rows.length).toBe(1);          // day-grain fetched_at -> same-day re-run upserts, not inserts
    expect(rows[0].metric_value_num).toBe(65); // reflects the latest value
  });

  it('writes nothing and does not throw when every input field is absent', async () => {
    await expect(persistMcConsolidatedMetrics('EMPTYCO', {})).resolves.toBeUndefined();
    const rows = await dbAll<any>(
      `SELECT * FROM mc_general_metrics WHERE symbol = 'EMPTYCO' AND source_api = 'mc_consolidated'`
    );
    expect(rows.length).toBe(0);
  });

  it('skips the beat-ratio metric when hitsMisses has zero total calls rather than dividing by zero', async () => {
    await persistMcConsolidatedMetrics('ZEROCO', {
      hitsMisses: { beats: { total: '0' }, misses: { total: '0' }, inline: { total: '0' } },
    });
    const rows = await dbAll<any>(
      `SELECT * FROM mc_general_metrics WHERE symbol = 'ZEROCO' AND source_api = 'mc_consolidated'`
    );
    expect(rows.length).toBe(0);
  });

  it('uppercases the symbol before writing', async () => {
    await persistMcConsolidatedMetrics('infy', { mcInsights: { classification: { stockScore: 50 } } });
    const rows = await dbAll<any>(
      `SELECT symbol FROM mc_general_metrics WHERE source_api = 'mc_consolidated' AND metric_name = 'mc_stock_score'`
    );
    expect(rows[0].symbol).toBe('INFY');
  });
});
