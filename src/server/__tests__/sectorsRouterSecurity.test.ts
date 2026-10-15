import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('sector AI briefing cost boundary', () => {
  it('rate-limits the public mutation that performs external fetches and an LLM call', () => {
    const source = readFileSync(new URL('../routers/sectors.router.ts', import.meta.url), 'utf8');
    expect(source).toMatch(/generateSectorAiBriefing:\s*expensiveProcedure/);
  });
});
