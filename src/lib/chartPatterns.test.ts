import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  buildChartPatternsUrl, buildMcSymbolMap, parseChartPatternItem,
  resolveInstrument, fetchChartPatternsPage,
  type McChartPatternRaw,
} from './chartPatterns';

// Fixtures mirror the live API shape (captured 2026-09-03, pattern ids 1830/1833/1825).
const stockByMcSymbol = buildMcSymbolMap();

const CLOSED_BUY: McChartPatternRaw = {
  pattern_id: 1833,
  pattern_name: 'Horizontal Trendline',
  comment: '200EMA Support',
  time_frame: '1 hour',
  p_status: 'Closed',
  is_closed: 'Y',
  end_date: '1970-01-01',
  created_at: '2026-09-02 11:40:49',
  created_at_epoch: 1788329449,
  meta_data: JSON.stringify({
    pattern_type: 'buy',
    entry_price: '389.50',
    cmp: '409.10',
    target_price: null,
    target_return_prcnt: '5.01',
    stoploss_price: null,
    stoploss_prcnt: '3.47',
    price_key: 'stk_RB02_N',
    timeline: [
      {
        pattern_img: { '1200x600': 'https://images.moneycontrol.com/technical_picks_cms/178832944739.png' },
        rationale: 'Price broke above the horizontal resistance.',
        action_type: 'add',
      },
      {
        pattern_img: { '1200x600': 'https://images.moneycontrol.com/technical_picks_cms/178842098632.png' },
        rationale: '5.46% up',
        action_type: 'close',
      },
    ],
  }),
};

const ACTIVE_BUY: McChartPatternRaw = {
  pattern_id: 1830,
  pattern_name: 'Rising Trendline',
  comment: '200EMA Support',
  time_frame: '1 hour',
  p_status: 'New',
  is_closed: 'N',
  end_date: '2026-10-09',
  created_at_epoch: 1788325333,
  meta_data: JSON.stringify({
    pattern_type: 'buy',
    entry_price: '1262.60',
    cmp: '1277.00',
    target_price: '1305',
    target_return_prcnt: '3.36',
    stoploss_price: '1248',
    stoploss_prcnt: '1.16',
    price_key: 'stk_UTI10_N',
    timeline: [{
      pattern_img: { '1200x600': 'https://images.moneycontrol.com/technical_picks_cms/178832533226.png' },
      rationale: 'Rising trendline and 200 EMA are acting as support.',
      action_type: 'add',
    }],
  }),
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('parseChartPatternItem', () => {
  it('extracts prices/percentages as numbers and leaves missing targets null (never 0)', () => {
    const p = parseChartPatternItem(CLOSED_BUY, stockByMcSymbol);
    expect(p.entryPrice).toBeCloseTo(389.5);
    expect(p.cmp).toBeCloseTo(409.1);
    expect(p.targetPrice).toBeNull();
    expect(p.stoplossPrice).toBeNull();
    expect(p.targetReturnPct).toBeCloseTo(5.01);
    expect(p.stoplossPct).toBeCloseTo(3.47);
  });

  it('derives Active/Closed from is_closed and treats the 1970 end_date sentinel as no date', () => {
    const closed = parseChartPatternItem(CLOSED_BUY, stockByMcSymbol);
    const active = parseChartPatternItem(ACTIVE_BUY, stockByMcSymbol);
    expect(closed.status).toBe('Closed');
    expect(closed.validTill).toBeNull();
    expect(active.status).toBe('Active');
    expect(active.validTill).toBe('2026-10-09');
  });

  it('uses the LATEST timeline entry for image/rationale and counts updates', () => {
    const closed = parseChartPatternItem(CLOSED_BUY, stockByMcSymbol);
    expect(closed.imageUrl).toBe('https://images.moneycontrol.com/technical_picks_cms/178842098632.png');
    expect(closed.rationale).toBe('5.46% up');
    expect(closed.latestAction).toBe('close');
    expect(closed.timelineCount).toBe(2);

    const active = parseChartPatternItem(ACTIVE_BUY, stockByMcSymbol);
    expect(active.imageUrl).toBe('https://images.moneycontrol.com/technical_picks_cms/178832533226.png');
    expect(active.latestAction).toBe('add');
  });

  it('parses the IST wall-clock created_at string when no epoch is present', () => {
    const p = parseChartPatternItem({ ...ACTIVE_BUY, created_at_epoch: undefined, created_at: '2026-09-02 10:32:13' }, stockByMcSymbol);
    expect(p.createdAtMs).toBe(Date.UTC(2026, 8, 2, 10, 32, 13) - 5.5 * 3600 * 1000);
  });

  it('survives malformed meta_data without throwing and still parses item-level fields', () => {
    const p = parseChartPatternItem({
      ...CLOSED_BUY,
      meta_data: '{not json',
      pattern_name: 'Rectangle Pattern',
    }, stockByMcSymbol);
    expect(p.patternName).toBe('Rectangle Pattern');
    expect(p.entryPrice).toBeNull();
    expect(p.direction).toBeNull();
    expect(p.imageUrl).toBeNull();
    expect(p.instrument.kind).toBe('unknown');
  });
});


describe('resolveInstrument', () => {
  it('strips the stk_ prefix / exchange suffix and resolves via the stocklist mcsymbol map', () => {
    const resolved = resolveInstrument('stk_RB02_N', stockByMcSymbol);
    expect(resolved.kind).toBe('stock');
    expect(resolved.code).toBe('RB02');
    const expected = stockByMcSymbol.get('RB02');
    expect(expected).toBeDefined();
    expect(resolved.symbol).toBe(expected!.symbol);
    expect(resolved.name).toBe(expected!.name);
  });

  it('keeps the raw code as stock kind when stocklist has no such mcsymbol', () => {
    const resolved = resolveInstrument('stk_ZZ99_N', stockByMcSymbol);
    expect(resolved).toEqual({ kind: 'stock', code: 'ZZ99', name: null, symbol: null });
  });

  it('classifies index price keys without inventing a name', () => {
    expect(resolveInstrument('indices_i_in;NSX', stockByMcSymbol))
      .toEqual({ kind: 'index', code: 'NSX', name: null, symbol: null });
  });

  it('returns kind unknown for a missing price_key', () => {
    expect(resolveInstrument(undefined, stockByMcSymbol).kind).toBe('unknown');
  });
});

describe('fetchChartPatternsPage', () => {
  it('builds the exact Moneycontrol URL with start/limit/pattern_type', () => {
    expect(buildChartPatternsUrl(0)).toBe(
      'https://api.moneycontrol.com/mcapi/technicalpicks/chart-patterns?deviceType=W&version=174&start=0&limit=12&pattern_type=all',
    );
    expect(buildChartPatternsUrl(24, 12)).toContain('start=24');
  });

  it('fetches and parses a successful response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ status: 'success', list: { total: 85, currentCount: 45, closedCount: 54, data: [CLOSED_BUY, ACTIVE_BUY] } }),
      { status: 200 },
    )));
    const pageData = await fetchChartPatternsPage(0);
    expect(pageData.sourceTotal).toBe(85);
    expect(pageData.patterns.map(p => p.id)).toEqual([1833, 1830]);
    expect(pageData.patterns[0].patternName).toBe('Horizontal Trendline');
  });

  it('throws on HTTP errors and on unexpected response shapes', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('blocked', { status: 403 })));
    await expect(fetchChartPatternsPage(0)).rejects.toThrow(/HTTP 403/);

    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ status: 'error' }),
      { status: 200 },
    )));
    await expect(fetchChartPatternsPage(0)).rejects.toThrow(/Unexpected response shape/);
  });
});

