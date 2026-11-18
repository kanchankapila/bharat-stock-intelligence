import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import viteConfig from '../vite.config';

const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const lock = JSON.parse(readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8'));
const config = viteConfig({ mode: 'test', command: 'serve' });

describe('dependency security and test-runner migration', () => {
  it('removes the unmaintained spreadsheet reader and the legacy worker-pool dependency', () => {
    expect(Object.keys(lock.packages).length).toBeGreaterThan(1);
    for (const name of Object.keys(lock.packages)) {
      expect(name).not.toMatch(/(?:^|\/)node_modules\/(?:xlsx|tinypool)$/);
    }
    expect(lock.packages['node_modules/vitest'].version).toMatch(/^5\./);
    expect(manifest.dependencies['write-excel-file']).toBeDefined();
  });

  it('preserves serial DB execution and the existing mock lifecycle on supported options', () => {
    expect(config.test.clearMocks).toBe(false);
    expect(config.test.sharedViteServer).toBe(false);
    for (const lane of [config.test, ...config.test.projects.map(p => p.test)]) {
      expect(lane.pool).toBe('forks');
      expect(lane.maxWorkers).toBe(1);
      expect(lane.fileParallelism).toBe(false);
      expect(lane.isolate).toBe(true);
      expect(lane).not.toHaveProperty('poolOptions');
    }
  });

  it('retains separate private-schema and real-provider lanes with ordered credential stripping', () => {
    const [unit, live] = config.test.projects.map(p => p.test);
    expect(unit.name).toBe('unit');
    expect(unit.globalSetup).toEqual(['./vitest.globalSetup.ts']);
    expect(unit.exclude).toContain('**/*.live.test.ts');
    expect(live.name).toBe('live');
    expect(live.setupFiles).toEqual(['./vitest.setup.live.ts', './vitest.setup.ts']);
    expect(live).not.toHaveProperty('globalSetup');
  });

  it('makes registry audit failures a CI failure rather than an advisory-only report', () => {
    expect(manifest.scripts['security:check']).toBe('npm audit --include=dev --audit-level=low');
    const ci = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
    expect(ci).toMatch(/run: npm run security:check/);
  });

  it('keeps imported CLI hashbangs at the start of the Vite SSR transform on Windows', () => {
    const attributes = readFileSync(new URL('../.gitattributes', import.meta.url), 'utf8');
    expect(attributes).toMatch(/^\*\.mjs text eol=lf$/m);
    const checker = readFileSync(new URL('./checkFindingsLedger.mjs', import.meta.url), 'utf8');
    expect(checker).toMatch(/^#![^\r\n]*\n/);
  });

  it('keeps the percentile fixture bounded and awaited instead of per-row autocommit', () => {
    const source = readFileSync(new URL('../src/server/__tests__/mlRankPct.test.ts', import.meta.url), 'utf8');
    const start = source.indexOf('async function seed()');
    const end = source.indexOf('const EXPECTED:', start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const seed = source.slice(start, end);
    expect(seed).toContain('await dbTransaction(');
    expect(seed).not.toContain('await dbRun(');
    expect(seed.match(/INSERT INTO technical_signals/g)).toHaveLength(1);
    const resolved = readFileSync(new URL('../src/server/__tests__/mlRouterResolvedPopulation.test.ts', import.meta.url), 'utf8');
    expect(resolved).toContain('dbTransaction');
    expect(resolved).not.toContain('await rec(');
  });

  it('fixes the Firebase gRPC chain without accepting the audit suggestion to downgrade Firebase', () => {
    expect(manifest.dependencies.firebase).toMatch(/^\^12\./);
    expect(manifest.overrides['@grpc/grpc-js']).toBe('^1.14.6');
    const grpc = Object.entries(lock.packages).filter(([name]) => name.endsWith('node_modules/@grpc/grpc-js'));
    expect(grpc.length).toBeGreaterThan(0);
    for (const [, pkg] of grpc) {
      const [major, minor, patch] = pkg.version.split('.').map(Number);
      expect(major > 1 || (major === 1 && (minor > 14 || (minor === 14 && patch >= 6)))).toBe(true);
    }
  });

  it('keeps digest and Trendlyne fixture writes inside awaited transactions', () => {
    for (const file of ['signalAccuracyDigest.test.ts', 'trendlyneDailyFetchTopN.test.ts', 'edgeRouter.test.ts']) {
      const source = readFileSync(new URL(`../src/server/__tests__/${file}`, import.meta.url), 'utf8');
      expect(source, file).toContain('await dbTransaction(');
      expect(source, file).not.toContain('await dbRun(');
      expect(source, file).not.toContain('await dbExec(');
    }
  });
});
