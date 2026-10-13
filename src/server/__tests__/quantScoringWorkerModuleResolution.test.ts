import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

describe('quant scoring worker module resolution', () => {
  it('uses an explicit TS extension for imports loaded by the fresh worker ESM instance', () => {
    const source = fs.readFileSync(path.resolve('src/server/quantScoringWorker.ts'), 'utf8');
    expect(source).toContain("from './riskFreeRate.ts'");
    expect(source).not.toContain("from './riskFreeRate';");
  });
});
