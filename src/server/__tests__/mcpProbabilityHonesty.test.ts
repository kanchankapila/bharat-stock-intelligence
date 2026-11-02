import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('stock profile probability disclosure', () => {
  it('does not present the unvalidated model output as a trade win probability', () => {
    const source = readFileSync(new URL('../mcpServer.ts', import.meta.url), 'utf8');
    expect(source.includes('**Win Probability:**')).toBe(false);
    expect(source.includes('Win probability unavailable: model outputs are not validated')).toBe(true);
  });
});
