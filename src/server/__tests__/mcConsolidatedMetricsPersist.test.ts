import { beforeEach, describe, expect, it } from 'vitest';

process.env.DATABASE_URL = ':memory:';
// Isolates this test from the host environment's USE_POSTGRES -- see backtestRunner.test.ts
// for the full explanation of why this must be set before any dbAsync.ts import.
process.env.USE_POSTGRES = 'false';
const { default: db } = await import('../db');
const { dbAll } = await import('../dbAsync');

const { persistMcConsolidatedMetrics } = await import('../mcApiService');

// mc_general_metrics and mc_swot_history are both real db.ts tables (the former shared with
// etMarketstatsSync.ts's writer) -- no ad-hoc CREATE TABLE needed here, unlike the
// Python-fetcher-owned tables in corporateActionsRouter.test.ts.
beforeEach(() => {
  db.exec(`DELETE FROM mc_general_metrics WHERE source_api = 'mc_consolidated'`);
  db.exec(`DELETE FROM mc_swot_history`);
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

  describe('SWOT (counts into mc_general_metrics, full text into mc_swot_history)', () => {
    it('writes strengths/weaknesses/opportunities/threats counts and a signed net_score', async () => {
      await persistMcConsolidatedMetrics('HDFCBANK', {
        swot: {
          strengths: ['Strong retail franchise', 'Low cost of funds'],
          weaknesses: ['Asset quality in unsecured book'],
          opportunities: ['Digital lending growth'],
          threats: [],
        },
      });
      const rows = await dbAll<any>(
        `SELECT metric_name, metric_value_num FROM mc_general_metrics
         WHERE symbol = 'HDFCBANK' AND source_api = 'mc_consolidated' AND metric_group = 'swot'
         ORDER BY metric_name`
      );
      const byName = Object.fromEntries(rows.map(r => [r.metric_name, r.metric_value_num]));
      expect(byName.strengths_count).toBe(2);
      expect(byName.weaknesses_count).toBe(1);
      expect(byName.opportunities_count).toBe(1);
      expect(byName.threats_count).toBe(0);
      expect(byName.net_score).toBe((2 + 1) - (1 + 0)); // (S+O) - (W+T) = 2
    });

    it('writes one mc_swot_history row per item, tagged with its own category', async () => {
      await persistMcConsolidatedMetrics('HDFCBANK', {
        swot: {
          strengths: ['Strong retail franchise'],
          weaknesses: ['Asset quality in unsecured book'],
          opportunities: [],
          threats: ['Rising competition from NBFCs'],
        },
      });
      const rows = await dbAll<any>(
        `SELECT category, item_text FROM mc_swot_history WHERE symbol = 'HDFCBANK' ORDER BY category`
      );
      expect(rows).toEqual([
        { category: 'strength', item_text: 'Strong retail franchise' },
        { category: 'threat', item_text: 'Rising competition from NBFCs' },
        { category: 'weakness', item_text: 'Asset quality in unsecured book' },
      ]);
    });

    it('a same-day re-run with the identical item does not duplicate the mc_swot_history row', async () => {
      const swot = { strengths: ['Strong retail franchise'], weaknesses: [], opportunities: [], threats: [] };
      await persistMcConsolidatedMetrics('DUPCO', { swot });
      await persistMcConsolidatedMetrics('DUPCO', { swot });
      const rows = await dbAll<any>(`SELECT * FROM mc_swot_history WHERE symbol = 'DUPCO'`);
      expect(rows.length).toBe(1);
    });

    it('writes nothing to either table when swot is entirely empty', async () => {
      await persistMcConsolidatedMetrics('BLANKCO', { swot: { strengths: [], weaknesses: [], opportunities: [], threats: [] } });
      const metricRows = await dbAll<any>(`SELECT * FROM mc_general_metrics WHERE symbol = 'BLANKCO' AND metric_group = 'swot'`);
      const swotRows = await dbAll<any>(`SELECT * FROM mc_swot_history WHERE symbol = 'BLANKCO'`);
      expect(metricRows.length).toBe(0);
      expect(swotRows.length).toBe(0);
    });
  });

  describe('historical rating sentiment (today\'s snapshot only -- MC\'s trend history is Pro-locked)', () => {
    it('writes sentiment text, a signed bull_flag, and the close price at that sentiment', async () => {
      await persistMcConsolidatedMetrics('TATASTEEL', {
        historicalRating: { data: [{ currSentiment: 'Bullish', closePrice: '145.30', currdate: '09 Aug 2026' }] },
      });
      const rows = await dbAll<any>(
        `SELECT metric_name, metric_value_num, metric_value_text FROM mc_general_metrics
         WHERE symbol = 'TATASTEEL' AND source_api = 'mc_consolidated' AND metric_group = 'historical_rating'
         ORDER BY metric_name`
      );
      const byName = Object.fromEntries(rows.map(r => [r.metric_name, r]));
      expect(byName.sentiment_text.metric_value_text).toBe('Bullish');
      expect(byName.bull_flag.metric_value_num).toBe(1);
      expect(byName.close_price_at_sentiment.metric_value_num).toBeCloseTo(145.30);
    });

    it('a bearish sentiment writes bull_flag = -1', async () => {
      await persistMcConsolidatedMetrics('BEARCO', {
        historicalRating: { data: [{ currSentiment: 'Bearish', closePrice: '50' }] },
      });
      const rows = await dbAll<any>(
        `SELECT metric_value_num FROM mc_general_metrics
         WHERE symbol = 'BEARCO' AND metric_group = 'historical_rating' AND metric_name = 'bull_flag'`
      );
      expect(rows[0].metric_value_num).toBe(-1);
    });

    it('a neutral/unrecognized sentiment writes bull_flag = 0, not a missing row', async () => {
      await persistMcConsolidatedMetrics('NEUTCO', {
        historicalRating: { data: [{ currSentiment: 'Neutral', closePrice: '10' }] },
      });
      const rows = await dbAll<any>(
        `SELECT metric_value_num FROM mc_general_metrics
         WHERE symbol = 'NEUTCO' AND metric_group = 'historical_rating' AND metric_name = 'bull_flag'`
      );
      expect(rows[0].metric_value_num).toBe(0);
    });

    it('writes nothing when historicalRating.data is empty (no public snapshot)', async () => {
      await persistMcConsolidatedMetrics('NODATACO', { historicalRating: { data: [] } });
      const rows = await dbAll<any>(`SELECT * FROM mc_general_metrics WHERE symbol = 'NODATACO' AND metric_group = 'historical_rating'`);
      expect(rows.length).toBe(0);
    });
  });
});
