import { describe, expect, it } from 'vitest';
import { parseDecisionMatrixInputs, buildMatrixItems } from '../decisionMatrixInputs';

// Live shapes captured 2026-09-30 (trimmed). The page read `c.score`/`c.verdict` (cockpit) and
// `recsRes.recommendations` (ranker) -- neither exists -- so every card showed invented numbers
// and the canonical picks were never displayed; with both empty it showed 6 made-up STRONG BUYs.
const candidate = {
  symbol: 'ABBOTINDIA', name: 'Abbott India', advice: 'STRONG BUY', compositeScore: 86,
  mlWinProbability: 79, factors: { technical: 90, fundamental: 100, momentum: 100, sentiment: 50, smartMoney: 50 },
  entryPrice: 27270, targetPrice: null, stopLoss: 26412.33, rsi: 59.14, cmp: 27270, changePct: 1.98, aiInsight: null,
};
const pick = {
  symbol: 'BOSCH-HCIL', unified_score: 98.14, conviction_level: 'S_ELITE', classification: 'Strong Buy',
  stop_loss: 1895.71, target_1: 2011.78, target_2: 2089.15, entry_zone_low: 1933.64, entry_zone_high: 1935.16,
  risk_reward: 4, trade_reasoning: 'BOSCH-HCIL: 19 bullish scanners', win_probability: null, rsi: 70.6, cmp: 1934.4, change_pct: 7.32,
};

describe('buildMatrixItems', () => {
  it('maps canonical ranker picks from their real fields', () => {
    const [it0] = buildMatrixItems([], [pick]);
    expect(it0).toMatchObject({
      symbol: 'BOSCH-HCIL', source: 'canonical', action: 'STRONG BUY', score: 98, price: 1934.4,
      changePct: 7.32, target1: 2011.78, target2: 2089.15, stopLoss: 1895.71, rrRatio: '1:4',
      reasoning: 'BOSCH-HCIL: 19 bullish scanners', confidence: null,
    });
    expect(it0.entryZone).toContain('1,934');
  });

  it('maps cockpit candidates from their real fields', () => {
    const [it0] = buildMatrixItems([candidate], []);
    expect(it0).toMatchObject({
      symbol: 'ABBOTINDIA', source: 'cockpit', action: 'STRONG BUY', score: 86, confidence: 79,
      price: 27270, target1: null, stopLoss: 26412.33, rrRatio: null, reasoning: null, setupType: 'BREAKOUT',
    });
  });

  it('prefers the canonical pick when both sources carry a symbol', () => {
    const items = buildMatrixItems([{ ...candidate, symbol: 'BOSCH-HCIL' }], [pick]);
    expect(items).toHaveLength(1);
    expect(items[0].source).toBe('canonical');
  });

  it('invents nothing when both sources are empty', () => {
    expect(buildMatrixItems([], [])).toEqual([]);
  });
});

// AF-20260930-43: UltimateDecisionMatrix read fields these procedures do not return
// (`lastPrice`/`pChange`, top-level `advances`, `fiiRes.data`), so every telemetry number fell
// through to a hard-coded fallback (NIFTY 24,850 +0.65%, VIX 13.8, FII +1,420, breadth 1240/810)
// on every render. Fixtures below are the live response shapes captured 2026-09-30.
const overviewRes = {
  success: true,
  data: {
    config: {},
    indiceList: [{ list: [
      { name: 'NIFTY 50', change: '-95.75', value: '22,620.45', changePer: '-0.42', direction: -1 },
      { name: 'NIFTY BANK', change: '373.10', value: '54,633.05', changePer: '0.69', direction: 1 },
      { name: 'India VIX', change: '0.08', value: '13.49', changePer: '0.60', direction: 1 },
    ] }],
  },
};
const adRes = { success: 1, data: [{ advances: 1629, time: 9301600, declines: 1619, unchanged: 89 }, { advances: 1, declines: 1 }] };
const fiiRes = [{ date: '2026-09-28', fii_net: -5353.22, dii_net: 5189.02 }, { date: '2026-09-25', fii_net: -3693.93 }];
const sentimentRes = { latest: { nifty_bias: 'Bullish' }, pcr: 0.4792677215891736, history: [] };

describe('parseDecisionMatrixInputs', () => {
  it('reads the real response shapes', () => {
    const m = parseDecisionMatrixInputs({ overviewRes, adRes, fiiRes, sentimentRes });
    expect(m.nifty).toEqual({ value: 22620.45, changePct: -0.42 });
    expect(m.bankNifty).toEqual({ value: 54633.05, changePct: 0.69 });
    expect(m.vix).toBe(13.49);
    expect(m.advances).toBe(1629);
    expect(m.declines).toBe(1619);
    expect(m.fiiNetCr).toBe(-5353.22);
    expect(m.fiiDate).toBe('2026-09-28');
    expect(m.pcr).toBeCloseTo(0.479, 3);
  });

  it('returns null, never a made-up number, when data is missing', () => {
    const m = parseDecisionMatrixInputs({});
    expect(m).toEqual({
      nifty: null, bankNifty: null, vix: null, advances: null, declines: null,
      fiiNetCr: null, fiiDate: null, pcr: null,
    });
  });
});
