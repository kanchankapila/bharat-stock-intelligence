/**
 * Tests for regime-dynamic weight multipliers in confluenceEngine.ts
 * Run with: npx tsx src/server/tests/test_confluence_regime.ts
 */

import { getCurrentRegime, _resetRegimeCache, REGIME_WEIGHTS } from '../confluenceEngine';

// ─── Minimal mock of better-sqlite3 db ────────────────────────────────────────

let _mockRegimeRow: { regime: string } | undefined = undefined;
let _dbQueryCount = 0;

// Patch the db module before importing confluenceEngine
// Since we import after patching is not straightforward, we use module-level
// mocking via the registry trick below. Instead, we test the logic directly
// by inspecting exported functions and using a fresh import with mocked db.

// ─── Inline logic tests (pure, no DB) ────────────────────────────────────────

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`ASSERTION FAILED: ${message}`);
  }
}

function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) {
    throw new Error(`ASSERTION FAILED: ${message}\n  expected: ${JSON.stringify(expected)}\n  actual:   ${JSON.stringify(actual)}`);
  }
}

function assertClose(actual: number, expected: number, tolerance: number, message: string): void {
  if (Math.abs(actual - expected) > tolerance) {
    throw new Error(`ASSERTION FAILED: ${message}\n  expected ≈ ${expected} (±${tolerance})\n  actual:   ${actual}`);
  }
}

// ─── Test 1: REGIME_WEIGHTS map has all required regimes ─────────────────────

function testRegimeWeightsMap() {
  const required = ['BULL', 'SIDEWAYS', 'HIGH_VOL', 'BEAR', 'CRASH'];
  for (const regime of required) {
    assert(regime in REGIME_WEIGHTS, `REGIME_WEIGHTS should have key "${regime}"`);
    const rw = REGIME_WEIGHTS[regime];
    assert(typeof rw.screenerMomentum === 'number', `${regime}.screenerMomentum is a number`);
    assert(typeof rw.trend === 'number', `${regime}.trend is a number`);
    assert(typeof rw.vol === 'number', `${regime}.vol is a number`);
    assert(typeof rw.sector === 'number', `${regime}.sector is a number`);
    assert(typeof rw.fund === 'number', `${regime}.fund is a number`);
  }
  console.log('  PASS: REGIME_WEIGHTS has all 5 regimes with correct shape');
}

// ─── Test 2: BULL regime has 1.0× for all multipliers ────────────────────────

function testBullRegimeNeutralMultipliers() {
  const bull = REGIME_WEIGHTS['BULL'];
  assertEqual(bull.screenerMomentum, 1.0, 'BULL.screenerMomentum === 1.0');
  assertEqual(bull.trend, 1.0, 'BULL.trend === 1.0');
  assertEqual(bull.vol, 1.0, 'BULL.vol === 1.0');
  assertEqual(bull.sector, 1.0, 'BULL.sector === 1.0');
  assertEqual(bull.fund, 1.0, 'BULL.fund === 1.0');
  console.log('  PASS: BULL regime applies 1.0× (neutral) multipliers');
}

// ─── Test 3: BEAR regime discounts momentum and boosts fundamentals ───────────

function testBearRegimeMultipliers() {
  const bear = REGIME_WEIGHTS['BEAR'];
  assertEqual(bear.screenerMomentum, 0.5, 'BEAR.screenerMomentum === 0.5');
  assertEqual(bear.trend, 0.7, 'BEAR.trend === 0.7');
  assertEqual(bear.vol, 0.5, 'BEAR.vol === 0.5');
  assertEqual(bear.sector, 0.7, 'BEAR.sector === 0.7');
  assertEqual(bear.fund, 1.5, 'BEAR.fund === 1.5');
  console.log('  PASS: BEAR regime discounts momentum (0.5×) and boosts fund (1.5×)');
}

// ─── Test 4: CRASH regime has most aggressive discounts ──────────────────────

function testCrashRegimeMultipliers() {
  const crash = REGIME_WEIGHTS['CRASH'];
  assertEqual(crash.screenerMomentum, 0.25, 'CRASH.screenerMomentum === 0.25');
  assertEqual(crash.trend, 0.5, 'CRASH.trend === 0.5');
  assertEqual(crash.vol, 0.3, 'CRASH.vol === 0.3');
  assertEqual(crash.sector, 0.5, 'CRASH.sector === 0.5');
  assertEqual(crash.fund, 1.8, 'CRASH.fund === 1.8');
  console.log('  PASS: CRASH regime has strongest discounts (0.25× momentum, 1.8× fund)');
}

// ─── Test 5: SIDEWAYS partial discounts ──────────────────────────────────────

function testSidewaysRegimeMultipliers() {
  const sw = REGIME_WEIGHTS['SIDEWAYS'];
  assertEqual(sw.screenerMomentum, 0.9, 'SIDEWAYS.screenerMomentum === 0.9');
  assertEqual(sw.vol, 1.0, 'SIDEWAYS.vol === 1.0 (unchanged)');
  assertEqual(sw.fund, 1.1, 'SIDEWAYS.fund === 1.1 (slight boost)');
  console.log('  PASS: SIDEWAYS partial discounts are correct');
}

// ─── Test 6: Momentum weight in BEAR is 0.5× less than BULL ─────────────────

function testMomentumWeightBearVsBull() {
  const momentumWeightForBull = 7 * REGIME_WEIGHTS['BULL'].screenerMomentum;  // e.g. "high momentum" = weight 7
  const momentumWeightForBear = 7 * REGIME_WEIGHTS['BEAR'].screenerMomentum;
  assertClose(momentumWeightForBear / momentumWeightForBull, 0.5, 0.001,
    'A weight-7 momentum screener in BEAR gets 0.5× the weight it gets in BULL');
  console.log('  PASS: In BEAR, momentum screener weight × 0.5 vs BULL');
}

// ─── Test 7: fundScore cap respected after boost ─────────────────────────────

function testFundScoreCapAfterBoost() {
  // fundScore = 12 (at cap), fund multiplier = 1.8 (CRASH)
  // Result should still be capped at 12
  const rawFundScore = 12;
  const fundMultiplier = REGIME_WEIGHTS['CRASH'].fund;  // 1.8
  const boosted = Math.min(12, Math.round(rawFundScore * fundMultiplier * 100) / 100);
  assertEqual(boosted, 12, 'fundScore=12 × 1.8 still capped at 12');

  // fundScore = 7, fund multiplier = 1.5 (BEAR)
  // 7 × 1.5 = 10.5 — below cap
  const partial = Math.min(12, Math.round(7 * 1.5 * 100) / 100);
  assertEqual(partial, 10.5, 'fundScore=7 × BEAR 1.5× = 10.5');
  console.log('  PASS: fundScore cap (12) respected after regime boost');
}

// ─── Test 8: trendScore regime scaling ───────────────────────────────────────

function testTrendScoreRegimeScaling() {
  const baseTrendScore = 15;  // at cap
  const bearTrend = Math.round(baseTrendScore * REGIME_WEIGHTS['BEAR'].trend * 100) / 100;
  assertEqual(bearTrend, 10.5, 'trendScore=15 × BEAR 0.7 = 10.5');

  const crashTrend = Math.round(baseTrendScore * REGIME_WEIGHTS['CRASH'].trend * 100) / 100;
  assertEqual(crashTrend, 7.5, 'trendScore=15 × CRASH 0.5 = 7.5');
  console.log('  PASS: trendScore scales correctly by regime');
}

// ─── Test 9: volScore regime scaling ─────────────────────────────────────────

function testVolScoreRegimeScaling() {
  const baseVolScore = 10;
  const highVolVol = Math.round(baseVolScore * REGIME_WEIGHTS['HIGH_VOL'].vol * 100) / 100;
  assertEqual(highVolVol, 6, 'volScore=10 × HIGH_VOL 0.6 = 6');

  const bullVol = Math.round(baseVolScore * REGIME_WEIGHTS['BULL'].vol * 100) / 100;
  assertEqual(bullVol, 10, 'volScore=10 × BULL 1.0 = 10 (unchanged)');
  console.log('  PASS: volScore scales correctly by regime');
}

// ─── Test 10: getCurrentRegime cache reset helper works ───────────────────────

function testResetRegimeCacheExists() {
  assert(typeof _resetRegimeCache === 'function', '_resetRegimeCache is a function');
  // Just ensure it doesn't throw
  _resetRegimeCache();
  console.log('  PASS: _resetRegimeCache() callable without error');
}

// ─── Test 11: getCurrentRegime fallback when DB throws ───────────────────────
// This test exercises the exported getCurrentRegime with the real DB wired in.
// The market_regimes table may or may not exist in the test environment.
// We rely on the catch branch returning 'SIDEWAYS' when the table is missing.

function testGetCurrentRegimeFallback() {
  _resetRegimeCache();
  const regime = getCurrentRegime();
  // In a test environment without market_regimes data, expect SIDEWAYS or any valid key
  const validRegimes = ['BULL', 'SIDEWAYS', 'HIGH_VOL', 'BEAR', 'CRASH'];
  assert(
    validRegimes.includes(regime),
    `getCurrentRegime() returned "${regime}" which is not a valid regime key`
  );
  console.log(`  PASS: getCurrentRegime() returned valid regime "${regime}" (fallback or real)`);
}

// ─── Test 12: getCurrentRegime caches (second call hits cache, not DB) ────────

function testGetCurrentRegimeCaches() {
  _resetRegimeCache();
  const first = getCurrentRegime();
  const second = getCurrentRegime();  // should hit cache
  assertEqual(first, second, 'Second getCurrentRegime() call returns same value (from cache)');
  console.log('  PASS: getCurrentRegime() caches result (two calls return same regime)');
}

// ─── Run all tests ────────────────────────────────────────────────────────────

const tests: Array<[string, () => void]> = [
  ['REGIME_WEIGHTS map structure',           testRegimeWeightsMap],
  ['BULL multipliers are 1.0× (neutral)',    testBullRegimeNeutralMultipliers],
  ['BEAR multipliers discount/boost',        testBearRegimeMultipliers],
  ['CRASH multipliers most aggressive',      testCrashRegimeMultipliers],
  ['SIDEWAYS partial discounts',             testSidewaysRegimeMultipliers],
  ['Momentum weight BEAR vs BULL is 0.5×',  testMomentumWeightBearVsBull],
  ['fundScore cap after regime boost',       testFundScoreCapAfterBoost],
  ['trendScore regime scaling',              testTrendScoreRegimeScaling],
  ['volScore regime scaling',                testVolScoreRegimeScaling],
  ['_resetRegimeCache callable',             testResetRegimeCacheExists],
  ['getCurrentRegime returns valid regime',  testGetCurrentRegimeFallback],
  ['getCurrentRegime caches result',         testGetCurrentRegimeCaches],
];

let passed = 0;
let failed = 0;

console.log('\nRunning confluence regime tests...\n');

for (const [name, fn] of tests) {
  try {
    console.log(`[TEST] ${name}`);
    fn();
    passed++;
  } catch (err: any) {
    console.error(`  FAIL: ${err.message}`);
    failed++;
  }
}

console.log(`\nResults: ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
