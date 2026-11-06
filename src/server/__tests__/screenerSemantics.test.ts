import { describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { analyzeScreener, screenerTitle } from '../screenerSemantics';

vi.mock('../dbAsync', () => ({ dbAll: vi.fn(), dbTransaction: vi.fn() }));

const cases: [string, string][] = [
  ['Morning Star (Bullish Reversal)', 'bullish'],
  ['Previous Day Breakout - Down Stocks which closed below their previous low', 'bearish'],
  ['Companies Increasing Debt as per Annual Report', 'bearish'],
  ['Decreasing Promoter Pledge', 'bullish'],
  ['Strong Earnings QualityFocuses on reduced bankruptcy risk', 'bullish'],
  ['Forecaster: Analysts Estimate Falling Interest Expense (QoQ)', 'bullish'],
  ['Forecaster: Analysts Estimate Rising Interest Expense (QoQ)', 'bearish'],
  ['Stocks with their EMA10 trading below their EMA100', 'bearish'],
  ['15 min CCI Oversold', 'neutral'],
  ['Overbought on both Week MFI and Week RSI', 'neutral'],
  ['Volume Shockers', 'neutral'],
  ['High Delivery', 'neutral'],
  ['FII Selling, DII Buying', 'neutral'],
  ['Low Volatility Stocks', 'neutral'],
  ['Results declared today', 'neutral'],
  ['My custom screener', 'neutral'],
  ['Low Price to SalesStocks with price-to-sales ratio of less than', 'bullish'],
  ['Not low debt', 'neutral'],
  ['Low DVM Stocks - Stocks to Exercise Caution On', 'bearish'],
  ['ASM (Additional Surveillance Measure)/GSM (Graded Surveillance Measure) stock list', 'bearish'],
  ['Distressed Operations Track stocks with consistent decline in key business ratios', 'bearish'],
  ['Operations Unsuccessful', 'bearish'],
  ['Increasing Trading Activity with Negative Weekly returns - Large CapDiscovering Momentum', 'bearish'],
  ['Increasing Trading Activity with Negative Weekly returns - Mid CapDiscover mid-cap stocks', 'bearish'],
  ['Increasing Trading Activity with Negative Weekly returns - Micro CapAmidst weekly losses', 'bearish'],
];

describe('shared screener semantics', () => {
  it.each(cases)('%s is %s', (name, expected) => {
    expect(analyzeScreener(name).semantic_bias).toBe(expected);
    expect(analyzeScreener(name).empirical_direction).toBe('unproven');
  });

  it('does not let marketing copy reverse a titled condition', () => {
    expect(screenerTitle('Low Debt StocksIdentifies companies avoiding high debt')).toBe('low debt stocks');
    expect(analyzeScreener('Low Debt StocksIdentifies companies avoiding high debt').semantic_bias).toBe('bullish');
  });

  it('uses verified provider filters only in the matching provider namespace', () => {
    expect(analyzeScreener('ROCE Annual %').semantic_bias).toBe('neutral');
    expect(analyzeScreener('ROCE Annual %', 'et_marketstats').semantic_bias).toBe('bullish');
    expect(analyzeScreener('Net Profit QoQ Growth %', 'et_marketstats').semantic_bias).toBe('bullish');
    expect(analyzeScreener('Negative Breakout First Support', 'et_marketstats', 'negative-breakout-first-support-e1d50602').role).toBe('invalid_filter');
    expect(analyzeScreener('Negative Breakout First Support', 'et_marketstats', 'new-corrected-key').semantic_bias).toBe('bearish');
  });

  it('matches the Python implementation on all shared examples', () => {
    const python = process.platform === 'win32' ? 'backend-python/venv/Scripts/python.exe' : 'python';
    const code = "import json,sys;sys.path.insert(0,'src/server');from screener_semantics import analyze_screener;print(json.dumps([analyze_screener(n) for n in json.load(sys.stdin)]))";
    const actual = JSON.parse(execFileSync(python, ['-c', code], {
      cwd: path.resolve('.'), input: JSON.stringify(cases.map(([name]) => name)), encoding: 'utf8',
    }));
    expect(actual).toEqual(cases.map(([name]) => analyzeScreener(name)));
  });
});
